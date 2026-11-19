# Spike R3.4: prompt modes and the DSH queue

Date: 2026-11-19. DSH 0.2.2-rc.3.

## Findings

| Question | Answer | Source |
|---|---|---|
| Which modes does the prompt API declare? | `queue` and `steer` (`SessionPromptRequest.mode`). | `dsh-api-session-controller/lib/typert.host.js`, `session_prompt_parameter_0_strict$schema` |
| What does the controller do with them? | `if (request.mode === "steer") agent.steer(message); else agent.followup(message)`. Every non-steer prompt, including the bridge's historical `followup`, goes to `agent.followup`. | `dsh-api-session-controller/lib/index.js` around lines 932–933 |
| What happens to a follow-up while the agent is busy? | It waits in the agent's inbox and runs after the current turn. Session state shows the queue with placements `queued`, `steering` and `context`. | `session_state_result$schema` (`queue[].placement`) |
| Can a queued item be changed? | `sessionController.updateQueue({sessionId, itemId, action: edit|remove|steer})`. | `session_updateQueue_parameter_0$schema` |
| Is there a "context note" that starts no turn? | The agent interface has `inject(message)`, next to `followup` and `steer`, but the session controller does not expose it. A plugin would need the live agent object. | `typert.host.js`, the agent interface (`send`, `followup`, `steer`, `inject`) |

## Consequences

- **The bridge's 409 for a busy session is the bridge's own choice, not a DSH limit.** DSH already queues follow-ups. The bridge now accepts `mode: "queue"`, which goes straight to that queue; `followup` keeps refusing a busy session for compatibility.
- Pings to `dsh:<session>` are delivered with `queue`, so a busy receiver gets them after its current turn.
- Phase 3 item P3.3 ("queue instead of 409") needs no bridge-side queue for DSH sessions: it becomes "default to `queue`", plus `updateQueue` for edits and removals.
- `inject` (a note without a turn) is not reachable through the controller. It is left out until DSH exposes it.
