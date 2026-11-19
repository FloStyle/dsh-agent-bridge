# Spike: HTTPS from a `workspace-write` shell on Windows

Date: 2026-11-19. DSH 0.2.2-rc.3, Windows 11, profile `bridge-test`, a scratch session in `workspace-write`. Public URLs only.

## Why this was checked

A session note in real work said that Windows-native HTTPS clients fail inside the DSH sandbox with `SEC_E_NO_CREDENTIALS`. If true, any session that fetches or pushes over HTTPS must leave `workspace-write`, whatever folders it writes.

## Results

| Client | TLS stack | Result |
|---|---|---|
| `Invoke-WebRequest https://example.com` | Windows Schannel | **failed**: `Authentication failed, see inner exception.` |
| `curl.exe https://example.com` (Windows build) | Schannel | **failed**: `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030e)` |
| `git ls-remote https://github.com/…` | Schannel (Git for Windows default) | **failed**: same `SEC_E_NO_CREDENTIALS` |
| `git -c http.sslBackend=openssl ls-remote https://github.com/…` | OpenSSL | **worked** |
| Node `https.get` | OpenSSL (Node's own) | **worked**: 200 |
| Python `urllib.request.urlopen` | OpenSSL (Python's own) | **worked**: 200 |

## Conclusions

1. The Windows sandbox's restricted token breaks Schannel: it cannot acquire client credentials. Every tool that uses the Windows TLS stack fails. That includes `git` with its default settings, `curl.exe` and PowerShell web cmdlets.
2. Tools with their own TLS stack work: Node, Python, and Git with the OpenSSL backend.
3. **Workaround for git:** `git config --global http.sslBackend openssl`. Git then uses its bundled CA list instead of the Windows certificate store. That differs when a company proxy or a private CA is in use.

## Not verified

- A `git push` or a fetch of a private repository in the sandbox. Both also need Git Credential Manager, which may hit the same restricted-token limit.
- `gh` (GitHub CLI).
- Other Schannel users: `Invoke-RestMethod`, .NET `HttpClient`, `winget`, `nuget.exe`.

This belongs in the upstream issue too: the sandbox token should allow Schannel to acquire credentials, or DSH should document the limitation.
