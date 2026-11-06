# DSH Agent Bridge

Use DeepSeek Harness as a local agent from any MCP-compatible client. Includes a
DSH conversation tab, an authenticated HTTP API, SSE events and a dependency-free
stdio MCP client. No Claude or Codex subscription is required by this plugin;
DSH uses whichever model provider you configure.

## Install

Requires DeepSeek Harness Desktop **0.2.2** APIs and Node.js **22 or newer** for
the external MCP client. Tested locally with DSH 0.2.2-rc.1 on Windows.

```sh
git clone https://github.com/FloStyle/dsh-agent-bridge.git
cd dsh-agent-bridge
```

Use the `dsh` CLI bundled with your DSH installation:

```sh
dsh plugin --profile desktop add file:/absolute/path/to/dsh-agent-bridge
```

On Windows, use a forward-slash absolute path such as
`file:C:/tools/dsh-agent-bridge`. Restart DSH when no session is working.
For updates, remove the plugin, add it again and restart DSH; its module and
package contents can be cached. Existing legacy Codex bridges can coexist.

## Connect an MCP client

Adapt this example to the configuration format of your MCP application:

```json
{
  "mcpServers": {
    "dsh-agent-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/dsh-agent-bridge/mcp/mcp.mjs"],
      "env": { "DSH_AGENT_NAME": "my-agent" }
    }
  }
}
```

The client reads the endpoint and generated bearer token from
`~/.dsh/agent-bridge.json`. This file is **private runtime state**: never commit
or share it. `DSH_BRIDGE_STATE_FILE` optionally selects another private state file;
set the same path for DSH and the MCP client. `DSH_AGENT_NAME` is a display label,
not an identity or permission boundary.

| Tool | Purpose |
| --- | --- |
| `dsh_list` | List sessions |
| `dsh_workspaces` | List workspaces |
| `dsh_read` | Read a bounded transcript; accepts a unique session ID prefix |
| `dsh_send` | Create a session or send work to an existing session |
| `dsh_wait` | Wait for completion or pending user input |
| `dsh_cancel` | Cancel a turn |

For a new session, supply `cwd` or `workspace` to `dsh_send`. Existing busy
sessions reject ordinary prompts; `mode: "steer"` must be explicit. Approval and
question prompts remain under DSH's controls. The bridge never approves them.

`node mcp/watch.mjs` prints completion/error notifications. `--session <full-id>`
filters one session; `--all` also prints status and user-message events. Its output
may contain private session content: do not publish captured output.

## HTTP API

Default listener: `127.0.0.1:7788` (configurable port in `cordis.patch.yml`). Every
request requires `Authorization: Bearer <runtime-token>`. Browser origins are
rejected; the UI uses DSH's own authenticated status route instead.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Listener status |
| GET | `/sessions` | Session summaries |
| GET | `/sessions/:id?limit=40` | Transcript and execution/pending-input state |
| POST | `/sessions` | Create, optionally prompt: `{cwd?, workspace?, text?, mode?}` |
| POST | `/sessions/:id/prompt` | Prompt: `{text, mode?}` |
| POST | `/sessions/:id/cancel` | Cancel |
| GET | `/workspaces` | Workspaces |
| GET | `/events?since=<id>` | SSE stream |

Transcript reads accept `limit` 0–1000; 0 requests the maximum bounded page.
`hasMore` reports older history. The status tab shows metadata, without prompt or
response excerpts. Authenticated transcript and SSE clients can read session content.

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
HTTP. They never connect to an installed DSH instance or call a model.

MIT licensed. Adapted from the original locally developed DSH bridge plugin.
