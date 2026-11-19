# DSH Agent Bridge

Use DeepSeek Harness as a local agent from any MCP-compatible client. Includes a
DSH conversation tab, an authenticated HTTP API, SSE events and a dependency-free
stdio MCP client. No Claude or Codex subscription is required by this plugin;
DSH uses whichever model provider you configure.

## Install

Requires DeepSeek Harness **0.2.2-rc.1** to **0.3.0**. Nothing else: the
`dsh-bridge` command runs on the Node.js that DeepSeek Harness ships. Node.js 22
or newer on `PATH` also works, and `DSH_NODE` can name any runtime.

The plugin itself installs with one line, from the machine that runs DSH:

```sh
dsh plugin add github:FloStyle/dsh-agent-bridge#v<version>
```

After that, everything goes through `dsh-bridge`, in the installed package:

| Windows | macOS and Linux |
| --- | --- |
| `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-agent-bridge\bin\dsh-bridge.cmd` | `~/.dsh/profiles/desktop/node_modules/dsh-agent-bridge/bin/dsh-bridge` |

The Windows launcher picks `DSH_NODE`, then DSH's own runtime
(`DeepSeek Harness.exe` with `ELECTRON_RUN_AS_NODE=1`), then `node` on `PATH`. The
POSIX launcher picks `DSH_NODE`, then `node`. `dsh-bridge runtime` shows which
one runs.

```sh
dsh-bridge doctor                 # read-only checks, one fix line per failure
dsh-bridge health                 # the running bridge's /health
dsh-bridge install --dry-run      # show what an upgrade would do
```

Restart DSH while no session is working after any install or upgrade.

### Upgrade, offline install, rollback, uninstall

```sh
dsh-bridge install --source release --version <version> --profile desktop
dsh-bridge install --source file --tarball dsh-agent-bridge-<version>.tgz --sha256 <hex>
dsh-bridge uninstall --profile desktop        # asks before deleting private files; --purge skips the question
```

`--source` takes `release` (the GitHub release tarball, default), `github` (the
tag), `local` (this clone) or `file` (a tarball on disk, checked against its
SHA-256 before anything changes). Every command that changes something accepts
`--dry-run`. `install` backs up `package.json`, `pnpm-lock.yaml` and the cordis
files to `~/.dsh/backups/<profile>-<timestamp>`, adds the new build before
anything is removed, and restores the backup if the add fails. Rollback is
copying that backup back and restarting DSH. Neither command reads the token.

The scripts in `scripts/` (`install`, `uninstall`, `connect-claude-code`) are
deprecated wrappers around these commands.

### Development

Install from a clone of this repository, not from a loose folder: DSH caches
plugin modules, so a copy on disk and the running plugin drift apart otherwise.

```sh
git clone https://github.com/FloStyle/dsh-agent-bridge.git
cd dsh-agent-bridge
node bin/dsh-bridge.mjs install --source local --profile bridge-test
node bin/dsh-bridge.mjs live-check --profile bridge-test
```

`live-check` creates and cancels a scratch session. It refuses the `desktop`
profile unless `--read-only` is given.

## Connect an MCP client

`dsh-bridge connect` prints the configuration for a client, with an absolute
runtime path, the installed MCP entry and a sender name. Nothing in it is a
token: the client reads the endpoint from `~/.dsh/agent-bridge.json` and the token
from the private files next to it at run time. These files are **private runtime
state**: never commit or share them. `DSH_BRIDGE_STATE_FILE` selects another state
file; set the same path for DSH and the client. `DSH_AGENT_NAME` is a display
label, not an identity or permission boundary.

```sh
dsh-bridge connect claude --name claude-code            # prints the command; --execute runs it
dsh-bridge connect codex --name codex                   # prints the TOML; --execute appends it after a backup
dsh-bridge connect generic --name cursor                # prints a JSON block for other clients
```

The printed configurations look like this (paths shortened; `connect` fills in
yours):

### Claude Code

```sh
claude mcp add dsh-agent-bridge --env ELECTRON_RUN_AS_NODE=1 --env DSH_AGENT_NAME=claude-code -- "C:/…/DeepSeek Harness/DeepSeek Harness.exe" "C:/…/.dsh/profiles/desktop/node_modules/dsh-agent-bridge/mcp/mcp.mjs"
```

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.dsh-agent-bridge]
command = "C:/…/DeepSeek Harness/DeepSeek Harness.exe"
args = ["C:/…/.dsh/profiles/desktop/node_modules/dsh-agent-bridge/mcp/mcp.mjs"]
env = { ELECTRON_RUN_AS_NODE = "1", DSH_AGENT_NAME = "codex" }
```

### Cursor and other `mcpServers` clients

```json
{
  "mcpServers": {
    "dsh-agent-bridge": {
      "command": "C:/…/DeepSeek Harness/DeepSeek Harness.exe",
      "args": ["C:/…/.dsh/profiles/desktop/node_modules/dsh-agent-bridge/mcp/mcp.mjs"],
      "env": { "ELECTRON_RUN_AS_NODE": "1", "DSH_AGENT_NAME": "cursor" }
    }
  }
}
```

Without DSH's runtime, the command is the absolute path of `node` and
`ELECTRON_RUN_AS_NODE` is omitted. Restart the client so it picks up the server.

For turn-end notifications without polling, run the watcher as a background
command in your client (for example a Monitor tool). It prints one line per
notification; `--session` takes a full id or a unique prefix:

```sh
dsh-bridge watch --session 3a9e7ffb
```

The MCP process must see the same `HOME` (or the same `DSH_BRIDGE_STATE_FILE`) as
DSH, otherwise it cannot read the endpoint and token.

| Tool | Purpose |
| --- | --- |
| `dsh_list` | List sessions, with each session's model |
| `dsh_workspaces` | List workspaces |
| `dsh_read` | Read a bounded transcript; accepts a unique session ID prefix |
| `dsh_send` | Create a session or send work to an existing session; `model` and `reasoningEffort` choose the model |
| `dsh_models` | List the models DSH can run now, with their reasoning efforts |
| `dsh_set_model` | Switch the model of an existing session |
| `bridge_ping` | Send a short message to another agent or into a DSH session |
| `dsh_profiles` | List the owner's access profiles |
| `dsh_access` | Show a session's preset, profile and extra writable folders |
| `dsh_apply_profile` | Apply an access profile to an existing session |
| `dsh_wait` | Wait for a turn to end or for pending user input |
| `dsh_cancel` | Cancel a turn |

The read-only tools carry `readOnlyHint: true`; `dsh_cancel` carries
`destructiveHint: true`. MCP clients use these hints for their own permission
prompts. That hint is advisory: the bridge itself still approves nothing.

For a new session, supply an **absolute, existing** `cwd` or a `workspace`.
Existing busy sessions reject ordinary prompts; `mode: "steer"` must be explicit.
Approval and question prompts remain under DSH's controls. The bridge never
approves them.

### Choosing the model

New DSH sessions start on DSH's default model. To choose, call `dsh_models`, then
pass a `model` to `dsh_send` (new or existing session) or `dsh_set_model`:

- `"provider/model"`, for example `"deepseek-account/deepseek-v4-pro"`
- a model id that only one provider offers, for example `"deepseek-v4-pro"`
- a model name as `dsh_models` shows it

`reasoningEffort` is optional and must be one the model lists. A bad choice is
refused with the list of valid ones, before anything is created. Every switch is
written to the audit log (`action: "model"`). `dsh_read` and `dsh_list` show the
model each session uses next.

To change the default for sessions **the bridge creates**, set it in the profile's
`cordis.patch.yml`:

```yaml
- id: agent-bridge
  name: dsh-agent-bridge
  config:
    defaultModel: deepseek-account/deepseek-v4-pro
    defaultReasoningEffort: high
```

Sessions you start in the DSH window keep DSH's own default.

### Access profiles

An access profile lets a session stay in `workspace-write` with exactly the extra
folders it needs, instead of `danger-full-access`. Only the owner writes profiles;
agents can only name one.

```sh
dsh-bridge profile add engine --cwd D:\dev\project --root D:\engine\Intermediate --preset workspace-write --yes
dsh-bridge profile list
dsh-bridge profile validate
```

Then `dsh_send` with `profile: "engine"` starts a session in the profile cwd, sets
its preset and registers the extra folders. The bridge registers them again after
a DSH restart. Every grant is audited (`action: "grant"`).

Limits, measured on DSH 0.2.2-rc.3 (`docs/spikes/`):

- Extra folders work for DSH's **file tools**. On Windows, shell commands ignore
  them and stay inside the session cwd.
- A profile cannot set full access: `danger-full-access` is refused. Drive roots,
  the home folder, `~/.dsh`, `~/.ssh` and `.git/hooks` are refused unless a root
  sets `allowSensitive: true`.
- In the sandbox, Windows-native HTTPS fails. See `docs/access-guide.md` for the
  git setting that works.

The Bridge tab and `dsh-bridge doctor` list the sessions that run in full access.

### Messages between agents (ping)

Agents can send each other short messages: `review-request`, `review-result`,
`question`, `done` or `ping`. A message carries a summary (at most 2000
characters) and an optional `ref` (`repo`, `branch`, `sha`, `pr`); the receiver
reads the details itself.

- **From an MCP client:** the `bridge_ping` tool. The sender is `DSH_AGENT_NAME`.
- **From a DSH session:** the `bridge_ping` tool that the bridge gives every DSH
  agent. The sender is the calling session (`dsh:<short id>`); it cannot be chosen.
- **To a DSH session:** `to: "dsh:<session id prefix>"`. The message is delivered
  into that session through the DSH queue, so a busy session gets it after its
  current turn.
- **To wake an external agent:** run a watcher as a background command; it exits
  with the message as one JSON line:

  ```sh
  dsh-bridge watch --agent reviewer --until message --exit
  ```

Replies use `inReplyTo` and stay in the thread. A thread stops at 6 hops. Every
message is audited (`action: "ping"`, hash and length only). Messages are data
from another agent, not instructions from the user, and the delivered text says
so. This is the in-memory version: messages are lost when DSH restarts. The
Phase 3 mailbox will keep them.

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
| POST | `/sessions` | Create, optionally prompt: `{cwd?, workspace?, profile?, text?, mode?, model?, reasoningEffort?}`; returns `sessionId`, `model`, `requestId`, `eventId`, `bootId` |
| POST | `/sessions/:id/model` | Switch the model: `{model, reasoningEffort?}`; returns `selected` |
| GET | `/profiles` | The owner's access profiles |
| POST | `/sessions/:id/profile` | Apply a profile: `{profile}`; the session cwd must match |
| GET | `/sessions/:id/access` | Preset, profile and registered folders of a session |
| GET | `/models` | The DSH model catalog: `default`, `providers`, `models[]` with `ref`, `efforts` |
| POST | `/sessions/:id/prompt` | Prompt: `{text, mode?}` (`followup` refuses a busy session, `queue` waits in the DSH queue, `steer` interrupts); returns `requestId`, `eventId`, `bootId` |
| POST | `/ping` | Send a message: `{to, kind, summary, ref?, threadId?, inReplyTo?}` |
| POST | `/sessions/:id/cancel` | Cancel |
| GET | `/sessions/:id/denials` | Sandbox denials of the session (read-only), for `scripts/access-report.mjs` |
| GET | `/workspaces` | Workspaces |
| GET | `/events?since=<id>` | SSE stream: `turn-end`, `user-message`, `status`, `error`, `pending-input`, `message`; a `gap` event first when `since` is older than the buffer |

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

`node scripts/access-report.mjs` (or `dsh-bridge access-report`) lists the sandbox
denials of your sessions with one suggestion per folder; see
[docs/access-guide.md](docs/access-guide.md).

Tests use an isolated temporary state file, a fake DSH controller and localhost
HTTP. They never connect to an installed DSH instance or call a model. CI runs
the same suite on Windows and Ubuntu with Node 22 and 24.

MIT licensed. Adapted from the original locally developed DSH bridge plugin.
