# Spike R3.3: giving DSH agents tools

Date: 2026-11-19. DSH 0.2.2-rc.3.

## Findings

| Question | Answer | Source |
|---|---|---|
| How does a plugin register a tool? | `ctx.tools.register(defineTool({name, description, parameters, output, execute}))`. The registration returns a disposer; register it inside an effect so the tool disappears with the plugin. | `@deepseek-ai/dsh-tools/README.md`, "Register a tool"; `dsh-better-sidebar/lib/index.js` imports `defineTool` from `@deepseek-ai/dsh-tools` and registers around line 5269 |
| Can a profile plugin import `defineTool`? | Yes, `dsh-better-sidebar` does. The bridge imports it dynamically and falls back to a plain definition when the import fails. | as above |
| **Does the tool know the calling session?** | **Yes.** `execute(args, exec)` receives `exec.agent`, and `exec.agent.session` is the calling session. DSH's own `todo_write` tool appends to `exec.agent.session`. | `@deepseek-ai/dsh-tool-todo/lib/index.js` around line 172; `dsh-tools/lib/pipeline.js` around line 299 (`const agent = exec.agent`) |
| Is the `tools` service always there? | Not guaranteed, and asking for a service the plugin did not declare throws. The bridge declares `tools` in a sub-plugin (`agent-bridge-tools`), so a DSH build without it disables only the tools. | `@deepseek-ai/cordis/lib/index.js` around line 1271 ("cannot get property … without inject") |
| Approvals | Tool calls go through DSH's tool policy (`allow` / `deny` / `ask`) like every other tool. The bridge adds no approval path. | `dsh-tools/README.md`, summary |

## Live check

On `bridge-test`, a scratch session called `bridge_ping` with `to: "reviewer"`. The bridge recorded `from: "dsh:aae0e870"`, which is the calling session, and the watcher waiting for `reviewer` woke within 2 seconds. Details are in the PR.
