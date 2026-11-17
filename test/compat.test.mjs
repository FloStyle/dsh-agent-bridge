// Phase 2 (0.6.0) / I7: a DSH surface that lacks an injected service must say so
// once, by name, instead of failing silently somewhere else.
import test from 'node:test'
import assert from 'node:assert/strict'
import { startBridge } from './helpers.mjs'

test('a missing injected service is named in the log and in /health', async (t) => {
  const warnings = []
  const bridge = await startBridge({
    context: {
      typertGateway: undefined,
      logger: { info() {}, warn: (line) => warnings.push(String(line)), error() {} },
    },
  })
  t.after(() => bridge.stop())

  assert.ok(
    warnings.some((line) => line.includes('typertGateway')),
    `expected a warning naming typertGateway, got ${JSON.stringify(warnings)}`,
  )

  const health = await (await bridge.get('/health')).json()
  assert.equal(health.services.checked > 0, true)
  assert.ok(health.services.missing.includes('typertGateway'))
})

test('a complete context reports no missing service', async (t) => {
  // The harness supplies sessionController, agents, workspaceRegistry,
  // connection and typertGateway; add the rest of the inject list.
  const extra = {}
  for (const name of ['agentDefaultModel', 'attachments', 'fileUploads', 'fs', 'llm', 'remoteAccess', 'sessions', 'sessionProjections', 'sessionQuery', 'typert']) {
    extra[name] = {}
  }
  const bridge = await startBridge({ context: extra })
  t.after(() => bridge.stop())
  const health = await (await bridge.get('/health')).json()
  assert.deepEqual(health.services.missing, [])
})
