// F3 (review of R1): DSH 0.2.2-rc.3 has seven turn-end kinds (TurnEndReasonMap in
// dsh-api-session-controller). Only `completed` means the turn finished; a
// truncated, blocked or forked turn must not look finished to a waiting agent.
import test from 'node:test'
import assert from 'node:assert/strict'
import { startBridge, startMcp, nextFrame, withTimeout } from './helpers.mjs'

const SESSION = 'test-session'
const session = { id: SESSION, header: { cwd: 'C:\\work' }, snapshotEvents: () => [] }

const CASES = [
  ['completed', 'completed'],
  ['aborted', 'cancelled'],
  ['interrupted', 'cancelled'],
  ['error', 'error'],
  ['max-tokens', 'incomplete'],
  ['blocked', 'incomplete'],
  ['forked', 'incomplete'],
  ['some-future-kind', 'incomplete'],
]

test('every DSH turn-end kind maps to completed, cancelled, error or incomplete', async (t) => {
  const bridge = await startBridge()
  t.after(() => bridge.stop())
  const stream = await bridge.get('/events?since=0')
  const reader = stream.body.getReader()
  t.after(() => reader.cancel().catch(() => {}))

  let turn = 0
  for (const [kind, expected] of CASES) {
    turn++
    bridge.emit('session/event', session, { type: 'turn/end', seq: turn, data: { turn, reason: { kind } } })
    const event = await nextFrame(reader)
    assert.equal(event.reason, expected, `kind ${kind} must map to ${expected}`)
    assert.equal(event.reasonKind, kind, 'the raw DSH kind stays available')
  }
})

test('dsh_wait reports incomplete: true for a truncated turn', async (t) => {
  const bridge = await startBridge({
    controller: {
      list: async () => ({ items: [{ sessionId: SESSION, cwd: 'C:\\work', updatedAt: Date.now() }] }),
    },
  })
  t.after(() => bridge.stop())
  const mcp = startMcp({ env: { DSH_BRIDGE_STATE_FILE: bridge.file, DSH_AGENT_NAME: 'test' } })
  t.after(() => mcp.stop())

  const sent = await withTimeout(mcp.callTool('dsh_send', { sessionId: SESSION, text: 'long answer' }), 10000, 'dsh_send')
  setTimeout(() => bridge.emit('session/event', session, { type: 'turn/end', seq: 9, data: { turn: 2, reason: { kind: 'max-tokens' } } }), 150).unref()
  const waited = await withTimeout(
    mcp.callTool('dsh_wait', { sessionId: SESSION, since: sent.eventId, bootId: sent.bootId, timeoutSec: 10 }),
    10000,
    'dsh_wait',
  )
  assert.equal(waited.reason, 'incomplete')
  assert.equal(waited.incomplete, true)
  assert.equal(waited.cancelled, undefined)
})
