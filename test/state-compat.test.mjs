// F1 and F2 (review of R1).
// F1: a second bridge that cannot listen must not mark a healthy bridge's state
//     file as stale; only a port held by something else gets the stale marker.
// F2: 0.6.1 MCP clients read `token` from the state file. Running clients keep
//     their old code after an upgrade, so 0.6.x keeps a deprecated copy there.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBridge } from './helpers.mjs'

test('F2: a 0.6.1-style reader gets the right token from a listening bridge', async (t) => {
  const bridge = await startBridge()
  t.after(() => bridge.stop())
  const state = JSON.parse(readFileSync(bridge.file, 'utf8'))
  assert.equal(state.token, bridge.token, 'the state file keeps a token copy for 0.6.x clients')
  assert.equal(state.tokenDeprecated, true, 'the copy is marked deprecated')
  const res = await fetch(`${state.url}/health`, { headers: { authorization: `Bearer ${state.token}` } })
  assert.equal(res.status, 200)
})

test('F1: a second bridge on the same port and state file leaves the healthy one alone', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'dsh-f1-'))
  t.after(() => rmSync(folder, { recursive: true, force: true }))
  const stateFile = join(folder, 'agent-bridge.json')

  const first = await startBridge({ stateFile })
  t.after(() => first.stop().catch(() => {}))
  const before = JSON.parse(readFileSync(stateFile, 'utf8'))

  const second = await startBridge({ port: first.port, stateFile, allowListenError: true })
  t.after(() => second.stop().catch(() => {}))

  const after = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.notEqual(after.stale, true, 'the healthy bridge must not be marked stale')
  assert.equal(after.bootId, before.bootId, 'the state file must still describe the first bridge')
  assert.equal(after.url, before.url)
  const res = await fetch(`${after.url}/health`, { headers: { authorization: `Bearer ${first.token}` } })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).bootId, before.bootId)
})

test('F1: a state file whose writer is gone still gets the stale marker', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'dsh-f1-dead-'))
  t.after(() => rmSync(folder, { recursive: true, force: true }))
  const stateFile = join(folder, 'agent-bridge.json')
  // A previous boot on the same port whose process no longer exists.
  const first = await startBridge({ stateFile })
  const port = first.port
  await first.stop()
  const previous = JSON.parse(readFileSync(stateFile, 'utf8'))
  writeFileSync(stateFile, JSON.stringify({ ...previous, pid: 2147483646 }))

  // Something else now owns the port.
  const { createServer } = await import('node:net')
  const foreign = createServer().listen(port, '127.0.0.1')
  await new Promise((resolve) => foreign.once('listening', resolve))
  t.after(() => new Promise((resolve) => foreign.close(() => resolve())))

  const clash = await startBridge({ port, stateFile, allowListenError: true })
  t.after(() => clash.stop().catch(() => {}))
  const after = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(after.stale, true)
  assert.equal('token' in after, false, 'a stale file never carries the token')
})
