# dsh-agent-bridge Phases 3–4: two-way messaging and wake-up

Author: Claude Code (external reviewer), 2026-11-17. Executor: a DSH session in creator mode, in C:\Dev\DSHAgentBridge.
**Baseline:** v0.6.1 is installed and live-verified on DSH 0.2.2-rc.3. This plan replaces Phases 3 and 4 in docs/improvement-plan.md. Copy it into the repo as docs/phase-3-4-plan.md.

## Goal

Agents in any harness (DSH, Claude Code, Codex and others) can message each other, and a message wakes the receiver, safely and with an audit trail.
Today the flow goes one way only: an external agent can drive DSH, but a DSH agent cannot reach anyone, and Claude Code learns about DSH events only by watching.

## Non-goals (unchanged)

- Loopback only, with no remote proxy.
- The bridge never approves permissions or answers questions on behalf of a human.
- No automatic installation into the live profile. The owner restarts DSH.

## Live findings to fix first (0.6.2)

| # | Finding | Fix |
|---|---|---|
| L1 | After a cancel, the `turn-end` event carries the previous turn's `lastText`. Seen live: turn 4 was cancelled and reported `pong-3`. | Give `turn-end` a `reason` (`completed`, `cancelled` or `error`) and the text of that turn only, or `null`. Make `dsh_wait` return `cancelled: true`. Add a test with a fake DSH that cancels. |
| L2 | The MCP client defaults to the sender name `mcp-agent`. | Make the connect scripts and README configs always set `DSH_AGENT_NAME`. `doctor` warns when the default is used. |
| L3 | `dsh-codex-subscription@3.2.6` was denied after the DSH upgrade because its declared DSH range was too narrow. | Make `doctor` list the profile plugins that DSH denies for version range, with the `dsh plugin allow-version` hint. Report only; the bridge's own range stays honest. |

## Phase 3 (0.7.0): identity, mailbox, two-way messaging

| # | Item | Done when |
|---|---|---|
| P3.1 | **One token per agent.** Agents are listed in `~/.dsh/agent-bridge-agents.json` (0600; on Windows, user-only rights) with `name`, `tokenSha256` and `scopes` (`read`, `send`, `create`, `cancel`, `receive`). `X-Agent-Name` is ignored when a per-agent token is used: the sender is the token's agent. The old single token keeps working as `legacy` with all scopes. Scripts: `agent add`, `agent list` and `agent revoke`, which print the token once. | Tests: a revoked token gets 401; a read-only token gets 403 on send; the sender name cannot be forged. |
| P3.2 | **Disk mailbox.** Messages are stored in SQLite, or JSONL plus an index, under `~/.dsh/agent-bridge/`. Fields: `id`, `threadId`, `inReplyTo`, `from`, `to`, `createdAt`, `expiresAt`, `hop`, `state` (`queued`, `delivered`, `acked`, `expired` or `failed`) and the body. Delivery state survives a DSH restart. Event IDs no longer reset; `bootId` stays for information only. | A restart with queued messages delivers them afterwards; tested with a fake DSH. |
| P3.3 | **Queue instead of 409.** A message to a busy DSH session is queued and delivered when the session becomes idle. Use DSH's own queue mode if the controller accepts it; otherwise the bridge waits for idle. `mode: steer` stays explicit. Check first which prompt modes DSH 0.2.2-rc.3 accepts (`followup`, `queue`, `steer`) and record the result. | Live: send twice to a busy scratch session; both are delivered in order, with no 409. |
| P3.4 | **Outbound tools for DSH agents.** The plugin registers tools inside DSH: `bridge_send(to, text, threadId?)`, `bridge_reply(threadId, text)` and `bridge_agents()`. Each message is stored in the mailbox and routed: to another DSH session as a prompt, or to an external agent's inbox (P3.5). Check first how a cordis plugin registers agent tools in DSH 0.2.2-rc.3 (look at dsh-skill-mcp-panel or the base bundle). Stop and report if no supported API exists. | A live DSH scratch session sends to a second scratch session, which wakes and replies in the same thread. |
| P3.5 | **Inbox API for external agents.** <ul><li>`GET /inbox?since=` and `POST /inbox/:id/ack`</li><li>SSE `message` events filtered to the caller's agent</li><li>MCP tools `bridge_inbox`, `bridge_ack` and `bridge_reply`</li></ul> | Claude Code reads and acks a message that a DSH agent sent. |
| P3.6 | **Threads and results.** `threadId` and `inReplyTo` on every send. `GET /requests/:requestId`, plus an MCP tool `dsh_result(requestId)`, returns that request's turn outcome: status, reason and text. | A result lookup after the turn ends returns the right turn even when other turns happened in between. |
| P3.7 | **Loop safety**, enforced in the bridge, not by convention: <ul><li>a `hop` limit per thread (default 6)</li><li>a wake budget per agent pair per hour (default 20)</li><li>a cap on queued messages per receiver</li><li>a message created automatically by a received message is marked `auto`, and `auto` messages never wake an agent that only sent `auto` messages in that thread</li><li>a global kill switch (`POST /pause`, plus a toggle in the Bridge tab) that queues everything and wakes no one</li></ul> | Two fake agents set to always reply stop at the hop limit, and the audit shows why. |
| P3.8 | **Human relay.** When a session waits for input, the bridge includes the question text and the options (read-only) in the `pending-input` event, so an agent can forward it to the owner. It still never answers. | Live: a question in a scratch session appears with its text. |
| P3.9 | **Audit** covers every mailbox state change (hash and length only), and the Bridge tab shows a thread view. | — |

## Phase 4 (0.8.0): wake-up adapters per harness

Every adapter delivers from the P3.2 mailbox and acks only after the receiver confirms.

| # | Adapter | Notes |
|---|---|---|
| P4.1 | **DSH:** prompt or queue (P3.3). | Already the model. |
| P4.2 | **Claude Code through MCP tasks.** `dsh_send` (and `bridge_inbox` waits) can return an MCP task that completes when the awaited turn ends or a message arrives. The Claude Code docs say that if Claude is idle when a task result arrives, it "starts on it unprompted". | First check which MCP protocol revision adds tasks, whether Claude Code 2.1.x supports it, and how the client advertises it. Keep the plain tools for clients without tasks. |
| P4.3 | **Watcher fallback:** `node mcp/watch.mjs --until turn-end\|message --session <id>\|--agent <name> --exit`. It exits with a JSON line when the event arrives. A Claude Code background task or Monitor then wakes the session. This works today with no new client features. | Document the exact Claude Code usage. |
| P4.4 | **Claude Code channel (experimental):** the MCP server declares `experimental['claude/channel']` and pushes `notifications/claude/channel` `{content, meta}` for messages addressed to it. | Research preview and CLI only. Custom servers need `--dangerously-load-development-channels server:dsh-agent-bridge`, and Team or Enterprise organizations must enable channels. Off by default; documented as experimental. |
| P4.5 | **Claude Code inbox socket:** deliver to a local Claude Code session's inbox, which wakes an idle session according to the cross-session-messaging docs. | The external-process path (`CLAUDE_CODE_MESSAGING_TOKEN`) is not fully verified. Investigate first. Use it only if it is documented and supported, otherwise drop it. |
| P4.6 | **Codex and generic adapters:** a webhook POST to a local URL that the receiver registers, plus the SSE inbox. | Research Codex's resume or exec path before writing code; do not guess flags. |
| P4.7 | **Discovery:** `bridge_agents()` lists each registered agent with its kind, scopes, wake method and last seen time. | — |

## Order and rules

1. 0.6.2 (L1–L3), then Phase 3 in this order: P3.1 → P3.2 → P3.3 → P3.6 → P3.7 → P3.4 → P3.5 → P3.8 → P3.9. Then Phase 4, starting with P4.3 and P4.2.
2. One branch and one PR per release. Write each failing test before its fix. CI must pass on Windows and Ubuntu with Node 22 and 24.
3. Test on the `bridge-test` scratch profile and on scratch sessions only. Never use the live `desktop` profile or real work sessions before the owner approves the install.
4. Do not merge, tag or install without the owner's go-ahead. Release through the 0.6.1 workflow (tarball plus SHA-256).
5. Report:
   - the PR links
   - the test output
   - the live checks done on the scratch profile
   - anything not verified, especially the DSH tool-registration API (P3.4) and the Claude Code task, channel and inbox support (P4.2, P4.4, P4.5)
