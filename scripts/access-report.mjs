#!/usr/bin/env node
// Read-only report of the sandbox denials in DSH sessions, grouped by folder,
// with one suggestion per group. It never changes anything.
//
//   node scripts/access-report.mjs [--session <id>] [--workspace <name>] [--since 7d] [--json]
//
// Without --session or --workspace it reads every session. The bridge must run.
import { call } from '../mcp/lib.mjs'
import { groupDenials, parseSince } from './access-report-lib.mjs'

const args = process.argv.slice(2)
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const asJson = args.includes('--json')

async function sessionIds() {
  const { items } = await call('GET', '/sessions')
  const wanted = value('--session')
  if (wanted) {
    const key = wanted.replace(/^session-/, '').toLowerCase()
    const hits = items.filter((item) => item.sessionId.replace(/^session-/, '').toLowerCase().startsWith(key))
    if (hits.length !== 1) throw new Error(hits.length ? `session id "${wanted}" is ambiguous` : `no DSH session matches "${wanted}"`)
    return hits.map((item) => item.sessionId)
  }
  const workspace = value('--workspace')
  if (workspace) {
    const { items: spaces } = await call('GET', '/workspaces')
    const hit = spaces.find((w) => w.id === workspace || String(w.title).toLowerCase() === workspace.toLowerCase())
    if (!hit) throw new Error(`no DSH workspace named "${workspace}"`)
    return hit.sessionIds
  }
  return items.map((item) => item.sessionId)
}

try {
  const sinceMs = parseSince(value('--since'))
  if (value('--since') && sinceMs === undefined) throw new Error('--since takes a number with d, h or m, for example 7d')
  const cutoff = sinceMs ? Date.now() - sinceMs : 0
  const ids = await sessionIds()
  const all = []
  for (const id of ids) {
    const { denials } = await call('GET', `/sessions/${encodeURIComponent(id)}/denials`)
    for (const denial of denials) if (!cutoff || (denial.time ?? 0) >= cutoff) all.push({ ...denial, sessionId: id })
  }
  const groups = groupDenials(all)
  if (asJson) {
    process.stdout.write(JSON.stringify({ sessions: ids.length, denials: all.length, groups }, null, 2) + '\n')
  } else if (!groups.length) {
    console.log(`No sandbox denials in ${ids.length} session(s).`)
  } else {
    console.log(`${all.length} sandbox denial(s) in ${ids.length} session(s):\n`)
    for (const group of groups) {
      console.log(`${String(group.count).padStart(5)}  ${group.kind.padEnd(5)}  ${group.folder ?? '(unknown path)'}`)
      console.log(`       ${group.suggestion}`)
      if (group.examples.length) console.log(`       e.g. ${group.examples[0]}`)
    }
  }
} catch (error) {
  console.error(`access-report: ${error.message}`)
  process.exit(1)
}
