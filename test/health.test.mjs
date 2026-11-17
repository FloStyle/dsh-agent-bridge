// Phase 1 (0.5.1): a client must be able to tell which bridge build answered it,
// and a restart must be visible. These tests fail on 0.5.0, which reports neither.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { startBridge, nextFrame } from './helpers.mjs'

const pkg = createRequire(import.meta.url)('../package.json')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

test('/health and the state file identify the version, protocol and boot', async (t) => {
  const bridge = await startBridge()
  t.after(() => bridge.stop())

  const health = await (await bridge.get('/health')).json()
  assert.equal(health.ok, true)
  assert.equal(health.version, pkg.version, 'health must report the running package version')
  assert.equal(health.protocol, 1)
  assert.match(health.bootId, UUID)
  assert.equal(typeof health.startedAt, 'number')
  assert.equal(health.pid, process.pid)
  assert.equal(health.lastEventId, 0)

  const state = JSON.parse(readFileSync(bridge.file, 'utf8'))
  assert.equal(state.version, health.version, 'the state file must match /health')
  assert.equal(state.protocol, health.protocol)
  assert.equal(state.bootId, health.bootId)
  assert.equal(state.startedAt, health.startedAt)
  assert.equal(state.pid, health.pid)
})

test('a restart produces a different boot id', async (t) => {
  const first = await startBridge()
  const one = (await (await first.get('/health')).json()).bootId
  const file = first.file
  await first.stop()
  const second = await startBridge({ stateFile: file })
  const two = (await (await second.get('/health')).json()).bootId
  t.after(() => second.stop())
  assert.match(one, UUID)
  assert.match(two, UUID)
  assert.notEqual(two, one, 'a new process must advertise a new boot id')
})

test('every SSE event names the boot that produced it', async (t) => {
  const bridge = await startBridge()
  t.after(() => bridge.stop())
  const { bootId } = await (await bridge.get('/health')).json()
  const controller = new AbortController()
  t.after(() => controller.abort())

  const stream = await bridge.get('/events?since=0', { signal: controller.signal })
  assert.equal(stream.status, 200)
  const reader = stream.body.getReader()
  t.after(() => reader.cancel().catch(() => {}))
  bridge.emit('agent/status', { agent: { id: 'test-session' }, status: 'idle' })
  const event = await nextFrame(reader)
  assert.equal(event.type, 'status')
  assert.equal(event.bootId, bootId, 'SSE frames must carry the boot id')
})

test('a wrong-length token is rejected without throwing', async (t) => {
  const bridge = await startBridge()
  t.after(() => bridge.stop())
  const short = await fetch(bridge.url + '/health', { headers: { authorization: 'Bearer nope' } })
  assert.equal(short.status, 401)
  const long = await fetch(bridge.url + '/health', { headers: { authorization: `Bearer ${bridge.token}extra` } })
  assert.equal(long.status, 401)
  const exact = await fetch(bridge.url + '/health', { headers: { authorization: `Bearer ${bridge.token}` } })
  assert.equal(exact.status, 200)
})
