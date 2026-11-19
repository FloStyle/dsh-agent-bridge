// Applying access profiles to sessions, and reading a session's access.
//
// DSH does not persist writable-root registrations, so the bridge keeps a
// session-to-profile map and registers the roots again the first time it sees
// a mapped session after a restart. Every grant is audited.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { loadProfiles, profilesFileFor, validateProfile } from './profiles.js'

const fail = (message, status) => Object.assign(new Error(message), { status })
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b))

export function createAccess({ dsh, audit, stateFile }) {
  const profilesFile = profilesFileFor(stateFile)
  const mapFile = join(dirname(stateFile), 'agent-bridge', 'session-profiles.json')
  /** sessionId -> {profile, roots: Map<path, dispose>} for this boot. */
  const live = new Map()

  const readMap = () => { try { return JSON.parse(readFileSync(mapFile, 'utf8')) } catch { return {} } }
  const writeMap = (map) => { mkdirSync(dirname(mapFile), { recursive: true }); writeFileSync(mapFile, JSON.stringify(map, null, 2) + '\n', { mode: 0o600 }) }

  /** A named, valid profile, or a 400. */
  function profileNamed(name) {
    if (typeof name !== 'string' || !name) throw fail('profile must be a profile name', 400)
    const all = existsSync(profilesFile) ? loadProfiles(profilesFile) : {}
    if (!Object.hasOwn(all, name)) throw fail(`unknown profile "${name}"; have: ${Object.keys(all).join(', ') || 'none'}`, 400)
    const { errors, profile } = validateProfile({ ...all[name], name })
    if (errors.length) throw fail(`profile "${name}" is invalid: ${errors.join('; ')}`, 400)
    return { name, ...profile }
  }

  function services() {
    const found = dsh.accessServices()
    if (!found) throw fail('this DSH build does not expose the sandbox policy and permission presets services', 501)
    return found
  }

  function registerRoots(session, profile, agent) {
    const { sandboxPolicy } = services()
    const state = live.get(session.id) ?? { profile: profile.name, roots: new Map() }
    state.profile = profile.name
    for (const root of profile.extraRoots) {
      if (state.roots.has(root)) continue
      state.roots.set(root, sandboxPolicy.registerWritableRoot(session, root))
      audit({ action: 'grant', outcome: 'accepted', status: 200, agent, sessionId: session.id, profile: profile.name, root })
    }
    live.set(session.id, state)
  }

  return {
    profilesFile,
    /** Public profile list for agents: name, description, cwd, roots, preset. */
    list() {
      const all = existsSync(profilesFile) ? loadProfiles(profilesFile) : {}
      return Object.entries(all).map(([name, raw]) => {
        const { errors, profile } = validateProfile({ ...raw, name })
        return { name, description: profile.description, cwd: profile.cwd, extraRoots: profile.extraRoots, preset: profile.preset, valid: errors.length === 0 }
      })
    },
    profileNamed,
    /** Apply a profile to a live session whose cwd must equal the profile's cwd. */
    apply(sessionId, name, agent, { cwd } = {}) {
      const profile = profileNamed(name)
      const { permissionPresets } = services()
      const session = dsh.sessionById(sessionId)
      if (!session) throw fail(`session ${sessionId} is not loaded in DSH; send it a prompt first`, 409)
      const sessionCwd = cwd ?? session.header?.cwd
      if (sessionCwd && !same(sessionCwd, profile.cwd)) throw fail(`profile "${name}" is for ${profile.cwd}, but the session works in ${sessionCwd}; a session's cwd cannot change`, 409)
      if (profile.preset) {
        permissionPresets.set(session, profile.preset)
        audit({ action: 'preset', outcome: 'accepted', status: 200, agent, sessionId, profile: name, preset: profile.preset })
      }
      registerRoots(session, profile, agent)
      const map = readMap()
      map[sessionId] = name
      writeMap(map)
      return { profile: name, preset: profile.preset, roots: profile.extraRoots }
    },
    /** Called for every session event: re-register the roots of a mapped session once per boot. */
    seen(session) {
      if (!session?.id || live.has(session.id)) return
      const name = readMap()[session.id]
      if (!name) return
      try { registerRoots(session, profileNamed(name), 'bridge-restore') } catch (error) {
        live.set(session.id, { profile: name, roots: new Map(), error: error.message })
        dsh.logger.warn(`agent-bridge: could not restore profile "${name}" for ${session.id}: ${error.message}`)
      }
    },
    /** What the bridge knows about a session's access. */
    view(sessionId) {
      const found = dsh.accessServices()
      const session = dsh.sessionById(sessionId)
      const state = live.get(sessionId)
      return {
        sessionId,
        preset: found && session ? found.permissionPresets.current(session) : undefined,
        profile: state?.profile ?? readMap()[sessionId],
        roots: state ? [...state.roots.keys()] : [],
        ...(state?.error ? { error: state.error } : {}),
        servicesAvailable: Boolean(found),
      }
    },
  }
}
