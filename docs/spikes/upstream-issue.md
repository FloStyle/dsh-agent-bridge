# Draft upstream issue (W0.5): writable roots are not passed to sandboxed subprocesses on Windows

Draft only. The owner decides whether to file it with DeepSeek Harness.

---

**Title:** Windows: `registerWritableRoot` and `additionalWritableRoots` do not reach sandboxed shell processes

**Version:** DSH 0.2.2-rc.3, Windows 11.

**What happens**

A session in `workspace-write` mode gets an extra writable folder, through `ctx.sandboxPolicy.registerWritableRoot(session, dir)` or the `additionalWritableRoots` config of `@deepseek-ai/dsh-sandbox-policy`. The file tools honor it. Shell commands (`pwsh`) are still denied in that folder:

| Tool | Extra root registered | Result |
|---|---|---|
| file `write` | yes | written |
| `pwsh` `Set-Content` | yes | `Access to the path '…' is denied.` `[sandbox: file access denied under workspace-write mode]` |

The sandbox-policy README documents this as a known limitation.

**Why it matters**

Real work writes outside the session cwd through shell tools: build tools writing into an engine folder, `git` writing the shared `.git` folder of a linked worktree, package managers writing their caches. In `workspace-write`, these always fail on Windows, so users switch sessions to `danger-full-access`, often with approvals set to `never`. A working per-session root for subprocesses would let them stay in `workspace-write`.

**Suggested change**

`@deepseek-ai/dsh-sandbox-windows-acl` already accepts several folders: `new AclSandbox({ writableDirs: [...] })`. Passing the resolved roots of the call (configured plus registered) into `writableDirs` for confined `pwsh` and `bash` calls would close the gap. The standing ACL grant per folder could reuse the existing capability-SID cache.

**Related: HTTPS fails in the same sandbox**

In `workspace-write`, every Schannel client fails with `SEC_E_NO_CREDENTIALS`: `git` with default settings, `curl.exe`, `Invoke-WebRequest`. OpenSSL-based clients work (Node, Python, `git -c http.sslBackend=openssl`). The restricted token appears to block Schannel's credential acquisition. Details: `docs/spikes/https-in-sandbox.md`.

**Workaround today**

Choose a session cwd that contains every folder the session writes, and send caches to folders inside it.
