// Phase 2 (0.6.0) / P2, P3, P7: an MCP client needs to know which tools are
// read-only before it can ask a human, which protocol version the server really
// speaks, and what input the schemas accept.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { startMcp, withTimeout } from './helpers.mjs'

const pkg = createRequire(import.meta.url)('../package.json')

test('initialize negotiates a supported protocol version', async (t) => {
  const mcp = startMcp()
  t.after(() => mcp.stop())

  const supported = await withTimeout(mcp.request('initialize', { protocolVersion: '2024-11-05' }), 10000, 'initialize')
  assert.equal(supported.result.protocolVersion, '2024-11-05', 'a supported version is echoed')
  assert.equal(supported.result.serverInfo.version, pkg.version)

  const unknown = await withTimeout(mcp.request('initialize', { protocolVersion: '1999-01-01' }), 10000, 'initialize')
  assert.equal(unknown.result.protocolVersion, '2025-06-18', 'an unknown version gets the newest supported one')
})

test('tools advertise annotations a client can gate permission prompts on', async (t) => {
  const mcp = startMcp()
  t.after(() => mcp.stop())
  const listed = await withTimeout(mcp.request('tools/list', {}), 10000, 'tools/list')
  const tools = Object.fromEntries(listed.result.tools.map((tool) => [tool.name, tool]))

  for (const name of ['dsh_list', 'dsh_workspaces', 'dsh_read', 'dsh_wait']) {
    assert.equal(tools[name].annotations?.readOnlyHint, true, `${name} is read-only`)
  }
  assert.equal(tools.dsh_send.annotations?.readOnlyHint, false)
  assert.equal(tools.dsh_send.annotations?.openWorldHint, false)
  assert.equal(tools.dsh_cancel.annotations?.destructiveHint, true)
  assert.equal(tools.dsh_cancel.annotations?.readOnlyHint, false)
})

test('tool schemas bound their arguments', async (t) => {
  const mcp = startMcp()
  t.after(() => mcp.stop())
  const listed = await withTimeout(mcp.request('tools/list', {}), 10000, 'tools/list')
  const tools = Object.fromEntries(listed.result.tools.map((tool) => [tool.name, tool]))

  assert.equal(tools.dsh_send.inputSchema.properties.text.maxLength, 50000)
  assert.equal(tools.dsh_wait.inputSchema.properties.timeoutSec.minimum, 1)
  assert.equal(tools.dsh_wait.inputSchema.properties.timeoutSec.maximum, 3600)
  assert.equal(tools.dsh_read.inputSchema.properties.limit.minimum, 0)
  assert.equal(tools.dsh_read.inputSchema.properties.limit.maximum, 1000)
  assert.equal(tools.dsh_list.inputSchema.properties.limit.maximum, 1000)
})
