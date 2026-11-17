# Changelog

## 0.6.2

- R1.1 `turn-end` reports `turn`, `reason` (`completed` / `cancelled` / `error`), `reasonKind` and only that turn's text, so a cancelled turn no longer shows the previous answer. `dsh_wait` returns `cancelled: true`.
- R1.2 `dsh_wait` with a cursor stops when its session starts waiting for a human (approval or question) instead of hanging until the timeout.
- R1.3 `follow()` retries only network errors; a 4xx is reported by name. `dsh_wait` surfaces it, and `watch.mjs` exits 2 on an auth failure.
- R1.4 The MCP server warns on stderr when `DSH_AGENT_NAME` is unset, `/health` reports `defaultAgentSeen`, and `doctor` warns with a fix line.
- R1.5 `doctor` lists every plugin DSH refuses for this runtime with the `dsh plugin allow-version …` hint.
- R1.6 The token lives in a private `agent-bridge.token` file. A failed listen writes `{stale: true, error}` with no token, the MCP client refuses it, and `doctor` fails with a fix line. Existing state files are migrated without rotating the token.
- R1.7 `install.ps1` parses under Windows PowerShell 5.1, failed cancels are audited, and unauthenticated requests are logged as `unauthorized` with no agent name.

## 0.6.1

- One-line install (`dsh plugin add github:FloStyle/dsh-agent-bridge#v0.6.1`), release workflow with tarball and SHA-256, `doctor`, `uninstall`, client setup for Claude Code, Codex and `mcpServers` clients, DSH version range, uninstalled-service warning.
