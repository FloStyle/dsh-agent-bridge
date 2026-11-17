// R1.4 (L2): a client without DSH_AGENT_NAME appeared as "mcp-agent", so the
// transcript, the audit log and the operator could not tell agents apart.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startBridge, withTimeout } from './helpers.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const SESSION = 'test-session'

test('every documented MCP config sets a sender name', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  const blocks = [...readme.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((match) => match[1])
  const configs = blocks.filter((block) => /mcpServers|mcp_servers|claude mcp add/.test(block))
  assert.ok(configs.length >= 3, `expected the three documented configs, found ${configs.length}`)
  for (const config of configs) {
    assert.match(config, /DSH_AGENT_NAME/, `a documented MCP config omits DSH_AGENT_NAME:\n${config}`)
  }
  for (const script of ['scripts/connect-claude-code.ps1', 'scripts/connect-claude-code.sh']) {
    assert.match(readFileSync(join(root, script), 'utf8'), /DSH_AGENT_NAME/, `${script} must set DSH_AGENT_NAME`)
  }
})

test('the MCP server warns once on stderr when DSH_AGENT_NAME is unset', async (t) => {
  const env = { ...process.env }
  delete env.DSH_AGENT_NAME
  const child = spawn(process.execPath, [join(root, 'mcp', 'mcp.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => { if (child.exitCode === null) child.kill() })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n')
  await withTimeout(new Promise((resolve) => child.stdout.once('data', resolve)), 8000, 'initialize')
  assert.match(stderr, /DSH_AGENT_NAME/, 'the warning must name the variable')
  assert.equal(stderr.trim().split('\n').length, 1, `one warning line, got: ${stderr}`)
})

test('/health reports when a client used the default agent name', async (t) => {
  const bridge = await startBridge()
  t.after(() => bridge.stop())

  const before = await (await bridge.get('/health')).json()
  assert.equal(before.defaultAgentSeen, false)

  await bridge.get(`/sessions/${SESSION}/prompt`, {
    method: 'POST',
    body: JSON.stringify({ text: 'named client' }),
    headers: { 'x-agent-name': 'claude-code' },
  })
  const named = await (await bridge.get('/health')).json()
  assert.equal(named.defaultAgentSeen, false, 'a named client must not set the flag')

  await bridge.get(`/sessions/${SESSION}/prompt`, {
    method: 'POST',
    body: JSON.stringify({ text: 'unnamed client' }),
    headers: { 'x-agent-name': 'mcp-agent' },
  })
  const unnamed = await (await bridge.get('/health')).json()
  assert.equal(unnamed.defaultAgentSeen, true, 'the default client name must be visible')
})

test('doctor warns about a client that used the default name', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-doctor-home-'))
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-doctor-state-'))
  const profile = join(home, '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-agent-bridge')
  mkdirSync(join(profile, 'mcp'), { recursive: true })
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-agent-bridge', version }))
  writeFileSync(join(profile, 'mcp', 'mcp.mjs'), '')
  const stateFile = join(stateDir, 'state.json')

  const health = { ok: true, version, protocol: 1, bootId: 'boot', startedAt: Date.now(), pid: process.pid, lastEventId: 3, services: { checked: 15, missing: [] }, defaultAgentSeen: true }
  const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(health)) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections?.(); await new Promise((resolve) => server.close(() => resolve())) })
  writeFileSync(stateFile, JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, token: 'x'.repeat(48) }))
  t.after(() => { rmSync(home, { recursive: true, force: true }); rmSync(stateDir, { recursive: true, force: true }) })

  // Async spawn: spawnSync would block this process and the fake server.
  const child = spawn(process.execPath, [join(root, 'scripts', 'doctor.mjs'), '--profile', 'desktop', '--repo', root], {
    env: { ...process.env, USERPROFILE: home, HOME: home, DSH_BRIDGE_STATE_FILE: stateFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  await withTimeout(new Promise((resolve) => child.once('close', resolve)), 20000, 'doctor exit')
  assert.match(output, /WARN.*mcp-agent/, `doctor must warn about the default name; output was:\n${output}`)
  assert.match(output, /fix:.*DSH_AGENT_NAME/i, 'the warning must carry a fix line')
})

