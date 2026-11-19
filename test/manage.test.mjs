// W6 (Q7): session and workspace management through DSH's own APIs, with an
// audit line for each change. Deleting stays a human action in DSH.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startBridge, startMcp, withTimeout } from './helpers.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

function fakeDsh(t) {
  const base = mkdtempSync(join(tmpdir(), 'dsh-manage-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const folder = join(base, 'project'); mkdirSync(folder)
  const calls = []
  const workspaces = [{ id: 'w1', title: 'Project', path: folder, sessionIds: ['session-a', 'session-b'], setTitle: async (title) => { calls.push(['setTitle', 'w1', title]) } }]
  return {
    base, folder, calls,
    controller: {
      list: async () => ({ items: [
        { sessionId: 'session-a', cwd: folder, updatedAt: Date.now(), projections: { values: { title: 'first' } } },
        { sessionId: 'session-b', cwd: folder, updatedAt: Date.now(), projections: { values: { title: 'second' } } },
        { sessionId: 'session-c', cwd: base, updatedAt: Date.now() },
      ] }),
      rename: async (request) => { calls.push(['rename', request.sessionId, request.title]); return { accepted: true } },
      create: async (request) => { calls.push(['create', request]); return { sessionId: 'session-new' } },
      prompt: async (request) => { calls.push(['prompt', request.content[0].text]); return { accepted: true } },
    },
    context: {
      workspaceRegistry: {
        list: () => workspaces,
        get: (id) => workspaces.find((w) => w.id === id),
        create: async (path, title) => { calls.push(['createWorkspace', path, title]); const w = { id: 'w2', title, path, sessionIds: [] }; workspaces.push(w); return w },
        archiveSession: async (id) => { calls.push(['archive', id]) },
        unarchiveSession: async (id) => { calls.push(['unarchive', id]) },
        pinSession: async (id) => { calls.push(['pin', id]) },
        unpinSession: async (id) => { calls.push(['unpin', id]) },
      },
    },
  }
}

test('workspaces: create for an existing folder, rename, and list a workspace sessions', async (t) => {
  const dsh = fakeDsh(t)
  const bridge = await startBridge({ controller: dsh.controller, context: dsh.context })
  t.after(() => bridge.stop())
  const other = join(dsh.base, 'other'); mkdirSync(other)
  const created = await bridge.post('/workspaces', { path: other, title: 'Other' })
  assert.equal(created.status, 200, await created.clone().text())
  assert.equal((await created.json()).id, 'w2')
  assert.equal((await bridge.post('/workspaces', { path: join(dsh.base, 'missing') })).status, 400)
  assert.equal((await bridge.post('/workspaces', { path: 'relative' })).status, 400)
  assert.equal((await bridge.post('/workspaces/w1/title', { title: 'Renamed' })).status, 200)
  assert.deepEqual(dsh.calls.find((c) => c[0] === 'setTitle'), ['setTitle', 'w1', 'Renamed'])
  const sessions = await (await bridge.get('/workspaces/w1/sessions')).json()
  assert.deepEqual(sessions.items.map((s) => s.sessionId), ['session-a', 'session-b'])
  assert.equal(sessions.items[0].title, 'first')
})

test('sessions: rename, archive, unarchive, pin and unpin are audited; there is no delete', async (t) => {
  const dsh = fakeDsh(t)
  const bridge = await startBridge({ controller: dsh.controller, context: dsh.context })
  t.after(() => bridge.stop())
  assert.equal((await bridge.post('/sessions/session-a/title', { title: 'scratch: renamed' })).status, 200)
  for (const action of ['archive', 'unarchive', 'pin', 'unpin']) assert.equal((await bridge.post(`/sessions/session-a/${action}`, {})).status, 200, action)
  assert.deepEqual(dsh.calls.map((c) => c[0]), ['rename', 'archive', 'unarchive', 'pin', 'unpin'])
  assert.equal((await bridge.get('/sessions/session-a', { method: 'DELETE' })).status, 404)
  assert.equal((await bridge.post('/sessions/session-a/delete', {})).status, 404)
  const audit = readFileSync(join(bridge.folder, 'audit.jsonl'), 'utf8')
  for (const action of ['rename', 'archive', 'unarchive', 'pin', 'unpin']) assert.match(audit, new RegExp(`"action":"${action}"`))
  assert.equal((await bridge.post('/sessions/session-a/title', { title: '' })).status, 400)
})

test('templates: an owner template sets the cwd, preset and first prompt of a new session', async (t) => {
  const dsh = fakeDsh(t)
  const stateDir = join(dsh.base, 'state'); mkdirSync(stateDir)
  writeFileSync(join(stateDir, 'agent-bridge-templates.json'), JSON.stringify({ templates: { review: { cwd: dsh.folder, agentPreset: 'code', firstPrompt: 'Review the open PR.' } } }))
  const bridge = await startBridge({ stateFile: join(stateDir, 'agent-bridge.json'), controller: dsh.controller, context: dsh.context })
  t.after(() => bridge.stop())
  const list = await (await bridge.get('/templates')).json()
  assert.deepEqual(list.items.map((x) => x.name), ['review'])
  const res = await bridge.post('/sessions', { template: 'review', text: 'Focus on tests.' })
  assert.equal(res.status, 200, await res.clone().text())
  const create = dsh.calls.find((c) => c[0] === 'create')[1]
  assert.equal(create.agentPreset, 'code')
  const prompt = dsh.calls.find((c) => c[0] === 'prompt')[1]
  assert.match(prompt, /Review the open PR\.\n\nFocus on tests\./)
  assert.equal((await bridge.post('/sessions', { template: 'nope' })).status, 400)
})

test('the template CLI previews and writes with --yes', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-tpl-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const file = join(base, 'agent-bridge-templates.json')
  const run = (args) => spawnSync(process.execPath, [join(root, 'bin', 'dsh-bridge.mjs'), 'template', ...args], { env: { ...process.env, DSH_BRIDGE_TEMPLATES_FILE: file }, encoding: 'utf8' })
  const preview = run(['add', 'review', '--cwd', base, '--first-prompt', 'Review it.'])
  assert.equal(preview.status, 0, preview.stderr)
  assert.match(preview.stdout, /would write/i)
  assert.equal(run(['add', 'review', '--cwd', base, '--first-prompt', 'Review it.', '--yes']).status, 0)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).templates.review.firstPrompt, 'Review it.')
  assert.match(run(['list']).stdout, /review/)
})

test('MCP management tools', async (t) => {
  const dsh = fakeDsh(t)
  const bridge = await startBridge({ controller: dsh.controller, context: dsh.context })
  t.after(() => bridge.stop())
  const mcp = startMcp({ env: { DSH_BRIDGE_STATE_FILE: bridge.file, DSH_AGENT_NAME: 'test' } })
  t.after(() => mcp.stop())
  await withTimeout(mcp.callTool('dsh_session_title', { sessionId: 'session-a', title: 'scratch: x' }), 10000, 'title')
  await withTimeout(mcp.callTool('dsh_session_archive', { sessionId: 'session-a', archived: true }), 10000, 'archive')
  await withTimeout(mcp.callTool('dsh_session_archive', { sessionId: 'session-a', archived: false }), 10000, 'unarchive')
  await withTimeout(mcp.callTool('dsh_session_pin', { sessionId: 'session-a', pinned: true }), 10000, 'pin')
  const listed = await withTimeout(mcp.callTool('dsh_sessions_by_workspace', { workspace: 'Project' }), 10000, 'by workspace')
  assert.deepEqual(listed.map((s) => s.sessionId), ['session-a', 'session-b'])
  await withTimeout(mcp.callTool('dsh_workspace_rename', { workspace: 'w1', title: 'New' }), 10000, 'ws rename')
  assert.deepEqual(dsh.calls.map((c) => c[0]), ['rename', 'archive', 'unarchive', 'pin', 'setTitle'])
})
