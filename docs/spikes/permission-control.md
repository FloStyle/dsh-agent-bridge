# Spike W0.2: reading and changing a session's mode and preset from a plugin

Date: 2026-11-19. DSH 0.2.2-rc.3, profile `bridge-test`.

## Findings

| Need | API | Verified |
|---|---|---|
| Read the current preset | `ctx.permissionPresets.current(session)` returns a preset name, or `custom` when the knob values match no configured preset | yes |
| List the presets | `ctx.permissionPresets.catalog()` returns `{options, defaultOptions, defaultPreset}`. On `bridge-test`: `read-only`, `workspace-write`, `danger-full-access`; default `workspace-write` | yes |
| Switch preset | `ctx.permissionPresets.set(session, name)`; unknown names throw | read in source |
| Switch sandbox mode only | `setSandboxMode(session, mode)` from `@deepseek-ai/dsh-sandbox-policy`. It appends the session event `sandbox/mode {mode}` | yes, through `session.append('sandbox/mode', {mode})` |
| Switch approval policy only | the session event `approval/policy {policy}` (`ask` or `never`) | yes |
| Persistence | Mode events are part of the session log. After a DSH restart, the log still held `workspace-write`, `read-only`, `workspace-write`, `read-only`, in the order they were written | yes |

Other observations:
- Changing one knob directly (for example only the approval policy) makes `current(session)` return `custom`, because the pair no longer matches a configured preset.
- The plugin context exposes `sandboxPolicy` methods `resolve`, `sessionWorkspaceRoot`, `registerWritableRoot` and `overrideOf`.
- A plugin reaches the session object through the `session/event` listener `(session, event)`. The session object has `append`, `snapshotEvents`, `header` and `id`.

## Consequences for the access work

- The bridge can show each session's mode and preset (W3) with `permissionPresets.current(session)`.
- The bridge can lower a session to `read-only` or `workspace-write` with `permissionPresets.set`. The design rule stays: it never sets `danger-full-access`.
- Applying a profile means `permissionPresets.set` plus one `registerWritableRoot` per extra folder, and the roots must be registered again after every restart.

## Sources

- `@deepseek-ai/dsh-permission-presets/lib/types/index.js`: `current(session)` (around line 264) and `set(session, name)` (around line 318).
- `@deepseek-ai/dsh-sandbox-policy/lib/index.js`: `setSandboxMode(session, mode)` appends `sandbox/mode` (around line 41).
