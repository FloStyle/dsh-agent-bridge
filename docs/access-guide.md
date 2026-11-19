# Working in `workspace-write` instead of full access

On Windows, a DSH session in `workspace-write` mode may write only inside its working folder (its cwd) and a private temporary folder. Shell commands such as `pwsh` stay inside that boundary even when a plugin registers extra writable folders; only the DSH file tools honor extra folders. See `docs/spikes/writable-roots.md`.

So the way to avoid `danger-full-access` is to make the work happen **inside the session cwd**. This guide lists the usual reasons a session writes outside it, and what to change. To find your own reasons, run the access report:

```sh
node scripts/access-report.mjs --since 7d
```

Each recipe says whether it was tested on the `bridge-test` profile. The untested ones are the tools' own documented settings.

## 1. Choose a cwd that contains everything the session writes

The session cwd cannot change after the session is created. Pick it before you start:

- **One repository:** the repository root.
- **A repository and its linked worktrees:** a linked worktree writes into the main checkout's `.git` folder. Pick a parent folder that contains both, for example `D:\dev` for `D:\dev\project` and `D:\dev\worktrees\feature`. Alternatively, use a full clone instead of a linked worktree; a clone keeps its own `.git` folder.
- **A project and an engine built from source:** builds write into the engine folder too. The cwd must contain both, or the build runs in a session with wider rights.

Tested: the writable boundary of `workspace-write` for shell and file tools. Not tested: each layout above.

## 2. Send tool caches into the cwd

Package managers and build tools write caches under your user profile by default. Point them at a folder inside the cwd, for example `<cwd>\.cache\<tool>`. Configure this once, in the tool's own config, before the session starts.

| Tool | Setting | Tested |
|---|---|---|
| pip | `pip config set global.cache-dir <cwd>\.cache\pip`, or the `PIP_CACHE_DIR` environment variable | no |
| npm | `npm config set cache <cwd>\.cache\npm` | no |
| pnpm | `pnpm config set store-dir <cwd>\.cache\pnpm-store` | no |
| NuGet | the `NUGET_PACKAGES` environment variable, or `globalPackagesFolder` in a `nuget.config` in the cwd | no |
| Unreal DerivedDataCache | the `UE-LocalDataCachePath` environment variable, or the local DDC path in the project config | no |

A DSH plugin cannot set these variables per session; DSH accepts only `DSH_*` variables from plugins (`docs/spikes/shell-env.md`). Set them in the tool's config file or in your user environment.

## 3. Grant extra folders for file edits only

When the session only needs to **edit files** in another folder (no shell command writes there), an extra writable root works. The bridge's access profiles will register them per session. Until then, the `additionalWritableRoots` config of `@deepseek-ai/dsh-sandbox-policy` grants folders to every session of a profile.

## 4. When nothing above fits

Some work must write outside any single folder. Two options, safest first:

1. **Full access with approvals on.** DSH permission presets are configurable per profile. A preset that keeps the sandbox open but still asks before risky actions is safer than full access with approvals set to `never`:

   ```yaml
   # profile cordis.patch.yml (untested; try it on a test profile first)
   - name: '@deepseek-ai/dsh-permission-presets'
     config:
       presets:
         workspace-write: { sandbox: workspace-write, approval: ask }
         full-ask: { sandbox: danger-full-access, approval: ask }
         danger-full-access: { sandbox: danger-full-access, approval: never }
       defaultPreset: workspace-write
   ```

2. **A short full-access session** for the one step that needs it (for example the engine build), while the rest of the work stays in `workspace-write` sessions.

## Upstream

The real fix is for DSH to pass extra writable folders to sandboxed shell processes on Windows. A draft issue is in `docs/spikes/upstream-issue.md`.
