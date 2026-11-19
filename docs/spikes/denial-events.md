# Spike W0.3: the structured form of a sandbox denial

Date: 2026-11-19. DSH 0.2.2-rc.3, profile `bridge-test`. Read through `sessionController.events`, not the session files.

## File tools (`write`, `edit` and the other file tools)

A denied file operation is a `tool/result` event with:

```json
{
  "type": "tool/result",
  "data": {
    "turn": 2, "step": 1,
    "message": {
      "role": "tool", "isError": true,
      "source": { "kind": "tool", "callId": "call_00_…" },
      "content": [{ "type": "text", "text": "Error: [sandbox: file access denied under workspace-write mode]\n[sandbox: escalation available — retry this exact operation once with sandbox_permissions …]" }]
    },
    "error": { "name": "FsError", "code": "FS_SANDBOX_DENIED" }
  }
}
```

The path is not in the result. It is in the matching `tool/call` event, which has the same `callId`: `data.arguments` is a JSON string such as `{"file_path": "D:\\work\\out\\a.txt", "content": "…"}`.

## Shell tools (`pwsh`; `bash` where it exists)

A denied shell write is **not** an error result. The command ran, and the OS refused the write:

```json
{
  "type": "tool/result",
  "data": {
    "message": {
      "isError": false,
      "content": [{ "type": "text", "text": "[stderr]\nSet-Content: Access to the path 'D:\\work\\out\\b.txt' is denied.\r\n[sandbox: file access denied under workspace-write mode]\n[sandbox: escalation available — retry this exact command once with sandbox_permissions …]" }]
    },
    "meta": { "cwd": "D:\\work\\session-cwd" }
  }
}
```

There is no error code. The reliable signals are:
- the DSH marker `[sandbox: file access denied under <mode> mode]`
- the OS message, which names the path: `Access to the path '<path>' is denied.` (PowerShell), or `Permission denied` / `EACCES` / `EPERM` with a path for other tools

## Mapping used by the access report

| Field | File tool | Shell |
|---|---|---|
| `kind` | `file` (tool name not `pwsh` or `bash`) | `shell` |
| `tool` | the `tool/call` name | the `tool/call` name |
| `code` | `data.error.code` (`FS_SANDBOX_DENIED`) | `SANDBOX_DENIED_SHELL` (synthetic) |
| `mode` | from the marker text | from the marker text |
| `path` | `file_path` or `path` from the call arguments | the quoted path in the OS message, else `null` |
| `cwd` | — | `data.meta.cwd` |

Only results that carry the `[sandbox: … denied …]` marker or `FS_SANDBOX_DENIED` count as sandbox denials. Other `Access denied` errors can have other causes and are ignored.
