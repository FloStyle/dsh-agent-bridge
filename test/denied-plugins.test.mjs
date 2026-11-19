// R1.5 (L3): after the DSH upgrade, dsh-codex-subscription@3.2.6 was denied and
// nothing told the operator why. DSH has no persisted refusal record: the only
// observable source is the warning that `dsh plugin <profile> list` prints.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withTimeout } from './helpers.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const fixture = readFileSync(join(root, 'test', 'fixtures', 'dsh-plugin-list-denied.txt'), 'utf8')

test('the denied-plugin parser reads the real dsh plugin list warning', async () => {
  const { parseDeniedPlugins } = await import('../scripts/plugin-list.mjs')
  const denied = parseDeniedPlugins(fixture)
  assert.deepEqual(denied, [{ name: 'dsh-codex-subscription', version: '3.2.6', runtime: '0.2.2-rc.3' }])
})

test('the parser ignores unrelated list output', async () => {
  const { parseDeniedPlugins } = await import('../scripts/plugin-list.mjs')
  const noise = 'dsh-profile-desktop C:\\x (PRIVATE)\n├── dsh-agent-bridge@0.6.2\n10 packages\n'
  assert.deepEqual(parseDeniedPlugins(noise), [])
})

test('doctor warns once per denied plugin, with the allow-version hint', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-doctor-home-'))
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-doctor-state-'))
  const bin = mkdtempSync(join(tmpdir(), 'dsh-fake-bin-'))
  const profile = join(home, '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-agent-bridge')
  mkdirSync(join(profile, 'mcp'), { recursive: true })
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-agent-bridge', version }))
  writeFileSync(join(profile, 'mcp', 'mcp.mjs'), '')
  const stateFile = join(stateDir, 'state.json')

  const health = { ok: true, version, protocol: 1, bootId: 'boot', startedAt: Date.now(), pid: process.pid, lastEventId: 3, services: { checked: 15, missing: [] }, defaultAgentSeen: false }
  const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(health)) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections?.(); await new Promise((resolve) => server.close(() => resolve())) })
  writeFileSync(stateFile, JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, token: 'x'.repeat(48) }))

  // A fake dsh on PATH: --version answers, `plugin ... list` prints the fixture.
  const fixturePath = join(bin, 'denied.txt')
  writeFileSync(fixturePath, fixture)
  let shim
  if (process.platform === 'win32') {
    shim = join(bin, 'dsh.cmd')
    writeFileSync(shim, [
      '@echo off',
      'if "%1"=="--version" (',
      '  echo 0.2.2-rc.3',
      '  exit /b 0',
      ')',
      `type "${fixturePath}" 1>&2`,
      'exit /b 0',
      '',
    ].join('\r\n'))
  } else {
    shim = join(bin, 'dsh')
    writeFileSync(shim, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then',
      '  echo 0.2.2-rc.3',
      '  exit 0',
      'fi',
      `cat "${fixturePath}" >&2`,
      'exit 0',
      '',
    ].join('\n'))
    chmodSync(shim, 0o755)
  }

  t.after(() => { rmSync(home, { recursive: true, force: true }); rmSync(stateDir, { recursive: true, force: true }); rmSync(bin, { recursive: true, force: true }) })

  const child = spawn(process.execPath, [join(root, 'scripts', 'doctor.mjs'), '--profile', 'desktop', '--repo', root], {
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, USERPROFILE: home, HOME: home, DSH_BRIDGE_STATE_FILE: stateFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  await withTimeout(new Promise((resolve) => child.once('close', resolve)), 30000, 'doctor exit')
  assert.match(output, /WARN.*dsh-codex-subscription@3\.2\.6/, `doctor must name the denied plugin; output was:\n${output}`)
  assert.match(output, /dsh plugin --profile desktop allow-version dsh-codex-subscription@3\.2\.6 --dsh-version 0\.2\.2-rc\.3 --accept-risk/, 'the fix line must use the real syntax')
})

