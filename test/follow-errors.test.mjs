// R1.3 (T3): follow() swallowed every error, so a 401, a 429 or a protocol
// mismatch surfaced as a silent timeout instead of the real cause.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { follow } from '../mcp/lib.mjs'
import { startMcp, withTimeout } from './helpers.mjs'

const SESSION = 'test-session'
const root = fileURLToPath(new URL('..', import.meta.url))

/** A fake bridge that answers the REST calls and applies `eventStatus` to /events. */
async function startHttpBridge({ eventStatus = 0, onEvents } = {}) {
  let events = 0
  const server = createServer((req, res) => {
    if (req.url.startsWith('/events')) {
      events++
      if (onEvents) return onEvents(req, res, events)
      res.writeHead(eventStatus, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: eventStatus === 401 ? 'unauthorized' : 'nope' }))
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ items: [{ sessionId: SESSION, updatedAt: Date.now(), running: false }] }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const folder = mkdtempSync(join(tmpdir(), 'dsh-follow-'))
  const stateFile = join(folder, 'state.json')
  writeFileSync(stateFile, JSON.stringify({ url: `http://127.0.0.1:${port}`, token: 'x'.repeat(48), protocol: 1, bootId: 'test-boot', version: '0.6.2' }))
  return {
    stateFile,
    folder,
    events: () => events,
    stop: async () => {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(() => resolve()))
      rmSync(folder, { recursive: true, force: true })
    },
  }
}

test('dsh_wait reports a 401 instead of timing out', async (t) => {
  const fake = await startHttpBridge({ eventStatus: 401 })
  t.after(() => fake.stop())
  const mcp = startMcp({ env: { DSH_BRIDGE_STATE_FILE: fake.stateFile } })
  t.after(() => mcp.stop())

  const started = Date.now()
  await assert.rejects(
    withTimeout(mcp.callTool('dsh_wait', { sessionId: SESSION, since: 0, bootId: 'test-boot', timeoutSec: 20 }), 8000, 'dsh_wait'),
    /401/,
  )
  assert.ok(Date.now() - started < 2000, 'the auth failure must be reported at once')
})

test('dsh_wait reports a 429 instead of timing out', async (t) => {
  const fake = await startHttpBridge({ eventStatus: 429 })
  t.after(() => fake.stop())
  const mcp = startMcp({ env: { DSH_BRIDGE_STATE_FILE: fake.stateFile } })
  t.after(() => mcp.stop())

  await assert.rejects(
    withTimeout(mcp.callTool('dsh_wait', { sessionId: SESSION, since: 0, bootId: 'test-boot', timeoutSec: 20 }), 8000, 'dsh_wait'),
    /429/,
  )
})

test('a dropped connection is still retried', async (t) => {
  const fake = await startHttpBridge({
    onEvents: (req, res, hit) => {
      if (hit === 1) return req.socket.destroy()
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('id: 7\ndata: {"id":7,"bootId":"test-boot","type":"status","sessionId":"test-session"}\n\n')
    },
  })
  t.after(() => fake.stop())
  const previous = process.env.DSH_BRIDGE_STATE_FILE
  process.env.DSH_BRIDGE_STATE_FILE = fake.stateFile
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_BRIDGE_STATE_FILE
    else process.env.DSH_BRIDGE_STATE_FILE = previous
  })

  const stream = follow({ since: 0, retryMs: 20 })
  t.after(() => stream.return?.())
  const first = await withTimeout(stream.next(), 5000, 'follow')
  assert.equal(first.value.id, 7)
  await stream.return()
})

test('watch.mjs exits 2 on a 401', async (t) => {
  const fake = await startHttpBridge({ eventStatus: 401 })
  t.after(() => fake.stop())
  const child = spawn(process.execPath, [join(root, 'mcp', 'watch.mjs')], {
    env: { ...process.env, DSH_BRIDGE_STATE_FILE: fake.stateFile, DSH_AGENT_NAME: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => { if (child.exitCode === null) child.kill() })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const code = await withTimeout(new Promise((resolve) => child.once('exit', resolve)), 8000, 'watch exit')
  assert.equal(code, 2, `watch must exit 2 on a 401; stderr was: ${stderr}`)
  assert.match(stderr, /401/)
})
