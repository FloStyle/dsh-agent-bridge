// Phase 2 (0.6.0) / C2: needs-approval was built on guessed session event names
// that never fire. DSH knows the pending requests: typertGateway exposes the
// unsettled approval/request and user-questions/request events per Agent.
import test from 'node:test'
import assert from 'node:assert/strict'
import { startBridge, nextFrame } from './helpers.mjs'

test('pending input is announced and cleared from the live request table', async (t) => {
  let pending = []
  const bridge = await startBridge({
    context: { typertGateway: { getPendingRemoteEvents: () => pending } },
    config: { pendingPollMs: 20 },
  })
  t.after(() => bridge.stop())

  const stream = await bridge.get('/events?since=0')
  const reader = stream.body.getReader()
  t.after(() => reader.cancel().catch(() => {}))

  pending = [{ event: 'approval/request', agentId: 'test-session' }]
  const raised = await nextFrame(reader)
  assert.equal(raised.type, 'pending-input')
  assert.equal(raised.sessionId, 'test-session')
  assert.deepEqual(raised.kinds, ['approval'])

  pending = []
  const cleared = await nextFrame(reader)
  assert.equal(cleared.type, 'pending-input')
  assert.equal(cleared.sessionId, 'test-session')
  assert.deepEqual(cleared.kinds, [])
})

test('a question is reported once, not on every sweep', async (t) => {
  const pending = [{ event: 'user-questions/request', agentId: 'test-session' }]
  const bridge = await startBridge({
    context: { typertGateway: { getPendingRemoteEvents: () => pending } },
    config: { pendingPollMs: 20 },
  })
  t.after(() => bridge.stop())

  const stream = await bridge.get('/events?since=0')
  const reader = stream.body.getReader()
  t.after(() => reader.cancel().catch(() => {}))

  const raised = await nextFrame(reader)
  assert.deepEqual(raised.kinds, ['question'])

  // The request is still unsettled; a second notice would train clients to ignore it.
  await assert.rejects(nextFrame(reader, undefined, 300), /timed out/)
})
