// Model selection: list the DSH model catalog, choose the model of a new
// session, and switch the model of an existing one.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { startBridge, startMcp, withTimeout } from './helpers.mjs'

const CATALOG = {
  default: { provider: 'deepseek-account', model: 'deepseek-flash' },
  routableProviders: ['deepseek-account', 'openrouter'],
  groups: [
    { id: 'deepseek-account', name: 'DeepSeek', models: [
      { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' },
      { id: 'deepseek-pro', name: 'DeepSeek V4.1 Pro', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } },
    ] },
    { id: 'openrouter', name: 'OpenRouter', models: [{ id: 'deepseek-pro', name: 'DeepSeek Pro via OpenRouter' }] },
  ],
}

function fakeDsh() {
  const calls = []
  return {
    calls,
    controller: {
      modelCatalog: async () => CATALOG,
      selectModel: async (request) => { calls.push(['selectModel', request]); return { selected: { provider: request.provider, model: request.model, ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}) } } },
      create: async () => { calls.push(['create']); return { sessionId: 'session-new' } },
      prompt: async () => { calls.push(['prompt']); return { accepted: true } },
      list: async () => ({ items: [{ sessionId: 'session-old', cwd: 'D:\\w', updatedAt: Date.now() }, { sessionId: 'session-new', cwd: 'D:\\w', updatedAt: Date.now() }] }),
    },
  }
}

test('GET /models lists every routable model with its provider and efforts', async (t) => {
  const dsh = fakeDsh()
  const bridge = await startBridge({ controller: dsh.controller })
  t.after(() => bridge.stop())
  const body = await (await bridge.get('/models')).json()
  assert.deepEqual(body.default, CATALOG.default)
  assert.equal(body.models.length, 3)
  const pro = body.models.find((m) => m.provider === 'deepseek-account' && m.id === 'deepseek-pro')
  assert.deepEqual(pro.efforts, ['low', 'high'])
  assert.equal(pro.defaultEffort, 'high')
  assert.equal(pro.ref, 'deepseek-account/deepseek-pro')
})

test('POST /sessions/:id/model switches a session and is audited', async (t) => {
  const dsh = fakeDsh()
  const bridge = await startBridge({ controller: dsh.controller })
  t.after(() => bridge.stop())
  const res = await bridge.post('/sessions/session-old/model', { model: 'deepseek-account/deepseek-pro', reasoningEffort: 'low' })
  assert.equal(res.status, 200, await res.clone().text())
  assert.deepEqual((await res.json()).selected, { provider: 'deepseek-account', model: 'deepseek-pro', reasoningEffort: 'low' })
  assert.deepEqual(dsh.calls[0], ['selectModel', { sessionId: 'session-old', provider: 'deepseek-account', model: 'deepseek-pro', reasoningEffort: 'low' }])
  const audit = readFileSync(process.env.DSH_BRIDGE_AUDIT_FILE ?? `${bridge.folder}/audit.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(audit.some((entry) => entry.action === 'model' && entry.outcome === 'accepted' && entry.model === 'deepseek-account/deepseek-pro'))
})

test('a model can be named by provider and id, by a unique id, or by a unique name', async (t) => {
  const dsh = fakeDsh()
  const bridge = await startBridge({ controller: dsh.controller })
  t.after(() => bridge.stop())
  const pick = async (model) => (await bridge.post('/sessions/session-old/model', { model })).json()
  assert.deepEqual((await pick('deepseek-flash')).selected, { provider: 'deepseek-account', model: 'deepseek-flash' })
  assert.deepEqual((await pick('DeepSeek Pro via OpenRouter')).selected, { provider: 'openrouter', model: 'deepseek-pro' })
  assert.deepEqual((await pick({ provider: 'openrouter', model: 'deepseek-pro' })).selected, { provider: 'openrouter', model: 'deepseek-pro' })
})

test('an unknown, ambiguous or badly-efforted model is refused with the choices', async (t) => {
  const dsh = fakeDsh()
  const bridge = await startBridge({ controller: dsh.controller })
  t.after(() => bridge.stop())
  const unknown = await bridge.post('/sessions/session-old/model', { model: 'gpt-9' })
  assert.equal(unknown.status, 400)
  assert.match((await unknown.json()).error, /deepseek-account\/deepseek-flash/)
  const ambiguous = await bridge.post('/sessions/session-old/model', { model: 'deepseek-pro' })
  assert.equal(ambiguous.status, 400)
  assert.match((await ambiguous.json()).error, /ambiguous/)
  const effort = await bridge.post('/sessions/session-old/model', { model: 'deepseek-account/deepseek-pro', reasoningEffort: 'extreme' })
  assert.equal(effort.status, 400)
  assert.match((await effort.json()).error, /low, high/)
  assert.equal(dsh.calls.length, 0, 'nothing reaches DSH when the choice is invalid')
})

test('POST /sessions with a model selects it before the first prompt', async (t) => {
  const dsh = fakeDsh()
  const bridge = await startBridge({ controller: dsh.controller })
  t.after(() => bridge.stop())
  const res = await bridge.post('/sessions', { text: 'hello', model: 'deepseek-account/deepseek-pro' })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.deepEqual(body.model, { provider: 'deepseek-account', model: 'deepseek-pro' })
  assert.deepEqual(dsh.calls.map((c) => c[0]), ['create', 'selectModel', 'prompt'])
})

test('POST /sessions with an invalid model creates nothing', async (t) => {
  const dsh = fakeDsh()
  const bridge = await startBridge({ controller: dsh.controller })
  t.after(() => bridge.stop())
  const res = await bridge.post('/sessions', { text: 'hello', model: 'gpt-9' })
  assert.equal(res.status, 400)
  assert.equal(dsh.calls.length, 0)
})

test('a session read and dsh_list show the session model from DSH modelSelection', async (t) => {
  const selection = { lastUsed: { provider: 'deepseek-account', model: 'deepseek-flash' }, next: { provider: 'deepseek-account', model: 'deepseek-pro', reasoningEffort: 'high' } }
  const bridge = await startBridge({
    controller: {
      list: async () => ({ items: [{ sessionId: 'session-old', cwd: 'D:\\w', updatedAt: Date.now(), projections: { values: { modelSelection: selection } } }] }),
    },
  })
  t.after(() => bridge.stop())
  const read = await (await bridge.get('/sessions/session-old')).json()
  assert.deepEqual(read.model, { next: 'deepseek-account/deepseek-pro', reasoningEffort: 'high', lastUsed: 'deepseek-account/deepseek-flash' })
  const mcp = startMcp({ env: { DSH_BRIDGE_STATE_FILE: bridge.file, DSH_AGENT_NAME: 'test' } })
  t.after(() => mcp.stop())
  const [row] = await withTimeout(mcp.callTool('dsh_list', {}), 10000, 'dsh_list')
  assert.equal(row.model, 'deepseek-account/deepseek-pro')
})

test('MCP: dsh_models, dsh_send with a model, and dsh_set_model', async (t) => {
  const dsh = fakeDsh()
  const workspaceRegistry = { list: () => [], create: async (path, title) => ({ id: 'w1', title, path }) }
  const bridge = await startBridge({ controller: dsh.controller, context: { workspaceRegistry } })
  t.after(() => bridge.stop())
  const mcp = startMcp({ env: { DSH_BRIDGE_STATE_FILE: bridge.file, DSH_AGENT_NAME: 'test' } })
  t.after(() => mcp.stop())
  const models = await withTimeout(mcp.callTool('dsh_models', {}), 10000, 'dsh_models')
  assert.equal(models.default.model, 'deepseek-flash')
  assert.ok(models.models.some((m) => m.ref === 'openrouter/deepseek-pro'))

  await withTimeout(mcp.callTool('dsh_send', { text: 'new work', cwd: process.cwd(), model: 'deepseek-account/deepseek-pro', reasoningEffort: 'high' }), 10000, 'dsh_send new')
  assert.deepEqual(dsh.calls.slice(-2).map((c) => c[0]), ['selectModel', 'prompt'])

  dsh.calls.length = 0
  await withTimeout(mcp.callTool('dsh_send', { sessionId: 'session-old', text: 'more', model: 'deepseek-flash' }), 10000, 'dsh_send existing')
  assert.deepEqual(dsh.calls.map((c) => c[0]), ['selectModel', 'prompt'], 'the model is switched before the prompt')

  const set = await withTimeout(mcp.callTool('dsh_set_model', { sessionId: 'session-old', model: 'openrouter/deepseek-pro' }), 10000, 'dsh_set_model')
  assert.deepEqual(set.selected, { provider: 'openrouter', model: 'deepseek-pro' })
})

test('config.defaultModel applies to sessions the bridge creates without a model', async (t) => {
  const dsh = fakeDsh()
  const bridge = await startBridge({ controller: dsh.controller, config: { defaultModel: 'deepseek-account/deepseek-pro', defaultReasoningEffort: 'high' } })
  t.after(() => bridge.stop())
  const body = await (await bridge.post('/sessions', { text: 'hello' })).json()
  assert.deepEqual(body.model, { provider: 'deepseek-account', model: 'deepseek-pro', reasoningEffort: 'high' })
  dsh.calls.length = 0
  const explicit = await (await bridge.post('/sessions', { text: 'hello', model: 'deepseek-flash' })).json()
  assert.deepEqual(explicit.model, { provider: 'deepseek-account', model: 'deepseek-flash' }, 'an explicit model wins over the default')
})
