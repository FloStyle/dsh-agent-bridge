# DSH Agent Bridge — audit and improvement plan

Date: 17 November 2026
Reviewer: Claude Code (Opus 5.5), external review requested by the owner
Target: https://github.com/FloStyle/dsh-agent-bridge at `ff04a1f` (package 0.5.0)
Also compared: the installed copy in `plugins/dsh-agent-bridge` next to this file (package 0.4.1)

## 1. Summary

The bridge works, and its design is sound: loopback only, bearer token, bounded reads, and it never approves DSH permissions. I used it today to read a DSH session and send it a review. That worked on the first try.

The main problems are:

1. **The running bridge is not the reviewed one.** DSH loads 0.4.1 from a non-git folder. The 0.5.0 hardening in the GitHub repo is not live. Nothing tells a client which version runs.
2. **Prompts from agents look like prompts from the owner.** A bridged message is stored as an ordinary user message. DSH cannot tell that an external agent sent it.
3. **One token does everything.** A reviewer that only needs to read gets the same power as a client that creates and steers sessions.
4. **`dsh_wait` can return too early.** It polls `running`, which can still be false just after a send.
5. **Missing capabilities for real delegation:** no agent, mode or model on session create (so no "creator mode" session from the bridge), no backward paging, tool output clipped to 600 characters, and no way to see what a pending input asks.
6. **The MCP server is minimal.** It has no tool annotations, no structured output, no resources or notifications, and no setup guide for Claude Code. Claude Code has not registered it, so I had to use curl.

## 2. Method

- Read every file in the repo: `index.js`, `client.js`, `mcp/*.mjs`, `test/bridge.test.mjs`, README, SECURITY.
- Diffed the installed 0.4.1 plugin against the repo.
- Ran `node --test` on Node 24.14.1: 1 test, 1 pass.
- Live use on this machine: `GET /health`, `GET /sessions`, `GET /sessions/:id?limit=N`, `POST /sessions/:id/prompt`. The token was read from `~/.dsh/agent-bridge.json` and never printed.

Line numbers below refer to the repo at `ff04a1f`.

## 3. Findings

Severity: **High** = fix before relying on the bridge for unattended work. **Medium** = fix soon. **Low** = polish.

### Deployment

| ID | Sev | Finding | Evidence | Fix |
| --- | --- | --- | --- | --- |
| D1 | High | The installed plugin is 0.4.1, but the repo is 0.5.0. The live bridge lacks the 0.5.0 hardening: 64 KiB body cap (0.4.1 allows 2 MB), Origin rejection (0.4.1 defines `loopbackOrigin` but never calls it), `limit` validation, request/header timeouts, the SSE client cap, token-length check and metadata-only status. | `plugins/dsh-agent-bridge/index.js:131,159`, `package.json` "0.4.1" | Install from a git clone of the repo. Add a `version` check (D2). Document the update steps in one script. |
| D2 | Medium | `/health` does not report the version, protocol, boot time or PID. A client cannot detect drift or a restart. | `index.js:226` | Return `{ok, version, protocol, bootId, startedAt, pid}`. Write the same fields to the state file. |
| D3 | Medium | `mcp-config.json` next to this file points to an older `client/mcp.mjs`, not the repo's `mcp/mcp.mjs`. | `../mcp-config.json` | Point all configs at the repo clone. Ship a `bin` (already in package.json) and document `npx`/`node` use. |
| D4 | Low | The repo has no CI. | no `.github/` | Add GitHub Actions: `node --test` on Windows and Ubuntu, Node 22 and 24. |

### Security and trust

| ID | Sev | Finding | Evidence | Fix |
| --- | --- | --- | --- | --- |
| S1 | High | **No provenance on bridged prompts.** `sc.prompt` stores the text as a normal user message. The DSH agent and the transcript cannot tell an external agent's message from the owner's. Today I had to put "Message from Claude Code…" in the text by hand. | `index.js:150-155` | Pass a source tag, e.g. `source: {kind: 'agent-bridge', agent: <X-Agent-Name>}`, if the DSH API supports one. If not, prefix a fixed, non-forgeable header line, and strip owner-looking headers from client text. Show the tag in the DSH UI. |
| S2 | High | **One all-powerful token.** It can read every session, create sessions in any folder, prompt, steer and cancel. A read-only reviewer needs much less. | SECURITY.md, `index.js:214` | Add scoped tokens: `read`, `prompt`, `create`, `cancel`, with an optional session or workspace allowlist. Keep the current token as `admin`. Let the MCP client pick a token by env var. |
| S3 | Medium | `POST /sessions` with `cwd` creates a DSH workspace for any string path. It does not check that the folder exists or is absolute. | `index.js:183` | Require an absolute, existing directory. Optionally require an allowlist of roots in config. |
| S4 | Medium | Prompts sent through the bridge are not logged durably. The request ring is in memory (100 entries) and lost on restart. | `index.js:156-163` | Append-only JSONL audit log in `~/.dsh/agent-bridge-audit.jsonl`: time, agent, action, session, text SHA-256 and length (not the text). Rotate by size. |
| S5 | Low | The token comparison uses `!==`, which is not constant-time. | `index.js:214` | Use `crypto.timingSafeEqual` on equal-length buffers. |
| S6 | Low | On Windows, mode 0600 has no effect, so the token file is protected only by profile ACLs. | `index.js:298-300` | Document it, or on Windows set an explicit owner-only ACL (`icacls /inheritance:r /grant:r %USERNAME%:F`). |

### Correctness

| ID | Sev | Finding | Evidence | Fix |
| --- | --- | --- | --- | --- |
| C1 | High | **`dsh_wait` race.** It returns as soon as `running` is false. Right after `dsh_send`, the new turn may not have started yet, so `dsh_wait` can return the previous turn's state. Not reproduced yet; this is from reading the code. Write a test first. | `mcp/mcp.mjs:50-58` | Make `prompt`/`create` return the `requestId` and current `lastEventId`. Make `dsh_wait` wait for a `turn-end` event for that session with an id greater than the send's id, through SSE, with polling as fallback. |
| C2 | Medium | `needs-approval` events depend on guessed event names (`approval|permission/(request|pending|ask)`). There is no test against real DSH events, so they may never fire. | `index.js:114` | Find the real DSH event types. Emit `pending-input` from `sc.state().pendingInput` changes as well. Add a test with the real names. |
| C3 | Medium | SSE event ids restart at 1 when DSH restarts. A client holding `since=500` silently misses new events. | `index.js:95-104` | Add `bootId` to every event and to `/health`. Clients reset `since` when `bootId` changes. |
| C4 | Low | `dsh_wait` re-reads 40 transcript entries every 750 ms. That is heavy for long waits. | `mcp/mcp.mjs:54-56` | Use SSE (C1). Poll only `/sessions/:id/state` (new, cheap) as fallback. |
| C5 | Low | The test suite has one test. It does not cover SSE, busy/steer, wait, workspace resolution or the MCP stdio protocol. | `test/bridge.test.mjs` | Add the tests in section 6. |

## 4. Missing capabilities

These came up in real use today: reviewing a TurboMCP release run and handing it work.

| ID | Capability | Why it matters | Proposal |
| --- | --- | --- | --- |
| M1 | **Choose agent, mode or model on create** | You cannot start a "creator mode" session from the bridge, which is the intended next step for this plan. The plugin already injects `agents` and `agentDefaultModel`. | `GET /agents` lists the available agents, modes and models. `POST /sessions` accepts `{agent?, mode?, model?}`, checked against that list. MCP: `dsh_agents` tool and the same fields on `dsh_send`. |
| M2 | **Backward paging** | `hasMore` and `cursor` are returned, but there is no `before` parameter, so older history cannot be read. | `GET /sessions/:id?before=<cursor>&limit=N`. |
| M3 | **Full entries on demand** | Tool arguments are clipped to 400 characters and results to 600. A reviewer cannot check evidence such as test logs or build output. | `GET /sessions/:id/entries/:seq` returns one entry in full, capped at about 256 KiB. Optional `?roles=assistant,turn-end` filter on reads. |
| M4 | **Cheap state endpoint** | Waiting and dashboards only need `running`, `pendingInput`, the last turn and the last event id. | `GET /sessions/:id/state`. |
| M5 | **Pending-input details** | `pendingInput` is returned, but no client can show what the question is, so the owner must switch to DSH to see it. | Read-only first: expose the question text and options. An `answer` endpoint only for *questions*, never permissions, behind its own scope and off by default. |
| M6 | **Session filters and search** | 15 sessions today. Agents need `cwd`, `running` and `since` filters and title search. | Query parameters on `GET /sessions`. |
| M7 | **Progress events** | Clients only see `turn-end`. A long run (a 6-minute test suite) shows no progress. | Optional `tool-call` and `turn-start` events, per session, opt-in with `?detail=progress` on `/events`. Metadata only by default. |
| M8 | **Attachments** | Prompts are text only, 50,000 characters. Handing over a report file means pasting it. | `files: [absolute paths]` on prompt/create, using the injected `attachments`/`fileUploads` services, with size and root limits. |
| M9 | **Session metadata** | No model, agent, mode, token usage or created time on list/read. | Add these fields when DSH exposes them. |

Non-goals, to keep: never approve tool or permission requests; never listen on anything except loopback; never proxy to a remote host.

## 5. MCP server improvements

| ID | Sev | Proposal |
| --- | --- | --- |
| P1 | High | **Claude Code setup.** Add a README section and a script: `claude mcp add dsh-agent-bridge --env DSH_AGENT_NAME=claude-code -- node <clone>/mcp/mcp.mjs`. Document using `node mcp/watch.mjs --session <id>` with Claude Code's Monitor tool for turn-end notifications. Optionally ship a Claude Code plugin (`.claude-plugin/plugin.json` + `.mcp.json` + a short "delegate to DSH" skill). |
| P2 | High | **Tool annotations.** `dsh_list`, `dsh_workspaces`, `dsh_read` and `dsh_wait`: `readOnlyHint: true`. `dsh_send`: `readOnlyHint: false`, `openWorldHint: false`. `dsh_cancel`: `destructiveHint: true`. MCP clients use these for permission prompts. |
| P3 | Medium | **Protocol version negotiation.** `initialize` echoes whatever version the client sends. Reply with the newest version the server really supports, or the client's version only if it is supported. |
| P4 | Medium | **Structured output.** Add `outputSchema` and `structuredContent` for list, read and wait, and keep the text copy for older clients. |
| P5 | Medium | **Resources and notifications.** Expose `dsh://session/<id>` resources with `resources/subscribe`. Send `notifications/resources/updated` on turn-end through SSE. This replaces polling for clients that support it. |
| P6 | Low | **New tools that match section 4:** `dsh_agents` (M1), `dsh_state` (M4), `dsh_entry` (M3). Add `before` to `dsh_read` (M2). Add `files` to `dsh_send` (M8). |
| P7 | Low | **Input bounds** in schemas: `limit` as an integer from 0 to 1000, `timeoutSec` from 1 to 3600, `text` with a maxLength of 50000. |
| P8 | Low | **Token scope selection** (S2): `DSH_BRIDGE_TOKEN_SCOPE` or a separate state-file entry per scope. |

## 6. Implementation plan

Each phase is one PR. Bump the version, keep `protocol: 1` unless the change breaks clients, and update README, SECURITY and tests in the same PR.

### Phase 1 — Live and identifiable (0.5.1)
- D1: install from a git clone. Add `scripts/install.ps1` (remove, add, restart message) and a matching sh script.
- D2: version, protocol, bootId, startedAt and pid in `/health` and the state file.
- C3: bootId on every SSE event. watch.mjs and the MCP client reset `since` when it changes.
- S5: constant-time token comparison.
- D4: CI workflow.
- Tests: health fields; a bootId change resets the client cursor.
- **Done when:** the installed DSH plugin reports 0.5.1 through `/health`, and CI is green on Windows and Ubuntu.

### Phase 2 — Trustworthy delegation (0.6.0)
- S1: provenance tag on bridged prompts, visible in the transcript and the UI.
- C1: request id plus event-based `dsh_wait`. A test sends then waits immediately and must get the *new* turn.
- C2: real pending-input and approval events, with a test.
- S4: audit log (hashes, not text).
- S3: `cwd` must be an absolute, existing directory.
- P2, P3, P7: MCP annotations, version negotiation and bounds.
- P1: Claude Code setup section and script.
- **Done when:** a Claude Code session with the MCP server registered can send work to a DSH session, wait for that exact turn and read the result, with no curl. The DSH transcript shows that message as coming from `claude-code`.

### Phase 3 — Scopes and richer reads (0.7.0)
- S2: scoped tokens with a session/workspace allowlist.
- M1: `GET /agents` and agent/mode/model on create. A test creates a session in a non-default mode.
- M2, M3, M4, M6: paging, full entry, state endpoint, filters.
- P4, P6: structured output and new tools.
- **Done when:** a read-only token can list and read but gets 403 on prompt, create and cancel, and a creator-mode session can be started through `dsh_send`.

### Phase 4 — Live follow-up (0.8.0)
- M7: progress events (opt-in).
- P5: MCP resources and subscriptions.
- M5: pending-input details (read-only). The `answer` endpoint only if the owner asks for it, behind its own scope.
- M8, M9: attachments and session metadata.
- S6: Windows ACL on the state file.

## 7. Brief for the DSH creator-mode session

Paste this into a new DSH session in creator mode, with the working folder set to a git clone of `FloStyle/dsh-agent-bridge`:

> Implement Phase 1 and then Phase 2 of `IMPROVEMENT-PLAN.md`. The plan is at `C:\Users\flost\Documents\Codex\2026-11-05\j-ai\outputs\DSH-Agent-Bridge\IMPROVEMENT-PLAN.md`; copy it into the repo as `docs/improvement-plan.md` first. Work on a branch per phase and open one PR per phase. Write each failing test before its fix, especially C1 (send-then-wait must return the new turn). Do not change the security non-goals: loopback only, never approve permissions, no remote proxy. Do not reinstall the plugin into the running DSH while a session is working. Ask the owner before the reinstall. Report the PR links, test output and the `/health` result after reinstall.

Phases 3 and 4 should wait until Phase 2 has been used for a few real hand-offs.
