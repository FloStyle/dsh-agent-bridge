# Spike W0.1: per-session writable roots on Windows

Date: 2026-11-19. DSH 0.2.2-rc.3, Windows 11, profile `bridge-test`.

## Question

Does `ctx.sandboxPolicy.registerWritableRoot(session, dir)` let a `workspace-write` session write into an extra folder outside its cwd, for the DSH file tools and for shell commands?

## Setup

- A throwaway plugin (not shipped) injected `sandboxPolicy`, `permissionPresets` and `sessionController` on a scratch DSH instance.
- A scratch session with cwd in a temporary folder, mode `workspace-write`.
- Approval policy set to `never`, so a sandbox denial is final instead of turning into an approval prompt. This used the same `approval/policy` session event that the approval service writes.
- The extra folder was **outside** `%TEMP%`, in a scratch folder under the user's dev drive. See the note below.

## Results

| Step | Tool | Root registered | Result |
|---|---|---|---|
| a0 | file `write` | no | denied: `FS_SANDBOX_DENIED` |
| a | file `write` | yes | **written** |
| b | `pwsh` (`Set-Content`) | yes | **denied**: `Access to the path '…\b.txt' is denied.` and `[sandbox: file access denied under workspace-write mode]` |
| a2 | file `write` | disposed | denied: `FS_SANDBOX_DENIED` |
| a3 | file `write` | registered, then DSH restarted | denied: the registration does not survive a restart |

There is no `bash` tool in this Windows composition, so the bash case does not apply here.

## Conclusions

1. `registerWritableRoot` works for the DSH file tools, and its disposer removes the grant at once.
2. **Sandboxed PowerShell commands ignore registered roots on Windows.** This confirms the limitation in the `@deepseek-ai/dsh-sandbox-policy` README ("Known limitations": Windows subprocesses keep workspace and private-temp access only).
3. Registrations are not persisted. A bridge feature that relies on them must re-register after every DSH restart, resume or fork.
4. **Note on `%TEMP%`:** in a first run, the extra folder was under `%TEMP%`. The file tool then wrote there even without a registration and after disposal, while PowerShell was still denied. The file tools appear to treat the temporary area as writable. A test of roots must use a folder outside `%TEMP%`.

## Sources

- `@deepseek-ai/dsh-sandbox-policy/lib/index.js`: `registerWritableRoot(session, directory)` returns a Cordis effect disposer (around line 204).
- `@deepseek-ai/dsh-sandbox-policy/README.md`: sections "Registering a session's writable directory" and "Known limitations and deferred work".
- `@deepseek-ai/dsh-sandbox-windows-acl/README.md`: the ACL backend grants the workspace and a private temporary folder.
