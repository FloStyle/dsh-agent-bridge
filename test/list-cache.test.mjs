// R2.7: P3 (the session list is cached for one second) and S5 (watch accepts a
// unique session-id prefix, like the MCP tools).
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startBridge, withTimeout } from './helpers.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const SESSION = 'session-3a9e7ffb-0000-4000-8000-000000000001'

test('P3: two reads within a second list the sessions once; a create refreshes the list', async (t) => {
  let lists = 0
  const bridge = await startBridge({
    controller: {
      list: async () => { lists++; return { items: [{ sessionId: SESSION, cwd: 'D:\\w', updatedAt: Date.now() }] } },
      create: async () => ({ sessionId: 'session-new' }),
    },
  })
  t.after(() => bridge.stop())
  await bridge.get(`/sessions/${SESSION}`)
  await bridge.get(`/sessions/${SESSION}`)
  await bridge.get('/sessions')
  assert.equal(lists, 1, 'the list must be cached within one second')
  await bridge.post('/sessions', {})
  await bridge.get('/sessions')
  assert.equal(lists, 2, 'a create must refresh the cached list')
})

test('S5: watch --session accepts a unique prefix', async (t) => {
  const bridge = await startBridge({
    controller: { list: async () => ({ items: [{ sessionId: SESSION, cwd: 'D:\\w', updatedAt: Date.now() }] }) },
  })
  t.after(() => bridge.stop())
  const child = spawn(process.execPath, [join(root, 'mcp', 'watch.mjs'), '--session', '3a9e7ffb'], {
    env: { ...process.env, DSH_BRIDGE_STATE_FILE: bridge.file, DSH_AGENT_NAME: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => child.kill())
  let out = ''
  child.stdout.on('data', (c) => { out += c })
  // Let the watcher resolve the prefix and connect before the event.
  await new Promise((resolve) => setTimeout(resolve, 1200))
  bridge.emit('session/event', { id: SESSION, header: { cwd: 'D:\\w' }, snapshotEvents: () => [] }, { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'completed' } } })
  await withTimeout(new Promise((resolve) => { const check = () => (out.includes('turn-end') ? resolve() : setTimeout(check, 50)); check() }), 8000, 'watch output')
  assert.match(out, new RegExp(`\\[dsh turn-end\\] ${SESSION}`))
})
