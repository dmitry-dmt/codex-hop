# Contributing

`codex-hop` depends on internal Codex client behavior, so a small, reproducible change is more useful than a broad refactor.

## Before opening an issue

- Check that the problem reproduces on the current `main` branch.
- Record the Codex client, Node.js, and Windows versions.
- Remove prompts, responses, tool results, credentials, thread identifiers, usernames, and local paths from anything you share.
- Do not post debug output without reviewing every line first.

## Pull requests

1. Keep the change focused and explain the observed behavior it addresses.
2. Add or update a regression test.
3. Run `npm ci` and `npm test`.
4. Update README or SECURITY when data flow, persistence, commands, or trust boundaries change.

The project intentionally keeps shell execution in the Codex client sandbox and does not store conversation content on disk. Changes that weaken either boundary will not be accepted.

