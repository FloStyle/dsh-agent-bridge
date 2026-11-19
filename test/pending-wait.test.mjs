// R1.2 (T2): dsh_wait with a cursor used to ignore pending input, so an
// approval or a question blocked the wait until the timeout (up to 3600 s).
import test from 'node:test'
import assert from 'node:assert/strict'
import { startBridge, startMcp, withTimeout } from './helpers.mjs'

const SESSION = 'test-session'

/** A fake DSH that stays idle and can be told which sessions have pending input. */
async function startFake() {
  const session = { id: SESSION, header: { cwd: 'C:\\work' }, snapshotEvents: () => [] }
  let pending = []
  const bridge = await startBridge({
    controller: {
      list: async () => ({ items: [{ sessionId: SESSION, cwd: 'C:\\work' }] }),
      state: async () => ({ running: false, pendingInput: [] }),
      events: async () => ({ records: [], cursor: 0, hasMore: false }),
      prompt: async () => ({ accepted: true }),
    },
    context: { typertGateway: { getPendingRemoteEvents: () => pending } },
    config: { pendingPollMs: 20 },
  })
  return { bridge, session, setPending: (next) => { pending = next } }
}

test('a wait with a cursor ends on pending input for that session', async (t) => {
  const { bridge, setPending } = await startFake()
  t.after(() => bridge.stop())
  const mcp = startMcp({ env: { DSH_BRIDGE_STATE_FILE: bridge.file } })
  t.after(() => mcp.stop())

  const sent = await withTimeout(mcp.callTool('dsh_send', { sessionId: SESSION, text: 'ask me something' }), 10000, 'dsh_send')
  setPending([{ event: 'approval/request', agentId: SESSION }])

  const started = Date.now()
  const waited = await withTimeout(
    mcp.callTool('dsh_wait', { sessionId: SESSION, since: sent.eventId, bootId: sent.bootId, timeoutSec: 20 }),
    10000,
    'dsh_wait',
  )
  assert.ok(Date.now() - started < 2000, 'the wait must end on the pending input, not the timeout')
  // N3: the kinds come back as pendingKinds; pendingInput keeps the session
  // state's own shape on every path.
  assert.deepEqual(waited.pendingKinds, ['approval'])
  assert.deepEqual(waited.pendingInput, [], 'pendingInput stays the value the session state reports')
  assert.equal(waited.timedOut, undefined)
})

test('pending input for another session does not end the wait', async (t) => {
  const { bridge, session, setPending } = await startFake()
  t.after(() => bridge.stop())
  const mcp = startMcp({ env: { DSH_BRIDGE_STATE_FILE: bridge.file } })
  t.after(() => mcp.stop())

  const sent = await withTimeout(mcp.callTool('dsh_send', { sessionId: SESSION, text: 'work' }), 10000, 'dsh_send')
  setPending([{ event: 'approval/request', agentId: 'another-session' }])
  await new Promise((resolve) => setTimeout(resolve, 120))

  bridge.emit('session/event', session, { type: 'turn/end', seq: 9, data: { turn: 2, reason: { kind: 'completed' } } })
  const waited = await withTimeout(
    mcp.callTool('dsh_wait', { sessionId: SESSION, since: sent.eventId, bootId: sent.bootId, timeoutSec: 10 }),
    10000,
    'dsh_wait',
  )
  assert.equal(waited.timedOut, undefined)
  assert.deepEqual(waited.pendingInput, [], 'another session must not end this wait')
  assert.equal(typeof waited.turnEndEventId, 'number')
})

test('a cleared pending-input event does not end the wait', async (t) => {
  const { bridge, session, setPending } = await startFake()
  t.after(() => bridge.stop())
  const mcp = startMcp({ env: { DSH_BRIDGE_STATE_FILE: bridge.file } })
  t.after(() => mcp.stop())

  // Raise first, so the raise is behind the cursor and only the clear is seen.
  setPending([{ event: 'approval/request', agentId: SESSION }])
  await new Promise((resolve) => setTimeout(resolve, 100))
  const sent = await withTimeout(mcp.callTool('dsh_send', { sessionId: SESSION, text: 'work' }), 10000, 'dsh_send')
  setPending([])
  await new Promise((resolve) => setTimeout(resolve, 120))

  bridge.emit('session/event', session, { type: 'turn/end', seq: 9, data: { turn: 2, reason: { kind: 'completed' } } })
  const waited = await withTimeout(
    mcp.callTool('dsh_wait', { sessionId: SESSION, since: sent.eventId, bootId: sent.bootId, timeoutSec: 10 }),
    10000,
    'dsh_wait',
  )
  assert.equal(waited.timedOut, undefined)
  assert.deepEqual(waited.pendingInput, [], 'a cleared pending-input must not end the wait')
  assert.equal(typeof waited.turnEndEventId, 'number', 'the wait ends on the turn-end, not the clear')
})

