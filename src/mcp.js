'use strict';
/*
 * MCP client layer for the codex-router.
 * - Official @modelcontextprotocol/sdk (pinned 1.30.0, vendored node_modules).
 * - Servers come from the router allowlist (router_config.json) only; command /
 *   args / env / cwd are sourced from ~/.codex/config.toml [mcp_servers.*].
 * - Tool allowlist is fail-closed: a tool not listed is never published.
 *   readOnlyHint === false on an allowlisted READ tool is a config error (not published).
 * - Write tools (router_config.json writeTools, OFF by default) are published by
 *   exact name only, listed in router_config.json. They are guarded by the
 *   elicitation handshake: the router DECLINES the server's elicit() during a
 *   normal model call (phase 'deny') and ACCEPTS it only after the user typed
 *   /send-ok in the same thread (phase 'accept') with a byte-identical preview.
 * - Tools are namespaced externally as mcp__<server>__<tool>; collisions are
 *   logged and the colliding tool is NOT published.
 * - Secrets known to the router (env/config values whose names look secret)
 *   are scrubbed from MCP tool results before they leave this module.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { ElicitRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

// The only variables an MCP subprocess gets for free: what a process needs to
// start at all. Everything else must be declared per server in the Codex config.
const RUNTIME_ENV_KEYS = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'ComSpec', 'windir',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'LANG', 'LC_ALL', 'TZ', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
];

const SECRET_NAME_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|AUTH|CREDENTIAL)/i;

// ---------------------------------------------------------------- config parsing
function parseTomlConfig(file) {
  const txt = fs.readFileSync(file, 'utf8');
  const sections = {};
  let cur = '';
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const sec = line.match(/^\[([^\]]+)\]\s*$/);
    if (sec) { cur = sec[1].trim(); if (!sections[cur]) sections[cur] = {}; continue; }
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!kv || !cur) continue;
    const key = kv[1].trim();
    let val = kv[2].trim();
    if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) {
      val = val.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else if (val.startsWith('[') && val.endsWith(']')) {
      val = val.slice(1, -1).split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    }
    sections[cur][key] = val;
  }
  return sections;
}

// ---------------------------------------------------------------- state
const state = { tools: [], byAlias: new Map(), clients: [], secrets: [] };

// Elicitation policy, set by the router for the duration of one callTool:
//   { phase: 'deny' }                     -> always decline (save intent via onPreview)
//   { phase: 'accept', expectedHash }     -> accept only if preview hash matches
let elicitPolicy = null;
let onMismatch = null;

function hashPreview(text) {
  return crypto.createHash('sha1').update(String(text || '')).digest('hex').slice(0, 16);
}

function collectSecrets(sections, routerConfig) {
  const out = [];
  const add = (name, value) => {
    if (typeof value === 'string' && value.length >= 6 && SECRET_NAME_RE.test(name)) out.push(value);
  };
  for (const [k, v] of Object.entries(process.env)) add(k, v);
  if (process.env.DEEPSEEK_API_KEY) out.push(process.env.DEEPSEEK_API_KEY);
  for (const serverName of Object.keys(routerConfig.mcpServers || {})) {
    const env = sections['mcp_servers.' + serverName + '.env'] || {};
    for (const [k, v] of Object.entries(env)) add(k, String(v));
  }
  return out;
}

// ---------------------------------------------------------------- lifecycle
async function init(routerConfig, codexConfigPath, log) {
  const mcpCfg = routerConfig.mcpServers || {};
  if (Object.keys(mcpCfg).length === 0) return;
  let sections;
  try { sections = parseTomlConfig(codexConfigPath); }
  catch (e) { log('MCP-CONFIG-ERROR ' + e.message); return; }
  state.secrets = collectSecrets(sections, routerConfig);
  const blocked = new Set(routerConfig.writeToolsBlocked || []);
  const writeCfg = routerConfig.writeTools || { enabled: false, tools: [] };
  const writeAllowed = new Set(writeCfg.enabled ? (writeCfg.tools || []) : []);
  state.writeToolsEnabled = !!writeCfg.enabled;

  for (const serverName of Object.keys(mcpCfg)) {
    const sec = sections['mcp_servers.' + serverName];
    if (!sec || !sec.command) {
      log('MCP-SERVER ' + serverName + ' not configured in ' + codexConfigPath + ' — not started');
      continue;
    }
    // A subprocess inherits nothing by default. Passing the router's whole
    // environment would hand every MCP server the provider key and anything else
    // that happens to be set. This is not a sandbox — the process still runs with
    // the user's file permissions — but it stops secrets travelling by accident.
    const env = {};
    for (const k of RUNTIME_ENV_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k];
    const envSec = sections['mcp_servers.' + serverName + '.env'] || {};
    for (const [k, v] of Object.entries(envSec)) env[k] = String(v);
    let client = null;
    try {
      const transport = new StdioClientTransport({
        command: sec.command,
        args: Array.isArray(sec.args) ? sec.args : [],
        cwd: sec.cwd || undefined,
        env,
      });
      client = new Client(
        { name: 'codex-router', version: '1.0.0' },
        { capabilities: { elicitation: { form: {} } } }
      );
      // Elicitation handler: the server calls ctx.elicit(message=preview, ...)
      // inside a write tool. We decline unless the router armed an accept
      // policy for this exact call (user typed /send-ok).
      client.setRequestHandler(ElicitRequestSchema, async (request) => {
        const params = (request && request.params) || {};
        const preview = String(params.message || '');
        const pol = elicitPolicy;
        if (!pol) return { action: 'decline', message: 'No confirmation policy' };
        if (pol.phase === 'deny') {
          if (pol.onPreview) pol.onPreview(preview);
          return { action: 'decline', message: 'Deferred — user must confirm with /send-ok' };
        }
        if (pol.expectedHash && hashPreview(preview) !== pol.expectedHash) {
          if (onMismatch) onMismatch();
          return { action: 'decline', message: 'Preview changed — not sending' };
        }
        return { action: 'accept', content: { confirm: true } };
      });
      await client.connect(transport);
      const toolsRes = await client.listTools();
      const allowed = new Set(mcpCfg[serverName].tools || []);
      let published = 0, denied = 0, writes = 0;
      for (const t of (toolsRes.tools || [])) {
        const isWrite = writeAllowed.has(t.name);
        if (blocked.has(t.name) && !isWrite) { log('MCP-TOOL-BLOCKED ' + serverName + '/' + t.name); continue; }
        if (!allowed.has(t.name) && !isWrite) { denied++; continue; }
        // The MCP spec puts this under `annotations`. Reading t.readOnlyHint
        // checks a field that never exists, so the guard never fired and every
        // allow-listed tool was published regardless of what the server said.
        // A missing annotation now fails closed: an unstated claim is not a claim.
        const readOnly = !!(t.annotations && t.annotations.readOnlyHint === true);
        if (!isWrite && !readOnly) {
          log('MCP-TOOL-NOT-READ-ONLY ' + serverName + '/' + t.name +
            ' (annotations.readOnlyHint is not true) — NOT published');
          continue;
        }
        const alias = 'mcp__' + serverName + '__' + t.name;
        if (state.byAlias.has(alias)) {
          log('MCP-TOOL-COLLISION ' + alias + ' — NOT published');
          continue;
        }
        state.byAlias.set(alias, { server: serverName, name: t.name, write: isWrite });
        state.tools.push({
          alias,
          name: alias,
          description: (t.description || '') + (isWrite ? ' [write; requires user /send-ok confirmation]' : ' [read-only via ' + serverName + ']'),
          parameters: t.inputSchema || { type: 'object', properties: {} },
          write: isWrite,
        });
        if (isWrite) writes++; else published++;
      }
      state.clients.push({ server: serverName, client });
      log('MCP-SERVER-UP ' + serverName + ' published=' + published + ' write=' + writes + ' denied=' + denied);
    } catch (e) {
      log('MCP-SERVER-ERROR ' + serverName + ' ' + String(e.message || e).slice(0, 300));
      if (client) { try { await client.close(); } catch (_) {} }
    }
  }
  log('MCP-READY tools=' + state.tools.length + ' writeTools=' + (state.writeToolsEnabled ? 'on' : 'off'));
}

async function closeAll() {
  for (const c of state.clients) { try { await c.client.close(); } catch (_) {} }
  state.clients = [];
}

// ---------------------------------------------------------------- scrub
function scrubText(text) {
  if (!text) return text;
  let out = text;
  for (const s of state.secrets) {
    if (s && out.includes(s)) out = out.split(s).join('[REDACTED]');
  }
  return out;
}

// ---------------------------------------------------------------- tools / calls
function getFunctionTools() {
  return state.tools.map((t) => ({ type: 'function', name: t.alias, description: t.description, parameters: t.parameters }));
}

function isMcpToolName(name) {
  return typeof name === 'string' && name.startsWith('mcp__');
}

function isWriteTool(alias) {
  const rec = state.byAlias.get(alias);
  return !!(rec && rec.write);
}

// policy: { phase: 'deny', onPreview(preview) } | { phase: 'accept', expectedHash, onMismatch() }
// The elicitation policy has to be visible to a handler the SDK invokes on its
// own, which makes it module state. Two calls in flight at once could therefore
// apply one thread's confirmation decision to another thread's write. Calls are
// serialized instead: they are rare, and correctness here is worth the latency.
let callChain = Promise.resolve();
function serialize(fn) {
  const run = callChain.then(fn, fn);
  callChain = run.then(() => {}, () => {});
  return run;
}

async function callTool(alias, args, policy) {
  const rec = state.byAlias.get(alias);
  if (!rec) return { isError: true, text: 'unknown MCP tool ' + alias };
  const c = state.clients.find((x) => x.server === rec.server);
  if (!c) return { isError: true, text: 'MCP server ' + rec.server + ' not available' };
  return serialize(async () => {
    elicitPolicy = policy || null;
    onMismatch = (policy && policy.onMismatch) || null;
    try {
      const res = await c.client.callTool({ name: rec.name, arguments: args || {} });
      let text = '';
      for (const part of (res.content || [])) {
        if (part && typeof part.text === 'string') text += part.text + '\n';
      }
      return { isError: !!res.isError, text: scrubText(text.trim()) };
    } catch (e) {
      return { isError: true, text: 'MCP call failed: ' + String((e && e.message) || e).slice(0, 200) };
    } finally {
      elicitPolicy = null;
      onMismatch = null;
    }
  });
}

// Enough to tell "MCP is up" from "MCP is configured but published nothing"
// without listing the tools themselves.
function status() {
  return { tools: state.tools.length, writeTools: !!state.writeToolsEnabled };
}

module.exports = { init, closeAll, getFunctionTools, isMcpToolName, isWriteTool, callTool, hashPreview, parseTomlConfig, status };
