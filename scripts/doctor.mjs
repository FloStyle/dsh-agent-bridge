// dsh-agent-bridge doctor: read-only checks with one fix line per failure.
//
//   node scripts/doctor.mjs [--profile desktop] [--repo .]
//
// It reads the profile manifest, the private state file and the bridge's /health.
// It never prints the token and never changes anything.
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
const argValue = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const profile = argValue('--profile', 'desktop')
const repo = resolve(argValue('--repo', join(import.meta.dirname, '..')))
const profileDir = join(homedir(), '.dsh', 'profiles', profile)
const stateFile = process.env.DSH_BRIDGE_STATE_FILE || join(homedir(), '.dsh', 'agent-bridge.json')
const packageName = 'dsh-agent-bridge'

const expectedProtocol = 1
let failures = 0
let warnings = 0
const ok = (label, detail = '') => console.log(`OK    ${label}${detail ? `: ${detail}` : ''}`)
const warn = (label, detail, fix) => { warnings++; console.log(`WARN  ${label}: ${detail}`); if (fix) console.log(`      fix: ${fix}`) }
const bad = (label, detail, fix) => { failures++; console.log(`FAIL  ${label}: ${detail}`); if (fix) console.log(`      fix: ${fix}`) }

// ---- 1. DSH CLI ----------------------------------------------------------------------------------
let dshVersion
try {
  // One command string: on Windows the CLI is a .cmd shim, which needs a shell.
  const cli = spawnSync('dsh --version', { encoding: 'utf8', shell: true, timeout: 20000 })
  const text = `${cli.stdout ?? ''}${cli.stderr ?? ''}`.trim()
  const match = text.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)
  dshVersion = match?.[0]
} catch { dshVersion = undefined }
if (dshVersion) ok('dsh CLI', dshVersion)
else bad('dsh CLI', 'not found on PATH', 'run this from a shell that can call dsh, or add the DSH runtime bin directory to PATH')

// ---- 2. installed plugin -------------------------------------------------------------------------
const installedManifest = join(profileDir, 'node_modules', packageName, 'package.json')
let installedVersion
if (existsSync(installedManifest)) {
  installedVersion = JSON.parse(readFileSync(installedManifest, 'utf8')).version
} else {
  bad(`plugin in profile '${profile}'`, 'not installed', `dsh plugin --profile ${profile} add github:FloStyle/dsh-agent-bridge#v0.6.1`)
}

const repoVersion = (() => {
  try { return JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version } catch { return undefined }
})()
if (installedVersion && repoVersion) {
  const compare = (a, b) => {
    const parse = (v) => v.split('-')[0].split('.').map((n) => Number(n))
    const [x, y] = [parse(a), parse(b)]
    for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1 }
    return 0
  }
  const order = compare(installedVersion, repoVersion)
  if (order < 0) warn('plugin version', `outdated: ${installedVersion} < ${repoVersion}`, `node scripts/install.ps1 -Source release -Version ${repoVersion} -Profile ${profile}, then restart DSH`)
  else if (order > 0) warn('plugin version', `${installedVersion} is newer than this clone (${repoVersion})`, 'run the doctor from the matching clone')
  else ok('plugin version', installedVersion)
} else if (installedVersion) {
  ok('plugin version', installedVersion)
}

// ---- 3. state file and /health -------------------------------------------------------------------
if (!existsSync(stateFile)) {
  bad('state file', `missing at ${stateFile}`, 'start DeepSeek Harness with the bridge plugin loaded; DSH writes this file')
} else {
  let state
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')) } catch { state = undefined }
  if (!state?.url || !state?.token) {
    bad('state file', `${stateFile} is not valid bridge state`, 'stop DSH, remove the file and restart to regenerate it')
  } else {
    const url = new URL(state.url)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
      bad('state file', `URL is not loopback HTTP: ${state.url}`, 'remove the file and restart DSH to regenerate it')
    } else {
      ok('state file', stateFile)
      let health
      try {
        const response = await fetch(`${url.origin}/health`, {
          headers: { authorization: `Bearer ${state.token}` },
          redirect: 'error',
          signal: AbortSignal.timeout(10000),
        })
        health = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
      } catch (error) {
        bad('bridge /health', `${url.origin} did not answer (${error.cause?.code ?? error.message})`, 'start or restart DeepSeek Harness; the bridge listens only while DSH runs')
      }
      if (health) {
        ok('bridge /health', `${url.origin}, lastEventId ${health.lastEventId ?? '?'}`)
        if (!health.version) {
          warn('bridge version', 'the running plugin does not report a version (older than 0.5.1)', 'install 0.6.1 and restart DSH to make the version visible')
        } else if (installedVersion && health.version !== installedVersion) {
          warn('bridge version', `running ${health.version}, installed ${installedVersion}`, 'restart DSH: the old module is still loaded')
        } else {
          ok('bridge version', health.version)
        }
        if (!health.protocol) {
          warn('protocol', 'not reported by the running plugin', 'install 0.6.1')
        } else if (health.protocol !== expectedProtocol) {
          bad('protocol', `bridge speaks ${health.protocol}, this client speaks ${expectedProtocol}`, 'install the matching versions of the plugin and the MCP client')
        } else {
          ok('protocol', String(health.protocol))
        }
        if (!health.services) {
          warn('injected services', 'not reported by the running plugin', 'install 0.6.1 to check the cordis services from /health')
        } else if (health.services.missing?.length) {
          bad('injected services', `missing: ${health.services.missing.join(', ')}`, `this DSH build differs from the supported range (>=0.2.2-rc.1 <0.3.0); check dsh --version or install a matching plugin`)
        } else {
          ok('injected services', `${health.services.checked} checked, none missing`)
        }
      }
    }
  }
}

// ---- 4. MCP client entry -------------------------------------------------------------------------
const mcpEntry = join(profileDir, 'node_modules', packageName, 'mcp', 'mcp.mjs')
if (existsSync(mcpEntry)) ok('MCP client entry', mcpEntry)
else bad('MCP client entry', `missing at ${mcpEntry}`, `dsh plugin --profile ${profile} add github:FloStyle/dsh-agent-bridge#v0.6.1`)

console.log('')
if (failures) {
  console.log(`${failures} failure(s), ${warnings} warning(s)`)
  process.exit(1)
}
console.log(`all checks passed${warnings ? ` with ${warnings} warning(s)` : ''}`)

