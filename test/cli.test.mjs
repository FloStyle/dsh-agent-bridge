// R2: the all-in-one dsh-bridge CLI.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findRuntime } from '../src/cli/runtime.js'
import { mcpConfig } from '../src/cli/connect.js'
import { VERSION, PROTOCOL } from '../src/version.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const cli = join(root, 'bin', 'dsh-bridge.mjs')

/** A fake home with a fake profile, so no test touches the real ~/.dsh. */
function fakeHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-cli-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const profile = join(home, '.dsh', 'profiles', 'demo')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'demo', dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }, null, 2))
  writeFileSync(join(profile, 'cordis.patch.yml'), '# demo\n')
  return { home, profile }
}

function run(args, home, extraEnv = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, DSH_AGENT_NAME: 'test', ...extraEnv }
  delete env.DSH_BRIDGE_STATE_FILE
  return spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 30000 })
}

/** Every file under a folder with its size and mtime, to prove nothing changed. */
function snapshot(dir) {
  const out = {}
  const walk = (d) => { for (const name of readdirSync(d)) { const p = join(d, name); const s = statSync(p); if (s.isDirectory()) walk(p); else out[p] = `${s.size}:${s.mtimeMs}` } }
  walk(dir)
  return out
}

test('R2.1 findRuntime prefers DSH_NODE, then the DSH install, then node on PATH', () => {
  const exe = 'C:\\Users\\u\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe'
  const fromEnv = findRuntime({ env: { DSH_NODE: 'D:\\node\\node.exe', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, platform: 'win32', exists: () => true })
  assert.deepEqual({ source: fromEnv.source, command: fromEnv.command }, { source: 'env', command: 'D:\\node\\node.exe' })
  const fromDsh = findRuntime({ env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, platform: 'win32', exists: (p) => p === exe })
  assert.equal(fromDsh.source, 'dsh-electron')
  assert.equal(fromDsh.command, exe)
  assert.deepEqual(fromDsh.env, { ELECTRON_RUN_AS_NODE: '1' })
  const fromPath = findRuntime({ env: {}, platform: 'linux', exists: () => false, execPath: '/usr/bin/node' })
  assert.equal(fromPath.source, 'path')
})

test('R2.1 runtime prints its source and Node version', (t) => {
  const { home } = fakeHome(t)
  const result = run(['runtime'], home)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^(env|dsh-electron|path) \d+\.\d+\.\d+/m)
})

test('R2.2 install --dry-run prints the plan and changes nothing', (t) => {
  const { home, profile } = fakeHome(t)
  const before = snapshot(home)
  const result = run(['install', '--profile', 'demo', '--source', 'github', '--version', '0.6.2', '--dry-run'], home)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /dry run/i)
  assert.match(result.stdout, /github:FloStyle\/dsh-agent-bridge#v0\.6\.2/)
  assert.match(result.stdout, /back up .*package\.json/i)
  assert.deepEqual(snapshot(home), before, 'a dry run must not touch the profile')
  assert.ok(!existsSync(join(home, '.dsh', 'backups')))
  assert.ok(existsSync(join(profile, 'package.json')))
})

test('R2.2 uninstall --dry-run lists the private files, including the token file, and changes nothing', (t) => {
  const { home } = fakeHome(t)
  for (const name of ['agent-bridge.json', 'agent-bridge.token', 'agent-bridge-audit.jsonl']) writeFileSync(join(home, '.dsh', name), 'x')
  const before = snapshot(home)
  const result = run(['uninstall', '--profile', 'demo', '--dry-run'], home)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /agent-bridge\.token/)
  assert.match(result.stdout, /dsh plugin --profile demo remove dsh-agent-bridge/)
  assert.deepEqual(snapshot(home), before)
})

test('R2.4 an offline install refuses a tarball whose SHA-256 does not match', (t) => {
  const { home } = fakeHome(t)
  const tarball = join(home, 'bridge.tgz')
  writeFileSync(tarball, 'not really a tarball')
  const before = snapshot(home)
  const wrong = run(['install', '--profile', 'demo', '--source', 'file', '--tarball', tarball, '--sha256', '0'.repeat(64)], home)
  assert.equal(wrong.status, 1)
  assert.match(wrong.stderr, /SHA-256 mismatch/)
  assert.deepEqual(snapshot(home), before)
  const sha = createHash('sha256').update(readFileSync(tarball)).digest('hex')
  const right = run(['install', '--profile', 'demo', '--source', 'file', '--tarball', tarball, '--sha256', sha, '--dry-run'], home)
  assert.equal(right.status, 0, right.stdout + right.stderr)
  assert.match(right.stdout, /SHA-256 verified/)
})

test('R2.3 connect builds configs with an absolute runtime, the MCP entry and a sender name', () => {
  const runtime = { source: 'dsh-electron', command: 'C:\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe', env: { ELECTRON_RUN_AS_NODE: '1' } }
  const entry = 'C:\\Users\\u\\.dsh\\profiles\\desktop\\node_modules\\dsh-agent-bridge\\mcp\\mcp.mjs'
  const claude = mcpConfig('claude', { name: 'reviewer', runtime, entry })
  assert.deepEqual(claude.args.slice(0, 3), ['mcp', 'add', 'dsh-agent-bridge'])
  assert.ok(claude.args.includes('DSH_AGENT_NAME=reviewer'))
  assert.ok(claude.args.includes('ELECTRON_RUN_AS_NODE=1'))
  assert.equal(claude.args.at(-2), runtime.command)
  assert.equal(claude.args.at(-1), entry)
  const codex = mcpConfig('codex', { name: 'codex', runtime, entry })
  assert.match(codex.text, /\[mcp_servers\.dsh-agent-bridge\]/)
  assert.match(codex.text, /DSH_AGENT_NAME = "codex"/)
  assert.match(codex.text, /C:\/Programs\/DeepSeek Harness\/DeepSeek Harness\.exe/)
  const generic = JSON.parse(mcpConfig('generic', { name: 'cursor', runtime, entry }).text)
  assert.equal(generic.mcpServers['dsh-agent-bridge'].env.DSH_AGENT_NAME, 'cursor')
  for (const text of [JSON.stringify(claude), codex.text, JSON.stringify(generic)]) assert.doesNotMatch(text, /token/i)
})

test('R2.3 connect without --execute only prints', (t) => {
  const { home } = fakeHome(t)
  const result = run(['connect', 'generic', '--name', 'cursor', '--profile', 'demo'], home)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /"DSH_AGENT_NAME": "cursor"/)
})

test('R2.5 one version source and no hard-coded release tags', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(VERSION, pkg.version)
  assert.equal(PROTOCOL, 1)
  assert.equal(JSON.parse(readFileSync(join(root, 'mcp', 'package.json'), 'utf8')).version, pkg.version, 'mcp/package.json must match')
  for (const dir of ['bin', 'src', 'scripts']) {
    const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])
    for (const file of walk(join(root, dir))) {
      assert.doesNotMatch(readFileSync(file, 'utf8'), /#v0\.\d+\.\d+|v0\.\d+\.\d+\.tgz/, `${file} hard-codes a release tag`)
    }
  }
})

test('R2.6 live-check refuses the desktop profile unless --read-only', (t) => {
  const { home } = fakeHome(t)
  const result = run(['live-check', '--profile', 'desktop'], home)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /--read-only/)
})

test('R2.2 the old connect scripts delegate to the CLI', () => {
  for (const script of ['scripts/connect-claude-code.ps1', 'scripts/connect-claude-code.sh']) {
    assert.match(readFileSync(join(root, script), 'utf8'), /dsh-bridge(\.mjs)?["']? connect claude/, `${script} must delegate to dsh-bridge connect`)
  }
})
