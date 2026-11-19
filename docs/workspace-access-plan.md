# dsh-agent-bridge track W: session, workspace and access management

Version 1, 2026-11-17.
Same rules, report template and review protocol as `execution-plan.md` (sections 0, 2 and 3).

**Goal:** sessions run in `workspace-write` with exactly the extra folders they need, instead of switching to `danger-full-access` with approvals off. The bridge also lets agents and the owner see and manage sessions, workspaces and access modes.

---

## 1. Evidence: why full access is needed today

I scanned the session logs in `~/.dsh/sessions` (read-only). They are concatenated zstd frames, one per append batch.

| Session | Start | Later | Paths near denials (top) |
|---|---|---|---|
| Session A (engine work) | `workspace-write` + ask | `danger-full-access` + never | `C:\UnrealEngine\Engine`, `<project folder>`, `<worktrees folder>`, `C:\` |
| Session B (engine work) | same | same | `C:\UnrealEngine\Engine` (143 hits), `%USERPROFILE%`, `<worktrees folder>` |
| Session C (plugin work) | same | same | `%USERPROFILE%` (81 hits), `<project folder>` |
| Session D | same | same | — |
| DSHAgentBridge sessions | `workspace-write` + ask | unchanged | — |

All four of these sessions have cwd `C:\Dev`. They needed writes in three places outside it:
- the engine at `C:\UnrealEngine`, for build output and caches
- the user profile at `%USERPROFILE%`, which holds `~/.dsh`, AppData, tool caches and package caches
- shared Git directories, for worktrees

The path counts are hints from the text near each denial, not exact write targets. Task W0.3 measures them properly.

## 2. What DSH 0.2.2-rc.3 offers (verified in the shipped package READMEs)

| Mechanism | Scope | Persisted | Windows shell (bash/pwsh) | Windows file tools (write/edit) |
|---|---|---|---|---|
| Session cwd | the writable boundary; cannot change after creation | yes | yes | yes |
| `sandboxPolicy.registerWritableRoot(session, dir)`, a plugin API | one live session | **no**: re-register after a restart, resume or fork | **ignored** | honored |
| `additionalWritableRoots` (deployment config) | all sessions | config | **ignored** | honored |
| Sandbox mode `read-only` / `workspace-write` / `danger-full-access` | per session, switchable, logged | yes | — | — |
| Permission presets (`ctx.permissionPresets`) | a sandbox mode plus an approval policy (`ask` / `never`). Configurable table, default preset for new sessions. | yes | — | — |
| Workspace registry (`ctx.workspaceRegistry`) | one directory per project. Groups sessions, can hide them. | yes | — | — |

Sources:
- `@deepseek-ai/dsh-sandbox-policy`: README, the sections "Registering a session's writable directory" and "Known limitations"
- `dsh-permission-presets`: README
- `dsh-sandbox-windows-acl`: README
- `dsh-workspace`: README

All four are inside `resources/app.asar` of the DSH install.

**The key fact:** on Windows, extra writable roots work for DSH's file tools but **not for shell commands**. Git, Unreal Build Tool (UBT), Python and pip all run as shell processes, so they still fail outside the cwd. That is why sessions end up in full access. The Windows sandbox backend's own API already accepts several writable directories (`AclSandbox({ writableDirs: [...] })`). The gap is in how DSH wires it up, not in the backend.

## 3. Design principles

1. **Only the owner defines grants.** Access profiles live in a file that the owner edits. Agents can apply a profile by name, but can never add a path through the API.
2. **The bridge never escalates to full access.** It can lower a session to `workspace-write` or `read-only`, and it can apply an owner profile. Switching to `danger-full-access` stays a human action in the DSH UI.
3. **Measure before granting.** The access report shows what was denied. The owner decides what to grant.
4. **Visible state.** Every session's mode, approval policy and grants are readable through the API, MCP and the Bridge tab. Every grant is written to the audit log.
5. **No sandbox bypass.** The bridge never adds a tool that runs commands outside DSH's sandbox.

---

## 4. Tasks

Track W ships in three releases. Section 5 places them among the other releases.

| Release | Branch | Tasks | Needs |
|---|---|---|---|
| **WA · measure** | `access-measure` | W0, W4 (as a standalone script), W5.1 | R1 merged |
| **WB · profiles** | `access-profiles` | W1, W2, W3 | R2 (CLI) and R3.1–R3.2 (adapter) merged, WA results |
| **WC · manage** | `access-manage` | W5.2, W6; W4 moves into the CLI | WB merged, ping-lite merged |

### W0 · Spikes on `bridge-test` (no product code)

- [ ] **W0.1 Writable-root API.** From a test plugin build on `bridge-test`, call `ctx.sandboxPolicy.registerWritableRoot(session, dir)` for a scratch session and a scratch folder outside its cwd. In that session:
  - (a) use the file `write` tool in the folder
  - (b) run `pwsh -c "Set-Content <dir>\x.txt hi"`
  - (c) run the same with bash

  Record which ones succeed. Then dispose the registration and run (a) again.

  **Expected result:** `docs/spikes/writable-roots.md` with a table of outcomes. If the README is right, (a) passes and (b) and (c) are denied. Cite the source lines of the API and the denial text.

  **Stop and report** if the API cannot be reached through the plugin's context.
- [ ] **W0.2 Mode and preset control.** Find how a plugin reads and sets a session's preset (`ctx.permissionPresets.current(session)` and `set()`) and sandbox mode (`setSandboxMode`). Test this on a scratch session: switch it from `workspace-write` to `read-only` and back. Confirm that the switch appears in the session log and survives a restart of `bridge-test`.

  **Expected result:** documented calls, with the source lines cited.
- [ ] **W0.3 Denial source.** Find the structured form of a sandbox denial in session events: the error code, the path, and the tool. Use the DSH session API (`sessionController.events`), not the raw files.

  **Expected result:** a mapping that W4 can use, from denial event to `{tool, path, code}`.
- [ ] **W0.4 Shell environment per session.** Find out whether a plugin can set environment variables for one session's shells, through `dsh-shell-env` or something else. This would let a profile send cache folders (pip, NuGet, Unreal's DerivedDataCache) into the cwd instead of `%USERPROFILE%`.

  **Expected result:** yes or no, with the source.
- [ ] **W0.5 Upstream issue draft.** Write the text of a DSH issue: "On Windows, `registerWritableRoot` and `additionalWritableRoots` are not passed to sandboxed subprocesses. `AclSandbox` already accepts `writableDirs`." Include the W0.1 table.

  **Expected result:** a draft in `docs/spikes/upstream-issue.md`. The owner decides whether to file it.

### W1 · Access profiles

- [ ] **Steps:**
  1. Add the file `~/.dsh/agent-bridge-profiles.json`, user-only like the agents file in P3.1. Each profile has:
     - `name`, `description`
     - `cwd`: an absolute, existing directory
     - `extraRoots[]`
     - `preset`, or `mode` + `approval`
     - `env{}`, only if W0.4 says yes
  2. Validation refuses:
     - a drive root (`C:\`)
     - the user's home folder itself
     - `~/.dsh` and `~/.ssh`
     - anything containing `.git\hooks`
     - paths that do not exist

     An explicit `"allowSensitive": true` on that one root overrides the refusal and gives a doctor WARN.
  3. CLI: `dsh-bridge profile list|show|add|remove|validate`. `add` writes only after showing the diff, and prints "only the owner should run this".
  4. Tests for each validation rule.
- **Expected result:** a profile like the example below validates. `C:\` and `%USERPROFILE%` are refused with a clear reason.

``json
{ "name": "turbomcp-candidate", "cwd": "C:\\Dev",
  "extraRoots": ["C:\\UnrealEngine\\Engine\\Intermediate", "C:\\UnrealEngine\\Engine\\Saved"],
  "preset": "workspace-write" }
``

The exact `extraRoots` come from the W4 report. They are not decided here.

### W2 · Apply a profile to sessions

- [ ] **Steps:**
  1. `POST /sessions {profile, text}` and `dsh_send({profile, ...})`:
     - create the session in the profile's cwd and workspace
     - set the preset
     - register each extra root
     - audit one `grant` line per root
  2. `POST /sessions/:id/profile {profile}` applies a profile to an existing session. The cwd must match the profile's cwd, else 409. A session's cwd cannot change.
  3. Store the session-to-profile mapping in `~/.dsh/agent-bridge/session-profiles.json`. On `agent/created` (resume, restart or fork), re-register the roots of a mapped session, because DSH does not persist them. Add a test with a fake restart.
  4. Refuse a profile whose preset is `danger-full-access`, with this message: "full access is set by the owner in DSH, not through the bridge".
- **Expected result:** on `bridge-test`, a session created with a profile still has its roots after a DSH restart. The audit shows the grants. W0.1 sets what a "working root" means: file tools on all platforms, and shells too only where DSH supports it.

### W3 · Visibility

- [ ] **Steps:**
  1. `GET /sessions/:id/access` returns `{mode, approval, preset, profile, roots[], since}`. Add the MCP tool `dsh_access` (read-only).
  2. `dsh_list` gains `mode` and `preset` per session.
  3. The Bridge tab shows a mode badge per session. It marks `danger-full-access` sessions in red with the time since the switch, and lists the registered roots.
  4. `doctor` lists sessions that have been in `danger-full-access` for more than 24 h (WARN, report only).
- **Expected result:** the owner sees in one place which sessions have full access and since when.

### W4 · Access report (read-only)

- [ ] **Steps:** in WA, write this as `scripts/access-report.mjs`. It runs with the same arguments and needs no CLI. In WC, it moves into the CLI as `dsh-bridge access-report [--session id|--workspace name] [--since 7d]`. It uses the W0.3 mapping. It groups denials by tool kind (file tool or shell) and by the deepest common folder, and prints a suggestion per group:
  - "add root X": works for file tools
  - "shell write outside cwd, not fixable with roots on Windows; see W5"
  - "cache folder: redirect with env (W0.4)"

  It never changes anything.
- **Expected result:** the report for session B names the folders under `C:\UnrealEngine\Engine` and `%USERPROFILE%` that were written, with counts. The owner uses it to write the first real profile.

### W5 · The Windows shell gap: mitigations, in order of preference

- [ ] **W5.1 Layout guidance.** Document how to keep shell writes inside the cwd:
  - choose a cwd that contains both the main checkout and its worktrees (for example `C:\Dev`)
  - or use a full clone instead of a linked worktree
  - point build caches and output to folders under the cwd where the tool allows it (Unreal's DerivedDataCache and Saved through project ini or env, pip and NuGet through env)

  **Expected result:** `docs/access-guide.md`, with one tested example per tool on `bridge-test`.
- [ ] **W5.2 Profile env.** Only if W0.4 says yes: the profile's `env` is applied to the session's shells. **Expected result:** a pip install in a profile session writes its cache under the cwd.
- [ ] **W5.3 Upstream.** The owner files the W0.5 issue. When DSH fixes it, W2 roots work for shells too, with no bridge change.
- **Not planned, and rejected:** a bridge tool that runs shell commands outside DSH's sandbox. It would bypass DSH's sandbox and approval rules, which breaks the bridge's non-goals.

### W6 · Session and workspace management

- [ ] **Steps:** first check each operation in the `dsh-workspace` and session controller READMEs and their source. Implement only the operations that DSH exposes:
  - `dsh_workspace_create(path, title)` and `dsh_workspace_rename`
  - `dsh_session_title(sessionId, title)`
  - `dsh_session_archive` and `dsh_session_unarchive` (hide and show, never delete)
  - `dsh_sessions_by_workspace`
  - templates: `profile` + optional agent preset + first prompt, saved by the owner, used through `dsh_send({template})`

  Deleting a session or workspace stays a human action in DSH.
- **Expected result:** a scratch session can be created from a template, renamed, archived and shown again, all through MCP, on `bridge-test`. An old test session is archived only after the owner approves.

---

## 5. Placement in the overall plan

Order approved by the owner on 2026-11-17:

1. R1 · 0.6.2 (in progress)
2. **WA · measure:** W0 spikes, W4 access report (script), W5.1 layout guide
3. R2 · 0.6.3: CLI
4. R3.1–R3.2: refactor PR
5. **WB · profiles:** W1–W3
6. R3.3–R3.6: ping-lite
7. **WC · manage:** W5.2, W6, access report into the CLI
8. R4 · Phase 3
9. R5 · Phase 4

Reasons:
- **WA comes first because it is cheap and decides the value of the rest.** If W0.1 confirms that Windows shells ignore extra roots, profiles alone will not take the TurboMCP sessions out of full access. The relief then comes from layout and cache redirection (W5), and WB is scoped down to match.
- WA also tests the DSH plugin APIs that R3.3 needs, so it lowers the risk of the ping work.
- WB is product code. It belongs on the CLI (R2) and the DSH adapter (R3.2), and its profiles are written from the WA report, not from guesses.

**Gate after WA:** the reviewer and the owner read the WA results. Then they confirm or cut the WB scope before WB starts.

Version numbers are set when each release is tagged. After R1 merges, I copy this order into `docs/execution-plan.md`.

## 6. Quick option before any code (owner decision)

DSH presets are configurable. A preset `full-ask` (`sandbox: danger-full-access`, `approval: ask`) would let shells write anywhere but ask before each sensitive action. That is safer than today's `full access + never`. It is a change to the `desktop` profile's cordis config and needs a DSH restart. Test it on `bridge-test` first, and schedule the restart in a quiet window with the TurboMCP session.
