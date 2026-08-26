# Security

`codex-hop` is an unofficial local proxy. It sits on the path of every request your
Codex client makes. This document states plainly what it protects against, what it
does not, and where your data goes.

## Reporting

Open a GitHub issue for anything non-sensitive. For something you would rather not
post publicly, open an issue asking for a contact channel without details.

## Where data goes

- **To OpenAI** — every request your client already makes, relayed byte-for-byte when
  the router has not modified it.
- **To your chosen external provider (DeepSeek)** — only on a `/dsk` turn, and then the
  whole thread: message history, system instructions, tool declarations and tool
  results. This is not a summary; the full context is re-sent every turn.
- **To MCP servers** — only tools you explicitly allow-listed, only when MCP is
  enabled, and only the arguments the model passes.
- **Stored locally** — provider choice per thread, in the data directory. No prompts,
  no responses, no tool results.

## Threat model

**Protected against**

- Requests from a web page. The router binds to loopback only, checks `Host`, and
  rejects browser-originated requests. A page cannot reach it.
- Credential crossing. Keys are attached per destination: the OpenAI session is never
  offered to the external provider, the provider key is never offered to OpenAI or to
  an MCP subprocess.
- Accidental secret leakage through tool output. Environment values whose names look
  like secrets are scrubbed from MCP results before they leave the process.
- Log leakage. Normal logs carry metadata only: route, status, sizes, timings, header
  *names*. Never bodies, prompts, responses or tool results.

**Not protected against**

- A process running as you on the same machine. It can read your Codex config, your
  environment and the data directory. Anything the router knows, that process already
  knows. Loopback is a boundary against the network, not against yourself.
- A malicious or compromised MCP server. A minimal environment reduces what a
  subprocess inherits; it is not a sandbox. The subprocess runs with your file
  permissions.
- A hostile Codex client build. The router trusts the client it proxies for.

## Design choices worth knowing

- **The router never executes shell commands itself.** Commands the model asks for run
  inside the client's own sandbox, under the client's own approval flow. Routing a
  provider switch must not become a way around that.
- **Write-capable MCP tools are disabled by default.** When enabled, the default is a
  two-phase handshake: the router declines the server's confirmation on the first
  pass, shows you the exact preview, and performs the write only after you type
  `/send-ok` and the preview hash still matches.
- **Debug logging is opt-in and announces itself.** Set `CODEX_HOP_DEBUG_CONTENT=1`
  and the router prints a warning at startup; with it on, logs contain conversation
  content. Do not attach a debug log to a public issue without reading it
  first.

## Not affiliated with OpenAI

`codex-hop` is an independent project. It is not affiliated with, endorsed by, or
supported by OpenAI. It depends on the internal behaviour of a client it does not
control, and a client update can break it at any time.
