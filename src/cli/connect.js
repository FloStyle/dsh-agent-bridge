// dsh-bridge connect (R2.3): MCP client configs that need no Node on PATH.
//
// The command is an absolute runtime (DSH's own Node when it is installed) and
// the entry is the installed mcp.mjs. DSH_AGENT_NAME is always set. No config
// contains a token: the client reads it at run time from the private files.
import { spawnSync } from 'node:child_process'
import { existsSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findRuntime } from './runtime.js'
import { installedEntry } from './profile.js'

const SERVER = 'dsh-agent-bridge'
const forward = (path) => path.replace(/\\/g, '/')

/** Build the config for one client. Pure: no I/O. */
export function mcpConfig(client, { name, runtime, entry }) {
  const env = { ...runtime.env, DSH_AGENT_NAME: name }
  if (client === 'claude') {
    const args = ['mcp', 'add', SERVER]
    for (const [key, value] of Object.entries(env)) args.push('--env', `${key}=${value}`)
    args.push('--', runtime.command, entry)
    return { kind: 'command', program: 'claude', args }
  }
  if (client === 'codex') {
    const envToml = Object.entries(env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join(', ')
    const text = [
      `[mcp_servers.${SERVER}]`,
      `command = ${JSON.stringify(forward(runtime.command))}`,
      `args = [${JSON.stringify(forward(entry))}]`,
      `env = { ${envToml} }`,
    ].join('\n')
    return { kind: 'toml', file: join(homedir(), '.codex', 'config.toml'), text }
  }
  if (client === 'generic') {
    const text = JSON.stringify({ mcpServers: { [SERVER]: { command: forward(runtime.command), args: [forward(entry)], env } } }, null, 2)
    return { kind: 'json', text }
  }
  throw new Error(`unknown client ${client}; use claude, codex or generic`)
}

export function connect(options, out = console) {
  const client = options._[0]
  if (!client) throw new Error('usage: dsh-bridge connect claude|codex|generic [--name <agent>] [--profile <p>] [--execute]')
  const profile = options.profile ?? 'desktop'
  const name = options.name ?? (client === 'generic' ? 'mcp-client' : client === 'claude' ? 'claude-code' : client)
  const installed = installedEntry(profile)
  const local = fileURLToPath(new URL('../../mcp/mcp.mjs', import.meta.url))
  const entry = existsSync(installed) ? installed : local
  const runtime = findRuntime()
  const config = mcpConfig(client, { name, runtime, entry })

  if (config.kind === 'command') {
    const rendered = [config.program, ...config.args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')
    out.log(rendered)
    if (!options.execute) { out.log('\nRe-run with --execute to register it now.'); return 0 }
    const result = spawnSync(config.program, config.args, { stdio: 'inherit', shell: process.platform === 'win32' })
    if (result.status !== 0) throw new Error(`claude mcp add failed with exit code ${result.status}`)
    out.log('Registered. Restart the client, then ask it to call dsh_list.')
    return 0
  }
  if (config.kind === 'toml') {
    out.log(config.text)
    if (!options.execute) { out.log(`\nAdd this to ${config.file}, or re-run with --execute to append it (a backup is made first).`); return 0 }
    const existing = existsSync(config.file) ? readFileSync(config.file, 'utf8') : ''
    if (existing.includes(`[mcp_servers.${SERVER}]`)) throw new Error(`${config.file} already has [mcp_servers.${SERVER}]; edit it by hand`)
    if (existing) copyFileSync(config.file, `${config.file}.bak`)
    writeFileSync(config.file, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}\n${config.text}\n`)
    out.log(`Appended to ${config.file}${existing ? ` (backup: ${config.file}.bak)` : ''}. Restart Codex.`)
    return 0
  }
  out.log(config.text)
  if (options.execute) out.log('\n--execute is not supported for generic clients; paste this into the client config.')
  return 0
}
