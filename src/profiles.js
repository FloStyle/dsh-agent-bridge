// Access profiles: owner-written settings for sessions the bridge starts.
//
//   { "profiles": { "<name>": { "description"?, "cwd", "extraRoots"?: [path | {path, allowSensitive}], "preset"? } } }
//
// Agents may name a profile; only the owner writes paths. Extra roots apply to
// DSH file tools; on Windows, shell commands ignore them (docs/spikes/writable-roots.md).
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const FULL_ACCESS = 'danger-full-access'

export function profilesFileFor(stateFile) {
  return process.env.DSH_BRIDGE_PROFILES_FILE || join(dirname(stateFile), 'agent-bridge-profiles.json')
}

export function loadProfiles(file) {
  if (!existsSync(file)) return {}
  const data = JSON.parse(readFileSync(file, 'utf8'))
  return data?.profiles && typeof data.profiles === 'object' ? data.profiles : {}
}

export function saveProfiles(file, profiles) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ profiles }, null, 2) + '\n', { mode: 0o600 })
}

const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)
const inside = (child, parent) => same(child, parent) || (process.platform === 'win32' ? child.toLowerCase() : child).startsWith((process.platform === 'win32' ? parent.toLowerCase() : parent) + sep)

/** Problems with one folder; `label` names it in messages. */
function folderProblems(path, label, allowSensitive) {
  const errors = []
  const warnings = []
  if (typeof path !== 'string' || !path.trim()) return { errors: [`${label} is missing`], warnings }
  if (!isAbsolute(path)) return { errors: [`${label} must be an absolute path: ${path}`], warnings }
  const full = resolve(path)
  const home = homedir()
  const sensitive = []
  if (same(full, parse(full).root)) errors.push(`${label} is a drive root: ${full}`)
  if (same(full, home)) errors.push(`${label} is the home folder itself: ${full}`)
  for (const name of ['.dsh', '.ssh']) if (inside(full, join(home, name))) sensitive.push(`${label} is inside ~/${name}: ${full}`)
  if (/[\\/]\.git[\\/]hooks([\\/]|$)/i.test(full)) sensitive.push(`${label} contains .git hooks: ${full}`)
  if (sensitive.length && allowSensitive) warnings.push(...sensitive.map((s) => `${s} (allowed by allowSensitive)`))
  else errors.push(...sensitive)
  if (!errors.length) {
    let directory = false
    try { directory = statSync(full).isDirectory() } catch { directory = false }
    if (!directory) errors.push(`${label} does not exist or is not a folder: ${full}`)
  }
  return { errors, warnings }
}

/**
 * Check one profile. `errors` blocks its use; `warnings` are shown by doctor.
 * @returns {{errors: string[], warnings: string[], profile: object}}
 */
export function validateProfile(input) {
  const errors = []
  const warnings = []
  const name = input?.name
  if (name !== undefined && !NAME.test(String(name))) errors.push(`profile name must be 1-64 letters, digits, dot, dash or underscore: ${name}`)
  const cwd = folderProblems(input?.cwd, 'cwd', false)
  errors.push(...cwd.errors)
  const roots = []
  for (const entry of input?.extraRoots ?? []) {
    const path = typeof entry === 'string' ? entry : entry?.path
    const checked = folderProblems(path, 'extra root', Boolean(entry?.allowSensitive))
    errors.push(...checked.errors)
    warnings.push(...checked.warnings)
    if (typeof path === 'string') roots.push(resolve(path))
  }
  if (input?.preset === FULL_ACCESS) errors.push('full access is set by the owner in DSH, not through a bridge profile')
  if (input?.preset !== undefined && typeof input.preset !== 'string') errors.push('preset must be a preset name')
  const profile = { cwd: typeof input?.cwd === 'string' ? resolve(input.cwd) : input?.cwd, extraRoots: roots }
  if (input?.preset) profile.preset = input.preset
  if (input?.description) profile.description = String(input.description).slice(0, 200)
  return { errors, warnings, profile }
}
