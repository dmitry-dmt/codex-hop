'use strict';
// Tests cover what the router *changes* about a request. The relay path itself
// is deliberately not re-tested here: it is byte-faithful by construction and
// exercised continuously in real use.
const test = require('node:test');
const assert = require('node:assert');

process.env.CODEX_HOP_DATA = process.env.CODEX_HOP_DATA ||
  require('node:path').join(require('node:os').tmpdir(), 'codex-hop-test');

const R = require('../src/router.js');

// --------------------------------------------------------------- marker grammar
test('marker grammar', async (t) => {
  const cases = [
    // [input, expected command, expected modifier]
    ['/dsk\n', 'dsk', null],
    ['/dsk \n', 'dsk', null],
    // The Desktop composer escapes a trailing space as a literal entity.
    ['/dsk&#x20;\n', 'dsk', null],
    ['/dsk&#32;\n', 'dsk', null],
    ['/dsk&nbsp;\n', 'dsk', null],
    ['/dsk high\n', 'dsk', 'high'],
    ['/dsk&#x20;high\n', 'dsk', 'high'],
    ['/dsk high&#x20;\n', 'dsk', 'high'],
    ['/dsk max\n', 'dsk', 'max'],
    ['/dsk force\n', 'dsk', 'force'],
    ['/dsk fix the parser\n', 'dsk', null],
    // "low" is a one-word task, not a bad modifier: the two are indistinguishable.
    ['/dsk low\n', 'dsk', null],
    ['/gpt\n', 'gpt', null],
    ['/mode\n', 'mode', null],
    ['/send-ok\n', 'send-ok', null],
    // Negatives.
    ['/dsx\n', null, null],
    ['/gptx\n', null, null],
    ['hello /dsk\n', null, null],
    ['  /dsk\n', 'dsk', null],
  ];
  for (const [input, cmd, arg] of cases) {
    await t.test(JSON.stringify(input), () => {
      const m = R.MARKER_RE.exec(input);
      assert.strictEqual(m ? m[1] : null, cmd);
      assert.strictEqual(m ? (m[2] || null) : null, arg);
    });
  }
});

test('marker is read after the attached-files wrapper', () => {
  const wrapped =
    '# Files mentioned by the user:\n## a.txt: /tmp/a.txt\n## My request:\n/dsk summarise it\n';
  const body = { input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: wrapped }] }] };
  const m = R.findMarker(body);
  assert.ok(m, 'marker must be found after the wrapper');
  assert.strictEqual(m.cmd, 'dsk');
});

test('file contents are never read as a command', () => {
  const wrapped =
    '# Files mentioned by the user:\n## notes.md: /tmp/notes.md\n/dsk this line lives inside the file list\n## My request:\nplease continue\n';
  const body = { input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: wrapped }] }] };
  assert.strictEqual(R.findMarker(body), null);
});

test('marker is stripped from every user message, not just the last', () => {
  const mk = (text) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
  const body = { input: [mk('/dsk first\n'), mk('/dsk second\n')] };
  R.stripAllMarkers(body);
  for (const it of body.input) {
    assert.ok(!/^\s*\/dsk/.test(it.content[0].text), 'marker left behind: ' + it.content[0].text);
  }
});

// --------------------------------------------------------- history normalisation
function bodyWith(input) {
  return { model: 'gpt-x', stream: true, input, tools: [] };
}

test('items the external provider cannot read are removed', () => {
  const out = R.normalizeToDS(bodyWith([
    { type: 'additional_tools', role: 'developer', tools: [{ name: 'exec', type: 'custom' }] },
    { type: 'reasoning', encrypted_content: 'opaque-openai-blob' },
    { type: 'compaction', id: 'cmp_1', encrypted_content: 'opaque-openai-blob' },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
  ]), 'high');

  const types = out.input.map((i) => i.type);
  assert.ok(!types.includes('additional_tools'), 'additional_tools must not reach the provider');
  assert.ok(!types.includes('reasoning'), 'encrypted reasoning must not reach the provider');
  assert.ok(!types.includes('compaction'), 'encrypted compaction must not reach the provider');
  assert.ok(types.includes('message'), 'the actual conversation must survive');
});

test('plaintext reasoning is preserved', () => {
  // DeepSeek 400s when its own intermediate reasoning is missing from history.
  const out = R.normalizeToDS(bodyWith([
    { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'thinking' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
  ]), 'high');
  assert.ok(out.input.some((i) => i.type === 'reasoning'), 'plaintext reasoning must survive');
});

test('unpaired tool calls are dropped in both directions', () => {
  // An unanswered call, or an answer with no call, makes the provider reject the
  // whole request.
  const out = R.normalizeToDS(bodyWith([
    { type: 'function_call', call_id: 'a', name: 'wait', arguments: '{}' },
    { type: 'function_call_output', call_id: 'a', output: 'ok' },
    { type: 'function_call', call_id: 'orphan-call', name: 'wait', arguments: '{}' },
    { type: 'function_call_output', call_id: 'orphan-output', output: 'ok' },
  ]), 'high');

  const ids = out.input.map((i) => i.call_id);
  assert.ok(ids.includes('a'), 'the paired call must survive');
  assert.ok(!ids.includes('orphan-call'), 'call without an answer must be dropped');
  assert.ok(!ids.includes('orphan-output'), 'answer without a call must be dropped');
});

test('backend-only fields are removed', () => {
  const b = bodyWith([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x' }] }]);
  Object.assign(b, {
    previous_response_id: 'resp_1', store: true, prompt_cache_key: 'k',
    metadata: { a: 1 }, include: ['x'], stream_options: { a: 1 }, lite: true,
  });
  const out = R.normalizeToDS(b, 'high');
  for (const key of ['previous_response_id', 'store', 'prompt_cache_key', 'metadata', 'include', 'stream_options', 'lite']) {
    assert.ok(!(key in out), key + ' must not be forwarded');
  }
});

test('normalisation does not mutate the caller body', () => {
  const b = bodyWith([{ type: 'additional_tools', role: 'developer', tools: [] }]);
  R.normalizeToDS(b, 'high');
  assert.strictEqual(b.input.length, 1, 'the original request must be untouched');
});

// ------------------------------------------------------------------- tool surface
test('the client tool declaration is what drives the surface', () => {
  const declared = R.collectClientTools([
    { type: 'additional_tools', role: 'developer', tools: [
      { name: 'exec', type: 'custom', description: 'run javascript' },
      { name: 'wait', type: 'function', parameters: { type: 'object', properties: {} } },
    ] },
  ]);
  const names = (declared.tools || []).map((t) => t.name);
  assert.ok(names.includes('exec'), 'exec must be picked up from the declaration');
  assert.ok(names.includes('wait'), 'wait must be picked up from the declaration');
});

test('a freeform tool becomes a callable function for the provider', () => {
  const t = R.toDSTool({ name: 'exec', type: 'custom', description: 'run javascript' });
  assert.strictEqual(t.type, 'function');
  assert.strictEqual(t.name, 'exec');
  assert.ok(t.parameters && t.parameters.properties, 'a schema is required for a function tool');
});

// ------------------------------------------------------------- privacy and errors
test('thread labels are stable and do not contain the raw id', () => {
  const id = '01a027ce-dead-beef-0000-000000000000';
  const a = R.threadKey(id);
  assert.strictEqual(a, R.threadKey(id), 'the label must be stable');
  assert.ok(!a.includes('01a027ce'), 'the raw id must not survive in the label');
  assert.notStrictEqual(a, R.threadKey(id + 'x'), 'different threads must differ');
});

test('provider failures produce something a user can act on', () => {
  const missing = R.dsErrorMessage({ status: 0, error: 'DEEPSEEK_API_KEY missing' }, 502);
  assert.match(missing, /DEEPSEEK_API_KEY/, 'must name the variable to set');

  assert.match(R.dsErrorMessage({ status: 401 }, 401), /401/);
  assert.match(R.dsErrorMessage({ status: 402 }, 402), /402/);
  assert.match(R.dsErrorMessage({ status: 429 }, 429), /429/);

  // A long upstream body must never be echoed wholesale into the chat.
  const noisy = R.dsErrorMessage({ status: 400, errorBody: 'x'.repeat(5000) }, 400);
  assert.ok(noisy.length < 600, 'error detail must be trimmed, got ' + noisy.length);
});

// ------------------------------------------------------------------- compaction
test('a compaction request is recognised, an ordinary turn is not', () => {
  const compact = {
    stream: false,
    reasoning: { context: 'all_turns' },
    input: [{ type: 'compaction_trigger' }],
  };
  assert.strictEqual(R.isCompactionRequest(compact), true);

  // A normal agentic turn also carries reasoning.context and ends on a tool
  // result; without the stream check it would be misread as a compaction.
  const ordinary = {
    stream: true,
    reasoning: { context: 'all_turns' },
    input: [{ type: 'function_call_output', call_id: 'a', output: 'ok' }],
  };
  assert.strictEqual(R.isCompactionRequest(ordinary), false);
});

// ------------------------------------------------------------- request guards
test('page-driven requests are recognised', () => {
  // The Codex client sets none of these; a browser always sets some.
  assert.strictEqual(R.isBrowserOriginated({ headers: { origin: 'https://evil.example' } }), true);
  assert.strictEqual(R.isBrowserOriginated({ headers: { 'sec-fetch-site': 'cross-site' } }), true);
  assert.strictEqual(R.isBrowserOriginated({ headers: { 'sec-fetch-mode': 'cors' } }), true);
  assert.strictEqual(R.isBrowserOriginated({ headers: { 'user-agent': 'codex/0.149.0' } }), false);
});

test('only loopback hosts are accepted', () => {
  assert.strictEqual(R.isLoopbackHost({ headers: { host: '127.0.0.1:8788' } }), true);
  assert.strictEqual(R.isLoopbackHost({ headers: { host: 'localhost:8788' } }), true);
  assert.strictEqual(R.isLoopbackHost({ headers: { host: 'evil.example' } }), false);
  // DNS rebinding resolves to loopback but keeps the attacker's Host header.
  assert.strictEqual(R.isLoopbackHost({ headers: { host: 'rebind.attacker.test:8788' } }), false);
});

test('thread ids are validated, never bucketed', () => {
  const good = '01a027ce-7a87-7b61-9e53-a69a55a04009';
  assert.strictEqual(R.readThreadId({ headers: { 'thread-id': good } }), good);
  assert.strictEqual(R.readThreadId({ headers: { 'session-id': good } }), good, 'session-id is the fallback');

  // Missing must not resolve to a shared key: two threads would share state.
  assert.strictEqual(R.readThreadId({ headers: {} }), null);
  // Path traversal must not reach a file name.
  assert.strictEqual(R.readThreadId({ headers: { 'thread-id': '../../etc/passwd' } }), null);
  assert.strictEqual(R.readThreadId({ headers: { 'thread-id': 'a/../../b' } }), null);
  assert.strictEqual(R.readThreadId({ headers: { 'thread-id': 'x'.repeat(500) } }), null);
  assert.strictEqual(R.readThreadId({ headers: { 'thread-id': 'short' } }), null);
});

// ------------------------------------------------------- write confirmation
test('write confirmation is required unless explicitly disabled', () => {
  // The safety default must not depend on remembering a second config key: a
  // config that enables write tools but omits this one used to perform writes
  // with no confirmation at all.
  const required = (cfg) => !cfg || cfg.requireConfirmation !== false;
  assert.strictEqual(required({}), true, 'missing key must still require confirmation');
  assert.strictEqual(required({ writeTools: { enabled: true, tools: ['x'] } }), true,
    'enabling write tools alone must not disable confirmation');
  assert.strictEqual(required({ requireConfirmation: true }), true);
  assert.strictEqual(required({ requireConfirmation: false }), false,
    'only an explicit false turns it off');
});

test('all project-facing text is English-only', () => {
  const CYRILLIC = /[\u0400-\u04FF]/;
  const samples = [
    R.dsErrorMessage({ status: 0, error: 'DEEPSEEK_API_KEY missing' }, 502),
    R.dsErrorMessage({ status: 401 }, 401),
    R.dsErrorMessage({ status: 402 }, 402),
    R.dsErrorMessage({ status: 429 }, 429),
    R.dsErrorMessage({ status: 400, errorBody: 'bad request' }, 400),
  ];
  for (const s of samples) {
    assert.ok(!CYRILLIC.test(s), 'non-English text reached the user: ' + s.slice(0, 60));
  }

  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const textExtensions = new Set(['.js', '.json', '.md', '.ps1', '.yml', '.yaml', '.svg']);
  const offenders = [];
  function scan(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { scan(file); continue; }
      if (!textExtensions.has(path.extname(entry.name).toLowerCase())) continue;
      const text = fs.readFileSync(file, 'utf8');
      if (CYRILLIC.test(text)) offenders.push(path.relative(root, file));
    }
  }
  scan(root);
  assert.deepStrictEqual(offenders, [],
    'project-facing text must remain English-only: ' + offenders.join(', '));
});

test('conversation content is not logged unless explicitly asked for', () => {
  // SECURITY.md states that normal logs carry metadata only. This keeps the
  // code and that promise from drifting apart.
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'router.js'), 'utf8');
  const line = src.split('\n').find((l) => l.includes("'USER-TEXT '"));
  assert.ok(line, 'the user-text log line should still exist, behind a flag');
  assert.match(line, /if \(DEBUG_CONTENT\)/,
    'user text must only be logged when content logging is explicitly enabled');
  assert.match(src, /const DEBUG_CONTENT = process\.env\.CODEX_HOP_DEBUG_CONTENT === '1'/,
    'the flag must default to off');
});

test('a config file with a BOM is still read', () => {
  // PowerShell's Set-Content and most Windows editors write UTF-8 with a BOM by
  // default, and JSON.parse rejects it. Without this the config silently does
  // nothing and MCP never appears, with no obvious cause.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hop-bom-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '﻿' + JSON.stringify({ maxMcpIterations: 4 }), 'utf8');

  const raw = fs.readFileSync(file, 'utf8');
  assert.throws(() => JSON.parse(raw), 'the fixture must actually carry a BOM');
  assert.doesNotThrow(() => JSON.parse(raw.replace(/^﻿/, '')),
    'stripping the BOM must make it parseable');

  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'router.js'), 'utf8');
  assert.match(src, /readJsonFile[\s\S]{0,200}replace\(\/\^\uFEFF\/, ''\)/,
    'the router must strip a BOM before parsing its config');
});

test('no log line carries a raw thread id', () => {
  // SECURITY.md states thread ids are hashed before reaching logs. A truncated
  // prefix is still the real id, and it survived one earlier sweep by being
  // written in a different shape.
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'router.js'), 'utf8');
  const offenders = src.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /threadId[^)]*\)?\.slice\(0,\s*\d+\)/.test(l));
  assert.deepStrictEqual(offenders, [],
    'raw thread id reaches a log line: ' + JSON.stringify(offenders));
});

test('the command surface is exactly what the README lists', async (t) => {
  const mk = (text) => ({ input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }] });
  const cases = [
    ['/dsk\n', 'dsk', null],
    ['/dsk finish the migration\n', 'dsk', null],
    ['/dsk high check the tests\n', 'dsk', 'high'],
    ['/dsk force\n', 'dsk', 'force'],
    ['/dsk&#x20;\n', 'dsk', null],
    ['/gpt\n', 'gpt', null],
    ['/mode\n', 'mode', null],
    ['/send-ok\n', 'send-ok', null],
    // Nothing beyond that: an undocumented command is surface nobody audits.
    ['/gptk\n', null, null],
    ['/ds\n', null, null],
    ['/dskx\n', null, null],
  ];
  for (const [input, cmd, arg] of cases) {
    await t.test(JSON.stringify(input), () => {
      const m = R.findMarker(mk(input));
      assert.strictEqual(m ? m.cmd : null, cmd);
      assert.strictEqual(m ? (m.arg || null) : null, arg);
    });
  }
});

test('the alias is stripped whole, leaving no stray letter', () => {
  const mk = (text) => ({ input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }] });
  const body = mk('/dsk finish the migration\n');
  R.stripAllMarkers(body);
  const left = body.input[0].content[0].text;
  assert.ok(!/^\s*k/.test(left), 'a stray "k" was left at the head of the task: ' + JSON.stringify(left));
  assert.match(left, /finish the migration/);
});


test('nothing conversation-derived is written to disk', () => {
  // The README promises that only a per-thread provider choice is stored. This
  // keeps that promise checkable rather than aspirational.
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'router.js'), 'utf8');

  const writes = src.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /fs\.(writeFileSync|appendFileSync|createWriteStream)\(/.test(l));

  assert.strictEqual(writes.length, 1,
    'exactly one write site is expected, found: ' + JSON.stringify(writes));
  assert.match(writes[0][1], /STATE_FILE/,
    'the only file written must be the thread-state file');

  // And that file must not be keyed by a real thread id.
  assert.match(src, /const key = threadKey\(threadId\)/,
    'thread state must be keyed by the hash, not the raw id');
});

test('intermediate provider history is scoped to one DS turn', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'router.js'), 'utf8');
  const start = src.indexOf('async function handleDSTurn');
  const end = src.indexOf('// ---------------------------------------------------------------- DS compaction', start);
  assert.ok(start >= 0 && end > start, 'handleDSTurn must be present');

  const turn = src.slice(start, end);
  assert.match(turn, /const priv = \{ items: \[\] \}/,
    'intermediate history must be local to handleDSTurn');
  assert.doesNotMatch(src, /privateHistory|loadPrivate|savePrivate|clearPrivate/,
    'conversation-derived history must not survive in process-global state');
});

// --------------------------------------------------- model reported by /mode
// The client can change the model in its own UI between turns, without any
// marker for the router to notice. A synthetic answer that names a compiled-in
// default instead of the live one tells the user something untrue.
test('synthetic answers name the model the client is actually on', async (t) => {
  await t.test('the live request body wins over anything stored', () => {
    const rec = { provider: 'openai', model: 'gpt-5.6-luna', last_openai_model: 'gpt-5.6-luna' };
    assert.strictEqual(R.synthModel(rec, { model: 'gpt-5.6-sol' }), 'gpt-5.6-sol');
  });

  await t.test('the DeepSeek leg reports what the router substitutes', () => {
    const rec = { provider: 'deepseek', model: 'deepseek-v4-flash' };
    // The body still carries the client's own model: it is the one being replaced.
    assert.strictEqual(R.synthModel(rec, { model: 'gpt-5.6-sol' }), 'deepseek-v4-flash');
  });

  await t.test('a body without a usable model falls back, newest first', () => {
    const rec = { provider: 'openai', model: 'gpt-5.6-luna', last_openai_model: 'gpt-5.6-sol' };
    assert.strictEqual(R.synthModel(rec, {}), 'gpt-5.6-sol');
    assert.strictEqual(R.synthModel(rec, null), 'gpt-5.6-sol');
    assert.strictEqual(R.synthModel({ provider: 'openai', model: 'gpt-5.6-sol' }, {}), 'gpt-5.6-sol');
  });

  await t.test('the DeepSeek model is never reported as an OpenAI one', () => {
    const got = R.synthModel({ provider: 'openai' }, { model: 'deepseek-v4-flash' });
    assert.ok(got.startsWith('gpt-'), 'expected an OpenAI model, got ' + got);
  });

  await t.test('no synthetic path carries its own copy of the model name', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(require('node:path').join(__dirname, '..', 'src', 'router.js'), 'utf8');
    const literals = src.match(/'gpt-[^']*'/g) || [];
    assert.deepStrictEqual(literals.length, 1,
      'the default model name belongs in exactly one constant, found: ' + literals.join(', '));
  });
});

// ------------------------------------------------ the limit message the README shows
// The README quotes this message verbatim. Quoting it is only useful if the quote
// stays true, so the two are compared rather than trusted.
test('the limit message matches the one the README quotes', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

  const blocks = [];
  let cur = [];
  for (const line of readme.split('\n')) {
    if (line.startsWith('>')) cur.push(line.replace(/^>\s?/, ''));
    else { if (cur.length) blocks.push(cur.join(' ')); cur = []; }
  }
  if (cur.length) blocks.push(cur.join(' '));

  const norm = (s) => s.replace(/`/g, '').replace(/\s+/g, ' ').trim();
  const documented = blocks.map(norm).find((b) => b.includes('usage limit reached'));
  assert.ok(documented, 'the README no longer quotes the limit message');

  // 5760 s is the value that renders as the "96 min" the README shows.
  assert.strictEqual(norm(R.usageLimitMessage({ resets_in_seconds: 5760 })), documented);
});

test('no upstream field name leaks into a message the user reads', () => {
  const msg = R.usageLimitMessage({ resets_in_seconds: 5786 });
  assert.doesNotMatch(msg, /resets_in_seconds|error\.type|plan_type/,
    'a message shown in the chat must not carry raw fields from the upstream error');
});

// ------------------------------------------------------- /mode as a readiness check
// Typing /dsk into a router that cannot reach DeepSeek should not be how you find out
// the key is missing. /mode costs nothing to run and says so up front.
test('/mode reports readiness, not just the selection', async (t) => {
  await t.test('a configured router says what is ready', () => {
    const line = R.modeText({ provider: 'openai', effort: 'high' }, 'thread-1',
      { model: 'gpt-5.6-sol' }, { key: true, mcpTools: 27 });
    assert.match(line, /provider=openai/);
    assert.match(line, /model=gpt-5\.6-sol/);
    assert.match(line, /deepseek-key=set/);
    assert.match(line, /mcp-tools=27/);
  });

  await t.test('a missing key cannot be skimmed past', () => {
    const line = R.modeText({ provider: 'openai' }, 'thread-1', {}, { key: false, mcpTools: 0 });
    assert.match(line, /deepseek-key=MISSING/,
      'an absent key must not read like a present one');
  });

  await t.test('no raw thread id reaches the line', () => {
    const line = R.modeText({ provider: 'openai' }, 'my-secret-thread-id', {},
      { key: true, mcpTools: 3 });
    assert.doesNotMatch(line, /my-secret-thread-id/);
  });
});

test('the autostart scripts are readable by PowerShell 5.1', () => {
  // A .ps1 without a BOM is read as ANSI, so a non-ASCII byte becomes mojibake -
  // and one stray apostrophe out of it ends a string literal early.
  const fs = require('node:fs');
  const path = require('node:path');
  for (const name of ['service.ps1', 'autostart.ps1', 'setup.ps1', 'uninstall.ps1']) {
    const buf = fs.readFileSync(path.join(__dirname, '..', 'scripts', name));
    const bad = [...buf].findIndex((b) => b > 126);
    assert.strictEqual(bad, -1,
      name + ' has a non-ASCII byte at offset ' + bad);
  }
});
