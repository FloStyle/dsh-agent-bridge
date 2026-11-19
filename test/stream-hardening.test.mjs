// R3.6: event-stream hardening (T5, X3) and the explicit queue mode.
import test from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { startBridge, nextFrame } from './helpers.mjs'

test('since must be a non-negative integer', async (t) => {
  const bridge = await startBridge()
  t.after(() => bridge.stop())
  for (const since of ['abc', '-1', '1.5']) {
    const res = await bridge.get(`/events?since=${since}`)
    assert.equal(res.status, 400, `since=${since}`)
  }
})

test('a cursor older than the ring gets a gap event first', async (t) => {
  const bridge = await startBridge()
  t.after(() => bridge.stop())
  const session = { id: 's', header: {}, snapshotEvents: () => [] }
  // 600 events: the ring keeps the newest 500.
  for (let i = 0; i < 600; i++) bridge.emit('agent/status', { agent: { id: 's' }, status: 'idle' })
  const res = await bridge.get('/events?since=10')
  const reader = res.body.getReader()
  t.after(() => reader.cancel().catch(() => {}))
  const first = await nextFrame(reader)
  assert.equal(first.type, 'gap')
  assert.equal(first.from, 10)
  assert.equal(first.oldest, 101)
  const next = await nextFrame(reader)
  assert.equal(next.id, 101)
  void session
})

test('only a loopback Host header is accepted', async (t) => {
  const bridge = await startBridge()
  t.after(() => bridge.stop())
  const call = (host) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: bridge.port, path: '/health', headers: { host, authorization: bridge.headers.authorization } }, (res) => { res.resume(); resolve(res.statusCode) })
    req.on('error', reject)
    req.end()
  })
  assert.equal(await call(`127.0.0.1:${bridge.port}`), 200)
  assert.equal(await call(`localhost:${bridge.port}`), 200)
  assert.equal(await call('evil.example:80'), 403)
  assert.equal(await call(`127.0.0.1:${bridge.port + 1}`), 403)
})

test('mode queue reaches a busy session through the DSH queue; followup still refuses', async (t) => {
  const prompts = []
  const bridge = await startBridge({
    controller: { prompt: async (r) => { prompts.push(r); return { accepted: true } } },
    context: { agents: { get: () => ({ status: 'running' }) } },
  })
  t.after(() => bridge.stop())
  assert.equal((await bridge.post('/sessions/s/prompt', { text: 'later', mode: 'queue' })).status, 200)
  assert.equal(prompts[0].mode, 'queue')
  assert.equal((await bridge.post('/sessions/s/prompt', { text: 'now' })).status, 409)
})
