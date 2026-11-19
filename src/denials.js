// Sandbox denials from raw DSH session events. Format: docs/spikes/denial-events.md.
//
// File tools report `error.code: FS_SANDBOX_DENIED`, and the path is in the
// matching tool call. Shell tools report no code: only the DSH marker and the
// OS message carry the information. Other "access denied" errors are ignored.

const MARKER = /\[sandbox: [^\]]*denied under ([a-z-]+) mode\]/
const SHELL_TOOLS = new Set(['pwsh', 'bash', 'shell', 'terminal'])
const SHELL_PATH = [
  /Access to the path '([^']+)' is denied/,
  /Access is denied: '([^']+)'/,
  /(?:EACCES|EPERM)[^']*'([^']+)'/,
  /Permission denied:? '([^']+)'/,
  /cannot (?:create|open|remove) '([^']+)'[^\n]*Permission denied/,
]

function textOf(message) {
  const content = message?.content
  if (!Array.isArray(content)) return typeof content === 'string' ? content : ''
  return content.map((part) => part?.text ?? '').join('\n')
}

function argsOf(call) {
  const raw = call?.data?.arguments
  if (raw && typeof raw === 'object') return raw
  try { return JSON.parse(raw ?? '{}') } catch { return {} }
}

/**
 * @param {Array<object>} events raw session events, oldest first
 * @returns {Array<{seq:number,time?:number,turn?:number,kind:'file'|'shell',tool:string,code:string,mode:string|null,path:string|null,cwd?:string}>}
 */
export function parseDenials(events) {
  const calls = new Map()
  const denials = []
  for (const event of events ?? []) {
    if (event?.type === 'tool/call' && event.data?.callId) {
      calls.set(event.data.callId, event)
      continue
    }
    if (event?.type !== 'tool/result') continue
    const data = event.data ?? {}
    const text = textOf(data.message)
    const marker = MARKER.exec(text)
    const fileCode = data.error?.code === 'FS_SANDBOX_DENIED'
    if (!marker && !fileCode) continue
    const call = calls.get(data.message?.source?.callId ?? data.message?.toolCallId)
    const tool = call?.data?.name ?? 'unknown'
    const shell = !fileCode && SHELL_TOOLS.has(tool)
    let path = null
    if (shell || !call) {
      for (const pattern of SHELL_PATH) {
        const match = pattern.exec(text)
        if (match) { path = match[1]; break }
      }
    } else {
      const args = argsOf(call)
      path = args.file_path ?? args.path ?? args.filePath ?? null
    }
    const denial = {
      seq: event.seq,
      time: event.time,
      turn: data.turn,
      kind: shell ? 'shell' : 'file',
      tool,
      code: fileCode ? data.error.code : 'SANDBOX_DENIED_SHELL',
      mode: marker?.[1] ?? null,
      path,
    }
    if (data.meta?.cwd) denial.cwd = data.meta.cwd
    denials.push(denial)
  }
  return denials
}
