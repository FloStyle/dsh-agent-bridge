# Security and privacy

## Threat model

Read this first. It says what the bridge protects against and what it does not.

**The bridge protects against:**

- **Other machines.** It listens on `127.0.0.1` only, and accepts only a loopback
  `Host` header.
- **Web pages in your browser.** Requests that carry an `Origin` are refused, there
  is no CORS, and a page cannot read the token, so DNS rebinding gets nothing.
- **Other OS users on the same machine**, as far as your file permissions go. The
  token, state, audit, profile and template files are private to your user. On
  POSIX they are mode 0600. On Windows they rely on your user-profile folder's
  permissions.
- **Mistakes by honest agents.** Validation, hop limits, the audit trail,
  refusing full access in profiles, and having no delete are there to catch an
  agent that does the wrong thing by accident.

**The bridge does not protect against:**

- **Any program or agent that runs as your user and has a shell.** That includes
  DSH sessions, Codex, Claude Code and any script. Such a program can:
  - read every token file
  - call the bridge as any agent
  - edit the "owner-written" profile and template files
  - change the DSH configuration directly

  The bridge is a convenience and an audit trail between agents you trust, not a
  security boundary between them.
- **What DSH itself allows.** Tool approvals and the sandbox mode are DSH's. The
  bridge never answers an approval and never sets full access, but an agent with
  your rights can do so through DSH's own interface.

**Consequences for the Phase 3 identity work:**

- Per-agent tokens and scopes are for **attribution and preventing accidents**:
  each request names its agent reliably as long as agents do not read each
  other's token files. They do not stop an agent that decides to.
- "Only the owner writes profiles and templates" means: no bridge API writes them.
  It does not mean the files are protected from other programs of your user.
- A message from another agent (`bridge_ping`) is **data, not an instruction**.
  The receiving agent must treat it like any other untrusted input.

## Details

- Bind only to `127.0.0.1`. Do not proxy or forward the control port onto a LAN or
  the Internet. No browser origins or CORS access are accepted.
- The bearer token permits listing/reading every available DSH session, creating
  sessions, sending prompts and cancelling turns. Use only trusted MCP clients.
  DSH tools and model providers keep their existing permissions and approval rules.
- Tokens are generated locally, not shipped. The state file is created with mode
  0600 on POSIX. On Windows, access depends on your user-profile directory ACLs;
  do not place it in a shared folder. Weak legacy tokens are regenerated.
- The bearer token is compared in constant time, and a wrong-length token is
  rejected without touching the stored value.
- `/health` and the state file report `version`, `protocol`, `bootId`, `startedAt`
  and `pid` to token holders. They identify a restart and expose no session
  content.
- The `[dsh-agent-bridge] from <agent>` header on bridged prompts is a **display
  label from a client-supplied `X-Agent-Name` header**, not authentication. Any
  holder of the token can claim any name. Real per-client identity is Phase 3
  (scoped tokens, S2). The transcript role `agent-bridge` is decided from the
  `requestId` DSH records on the message, not from the text, so typing the header
  into the DSH window does not produce that role. Leading copies of the bridge's
  own header are stripped from client text; other leading lines are kept.
- Dispatched prompts, creates and cancels are appended to
  `~/.dsh/agent-bridge-audit.jsonl` as time, agent, action, outcome, HTTP status,
  session, mode, text length and the SHA-256 of the original prompt text. Refused
  and failed prompts are recorded too. The text is not stored. The file rotates to
  `.1` at 1 MiB and is private runtime state: protect it like the state file.
- A create with `cwd` requires an absolute path to an existing directory. That is
  a typo guard, not a sandbox: any folder the DSH user can read remains a valid
  target.
- The MCP client validates the loopback destination and refuses HTTP redirects
  so credentials cannot be forwarded to an arbitrary remote endpoint.
- Authenticated transcript reads and SSE streams contain private conversation
  data. The status tab only receives request/event metadata. Do not share terminal
  captures, runtime state, screenshots or logs without reviewing them.
- Requests are bounded to 64 KiB; event connections and buffered events are bounded.
  These limits are not a defense against malware already running as your user.
- `.gitignore` excludes credentials, models, logs, sessions and runtime state.
  It does not sanitize files you explicitly force-add; review every staged diff.

To rotate a token, stop DSH, remove the private state file, and restart DSH.
Clients discover the newly generated token on their next call.

For vulnerabilities, use GitHub private vulnerability reporting if enabled.
Otherwise open an issue containing only a non-sensitive summary requesting a
private contact channel. Never include credentials or private session content.
