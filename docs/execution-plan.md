# dsh-agent-bridge execution plan (recipe)

Version 1, 2026-11-17.
**Executor:** the implementing agent, working in a clone of this repository.
**Reviewer:** the maintainer's review session.
**Approver:** the owner (FloStyle). Only the owner merges, tags, installs into `desktop` and restarts DSH.

Sources:
- `audit-2026-11-17.md`: finding IDs such as T2, X2 and S1 come from it.
- `phase-3-4-plan.md`: item IDs such as P3.1 and P4.3 come from it.

Both files are in the same folder as this one. This plan sets the order. Where it differs from `phase-3-4-plan.md`, this plan wins.

---

## 0. Rules for every task

Read these before you start. Read them again before each release.

1. **One release, one branch, one PR.** The branch names are given below. Do not mix tasks from two releases in one PR.
2. **Write the failing test first.** Commit it before the fix, in a separate commit whose message starts with `test:`. The reviewer checks the commit order.
3. **CI must pass** on Windows and Ubuntu with Node 22 and 24 (`node --test`).
4. **Test only on the `bridge-test` profile and on scratch sessions you create.** Never install into `desktop`. Never prompt, cancel or read real work sessions.
5. **Never print, log or commit the token.** Do not paste `~/.dsh/agent-bridge.json` into a report.
6. **Do not merge, tag, release or install.** Open the PR, report, and wait.
7. **Stop and report** when one of these happens:
   - a step needs a DSH API that you cannot find
   - a test needs the live `desktop` profile
   - a fix needs work outside the task's scope
   - the same test fails 3 times after different fixes

   Do not work around a stop condition.
8. **Do not guess flags or APIs.** For a research step, show the source: a file and line in DSH or a plugin, or the command output.
9. **Keep the scope.** Write new findings in the report under "New findings". Do not fix them in the same PR.
10. **Tick a box `[x]` only with evidence**, in your PR's copy of this plan (`docs/execution-plan.md`). The reviewer confirms or unticks it.

### How a release flows

``
executor: branch → failing tests → fixes → CI green → bridge-test live check → PR → report
reviewer: review the PR against "Expected result" + "Review checks" → approve or request changes
owner:    merge → tag → release → choose a quiet window with the TurboMCP session → install into desktop → restart DSH
reviewer: run doctor + live check on desktop → close the release
``

---

## 1. Status board

| Release | Branch | Theme | Status |
|---|---|---|---|
Rows are in execution order. Releases WA, WB and WC are in `workspace-access-plan.md` (same folder).

| # | Release | Branch | Theme | Status |
|---|---|---|---|---|
| 1 | R1 · 0.6.2 | `fix-0.6.2` | Correct waits and small safety fixes | [ ] in progress |
| 2 | WA · measure | `access-measure` | Access spikes, access report script, layout guide | [ ] not started |
| 3 | R2 · 0.6.3 | `cli-0.6.3` | All-in-one CLI, no Node or shell needed | [ ] not started |
| 4 | R3.1–R3.2 | `refactor-0.7` | Module split and DSH adapter (no behaviour change) | [ ] not started |
| 5 | WB · profiles | `access-profiles` | Access profiles, apply on create and restart, visibility | [ ] not started (gate: WA review) |
| 6 | R3.3–R3.6 | `ping-lite-0.7` | DSH spikes, ping-lite, event-stream hardening | [ ] not started |
| 7 | WC · manage | `access-manage` | Profile env, session and workspace management | [ ] not started |
| 8 | R4 · 0.7.0 | `phase-3-0.7.0` | Identity, mailbox, two-way messaging | [ ] not started |
| 9 | R5 · 0.8.0 | `phase-4-0.8.0` | Wake-up adapters per harness | [ ] not started |

Do not start a release until the owner has merged the one before it. Version numbers after 0.6.3 are set when each release is tagged.

---

## R1 · 0.6.2: correct waits and small safety fixes

Branch `fix-0.6.2`, from `main`.

### R1.0 Put this plan in the repo
- [ ] **Steps:** Copy this file to `docs/execution-plan.md`. Copy `phase-3-4-plan.md` to `docs/phase-3-4-plan.md`. Copy `audit-2026-11-17.md` to `docs/audit-2026-11-17.md`.
- **Expected result:** the three files are in the PR with no content changes.

### R1.1 `turn-end` reports the right turn (L1, T1)
- [ ] **Steps:**
  1. Test: a fake DSH runs turn 1, which ends with `pong-1`. Turn 2 is cancelled before any assistant text. Assert that the `turn-end` event for turn 2 has `reason: "cancelled"` and `lastText: null`.
  2. Test: a turn that ends with an error has `reason: "error"`.
  3. Fix: in `index.js`, build `lastText` only from `assistant/message` events whose `data.turn` equals the `turn` of the `turn/end` event. Map DSH's `reason.kind` to `completed`, `cancelled` or `error`, and keep the raw value in `reasonKind`.
  4. In `mcp/mcp.mjs`, `dsh_wait` returns `cancelled: true` when the turn-end reason is `cancelled`.
- **Expected result:** both tests pass. On `bridge-test`, cancelling a scratch turn after an earlier completed turn gives `lastText: null`, not the earlier text.
- **Evidence:** the test names, plus the `turn-end` event JSON from the live check.

### R1.2 `dsh_wait` stops on pending input (T2)
- [ ] **Steps:**
  1. Test: after `dsh_send`, the fake DSH emits `pending-input` with `kinds: ["approval"]` for that session. `dsh_wait` with `since` returns within 2 s with `pendingInput: ["approval"]` and `timedOut` not set.
  2. Test: a `pending-input` event for another session does not end the wait.
  3. Test: a `pending-input` event with `kinds: []` does not end the wait.
  4. Fix in `mcp/mcp.mjs` around line 107.
- **Expected result:** a wait never hangs on an approval or a question. The tool description says so.

### R1.3 `follow()` reports auth and protocol errors (T3)
- [ ] **Steps:**
  1. Test: the bridge answers 401. `dsh_wait` with `since` fails within 2 s with an error that contains `401`, not `timedOut`.
  2. Test: a 429 response gives a clear error.
  3. Test: a dropped connection is still retried, as it is today.
  4. Fix in `mcp/lib.mjs:79`: retry only network errors (no HTTP response). Throw on any HTTP status from 400 to 499. Make `watch.mjs` print the error and exit with code 2 on 401.
- **Expected result:** a wrong token is reported at once, by name.

### R1.4 Sender name always set (L2)
- [ ] **Steps:**
  1. Make `scripts/connect-claude-code.*` and every config example in the README set `DSH_AGENT_NAME`. Check them with a test that scans the README.
  2. When `DSH_AGENT_NAME` is not set, the MCP server writes one warning line to stderr at start.
  3. `/health` gains `defaultAgentSeen: true` after a request arrives with the agent name `mcp-agent`. Add a test.
  4. `doctor` prints a WARN with a fix line when `defaultAgentSeen` is true.
- **Expected result:** a client without a name is visible in `doctor`, and no documented config omits it.

### R1.5 `doctor` lists plugins that DSH denies (L3)
- [ ] **Steps:**
  1. Research: find where DSH 0.2.2-rc.3 records that it skipped `dsh-codex-subscription@3.2.6` for its version range. Check the output of `dsh plugin --profile bridge-test list`, the DSH log files and the profile state. Report the source (command or file, and the exact text).
  2. **Stop and report** if no stable source exists.
  3. Otherwise, `doctor` prints one WARN per denied plugin, with the hint `dsh plugin allow-version <name>@<version>`. First confirm in `dsh plugin --help` that this command exists, and use the real syntax.
  4. Add a test with a fixture of the source output.
- **Expected result:** the WARN for `dsh-codex-subscription` appears when `doctor` runs against `desktop`. The reviewer runs that check; the executor shows the fixture test. `doctor` changes nothing.

### R1.6 No token leak after a port clash (X2)
- [ ] **Steps:**
  1. Test: occupy the port, then start the bridge. Assert that the state file has no `token`, has `stale: true` and has an `error` string. The bridge logs an error.
  2. Test: the MCP client refuses a stale state file with the message `bridge is not listening (port in use); restart DSH or change the port`.
  3. Fix in `index.js`: handle `server.on('error')` before `listen`, and write the stale state file. Keep the saved token in memory and on the next successful listen, but do not write it to a state file that has no listener.

     Choose one design and say which in the report:
     - (a) a separate private file `agent-bridge.token`
     - (b) keep the token only in memory and regenerate it on the next boot

     Prefer (a) if the existing tests allow it.
  4. `doctor` reports FAIL with a fix line on a stale state file.
- **Expected result:** with port 7788 taken, no request from the MCP client carries the token.

### R1.7 Smaller fixes (P1, T6, X4)
- [ ] **P1:** remove `??` from `scripts/install.ps1:129` and add `#Requires -Version 5.1`. **Expected result:** `powershell.exe -NoProfile -File scripts/install.ps1 -?` parses without errors.
- [ ] **T6:** audit a failed cancel as `outcome: "failed"`. Add a test.
- [ ] **X4:** log unauthenticated requests with `agent: null` and `kind: "unauthorized"`. Add a test.

### R1.8 Release preparation
- [ ] **Steps:** bump the version to 0.6.2 in both `package.json` files. Add a `CHANGELOG.md` entry with one line per task. Pack the release locally with `npm pack`. Install the tarball on `bridge-test` with `./scripts/install.ps1 -Source local -Profile bridge-test`.
- [ ] **Live check on `bridge-test`:** health, token, send then wait, cancel (R1.1), approval wait (R1.2, with a scratch prompt that asks for a tool approval), wrong token (R1.3), port clash (R1.6), audit lines.
- **Expected result of R1:** CI green on the 4 jobs. All new tests named in the report. Every live check above shows PASS with its output.

---

## R2 · 0.6.3: all-in-one CLI

Branch `cli-0.6.3`. **Goal:** after install, nothing outside DSH is needed. No Node on PATH, no PowerShell 7 and no bash.

### R2.1 Runtime launchers
- [ ] **Steps:**
  1. Create `bin/dsh-bridge.cmd` (Windows) and `bin/dsh-bridge` (POSIX). Each finds a JavaScript runtime in this order and runs `bin/dsh-bridge.mjs`:
     1. `DSH_NODE`
     2. the DSH install: on Windows `%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe` with `ELECTRON_RUN_AS_NODE=1`; on macOS and Linux, research the paths and do not guess them
     3. `node` on PATH
  2. `dsh-bridge.mjs runtime` prints which runtime was used and its Node version.
- **Expected result:** on a shell where `node` is removed from PATH, `bin\dsh-bridge.cmd runtime` prints `dsh-electron 24.x`.
- **Evidence:** the output with PATH stripped.

### R2.2 One CLI with subcommands
- [ ] **Steps:** add `bin/dsh-bridge.mjs` with these subcommands:
  - `install`, `uninstall`, `doctor`, `connect`, `mcp`, `watch`, `health`, `runtime`
  - Port the logic from `scripts/*.ps1`, `scripts/*.sh`, `doctor.mjs`, `health.mjs`, `watch.mjs` and `mcp.mjs`.
  - Every command that changes something has `--dry-run`, which prints the actions and changes nothing.
- [ ] Test: run `install --dry-run` and `uninstall --dry-run` against a temporary fake profile. Assert the printed plan, and that no file changed.
- [ ] Keep the old scripts for one release as wrappers of about 3 lines that call the CLI and print `deprecated: use dsh-bridge <cmd>`.
- **Expected result:** each old script has a CLI equivalent with the same behaviour. The README documents only the CLI.

### R2.3 `connect` writes runtime-independent configs
- [ ] **Steps:** `connect claude|codex|generic --name <agent> [--execute]` writes or prints an MCP config whose command is the absolute launcher path from R2.1, with `DSH_AGENT_NAME` set. For Claude Code, use `claude mcp add`. For Codex, print the `config.toml` block; edit it only with `--execute`, and after making a backup.
- **Expected result:** after `connect claude --execute` on a test machine profile, `claude mcp get dsh-agent-bridge` shows the launcher, not `node`.

### R2.4 Offline install with checksum
- [ ] **Steps:** `install --source file --tarball <path> [--sha256 <hex>|--sha256-file <path>]` checks the hash before it calls `dsh plugin add`. On a mismatch it refuses and changes nothing.
- **Expected result:** a test proves the mismatch refusal. A live install from a local tarball works on `bridge-test`.

### R2.5 One version source and one protocol source (S4)
- [ ] **Steps:** `src/version.js` exports `VERSION` (read from the root `package.json`) and `PROTOCOL`. `doctor` fix lines use `VERSION`. A test fails if `mcp/package.json` has another version, or if a hard-coded `v0.` tag appears in `bin/` or `src/`.
- **Expected result:** a release bump touches one file. A test guards the second `package.json`.

### R2.6 Scripted live check (S6)
- [ ] **Steps:** `dsh-bridge live-check --profile bridge-test` runs the R1.8 live checks and prints PASS or FAIL per check. It refuses `--profile desktop` unless you pass `--read-only`, which runs only health, list and doctor.
- **Expected result:** one command gives the full live evidence of a release.

### R2.7 Smaller items
- [ ] **S5:** `watch --session` accepts a unique prefix. Add a test.
- [ ] **X6:** pin the GitHub actions by commit SHA. Set `permissions: contents: read` at the workflow level and `contents: write` only on the release job.
- [ ] **P3:** cache the session list for 1 s in the bridge, and skip `resolveId` for full ids. Add a test that counts the `sc.list` calls.

**Expected result of R2:** a clean Windows user account with DSH and no Node installs, connects and runs `doctor` with only `bin\dsh-bridge.cmd`. The reviewer checks this on the evidence; the owner checks it once by hand. CI is green.

---

## R3 · 0.7.0-pre: refactor, spikes, ping-lite

Branch `refactor-0.7`. Three parts, in this order. **R3.1 and R3.2 are one PR with no behaviour change.** R3.3 to R3.6 are a second PR on a new branch `ping-lite-0.7` after the first merges.

### R3.1 Split `index.js` (S1)
- [ ] **Steps:** move the code into `src/auth.js`, `src/audit.js`, `src/events.js` (ring, SSE, cursor), `src/pending.js`, `src/prompt.js`, `src/workspaces.js` and `src/routes.js`. `index.js` keeps only `name`, `inject` and `apply()` wiring.
- **Expected result:**
  - No test file changes except import paths.
  - All tests pass unchanged.
  - `index.js` is under 120 lines.
  - No module is over 250 lines.

### R3.2 DSH adapter (S2)
- [ ] **Steps:** `src/dsh.js` wraps every `ctx.*` call: `listSessions`, `state`, `events`, `prompt`, `cancel`, `create`, `agentStatus`, `pendingInputs`, `workspaces`, `onSessionEvent` and `registerRoute`. No other module touches `ctx`. The test helper fakes this adapter, not the raw `ctx`.
- **Expected result:** `grep -n "ctx\." src/` shows matches only in `src/dsh.js`.

### R3.3 Spike A: DSH agent tools
- [ ] **Steps:** on `bridge-test` only, register one tool `bridge_echo(text)` with `ctx.tools.register`. Copy the shape from `dsh-codex-subscription` (`lib/index.js` around line 17509) and cite the lines you used. From a scratch DSH session, call the tool. Record:
  - the tool object schema
  - what the tool handler receives, in particular **whether it identifies the calling session**
  - how a tool approval is shown
  - what the returned disposer does
- **Stop and report** if the handler does not give the calling session id.
- **Expected result:** a short report (`docs/spikes/dsh-tools.md`) with the cited sources and a screenshot or transcript of the call.

### R3.4 Spike B: prompt modes and context notes
- [ ] **Steps:** on scratch sessions, test which modes `sessionController.prompt` accepts on DSH 0.2.2-rc.3 (`followup`, `queue`, `steer`, and any other you find in source). For each mode, record what happens when the session is idle and when it is busy. Test `agent.inject(...)` the same way: does the note start a turn, and does the next turn see it? Cite the DSH source lines.
- **Expected result:** `docs/spikes/dsh-prompt-modes.md` with a table of modes against outcomes. It is the input for P3.3 and for the "inject" wake method.

### R3.5 Ping-lite (in memory)
Define the message shape once. Phase 3 must keep it.

``json
{ "type": "message", "id": "msg-<uuid>", "threadId": "thr-<uuid>", "inReplyTo": null,
  "from": "<agent>", "to": "<agent>", "kind": "ping|review-request|review-result|question|done",
  "summary": "≤ 2000 chars", "ref": { "repo": "…", "branch": "…", "sha": "…", "pr": 0 },
  "hop": 1, "auto": false, "time": 0 }
``

- [ ] `POST /ping` with `{to, kind, summary, ref?, threadId?, inReplyTo?}`. Validate the fields and the 2,000-character limit, emit the `message` event, and write an audit line (hash and length only). The `hop` value is the parent's hop plus 1; refuse when it is over 6. Add tests.
- [ ] `watch --agent <name> --until message|turn-end|pending-input --exit` prints one JSON line for the first matching event and exits 0. Add a test.
- [ ] DSH tool `bridge_ping`, using the R3.3 result. `from` is the calling session (`dsh:<shortId>`), never a parameter.
- [ ] MCP tool `bridge_ping` for external agents. `from` comes from `DSH_AGENT_NAME`; until Phase 3 it is only a label, and the tool description says so.
- [ ] Documentation: "in-memory, lost on DSH restart, replaced by the mailbox in 0.7.0".
- **Expected result, the round trip on `bridge-test`:**
  1. The reviewer runs `dsh-bridge watch --agent reviewer --until message --exit` in the background.
  2. A scratch DSH session calls `bridge_ping({to: "reviewer", kind: "review-request", summary, ref})`.
  3. The watcher exits within 2 s, and the reviewer wakes up.
  4. The reviewer answers with the MCP `bridge_ping({to: "dsh:<shortId>", kind: "review-result", inReplyTo})`, and the bridge prompts that DSH session (it is idle).
  5. The audit shows both messages with the same `threadId`.

  The reviewer takes part in this check; schedule it with the reviewer.

### R3.6 Event-stream hardening (T5, X3)
- [ ] Validate `since` (an integer ≥ 0, else 400). When `since` is older than the ring, first send `{"type":"gap","from":<since>,"oldest":<id>}`. Add tests.
- [ ] Accept only `Host: 127.0.0.1:<port>` or `localhost:<port>`, else 403. Add a test.
- **Expected result:** a client can always tell that it missed events.

---

## R4 · 0.7.0: Phase 3

Branch `phase-3-0.7.0`. Follow `phase-3-4-plan.md`, in this order: P3.1 → P3.2 → P3.3 → P3.6 → P3.7 → P3.4 → P3.5 → P3.8 → P3.9. The "Done when" column of that plan is the expected result. The changes below come from the audit.

- [ ] **R4.0 Threat model first (X1).** Before any code, update SECURITY.md. The token protects against other OS users and browsers. It does not protect against agents of the same user that have shell access. Scopes are for attribution and preventing accidents. **Expected result:** the reviewer approves the text before R4.1 starts.
- [ ] **R4.1 = P3.1**, with these changes:
  - a config switch `legacyToken: "on" | "read-only" | "off"`, default `on` in 0.7.0, with a doctor WARN while it is `on`
  - `agent add` prints the config snippet for the harness, not just the token
  - Windows: user-only ACL on the agents file, the state file and the audit log (X5), with a test that reads the ACL
- [ ] **R4.2 = P3.2.** The `message` shape from R3.5 is the stored record. Persist the bridged `requestId` table too (T7). **Expected result:** after a restart, earlier bridged prompts still show `role: agent-bridge`.
- [ ] **R4.3 = P3.3**, using the Spike B table. **Expected result:** two sends to a busy session are both delivered in order with no 409, and the T4 race test passes.
- [ ] **R4.4 = P3.6**, then **R4.5 = P3.7**, as written in that plan.
- [ ] **R4.6 = P3.4**, using the Spike A result. `bridge_ping` from R3.5 becomes `bridge_send` and `bridge_reply`. Keep `bridge_ping` as an alias for one release.
- [ ] **R4.7 = P3.5, R4.8 = P3.8, R4.9 = P3.9**, as written in that plan.
- **Expected result of R4:**
  - The R3.5 round trip works again, and it survives a DSH restart between the request and the reply.
  - Two fake agents set to always reply stop at hop 6, and the audit shows why.
  - A revoked token gets 401.

---

## R5 · 0.8.0: Phase 4

Branch `phase-4-0.8.0`. Order: P4.3 → P4.7 → P4.2 → P4.6 → P4.4 → P4.5. Every research step ends in `docs/spikes/<name>.md` with sources before any code.

- [ ] **R5.1 = P4.3 watcher adapter.** The R3.5 watcher becomes a wake method registered per agent. **Expected result:** a documented Claude Code recipe (a background task or Monitor command) that the reviewer has run.
- [ ] **R5.2 = P4.7 discovery.** **Expected result:** `bridge_agents()` lists the kind, scopes, wake method and last-seen time.
- [ ] **R5.3 = P4.2 MCP tasks.** Research: which MCP revision defines tasks, whether the installed Claude Code supports them, and how a client advertises them. **Stop and report** if Claude Code does not support them. Plain tools stay available.
- [ ] **R5.4 = P4.6 Codex and webhook.** Research the Codex non-interactive resume command from Codex's own `--help` and docs, with the version. Implement a webhook only to a URL that the receiver registered, on loopback only.
- [ ] **R5.5 = P4.4 channel**, optional and off by default. **R5.6 = P4.5 inbox socket**, only if it is documented; otherwise record "dropped" with the reason.

---

## 2. Executor report template

Send this report through the bridge when a release PR is ready, and when you stop.

``
Release: R<n> · <version> · branch <name> · PR <url>
Status: ready for review | stopped (<stop condition>)

Tasks:
- R<n>.<m> [x|-] <one line>; tests: <names>; evidence: <command → result>

CI: <link> · windows/22 <ok> · windows/24 <ok> · ubuntu/22 <ok> · ubuntu/24 <ok>
Live check (bridge-test): <check → PASS/FAIL>, one line each
Commit order: test commit <sha> before fix commit <sha>, per task

Not verified: <list, with reason>
New findings (not fixed here): <list>
Questions for the owner: <list or none>
``

---

## 3. Review protocol

For each release PR, the reviewer:

1. **Checks scope.** Every changed file belongs to a task of this release. Nothing else.
2. **Checks test-first.** For each task, the `test:` commit is before the fix commit. Check out the test commit and run it alone; it must fail for the stated reason.
3. **Checks the expected result** of every task against the evidence, and runs the claims that can be reproduced again on `bridge-test`.
4. **Checks safety:**
   - no token in code, logs, tests or the report
   - loopback only
   - the audit holds no prompt text
   - no change to the `desktop` profile
   - the bridge never answers approvals
5. **Checks the docs:** README, SECURITY.md and CHANGELOG match the behaviour.
6. **Gives a verdict** in the PR and through the bridge:
   - **Approve**
   - **Changes requested**, with findings as `file:line, problem, expected`
   - **Stop**, if the release breaks a rule in section 0
7. **After the owner installs** (in a quiet window agreed with the TurboMCP session), runs `dsh-bridge doctor` and `live-check --read-only` on `desktop`, and closes the release on the status board.

A release is done only when the owner has merged and installed it and the reviewer's post-install check passes.
