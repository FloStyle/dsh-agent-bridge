// dsh-bridge profile: the owner edits access profiles. `add` and `remove`
// preview by default and change the file only with --yes.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadProfiles, saveProfiles, validateProfile } from '../profiles.js'

const defaultFile = () => process.env.DSH_BRIDGE_PROFILES_FILE
  || join(process.env.DSH_BRIDGE_STATE_FILE ? join(process.env.DSH_BRIDGE_STATE_FILE, '..') : join(homedir(), '.dsh'), 'agent-bridge-profiles.json')

const asList = (value) => (value === undefined || value === true ? [] : Array.isArray(value) ? value : [value])

export function profileCommand(options, out = console) {
  const [action = 'list', name] = options._
  const file = options.file ?? defaultFile()
  const profiles = loadProfiles(file)

  if (action === 'list') {
    const names = Object.keys(profiles)
    if (!names.length) out.log(`No profiles in ${file}.`)
    for (const n of names) {
      const { errors } = validateProfile({ ...profiles[n], name: n })
      out.log(`${errors.length ? 'INVALID' : 'ok     '} ${n}  ${profiles[n].cwd}${profiles[n].preset ? `  [${profiles[n].preset}]` : ''}`)
    }
    return 0
  }
  if (action === 'show') {
    if (!profiles[name]) throw new Error(`no profile "${name}" in ${file}`)
    out.log(JSON.stringify({ [name]: profiles[name] }, null, 2))
    return 0
  }
  if (action === 'validate') {
    let bad = 0
    for (const [n, raw] of Object.entries(profiles)) {
      const { errors, warnings } = validateProfile({ ...raw, name: n })
      for (const e of errors) out.log(`FAIL  ${n}: ${e}`)
      for (const w of warnings) out.log(`WARN  ${n}: ${w}`)
      if (!errors.length) out.log(`OK    ${n}`)
      bad += errors.length ? 1 : 0
    }
    return bad ? 1 : 0
  }
  if (action === 'add') {
    if (!name) throw new Error('usage: dsh-bridge profile add <name> --cwd <folder> [--root <folder>]... [--preset <name>] [--description <text>] [--yes]')
    const input = { name, cwd: options.cwd, extraRoots: asList(options.root), preset: options.preset, description: options.description }
    const { errors, warnings, profile } = validateProfile(input)
    if (errors.length) throw new Error(errors.join('; '))
    for (const w of warnings) out.log(`warning: ${w}`)
    out.log(`${options.yes ? 'Writing' : 'Would write'} to ${file}:`)
    out.log(JSON.stringify({ [name]: profile }, null, 2))
    if (!options.yes) { out.log('\nOnly the owner should add profiles. Re-run with --yes to write it.'); return 0 }
    saveProfiles(file, { ...profiles, [name]: profile })
    return 0
  }
  if (action === 'remove') {
    if (!profiles[name]) throw new Error(`no profile "${name}" in ${file}`)
    if (!options.yes) { out.log(`Would remove "${name}" from ${file}. Re-run with --yes.`); return 0 }
    const { [name]: _, ...rest } = profiles
    saveProfiles(file, rest)
    out.log(`Removed "${name}".`)
    return 0
  }
  throw new Error(`unknown action "${action}"; use list, show, add, remove or validate`)
}
