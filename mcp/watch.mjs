#!/usr/bin/env node
// Print one line per DSH notification (turn end, error, approval needed).
// Made for any MCP client's Monitor tool: each stdout line becomes a notification.
// Usage: node watch.mjs [--session <id>] [--all]   (--all also prints status/user-message)
import { events } from './lib.mjs'

const args = process.argv.slice(2)
const only = args.includes('--session') ? args[args.indexOf('--session') + 1] : undefined
const all = args.includes('--all')
const oneLine = (s, n = 300) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n)

for (;;) {
  try {
    for await (const ev of events()) {
      if (only && ev.sessionId !== only) continue
      if (ev.type === 'turn-end') console.log(`[dsh turn-end] ${ev.sessionId} "${oneLine(ev.title, 60)}" (${ev.reason}) :: ${oneLine(ev.lastText)}`)
      else if (ev.type === 'error') console.log(`[dsh error] ${ev.sessionId} :: ${oneLine(ev.message)}`)
      else if (ev.type === 'needs-approval') console.log(`[dsh needs-approval] ${ev.sessionId} (${ev.event})`)
      else if (all) console.log(`[dsh ${ev.type}] ${ev.sessionId} ${oneLine(ev.status ?? ev.text, 120)}`)
    }
  } catch (e) {
    console.error(`bridge connection lost: ${e.message}; retrying in 5s`)
  }
  await new Promise((r) => setTimeout(r, 5000))
}
