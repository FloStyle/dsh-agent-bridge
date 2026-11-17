# DSH Agent Bridge

Use DeepSeek Harness as a local agent from any MCP-compatible client. Includes a
DSH conversation tab, an authenticated HTTP API, SSE events and a dependency-free
stdio MCP client. No Claude or Codex subscription is required by this plugin;
DSH uses whichever model provider you configure.

## Install

Requires DeepSeek Harness **0.2.2-rc.1** to **0.3.0** and Node.js **22 or newer**
for the external MCP client. The plugin declares that range in `package.json`
(`engines.dsh` and `dsh.compatibility.dsh`).

One line, from the machine that runs DSH:

```sh
dsh plugin add github:FloStyle/dsh-agent-bridge#v0.6.1
```

Or the release tarball, if you prefer a pinned artifact:

```sh
dsh plugin add https://github.com/FloStyle/dsh-agent-bridge/releases/download/v0.6.1/dsh-agent-bridge-0.6.1.tgz
```

Both go through `pnpm` in the profile, so they work for any profile
(`dsh plugin --profile desktop add ...`). Restart DSH when no session is working,
then check what is live:

```sh
node "$HOME/.dsh/profiles/desktop/node_modules/dsh-agent-bridge/scripts/doctor.mjs"
```

The doctor is read-only: it checks the DSH CLI, the installed version, the state
file, `/health` (version, protocol, injected services) and the MCP entry, and
prints a fix line for each failure. `/health` reports `version`, `protocol`,
`bootId`, `startedAt`, `pid` and the injected-service check. Existing legacy Codex
bridges can coexist.

### Upgrade, rollback, uninstall

```powershell
./scripts/install.ps1 -Source release -Version 0.6.1 -Profile desktop
```

```sh
./scripts/install.sh --source release --version 0.6.1 --profile desktop
```

`-Source` / `--source` takes `release` (tarball, default), `github` (tag) or
`local` (this clone, for development); `-Version` / `--version` defaults to the
latest release. The script backs up `package.json`, `pnpm-lock.yaml` and the cordis
files to `~/.dsh/backups/<profile>-<timestamp>`, adds the new build **before**
anything is removed, and restores the backup if the install fails. It never reads
the bridge token. Rollback is copying that backup back and restarting DSH.

To remove the plugin, run `./scripts/uninstall.ps1` (or `uninstall.sh`). It asks
before deleting `~/.dsh/agent-bridge.json` and the audit log; `-Purge` / `--purge`
skips the question.

### Development

Install from a clone of this repository, not from a loose folder: DSH caches
plugin modules, so a copy on disk and the running plugin drift apart otherwise.

```sh
git clone https://github.com/FloStyle/dsh-agent-bridge.git
cd dsh-agent-bridge
./scripts/install.ps1 -Source local        # or: ./scripts/install.sh --source local
node scripts/health.mjs
```

## Connect an MCP client

The client reads the endpoint and generated bearer token from
`~/.dsh/agent-bridge.json`, so **no token appears in any of these configs**. This
file is **private runtime state**: never commit or share it.
`DSH_BRIDGE_STATE_FILE` optionally selects another private state file; set the same
path for DSH and the MCP client. `DSH_AGENT_NAME` is a display label, not an
identity or permission boundary.

Every config below uses the installed copy:
`~/.dsh/profiles/<profile>/node_modules/dsh-agent-bridge/mcp/mcp.mjs`. Replace
`desktop` with your profile and the home directory with yours.

### Claude Code

```sh
claude mcp add dsh-agent-bridge --env DSH_AGENT_NAME=claude-code -- node "$HOME/.dsh/profiles/desktop/node_modules/dsh-agent-bridge/mcp/mcp.mjs"
```

`scripts/connect-claude-code.ps1` and `scripts/connect-claude-code.sh` print the
same command with the right path; pass `-Execute` / `--execute` to run it.
Restart the client so it picks up the new server.

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.dsh-agent-bridge]
command = "node"
args = ["C:/Users/<you>/.dsh/profiles/desktop/node_modules/dsh-agent-bridge/mcp/mcp.mjs"]
env = { DSH_AGENT_NAME = "codex" }
```

### Cursor and other `mcpServers` clients

`~/.cursor/mcp.json` (the same shape works for any client that reads
`mcpServers`):

```json
{
  "mcpServers": {
    "dsh-agent-bridge": {
      "command": "node",
      "args": ["C:/Users/<you>/.dsh/profiles/desktop/node_modules/dsh-agent-bridge/mcp/mcp.mjs"],
      "env": { "DSH_AGENT_NAME": "cursor" }
    }
  }
}
```

Use forward slashes on Windows inside JSON and TOML. If your client runs under a
different user or `HOME`, set `DSH_BRIDGE_STATE_FILE` in `env` to the same path DSH
uses instead of relying on `~/.dsh/agent-bridge.json`.

For turn-end notifications without polling, run the watcher through Claude Code's
Monitor tool. It prints one line per notification on stdout:

```sh
node /absolute/path/to/dsh-agent-bridge/mcp/watch.mjs --session <full-session-id>
```

The MCP process must see the same `HOME` (or the same `DSH_BRIDGE_STATE_FILE`) as
DSH, otherwise it cannot read the endpoint and token.

| Tool | Purpose |
| --- | --- |
| `dsh_list` | List sessions |
| `dsh_workspaces` | List workspaces |
| `dsh_read` | Read a bounded transcript; accepts a unique session ID prefix |
| `dsh_send` | Create a session or send work to an existing session |
| `dsh_wait` | Wait for a turn to end or for pending user input |
| `dsh_cancel` | Cancel a turn |

The read-only tools carry `readOnlyHint: true`; `dsh_cancel` carries
`destructiveHint: true`. MCP clients use these hints for their own permission
prompts. That hint is advisory: the bridge itself still approves nothing.

For a new session, supply an **absolute, existing** `cwd` or a `workspace`.
Existing busy sessions reject ordinary prompts; `mode: "steer"` must be explicit.
Approval and question prompts remain under DSH's controls. The bridge never
approves them.

### Delegating a turn

`dsh_send` returns the cursor of the turn it started; hand both fields to
`dsh_wait` to wait for exactly that turn:

```jsonc
// dsh_send -> { "sessionId": "...", "requestId": "...", "eventId": 42, "bootId": "...", "accepted": true }
// then dsh_wait
{ "sessionId": "...", "since": 42, "bootId": "...", "timeoutSec": 600 }
```

Without `since`, `dsh_wait` keeps the older behaviour: it returns as soon as the
session looks idle, which right after a send can still be the previous turn. Use
the cursor whenever the result matters.

### Provenance

Every prompt the bridge sends starts with `[dsh-agent-bridge] from <agent>`, where
`<agent>` is the client's `DSH_AGENT_NAME` / `X-Agent-Name` label. The DSH
transcript and UI therefore show an external agent's message as such, and
`dsh_read` reports it with role `agent-bridge`.

Two limits matter:

- **The name is self-asserted.** `X-Agent-Name` is chosen by the client, so any
  holder of the token can claim any name. It is a display label, not an
  authorization boundary. Per-client identity is Phase 3 (scoped tokens, S2).
- **The role comes from DSH, not from the text.** DSH records the `requestId` the
  bridge minted as `source.rpcId` on the accepted message; the bridge shows role
  `agent-bridge` only for ids it minted in this process. A human who types the
  same header into the DSH window stays `user`. The id set is in memory, so after
  a DSH restart older bridged messages read as `user` with the header still
  visible in the text.

Leading copies of the bridge's own header are stripped from client text, so a
client cannot stack a forged one in front of its message. Other leading lines,
including bracketed labels such as `[WIP]`, are left untouched.

`node mcp/watch.mjs` prints completion, error and pending-input notifications.
`--session <full-id>` filters one session; `--all` also prints status and
user-message events. Its output may contain private session content: do not
publish captured output.

## HTTP API

Default listener: `127.0.0.1:7788` (configurable port in `cordis.patch.yml`). Every
request requires `Authorization: Bearer <runtime-token>`. Browser origins are
rejected; the UI uses DSH's own authenticated status route instead.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Build and process identity: version, protocol, bootId, startedAt, pid, clients, lastEventId, injected-service check |
| GET | `/sessions` | Session summaries |
| GET | `/sessions/:id?limit=40` | Transcript and execution/pending-input state |
| POST | `/sessions` | Create, optionally prompt: `{cwd?, workspace?, text?, mode?}`; returns `sessionId`, `requestId`, `eventId`, `bootId` |
| POST | `/sessions/:id/prompt` | Prompt: `{text, mode?}`; returns `requestId`, `eventId`, `bootId` |
| POST | `/sessions/:id/cancel` | Cancel |
| GET | `/workspaces` | Workspaces |
| GET | `/events?since=<id>` | SSE stream: `turn-end`, `user-message`, `status`, `error`, `pending-input` |

Transcript reads accept `limit` 0–1000; 0 requests the maximum bounded page.
`hasMore` reports older history. The status tab shows metadata, without prompt or
response excerpts. Authenticated transcript and SSE clients can read session content.

`pending-input` reports `{sessionId, kinds}` when a session starts waiting for a
human (`approval`, `question`), and again with `kinds: []` when it stops. It comes
from DSH's own unsettled-request table, not from guessed event names. The bridge
never answers those requests. `needs-approval` is emitted as a **deprecated alias**
with the same payload for one release; it disappears in 0.7.0 with a protocol bump.

Every prompt, create and cancel is appended to `~/.dsh/agent-bridge-audit.jsonl`
(`DSH_BRIDGE_AUDIT_FILE` moves it): one JSON object per line with time, agent,
action, `outcome` (`accepted` / `refused` / `failed`), `status` (the HTTP status),
session, mode, text length and the SHA-256 of the original prompt text. Refusals
(409 busy, 400 invalid) and DSH prompt errors are recorded too. The prompt text
itself is never written. The file rotates to `.1` at 1 MiB.

SSE event ids restart at 1 when DSH restarts. Every event carries the `bootId` of
the process that emitted it: clients must drop a `since` cursor from a previous
boot. `mcp/lib.mjs` exports `follow()`, which reconnects and resets the cursor on
that change; `mcp/watch.mjs` uses it.

## Limits and security

Read [SECURITY.md](SECURITY.md) before exposing this to another client. The token
grants access to **all** available DSH sessions and workspaces. This is a trusted
local integration, not a multi-user authorization system or a public web service.

The SSE ring retains 500 events in memory and resets on restart. There is no
durable request queue or delivery deduplication; after a network interruption,
inspect the session before resending work. The legacy two-slot file bridge has
different persistence guarantees and is not replaced automatically.

## Development

```sh
npm test
```

Tests use an isolated temporary state file, a fake DSH controller and localhost
HTTP. They never connect to an installed DSH instance or call a model. CI runs
the same suite on Windows and Ubuntu with Node 22 and 24.

MIT licensed. Adapted from the original locally developed DSH bridge plugin.
