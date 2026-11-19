# Spike W0.4: can a plugin set environment variables for one session's shells?

Date: 2026-11-19. DSH 0.2.2-rc.3. Answer from source and docs.

## Answer: no, except variables named `DSH_*`

`@deepseek-ai/dsh-shell-env` owns the environment that every model shell call (bash or pwsh) receives. Plugins can add their own facts with `ctx.shellEnv.register({name, variables, resolve})`, but:

- every key must start with the `DSH_` prefix (`DSH_ENV_PREFIX`, imported from `@deepseek-ai/dsh-shell`)
- every key must be declared up front
- an undeclared key, or a value that is not a string, fails the shell call with `ShellEnvError` (`SHELL_ENV_CONTRIBUTION_INVALID`)

So a bridge profile **cannot** set `PIP_CACHE_DIR`, `npm_config_cache`, `NUGET_PACKAGES` or an Unreal cache path for a session's shells.

## Consequences

- Task W5.2 ("profile env") is dropped.
- Cache redirection stays a layout choice that the user makes once, in the tools' own config files or the user environment. The access guide (`docs/access-guide.md`) covers it.
- A profile could still expose its own facts as `DSH_BRIDGE_*` variables (for example `DSH_BRIDGE_PROFILE`), which scripts can read. That is optional and not planned.

## Sources

- `@deepseek-ai/dsh-shell-env/README.md`: "What every shell call receives" and "Adding your own environment facts".
- `@deepseek-ai/dsh-shell-env/lib/index.js`: the keys are built from `DSH_ENV_PREFIX` (around lines 5 and 37).
