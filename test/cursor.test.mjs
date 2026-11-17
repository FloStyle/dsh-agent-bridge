// Phase 1 (0.5.1) / C3: SSE ids restart at 1 with the process. A client holding
// since=500 from the previous boot silently misses every new event unless it
// resets its cursor when the boot id changes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { follow } from '../mcp/lib.mjs'
import { startBridge, withTimeout } from './helpers.mjs'

test('a follow cursor resets when the bridge reboots', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'dsh-bridge-boot-'))
  const file = join(folder, 'state.json')
  const previous = process.env.DSH_BRIDGE_STATE_FILE
  process.env.DSH_BRIDGE_STATE_FILE = file
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_BRIDGE_STATE_FILE
    else process.env.DSH_BRIDGE_STATE_FILE = previous
    rmSync(folder, { recursive: true, force: true })
  })

  const first = await startBridge({ stateFile: file, keepStateEnv: true })
  t.after(() => first.stop().catch(() => {}))

  first.emit('agent/status', { agent: { id: 'test-session' }, status: 'idle' })
  const bootOne = (await (await first.get('/health')).json()).bootId

  const controller = new AbortController()
  const stream = follow({ since: 0, retryMs: 25, signal: controller.signal })
  t.after(async () => { await stream.return?.(); controller.abort() })

  const one = await withTimeout(stream.next(), 4000, 'first boot event')
  assert.equal(one.value.bootId, bootOne)

  await first.stop()

  const second = await startBridge({ stateFile: file, port: first.port, keepStateEnv: true })
  t.after(() => second.stop().catch(() => {}))
  // Read the new boot from the state file: a pooled HTTP socket from the dead
  // process can still answer the first request with ECONNRESET.
  const bootTwo = second.state.bootId
  assert.notEqual(bootTwo, bootOne)

  // Ids restart at 1, far below the cursor the client now holds.
  second.emit('agent/status', { agent: { id: 'test-session' }, status: 'idle' })
  const two = await withTimeout(stream.next(), 6000, 'post-restart event')
  assert.equal(two.value.bootId, bootTwo)
  assert.equal(two.value.id, 1, 'the client must re-read the new boot from id 1')
})
