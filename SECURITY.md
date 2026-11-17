# Security and privacy

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
  label from a client-supplied header**, not authentication. Any holder of the
  token can choose the label; the audit log records the same value. Leading
  sender-looking lines are stripped from client text so a client cannot make its
  message look like it came from the owner or another agent.
- Dispatched prompts, creates and cancels are appended to
  `~/.dsh/agent-bridge-audit.jsonl` as time, agent, action, session, mode, text
  length and the SHA-256 of the original prompt text. The text is not stored.
  The file rotates to `.1` at 1 MiB and is private runtime state: protect it like
  the state file.
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
