# dsh-agent-bridge: merge, easy install, and live rollout

Author: Claude Code (external reviewer), 2026-11-17. Executor: the DSH bridge session (session-f1b3805c…, cwd C:\Dev\DSHAgentBridge).
**Start condition:** the TurboMCP session (session-65d391a4…) has finished Task A. It uses the live bridge, and a DSH restart would cut it off.

## What I found about installing (read-only)

- `dsh plugin` passes its arguments straight to **pnpm** in `~/.dsh/profiles/<profile>`. The DSH CLI is 0.2.2-rc.1. Any pnpm spec works:
  - `github:FloStyle/dsh-agent-bridge#v0.6.1`
  - a release tarball URL
  - an npm name
  - `file:`
  Your profile already installs `@dsh-external/donsetch` with a `github:` spec.
- The live install is `"dsh-agent-bridge": "file:C:/Users/flost/Documents/Codex/2026-11-05/j-ai/outputs/DSH-Agent-Bridge/plugins/dsh-agent-bridge"`. That is version 0.4.1, from an old copy that is not the git repo. `dsh-agent-bridge` is also listed in `dsh.profile.bundles` in the profile's package.json.
- `scripts/install.ps1` (PR #1) has two problems:
  1. It **removes the plugin before it adds the new one**. If `add` fails, the bridge is gone and every agent that uses it loses access.
  2. It says "pass -Force to rotate" the token, but `-Force` only hides that message and rotates nothing.
- `scripts/install.ps1` and `scripts/install.sh` only support installing from a local clone (`file:`). That is fine for development, but other DSH users need a one-line install.

## Stage 1: merge 0.6.0 (bridge session)

1. Merge PR #1 into main with a merge commit.
2. Retarget PR #2 to main and check that its diff contains only Phase 2. Wait for CI 4/4, then merge it with a merge commit.
3. No squash, no `--admin`, no force-push. Do not tag yet.

## Stage 2: make installation easy (PR #3, version 0.6.1)

| # | Change | Done when |
|---|---|---|
| I1 | **Release workflow:** on a `v*` tag, run `node --test` on Windows and Ubuntu, then `npm pack`. Attach `dsh-agent-bridge-<v>.tgz` and its SHA-256 to a GitHub release. | A tag produces a release with the tarball and hash. |
| I2 | **One-line install in the README**, the first thing a user sees: `dsh plugin add github:FloStyle/dsh-agent-bridge#v0.6.1`, with the tarball URL as the alternative. Install from a local clone is the dev path. | A fresh profile installs from the line as written. |
| I3 | **`install.ps1` and `install.sh` take `-Source release\|github\|local` and `-Version`** (default: the latest release). | They are safe: <ul><li>Back up the profile's `package.json` and `pnpm-lock.yaml` first.</li><li>Add the new spec before anything is removed. pnpm replaces the dependency in place.</li><li>On failure, restore the backup and exit non-zero.</li><li>Never print the token.</li><li>Fix or remove the `-Force` rotation claim.</li></ul> |
| I4 | **Enablement check:** after `add`, confirm `dsh-agent-bridge` is in `dsh.profile.bundles`. If DSH does not add it itself, the script adds it. Document which case is true. | Tested on a scratch profile (`--profile bridge-test`), never on `desktop`. |
| I5 | **`scripts/doctor.mjs`** checks: <ul><li>the DSH CLI version</li><li>the installed plugin version against the repo or release</li><li>that the state file exists and the port answers `/health`</li><li>that the `version` and `protocol` in `/health` match the MCP client</li><li>that the cordis services the plugin injects exist</li></ul> It prints a clear fix for each failure. | It runs against the live 0.4.1 bridge and reports "outdated: 0.4.1 < 0.6.1" without changing anything. |
| I6 | **Client setup for any MCP client:** keep `connect-claude-code.ps1`/`.sh`. Add a README section with ready configs for Claude Code (`claude mcp add`), Codex and Cursor-style JSON. Each points at `node <profile>/node_modules/dsh-agent-bridge/mcp/mcp.mjs`. Add an option to read the URL and token from the state file, so no token is ever pasted. | Each config is copied from a real run, not invented. |
| I7 | **Compatibility:** declare the supported DSH range in package.json, for example `"dsh": { "engine": ">=0.2.2" }` if DSH reads such a field. Otherwise document it. If an injected service is missing, the plugin logs one clear line naming the missing service. | A test with a fake ctx that lacks `typertGateway` shows the message. |
| I8 | **`scripts/uninstall.ps1`/`.sh`:** remove the plugin. Ask before deleting the state and audit files. | — |

**Test every script on a scratch profile.** Never touch `desktop` before Stage 4.
After PR #3 is merged: tag `v0.6.1`, then check that the release has the tarball and its SHA-256.

## Stage 3: upgrade DeepSeek Harness (owner)

1. The bridge session backs up `~/.dsh/profiles/desktop/{package.json,pnpm-lock.yaml,cordis.yml,cordis.patch.yml}` and `~/.dsh/agent-bridge.json` to a dated folder. It reports the path and does not print the token.
2. **The owner** upgrades DeepSeek Harness, while no session is working.
3. After the upgrade, before reinstalling, record:
   - the new `dsh --version`
   - whether the profile's package.json and bundles survived
   - whether the old 0.4.1 bridge still answers `/health`

## Stage 4: install 0.6.1 on the live profile

1. Run `scripts/install.ps1 -Source release -Version 0.6.1 -Profile desktop`. The token stays the same.
2. **The owner** restarts DSH.
3. **Rollback, ready before step 1:** `dsh plugin --profile desktop add "file:C:/Users/flost/Documents/Codex/2026-11-05/j-ai/outputs/DSH-Agent-Bridge/plugins/dsh-agent-bridge"`, then restart. Or restore the Stage 3 backup.

## Stage 5: live verification (the items not verified so far)

After the restart, in a new turn, check each item and record the evidence. Claude Code checks them too, through the bridge.

| Check | Expected |
|---|---|
| `GET /health` | `version: 0.6.1`, `protocol: 1`, a `bootId`, the same port 7788 |
| Token unchanged | Existing clients (Claude Code) still authenticate |
| Send, then wait at once (C1 live) | The wait returns the new turn, not the previous one |
| Provenance on a real DSH turn | The transcript shows `role: agent-bridge` with the agent name. A message typed by hand with the header stays `user`. |
| `followup` mode on a real DSH | Accepted. If DSH rejects it, map it to DSH's `queue` and report. |
| `pending-input` | A real approval or question in a test session emits `pending-input` and clears it. The deprecated alias is also sent. |
| Audit log | Accepted, refused and busy entries appear in `~/.dsh/agent-bridge-audit.jsonl`, with hash and length only |
| MCP | Claude Code connects through the I6 setup and lists, reads, sends and waits on a scratch session |
| `scripts/doctor.mjs` | Everything is green |

Use a dedicated scratch session for the tests. Never use the TurboMCP session or other live work.

## Rules (unchanged)

- Loopback only. The bridge never approves permissions. No remote proxy.
- Never print or commit the token.
- The owner restarts DSH and upgrades it. The agent never kills the DSH process.
- No force-push. No direct changes to `desktop` before Stage 4.
- Report each stage with links, SHAs, test output, and anything not verified.
