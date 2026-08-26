# codex-hop

**Unofficial. Not affiliated with, endorsed by, or supported by OpenAI.**

Switch a Codex thread between OpenAI and DeepSeek without leaving it. Type `/dsk` and
the rest of that thread is answered by DeepSeek — same conversation, same files, same
tools. `/gpt` switches back. Useful when your usage limit runs out mid-task.

```
you   ▸ /dsk finish the migration script
        ↳ answered by DeepSeek, same thread, same files, same tools
you   ▸ /gpt now review what you just wrote
        ↳ back on OpenAI, history intact
```

`codex-hop` is a small local proxy between your Codex client and its backend. It
relays everything untouched and only steps in when a message starts with a marker.

---

## Before you install: where your data goes

On a `/dsk` turn the router sends your **entire thread** to DeepSeek — message
history, system instructions, tool declarations and tool results. Not a summary. The
full context, re-sent on every turn.

Nothing is stored beyond a per-thread provider choice. No prompts, no responses and
no tool results are written to disk or to logs unless you set
`CODEX_HOP_DEBUG_CONTENT=1`, which the router warns about at startup. See
[SECURITY.md](SECURITY.md).

If sending your thread to a second provider is not acceptable for your work, this
tool is not for that work.

---

## If something goes wrong

The router sits on the path of every Codex request. If it stops, Codex stops with it.
The escape hatch is one line — remove this from your Codex config and restart Codex:

```toml
openai_base_url = "http://127.0.0.1:8788"
```

---

## Install

Requires **Node 22.15+**.

```bash
git clone https://github.com/dmitry-dmt/codex-hop
cd codex-hop
npm install
```

Point Codex at the router by adding one line to `~/.codex/config.toml`
(Windows: `%USERPROFILE%\.codex\config.toml`):

```toml
openai_base_url = "http://127.0.0.1:8788"
```

On Windows a script can do that for you. It takes a timestamped backup, shows the
change before making it, and refuses to guess if the file is ambiguous:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
```

Then set your key, start the router, and **fully restart Codex**:

```bash
DEEPSEEK_API_KEY=sk-... npm start
```

No service, no autostart, nothing running in the background. To undo:
`powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1`, which restores your
previous setting only if it still points at a local router.

---

## Commands

Type these at the start of a message in any Codex thread.

| Command | Effect |
| --- | --- |
| `/dsk <task>` | Switch this thread to DeepSeek and do the task |
| `/dsk high` / `/dsk max` | Switch and set reasoning effort |
| `/dsk force <task>` | Proceed even if the thread is over the size guard |
| `/gpt <task>` | Switch back to OpenAI |
| `/mode` | Show the current provider — answered locally, no upstream call |
| `/send-ok` | Confirm a pending write-capable MCP call |

`/dsk low` is not an effort level — `low` is read as the task text.

---

## Tools

Your tools keep working on the other provider, including shell. Commands run in the
client's own sandbox under the client's own approval flow — **the router never
executes shell itself.**

---

## When the limit hits

An exhausted OpenAI limit is reported in the chat with its reset time, instead of
arriving as a broken stream:

> OpenAI usage limit reached, it resets in about 96 min. Type `/dsk` to keep working
> in this thread on DeepSeek.

---

## Long threads

Codex re-sends the whole thread on every turn. Past a few megabytes DeepSeek gets
slow and noticeably worse, so the router refuses rather than let you wait for a bad
answer:

> History in this thread is about 6.2 MB. DeepSeek will be slow and noticeably worse.
> Compact the thread or start a new one. To proceed anyway, type `/dsk force`.

Nothing is truncated and no context is silently dropped. Switch to `/dsk` at the
start of a task rather than at the end of a long thread.

---

## MCP (optional, off by default)

If you have MCP servers configured for Codex, the router can run them on behalf of
the external model.

Read-only by default. A tool is published only if it is in your allow-list **and**
the server reports `annotations.readOnlyHint === true`. Write-capable tools are a
separate opt-in, guarded by a preview plus `/send-ok` confirmation.

Copy [`examples/config.example.json`](examples/config.example.json) into the data
directory as `config.json` to enable it.

---

## What it does not do

- **Execute shell itself.** Commands run in the client's sandbox, under its approvals.
- **Carry reasoning across providers.** Messages, tool calls and tool results cross;
  reasoning does not.
- **Save tokens.** It saves money and quota. The context is the same size.
- **Guarantee it keeps working.** It depends on internal client behaviour, and a
  client update can break it.
- **macOS or Linux.** Untested there.

## Limitations

- Compaction runs on OpenAI. If your OpenAI limit is exhausted *and* the thread is
  large enough to need compacting, that thread waits for the reset.
- Windows only. Tested against Codex Desktop client 0.149.0.

---

## License

MIT. See [LICENSE](LICENSE).
