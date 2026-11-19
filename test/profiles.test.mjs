// WB (Q5): access profiles and visibility. A profile is owner-written: a cwd,
// a preset, and extra writable folders. Agents may name a profile, never a path.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateProfile } from '../src/profiles.js'
import { startBridge, startMcp, withTimeout } from './helpers.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

function folders(t) {
  const base = mkdtempSync(join(tmpdir(), 'dsh-profiles-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const cwd = join(base, 'work'); const extra = join(base, 'engine', 'Intermediate'); const stateDir = join(base, 'state')
  for (const d of [cwd, extra, stateDir]) mkdirSync(d, { recursive: true })
  return { base, cwd, extra, stateFile: join(stateDir, 'agent-bridge.json'), profilesFile: join(stateDir, 'agent-bridge-profiles.json') }
}

/** Fake DSH access services: presets and writable roots, recorded. */
function fakeAccess() {
  const log = []
  const sessions = new Map()
  const sessionFor = (id) => { if (!sessions.has(id)) sessions.set(id, { id, header: { cwd: undefined } }); return sessions.get(id) }
  const presets = new Map()
  return {
    log, sessions, sessionFor,
    context: {
      sessions: { get: (id) => sessions.get(id) },
      permissionPresets: {
        current: (session) => presets.get(session.id) ?? 'workspace-write',
        set: (session, name) => { log.push(['preset', session.id, name]); presets.set(session.id, name) },
        catalog: () => ({ options: [{ value: 'read-only' }, { value: 'workspace-write' }, { value: 'danger-full-access' }] }),
      },
      sandboxPolicy: {
        registerWritableRoot: (session, dir) => { log.push(['root', session.id, dir]); return () => log.push(['unroot', session.id, dir]) },
      },
    },
  }
}

test('validateProfile accepts a sound profile and refuses dangerous or missing paths', (t) => {
  const { cwd, extra } = folders(t)
  assert.deepEqual(validateProfile({ name: 'engine', cwd, extraRoots: [extra], preset: 'workspace-write' }).errors, [])
  const home = homedir()
  const drive = parse(cwd).root
  const cases = [
    [{ name: 'x', cwd: drive }, /drive root/],
    [{ name: 'x', cwd: home }, /home folder/],
    [{ name: 'x', cwd, extraRoots: [join(home, '.dsh')] }, /\.dsh/],
    [{ name: 'x', cwd, extraRoots: [join(home, '.ssh')] }, /\.ssh/],
    [{ name: 'x', cwd, extraRoots: [join(cwd, '.git', 'hooks')] }, /hooks/],
    [{ name: 'x', cwd: join(cwd, 'missing') }, /does not exist/],
    [{ name: 'x', cwd: 'relative\\path' }, /absolute/],
    [{ name: 'x', cwd, preset: 'danger-full-access' }, /full access/],
    [{ name: 'bad name!', cwd }, /name/],
  ]
  for (const [profile, pattern] of cases) {
    const { errors } = validateProfile(profile)
    assert.ok(errors.some((e) => pattern.test(e)), `${JSON.stringify(profile)} → ${JSON.stringify(errors)}`)
  }
  // An explicit override lets one sensitive root through, with a warning.
  const override = validateProfile({ name: 'x', cwd, extraRoots: [{ path: join(home, '.dsh'), allowSensitive: true }] })
  // The sensitive-folder rule is lifted. (A CI runner may have no ~/.dsh at all,
  // so a "does not exist" error is allowed here; this checks only the rule.)
  assert.ok(!override.errors.some((e) => /inside ~\/\.dsh/.test(e)), JSON.stringify(override))
  assert.ok(override.warnings.some((w) => /allowSensitive/.test(w)))
})

test('the profile CLI previews by default and writes only with --yes', (t) => {
  const { cwd, extra, profilesFile } = folders(t)
  const run = (args) => spawnSync(process.execPath, [join(root, 'bin', 'dsh-bridge.mjs'), 'profile', ...args], { env: { ...process.env, DSH_BRIDGE_PROFILES_FILE: profilesFile }, encoding: 'utf8' })
  const preview = run(['add', 'engine', '--cwd', cwd, '--root', extra, '--preset', 'workspace-write'])
  assert.equal(preview.status, 0, preview.stderr)
  assert.match(preview.stdout, /would write/i)
  assert.ok(!existsSync(profilesFile))
  const written = run(['add', 'engine', '--cwd', cwd, '--root', extra, '--preset', 'workspace-write', '--yes'])
  assert.equal(written.status, 0, written.stderr)
  assert.equal(JSON.parse(readFileSync(profilesFile, 'utf8')).profiles.engine.cwd, cwd)
  assert.match(run(['list']).stdout, /engine/)
  const refused = run(['add', 'home', '--cwd', homedir(), '--yes'])
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /home folder/)
  assert.equal(run(['validate']).status, 0)
})

test('creating a session with a profile uses its cwd, preset and roots, and audits each grant', async (t) => {
  const { cwd, extra, stateFile, profilesFile } = folders(t)
  writeFileSync(profilesFile, JSON.stringify({ profiles: { engine: { cwd, extraRoots: [extra], preset: 'workspace-write' } } }))
  const access = fakeAccess()
  const bridge = await startBridge({
    stateFile,
    controller: { create: async () => { access.sessionFor('session-p1'); return { sessionId: 'session-p1' } } },
    context: { ...access.context, workspaceRegistry: { list: () => [], create: async (path, title) => ({ id: 'w', title, path }) } },
  })
  t.after(() => bridge.stop())
  const res = await bridge.post('/sessions', { profile: 'engine', text: 'build it' })
  assert.equal(res.status, 200, await res.clone().text())
  const body = await res.json()
  assert.deepEqual(body.access, { profile: 'engine', preset: 'workspace-write', roots: [extra] })
  assert.deepEqual(access.log, [['preset', 'session-p1', 'workspace-write'], ['root', 'session-p1', extra]])
  const map = JSON.parse(readFileSync(join(stateFile, '..', 'agent-bridge', 'session-profiles.json'), 'utf8'))
  assert.equal(map['session-p1'], 'engine')
  const audit = readFileSync(join(stateFile, '..', 'audit.jsonl'), 'utf8')
  assert.match(audit, /"action":"grant"[^\n]*"root"/)
  // An agent cannot pass a path, and cannot combine a profile with another cwd.
  const mismatch = await bridge.post('/sessions', { profile: 'engine', cwd: extra, text: 'x' })
  assert.equal(mismatch.status, 400)
  const unknown = await bridge.post('/sessions', { profile: 'nope', text: 'x' })
  assert.equal(unknown.status, 400)
})

test('applying a profile to an existing session needs the same cwd', async (t) => {
  const { cwd, extra, stateFile, profilesFile } = folders(t)
  writeFileSync(profilesFile, JSON.stringify({ profiles: { engine: { cwd, extraRoots: [extra] } } }))
  const access = fakeAccess()
  access.sessionFor('session-a').header.cwd = cwd
  access.sessionFor('session-b').header.cwd = extra
  const bridge = await startBridge({ stateFile, context: access.context })
  t.after(() => bridge.stop())
  const ok = await bridge.post('/sessions/session-a/profile', { profile: 'engine' })
  assert.equal(ok.status, 200, await ok.clone().text())
  const conflict = await bridge.post('/sessions/session-b/profile', { profile: 'engine' })
  assert.equal(conflict.status, 409)
})

test('a full-access profile is refused even when the file is edited by hand', async (t) => {
  const { cwd, stateFile, profilesFile } = folders(t)
  writeFileSync(profilesFile, JSON.stringify({ profiles: { wide: { cwd, preset: 'danger-full-access' } } }))
  const access = fakeAccess()
  access.sessionFor('session-a').header.cwd = cwd
  const bridge = await startBridge({ stateFile, context: access.context })
  t.after(() => bridge.stop())
  const res = await bridge.post('/sessions/session-a/profile', { profile: 'wide' })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /full access is set by the owner/)
  assert.equal(access.log.length, 0)
})

test('after a restart the roots of a mapped session are registered again when it is seen', async (t) => {
  const { cwd, extra, stateFile, profilesFile } = folders(t)
  writeFileSync(profilesFile, JSON.stringify({ profiles: { engine: { cwd, extraRoots: [extra] } } }))
  mkdirSync(join(stateFile, '..', 'agent-bridge'), { recursive: true })
  writeFileSync(join(stateFile, '..', 'agent-bridge', 'session-profiles.json'), JSON.stringify({ 'session-a': 'engine' }))
  const access = fakeAccess()
  const session = access.sessionFor('session-a')
  session.header.cwd = cwd
  const bridge = await startBridge({ stateFile, context: access.context })
  t.after(() => bridge.stop())
  bridge.emit('session/event', session, { type: 'user/message', data: { source: { kind: 'user' }, content: [] } })
  bridge.emit('session/event', session, { type: 'assistant/message', data: {} })
  assert.deepEqual(access.log, [['root', 'session-a', extra]], 'registered once, on the first event after the restart')
  const view = await (await bridge.get('/sessions/session-a/access')).json()
  assert.deepEqual({ profile: view.profile, preset: view.preset, roots: view.roots }, { profile: 'engine', preset: 'workspace-write', roots: [extra] })
})

test('without the DSH access services, profiles are refused and the rest works', async (t) => {
  const { cwd, stateFile, profilesFile } = folders(t)
  writeFileSync(profilesFile, JSON.stringify({ profiles: { engine: { cwd } } }))
  const bridge = await startBridge({ stateFile })
  t.after(() => bridge.stop())
  const res = await bridge.post('/sessions/session-a/profile', { profile: 'engine' })
  assert.equal(res.status, 501)
  assert.equal((await bridge.get('/health')).status, 200)
})

test('MCP: dsh_profiles lists names without leaking more than the owner wrote, and dsh_access reads a session', async (t) => {
  const { cwd, extra, stateFile, profilesFile } = folders(t)
  writeFileSync(profilesFile, JSON.stringify({ profiles: { engine: { cwd, extraRoots: [extra], description: 'engine builds' } } }))
  const access = fakeAccess()
  access.sessionFor('session-a').header.cwd = cwd
  const bridge = await startBridge({
    stateFile,
    context: access.context,
    controller: { list: async () => ({ items: [{ sessionId: 'session-a', cwd, updatedAt: Date.now(), projections: { values: { permissions: { currentValue: 'danger-full-access' } } } }] }) },
  })
  t.after(() => bridge.stop())
  const mcp = startMcp({ env: { DSH_BRIDGE_STATE_FILE: stateFile, DSH_AGENT_NAME: 'test' } })
  t.after(() => mcp.stop())
  const profiles = await withTimeout(mcp.callTool('dsh_profiles', {}), 10000, 'dsh_profiles')
  assert.deepEqual(profiles.map((p) => p.name), ['engine'])
  assert.equal(profiles[0].description, 'engine builds')
  const view = await withTimeout(mcp.callTool('dsh_access', { sessionId: 'session-a' }), 10000, 'dsh_access')
  assert.equal(view.preset, 'workspace-write')
  const [row] = await withTimeout(mcp.callTool('dsh_list', {}), 10000, 'dsh_list')
  assert.equal(row.preset, 'danger-full-access', 'dsh_list shows the preset DSH reports')
})

test('the Bridge tab status lists the sessions in full access', async (t) => {
  const bridge = await startBridge({
    controller: { list: async () => ({ items: [
      { sessionId: 'session-wide', cwd: 'D:\w', updatedAt: Date.now(), projections: { values: { title: 'wide one', permissions: { currentValue: 'danger-full-access' } } } },
      { sessionId: 'session-safe', cwd: 'D:\w', updatedAt: Date.now(), projections: { values: { permissions: { currentValue: 'workspace-write' } } } },
    ] }) },
  })
  t.after(() => bridge.stop())
  const response = await bridge.routes.get('/api/agent-bridge/status')()
  const status = await response.json()
  assert.deepEqual(status.fullAccess.map((s) => s.sessionId), ['session-wide'])
  assert.equal(status.fullAccess[0].title, 'wide one')
})
