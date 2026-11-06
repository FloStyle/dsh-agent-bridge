import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { apply } from '../index.js'
import { bridge } from '../mcp/lib.mjs'

test('local control API enforces auth, validates input and keeps status metadata private', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'dsh-bridge-test-'))
  const file = join(folder, 'state.json')
  const previous = process.env.DSH_BRIDGE_STATE_FILE
  process.env.DSH_BRIDGE_STATE_FILE = file
  const probe = createServer().listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const disposers = [], routes = new Map(), handlers = new Map()
  let creates = 0, prompts = 0, busy = false
  const ctx = {
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
    on(event, handler) { handlers.set(event, handler) },
    connection: { fetch: { register(route) { routes.set(route.path, route.fetch); return () => {} } } },
    workspaceRegistry: { list: () => [] },
    agents: { get: () => ({ status: busy ? 'running' : 'idle' }) },
    sessionController: {
      list: async () => ({ items: [{ sessionId: 'test-session', running: busy }] }),
      create: async () => { creates++; return { sessionId: 'test-session' } },
      prompt: async () => { prompts++; return { accepted: true } },
      cancel: async () => ({ cancelled: true }),
      state: async () => ({ running: busy, pendingInput: [] }),
      events: async () => ({ records: [{ event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'synthetic reply' }] } } } }], cursor: 1, hasMore: false }),
    },
  }
  const server = apply(ctx, { port })
  t.after(async () => {
    for (const dispose of disposers.reverse()) dispose()
    server.closeAllConnections()
    if (previous === undefined) delete process.env.DSH_BRIDGE_STATE_FILE
    else process.env.DSH_BRIDGE_STATE_FILE = previous
    rmSync(folder, { recursive: true, force: true })
  })
  await once(server, 'listening')
  const { url, token } = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(server.address().address, '127.0.0.1')
  assert.ok(token.length >= 32)
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const post = (path, body) => fetch(url + path, { method: 'POST', headers, body: JSON.stringify(body) })
  assert.equal((await fetch(url + '/health')).status, 401)
  assert.equal((await fetch(url + '/ui/status')).status, 401)
  assert.equal((await fetch(url + '/health', { headers: { ...headers, origin: 'https://example.invalid' } })).status, 403)
  assert.equal((await fetch(url + '/health', { headers })).status, 200)
  assert.equal((await post('/sessions', { text: 42 })).status, 400)
  assert.equal((await post('/sessions', { text: 'hello', mode: 'unknown' })).status, 400)
  assert.equal((await post('/sessions', { cwd: {} })).status, 400)
  assert.equal((await post('/sessions', { text: 'a'.repeat(70000) })).status, 413)
  assert.equal(creates, 0, 'invalid input must not create sessions')
  assert.equal((await post('/sessions', { text: 'synthetic private prompt' })).status, 200)
  assert.equal(creates, 1)
  busy = true
  assert.equal((await post('/sessions/test-session/prompt', { text: 'hello' })).status, 409)
  assert.equal((await post('/sessions/test-session/prompt', { text: 'hello', mode: 'steer' })).status, 200)
  assert.equal(prompts, 2)
  assert.equal((await fetch(url + '/sessions/test-session?limit=NaN', { headers })).status, 400)
  const state = await (await fetch(url + '/sessions/test-session', { headers })).json()
  assert.equal(state.entries[0].text, 'synthetic reply')
  const status = await (await routes.get('/api/agent-bridge/status')()).text()
  assert.ok(!status.includes('synthetic private prompt'))
  assert.ok(!status.includes(token))
  const controller = new AbortController()
  const stream = await fetch(url + '/events', { headers, signal: controller.signal })
  const reader = stream.body.getReader()
  handlers.get('agent/status')({ agent: { id: 'test-session' }, status: 'idle' })
  assert.match(new TextDecoder().decode((await reader.read()).value), /test-session/)
  controller.abort()
  assert.equal(bridge().url, url)
  writeFileSync(file, JSON.stringify({ url: 'https://example.invalid', token: randomBytes(24).toString('hex') }))
  assert.throws(() => bridge(), /127\.0\.0\.1/)
})
