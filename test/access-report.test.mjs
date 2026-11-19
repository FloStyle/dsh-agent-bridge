// W4: the access report. Sandbox denials come from session events (format in
// docs/spikes/denial-events.md); the report groups them and suggests a fix.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDenials } from '../src/denials.js'
import { groupDenials } from '../scripts/access-report-lib.mjs'
import { startBridge, withTimeout } from './helpers.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const events = JSON.parse(readFileSync(join(root, 'test', 'fixtures', 'denial-events.json'), 'utf8'))

test('parseDenials finds file and shell sandbox denials and ignores other access errors', () => {
  const denials = parseDenials(events)
  assert.equal(denials.length, 4, JSON.stringify(denials))
  const [file, shell, cache, readOnly] = denials
  assert.deepEqual(
    { kind: file.kind, tool: file.tool, code: file.code, mode: file.mode, path: file.path, seq: file.seq },
    { kind: 'file', tool: 'write', code: 'FS_SANDBOX_DENIED', mode: 'workspace-write', path: 'D:\\Engine\\Intermediate\\Build\\a.txt', seq: 32 },
  )
  assert.deepEqual(
    { kind: shell.kind, tool: shell.tool, code: shell.code, mode: shell.mode, path: shell.path, cwd: shell.cwd },
    { kind: 'shell', tool: 'pwsh', code: 'SANDBOX_DENIED_SHELL', mode: 'workspace-write', path: 'D:\\Engine\\Saved\\b.txt', cwd: 'D:\\work' },
  )
  assert.equal(cache.path, 'C:\\Users\\someone\\AppData\\Local\\pip\\cache\\http')
  assert.equal(readOnly.mode, 'read-only')
  assert.equal(readOnly.path, 'D:\\Engine\\Intermediate\\Build\\c.txt', 'the edit tool path comes from `path`')
  assert.equal(typeof file.time, 'number')
})

test('groupDenials groups by kind and deepest common folder, with one suggestion each', () => {
  const groups = groupDenials(parseDenials(events))
  const byKey = Object.fromEntries(groups.map((g) => [`${g.kind} ${g.folder}`, g]))
  const files = byKey['file D:\\Engine\\Intermediate\\Build']
  assert.ok(files, JSON.stringify(groups.map((g) => `${g.kind} ${g.folder}`)))
  assert.equal(files.count, 2)
  assert.match(files.suggestion, /^add root /)
  const shell = byKey['shell D:\\Engine\\Saved']
  assert.ok(shell)
  assert.match(shell.suggestion, /shell write outside cwd/)
  const cache = groups.find((g) => g.cache)
  assert.ok(cache, 'the pip cache is recognised')
  assert.equal(cache.cache, 'pip')
  assert.match(cache.suggestion, /cache folder: redirect/)
  assert.ok(groups[0].count >= groups.at(-1).count, 'groups are sorted by count')
})

test('GET /sessions/:id/denials returns the parsed denials', async (t) => {
  const bridge = await startBridge({
    controller: {
      events: async () => ({ records: events.map((event) => ({ event })), cursor: 71, hasMore: false }),
      list: async () => ({ items: [{ sessionId: 's1', cwd: 'D:\\work', updatedAt: Date.now() }] }),
    },
  })
  t.after(() => bridge.stop())
  const res = await bridge.get('/sessions/s1/denials')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.sessionId, 's1')
  assert.equal(body.cwd, 'D:\\work')
  assert.equal(body.denials.length, 4)
})

test('access-report prints groups for a session and changes nothing', async (t) => {
  const bridge = await startBridge({
    controller: {
      events: async () => ({ records: events.map((event) => ({ event })), cursor: 71, hasMore: false }),
      list: async () => ({ items: [{ sessionId: 's1', cwd: 'D:\\work', updatedAt: Date.now() }] }),
    },
  })
  t.after(() => bridge.stop())
  const child = spawn(process.execPath, [join(root, 'scripts', 'access-report.mjs'), '--session', 's1', '--json'], {
    env: { ...process.env, DSH_BRIDGE_STATE_FILE: bridge.file, DSH_AGENT_NAME: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (c) => { out += c })
  child.stderr.on('data', (c) => { out += c })
  const code = await withTimeout(new Promise((resolve) => child.once('close', resolve)), 15000, 'access-report')
  assert.equal(code, 0, out)
  const report = JSON.parse(out)
  assert.equal(report.sessions, 1)
  assert.equal(report.denials, 4)
  assert.ok(report.groups.some((g) => /^add root /.test(g.suggestion)))
})
