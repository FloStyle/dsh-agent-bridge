# Changelog

## 0.6.2

- R1.1 `turn-end` reports `turn`, `reason` (`completed` / `cancelled` / `error`), `reasonKind` and only that turn's text, so a cancelled turn no longer shows the previous answer. `dsh_wait` returns `cancelled: true`.
- R1.2 `dsh_wait` with a cursor stops when its session starts waiting for a human (approval or question) instead of hanging until the timeout.
- R1.3 `follow()` retries only network errors; a 4xx is reported by name. `dsh_wait` surfaces it, and `watch.mjs` exits 2 on an auth failure.
- R1.4 The MCP server warns on stderr when `DSH_AGENT_NAME` is unset, `/health` reports `defaultAgentSeen`, and `doctor` warns with a fix line.
- R1.5 `doctor` lists every plugin DSH refuses for this runtime with the `dsh plugin allow-version …` hint.
- R1.6 The token lives in a private `agent-bridge.token` file. A failed listen writes `{stale: true, error}` with no token, the MCP client refuses it, and `doctor` fails with a fix line. Existing state files are migrated without rotating the token.
- R1.7 `install.ps1` parses under Windows PowerShell 5.1, failed cancels are audited, and unauthenticated requests are logged as `unauthorized` with no agent name.
- Review F1: a bridge that cannot listen leaves the state file alone when it belongs to another live bridge on the same port. Only a port held by something else gets the stale marker.
- Review F2: the state file keeps a deprecated `token` copy (`tokenDeprecated: true`) so 0.6.1 MCP clients that are already running keep working after the upgrade. Protocol 2 (0.7.0) removes it. A stale marker never carries it.
- Review F3: `turn-end` `reason` is `incomplete` for `max-tokens`, `blocked`, `forked` and unknown kinds, instead of `completed`. `dsh_wait` returns `incomplete: true` for them.
- Review N2, N3: `defaultAgentSeen` counts only authenticated requests. On pending input, `dsh_wait` returns the kinds as `pendingKinds` and keeps `pendingInput` from the session state.

## 0.6.1

- One-line install (`dsh plugin add github:FloStyle/dsh-agent-bridge#v0.6.1`), release workflow with tarball and SHA-256, `doctor`, `uninstall`, client setup for Claude Code, Codex and `mcpServers` clients, DSH version range, uninstalled-service warning.
