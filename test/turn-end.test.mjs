// R1.1 (L1, T1): turn-end used to report the last assistant text of the whole
// session, so a cancelled turn showed the previous turn's answer.
import test from 'node:test'
import assert from 'node:assert/strict'
import { startBridge, nextFrame } from './helpers.mjs'

const SESSION = 'test-session'

function fakeSession(events) {
  return { id: SESSION, header: { cwd: 'C:\\work' }, snapshotEvents: () => events }
}

test('a cancelled turn reports no text from the previous turn', async (t) => {
  const bridge = await startBridge()
  t.after(() => bridge.stop())
  const events = [
    { type: 'assistant/message', seq: 1, data: { turn: 1, message: { content: [{ type: 'text', text: 'pong-1' }] } } },
    { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const session = fakeSession(events)
  const stream = await bridge.get('/events?since=0')
  const reader = stream.body.getReader()
  t.after(() => reader.cancel().catch(() => {}))

  bridge.emit('session/event', session, { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } })
  const first = await nextFrame(reader)
  assert.equal(first.turn, 1)
  assert.equal(first.reason, 'completed')
  assert.equal(first.reasonKind, 'completed')
  assert.equal(first.lastText, 'pong-1')

  // Turn 2 is cancelled before any assistant text exists.
  bridge.emit('session/event', session, { type: 'turn/end', seq: 4, data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  const second = await nextFrame(reader)
  assert.equal(second.turn, 2)
  assert.equal(second.reason, 'cancelled')
  assert.equal(second.reasonKind, 'aborted')
  assert.equal(second.lastText, null, 'a cancelled turn must not inherit the previous turn text')
})

test('an errored turn reports reason error and its own text', async (t) => {
  const bridge = await startBridge()
  t.after(() => bridge.stop())
  const events = [
    { type: 'assistant/message', seq: 1, data: { turn: 1, message: { content: [{ type: 'text', text: 'pong-1' }] } } },
    { type: 'assistant/message', seq: 3, data: { turn: 2, message: { content: [{ type: 'text', text: 'partial-2' }] } } },
  ]
  const session = fakeSession(events)
  const stream = await bridge.get('/events?since=0')
  const reader = stream.body.getReader()
  t.after(() => reader.cancel().catch(() => {}))

  bridge.emit('session/event', session, { type: 'turn/end', seq: 4, data: { turn: 2, reason: { kind: 'error', error: { message: 'boom' } } } })
  const event = await nextFrame(reader)
  assert.equal(event.reason, 'error')
  assert.equal(event.reasonKind, 'error')
  assert.equal(event.lastText, 'partial-2', 'the error turn reports its own partial text')
})
