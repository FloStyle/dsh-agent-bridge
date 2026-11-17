#!/usr/bin/env node
// Print one line per DSH notification (turn end, error, pending input).
// Made for any MCP client's Monitor tool: each stdout line becomes a notification.
// Usage: node watch.mjs [--session <id>] [--all]   (--all also prints status/user-message)
import { follow } from './lib.mjs'

const args = process.argv.slice(2)
const only = args.includes('--session') ? args[args.indexOf('--session') + 1] : undefined
const all = args.includes('--all')
const oneLine = (s, n = 300) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n)
let bootId

for (;;) {
  try {
    for await (const ev of follow({ retryMs: 5000 })) {
      if (ev.bootId && bootId && ev.bootId !== bootId) console.log(`[dsh bridge] DSH restarted; cursor reset to the new boot ${ev.bootId.slice(0, 8)}`)
      bootId = ev.bootId ?? bootId
      if (only && ev.sessionId !== only) continue
      if (ev.type === 'turn-end') console.log(`[dsh turn-end] ${ev.sessionId} "${oneLine(ev.title, 60)}" (${ev.reason}) :: ${oneLine(ev.lastText)}`)
      else if (ev.type === 'error') console.log(`[dsh error] ${ev.sessionId} :: ${oneLine(ev.message)}`)
      else if (ev.type === 'pending-input') console.log(`[dsh pending-input] ${ev.sessionId} (${(ev.kinds ?? []).join(', ')})`)
      else if (ev.type === 'needs-approval') continue // deprecated alias of pending-input
      else if (all) console.log(`[dsh ${ev.type}] ${ev.sessionId} ${oneLine(ev.status ?? ev.text, 120)}`)
    }
  } catch (e) {
    if (typeof e?.status === 'number' && e.status >= 400 && e.status < 500) {
      console.error(`DSH bridge error ${e.status}: ${e.message}`)
      console.error('Fix: check the token in ~/.dsh/agent-bridge.json (or DSH_BRIDGE_STATE_FILE); restart DSH after a token change.')
      process.exit(2)
    }
    console.error(`bridge connection lost: ${e.message}; retrying in 5s`)
    await new Promise((r) => setTimeout(r, 5000))
  }
}
