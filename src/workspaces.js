// DSH workspaces as the bridge shows and resolves them.
import { resolve } from 'node:path'

export const wsInfo = (w) => ({ id: w.id, title: w.title, path: w.path, sessionIds: [...(w.sessionIds ?? [])] })

function samePath(a, b) {
  const normalize = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p))
  return typeof a === 'string' && typeof b === 'string' && normalize(a) === normalize(b)
}

/** Workspace by id or title, else the one owning cwd, else a new one for cwd. */
export async function resolveWorkspace(dsh, name, cwd) {
  const all = dsh.listWorkspaces()
  if (name) {
    const hit = all.find((w) => w.id === name) ?? all.find((w) => String(w.title).toLowerCase() === String(name).toLowerCase())
    if (!hit) throw new Error(`no DSH workspace named "${name}" (have: ${all.map((w) => w.title).join(', ')})`)
    return hit
  }
  if (!cwd) return undefined
  return all.find((w) => samePath(w.path, cwd)) ?? await dsh.createWorkspace(cwd, cwd.split(/[\/]/).filter(Boolean).pop())
}
