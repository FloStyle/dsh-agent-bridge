// R1.6 (X2): if port 7788 is taken, listen failed but the old state file stayed,
// so the MCP client sent its bearer token to whatever owned the port.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { startBridge, readBridgeToken, withTimeout } from './helpers.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

/** Take a loopback port and keep it busy until `release()` is called. */
async function occupyPort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  return {
    port,
    release: async () => { server.closeAllConnections?.(); await new Promise((resolve) => server.close(() => resolve())) },
  }
}

test('a port clash writes a stale state file with no token', async (t) => {
  const busy = await occupyPort()
  t.after(() => busy.release())
  const warnings = []
  const bridge = await startBridge({
    port: busy.port,
    allowListenError: true,
    context: { logger: { info() {}, warn() {}, error: (line) => warnings.push(String(line)) } },
  })
  t.after(() => bridge.stop().catch(() => {}))

  const state = JSON.parse(readFileSync(bridge.file, 'utf8'))
  assert.equal(state.stale, true)
  assert.equal('token' in state, false, 'a state file without a listener must not carry the token')
  assert.match(String(state.error), /listen|in use/i)
  assert.ok(warnings.some((line) => /cannot listen/i.test(line)), `the bridge must log the error, got ${JSON.stringify(warnings)}`)
})

test('the MCP client refuses a stale state file', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'dsh-stale-'))
  t.after(() => rmSync(folder, { recursive: true, force: true }))
  const stateFile = join(folder, 'agent-bridge.json')
  writeFileSync(stateFile, JSON.stringify({ stale: true, error: 'cannot listen on 127.0.0.1:7788: EADDRINUSE' }))

  const child = spawn(process.execPath, [join(root, 'scripts', 'health.mjs')], {
    env: { ...process.env, DSH_BRIDGE_STATE_FILE: stateFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  await withTimeout(new Promise((resolve) => child.once('close', resolve)), 8000, 'health exit')
  assert.match(output, /bridge is not listening \(port in use\); restart DSH or change the port/, `got: ${output}`)
})

test('the token file keeps the token stable across a clash', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'dsh-token-stable-'))
  const stateFile = join(folder, 'agent-bridge.json')
  const tokenFile = join(folder, 'agent-bridge.token')
  t.after(() => rmSync(folder, { recursive: true, force: true }))

  const first = await startBridge({ stateFile })
  t.after(() => first.stop().catch(() => {}))
  const token = first.token
  assert.equal(readFileSync(tokenFile, 'utf8').trim(), token, 'the token lives in its own file')
  await first.stop()

  const busy = await occupyPort()
  t.after(() => busy.release().catch(() => {}))
  const clashes = await startBridge({ port: busy.port, stateFile, allowListenError: true })
  t.after(() => clashes.stop().catch(() => {}))
  const stale = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(stale.stale, true)
  assert.equal(readFileSync(tokenFile, 'utf8').trim(), token, 'a clash must not lose or rotate the token')
  await clashes.stop()
  await busy.release()

  const second = await startBridge({ stateFile })
  t.after(() => second.stop().catch(() => {}))
  assert.equal(second.token, token, 'the same token comes back after the clash clears')
  assert.equal('token' in JSON.parse(readFileSync(stateFile, 'utf8')), false)
})

test('an existing state-file token is adopted, not rotated', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'dsh-migrate-'))
  t.after(() => rmSync(folder, { recursive: true, force: true }))
  const stateFile = join(folder, 'agent-bridge.json')
  const legacy = 'legacy'.padEnd(48, 'x')
  writeFileSync(stateFile, JSON.stringify({ url: 'http://127.0.0.1:1', token: legacy, protocol: 1 }))

  const bridge = await startBridge({ stateFile })
  t.after(() => bridge.stop())
  assert.equal(bridge.token, legacy, '0.6.2 must keep the token a 0.6.1 state file holds')
  assert.equal(readFileSync(join(folder, 'agent-bridge.token'), 'utf8').trim(), legacy)
  assert.equal('token' in JSON.parse(readFileSync(stateFile, 'utf8')), false, 'the state file is cleaned of the token')
})

test('doctor fails on a stale state file', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-doctor-home-'))
  const profile = join(home, '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-agent-bridge')
  mkdirSync(join(profile, 'mcp'), { recursive: true })
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-agent-bridge', version }))
  writeFileSync(join(profile, 'mcp', 'mcp.mjs'), '')
  const stateFile = join(home, 'agent-bridge.json')
  writeFileSync(stateFile, JSON.stringify({ stale: true, error: 'cannot listen on 127.0.0.1:7788: EADDRINUSE' }))
  t.after(() => rmSync(home, { recursive: true, force: true }))

  const child = spawn(process.execPath, [join(root, 'scripts', 'doctor.mjs'), '--profile', 'desktop', '--repo', root], {
    env: { ...process.env, USERPROFILE: home, HOME: home, DSH_BRIDGE_STATE_FILE: stateFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  const code = await withTimeout(new Promise((resolve) => child.once('close', resolve)), 20000, 'doctor exit')
  assert.equal(code, 1, `doctor must exit 1 on a stale state file; output:\n${output}`)
  assert.match(output, /FAIL.*stale/i, `doctor must name the stale state; output:\n${output}`)
  assert.match(output, /fix:.*port/i, 'the failure must carry a fix line')
  assert.ok(!output.includes('aaa'), 'no token material expected')
})
