// Phase 2 (0.6.0) / C1: dsh_wait used to return as soon as `running` was false.
// Right after dsh_send the new turn has not started yet, so it returned the
// previous turn's transcript. The wait must be tied to the turn the send began.
import test from 'node:test'
import assert from 'node:assert/strict'
import { startBridge, startMcp, withTimeout } from './helpers.mjs'

const SESSION = 'test-session'
const OLD = 'OLD TURN RESULT'
const NEW = 'NEW TURN RESULT'

/** A fake DSH session whose turn ends a moment after the prompt is accepted. */
function fakeDsh() {
  const state = { phase: 'old', turnEndAt: undefined }
  const text = () => (state.phase === 'new' ? NEW : OLD)
  const event = () => ({
    type: 'assistant/message',
    seq: 3,
    data: { turn: 1, message: { content: [{ type: 'text', text: text() }] } },
  })
  const session = { id: SESSION, header: { cwd: 'C:\\work' }, snapshotEvents: () => [event()] }
  const controller = {
    list: async () => ({ items: [{ sessionId: SESSION, cwd: 'C:\\work', updatedAt: Date.now() }] }),
    // Running stays false: this is the race the audit describes.
    state: async () => ({ running: false, pendingInput: [] }),
    events: async () => ({ records: [{ event: event() }], cursor: 3, hasMore: false }),
    prompt: async () => ({ accepted: true }),
  }
  return {
    controller,
    session,
    /** Complete the turn `delayMs` after the prompt was accepted. */
    finishTurnAfter(delayMs, bridge) {
      setTimeout(() => {
        state.phase = 'new'
        state.turnEndAt = Date.now()
        bridge.emit('session/event', session, { type: 'turn/end', seq: 9, data: { turn: 2, reason: { kind: 'completed' } } })
      }, delayMs).unref()
    },
  }
}

async function startFake(options = {}) {
  const dsh = fakeDsh()
  const bridge = await startBridge({ controller: dsh.controller, ...options })
  return { bridge, dsh }
}

test('a wait right after a send returns the new turn, not the previous one', async (t) => {
  const { bridge, dsh } = await startFake()
  t.after(() => bridge.stop())

  // An earlier turn ended before the send: its turn-end must not satisfy the wait.
  bridge.emit('session/event', dsh.session, { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } })

  const mcp = startMcp({ env: { DSH_BRIDGE_STATE_FILE: bridge.file } })
  t.after(() => mcp.stop())

  const sent = await withTimeout(mcp.callTool('dsh_send', { sessionId: SESSION, text: 'do the new work' }), 10000, 'dsh_send')
  assert.equal(typeof sent.requestId, 'string', 'a send must return the request id')
  assert.equal(typeof sent.eventId, 'number', 'a send must return the event cursor to wait after')
  assert.equal(sent.bootId, bridge.state.bootId)

  dsh.finishTurnAfter(150, bridge)

  const waited = await withTimeout(
    mcp.callTool('dsh_wait', { sessionId: SESSION, since: sent.eventId, bootId: sent.bootId, timeoutSec: 10 }),
    10000,
    'dsh_wait',
  )
  assert.equal(waited.timedOut, undefined, 'the wait must not time out')
  const texts = (waited.entries ?? []).map((entry) => entry.text ?? '')
  assert.ok(texts.some((text) => text.includes(NEW)), `wait returned ${JSON.stringify(texts)}; expected the new turn`)
  assert.ok(!texts.some((text) => text.includes(OLD)), 'the wait returned the previous turn')
  assert.ok(waited.turnEndEventId > sent.eventId, 'the wait must report the turn-end it observed')
})

test('a wait without a cursor still reports idle and bounded output', async (t) => {
  const { bridge } = await startFake()
  t.after(() => bridge.stop())
  const mcp = startMcp({ env: { DSH_BRIDGE_STATE_FILE: bridge.file } })
  t.after(() => mcp.stop())

  const waited = await withTimeout(mcp.callTool('dsh_wait', { sessionId: SESSION, timeoutSec: 5 }), 10000, 'dsh_wait')
  assert.equal(waited.sessionId, SESSION)
  assert.ok(Array.isArray(waited.entries))
  assert.equal(waited.cursorless, true, 'a cursorless wait must say it may be the previous turn')
  assert.match(waited.warning, /previous turn/)
  assert.match(waited.warning, /eventId/)
})

test('a wait reports a timeout instead of hanging when no turn ends', async (t) => {
  const { bridge } = await startFake()
  t.after(() => bridge.stop())
  const mcp = startMcp({ env: { DSH_BRIDGE_STATE_FILE: bridge.file } })
  t.after(() => mcp.stop())

  const sent = await withTimeout(mcp.callTool('dsh_send', { sessionId: SESSION, text: 'never finishes' }), 10000, 'dsh_send')
  const waited = await withTimeout(
    mcp.callTool('dsh_wait', { sessionId: SESSION, since: sent.eventId, bootId: sent.bootId, timeoutSec: 1 }),
    15000,
    'dsh_wait',
  )
  assert.equal(waited.timedOut, true)
  assert.equal(waited.sessionId, SESSION)
})

test('a cancelled turn ends the wait with cancelled true (R1.1)', async (t) => {
  const { bridge, dsh } = await startFake()
  t.after(() => bridge.stop())
  const mcp = startMcp({ env: { DSH_BRIDGE_STATE_FILE: bridge.file } })
  t.after(() => mcp.stop())

  const sent = await withTimeout(mcp.callTool('dsh_send', { sessionId: SESSION, text: 'then cancel me' }), 10000, 'dsh_send')
  bridge.emit('session/event', dsh.session, { type: 'turn/end', seq: 9, data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } } })

  const waited = await withTimeout(
    mcp.callTool('dsh_wait', { sessionId: SESSION, since: sent.eventId, bootId: sent.bootId, timeoutSec: 10 }),
    10000,
    'dsh_wait',
  )
  assert.equal(waited.cancelled, true, 'a cancelled turn must be reported as cancelled')
  assert.equal(waited.timedOut, undefined)
})
