// DSH profile helpers shared by install, uninstall and connect.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PACKAGE } from '../version.js'

export const BACKUP_FILES = ['package.json', 'pnpm-lock.yaml', 'cordis.yml', 'cordis.patch.yml']

export const dshHome = () => join(homedir(), '.dsh')
export const profileDir = (profile) => join(dshHome(), 'profiles', profile)
export const installedEntry = (profile) => join(profileDir(profile), 'node_modules', PACKAGE, 'mcp', 'mcp.mjs')

/** The private runtime files the bridge writes. */
export function privateFiles() {
  const stateFile = process.env.DSH_BRIDGE_STATE_FILE || join(dshHome(), 'agent-bridge.json')
  const auditFile = process.env.DSH_BRIDGE_AUDIT_FILE || join(dshHome(), 'agent-bridge-audit.jsonl')
  return [stateFile, join(stateFile, '..', 'agent-bridge.token'), auditFile, `${auditFile}.1`]
}

export function readManifest(profile) {
  const file = join(profileDir(profile), 'package.json')
  if (!existsSync(file)) return undefined
  return JSON.parse(readFileSync(file, 'utf8'))
}

export function writeManifest(profile, manifest) {
  writeFileSync(join(profileDir(profile), 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
}

export function bundlesOf(manifest) {
  return Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
}

/** Copy the profile files to ~/.dsh/backups/<profile>-<timestamp>; returns the folder and the copied names. */
export function backupProfile(profile, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const folder = join(dshHome(), 'backups', `${profile}-${stamp}`)
  const copied = []
  for (const name of BACKUP_FILES) {
    const source = join(profileDir(profile), name)
    if (!existsSync(source)) continue
    mkdirSync(folder, { recursive: true })
    copyFileSync(source, join(folder, name))
    copied.push(name)
  }
  return { folder, copied }
}

export function restoreProfile(profile, backup) {
  for (const name of backup.copied) copyFileSync(join(backup.folder, name), join(profileDir(profile), name))
}

/** Quote one argument for the Windows command shell when it needs it. */
const quote = (arg) => (/[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)

/** Run the dsh CLI. On Windows it is a .cmd shim, which needs a shell. */
export function runDsh(args, { stdio = 'inherit' } = {}) {
  const result = spawnSync(['dsh', ...args].map(quote).join(' '), { shell: true, stdio, encoding: 'utf8', timeout: 600000 })
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

export function dshAvailable() {
  return runDsh(['--version'], { stdio: 'pipe' }).status === 0
}
