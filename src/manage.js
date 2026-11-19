// W6: workspace and session management routes. Each change goes through DSH's
// own API and writes an audit line. There is deliberately no delete.
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { readBody, send } from './http.js'
import { loadTemplates, templatesFileFor, validateTemplate } from './templates.js'
import { resolveWorkspace, wsInfo } from './workspaces.js'

const fail = (message, status = 400) => Object.assign(new Error(message), { status })
const SESSION_ACTIONS = {
  archive: (dsh, id) => dsh.archiveSession(id),
  unarchive: (dsh, id) => dsh.unarchiveSession(id),
  pin: (dsh, id) => dsh.pinSession(id),
  unpin: (dsh, id) => dsh.unpinSession(id),
}

export function createManager({ dsh, audit, stateFile, listSessions }) {
  const templatesFile = templatesFileFor(stateFile)

  function templateNamed(name) {
    const all = loadTemplates(templatesFile)
    if (typeof name !== 'string' || !Object.hasOwn(all, name)) throw fail(`unknown template "${name}"; have: ${Object.keys(all).join(', ') || 'none'}`)
    const { errors, template } = validateTemplate(name, all[name])
    if (errors.length) throw fail(`template "${name}" is invalid: ${errors.join('; ')}`)
    return template
  }

  /** Handle a management route; returns false when the route is not one of these. */
  async function handle(req, res, { parts, entry, signal }) {
    const { method } = req
    if (method === 'GET' && parts[0] === 'templates' && parts.length === 1) {
      const all = loadTemplates(templatesFile)
      return send(res, 200, { items: Object.entries(all).map(([name, raw]) => ({ name, ...validateTemplate(name, raw).template })) }), true
    }
    if (parts[0] === 'workspaces') {
      if (method === 'POST' && parts.length === 1) {
        const body = await readBody(req)
        if (typeof body.path !== 'string' || !isAbsolute(body.path)) throw fail('path must be an absolute folder')
        let directory = false
        try { directory = statSync(body.path).isDirectory() } catch { directory = false }
        if (!directory) throw fail('path must be an existing folder')
        const existing = dsh.listWorkspaces().length
        const ws = await resolveWorkspace(dsh, undefined, body.path)
        if (body.title && dsh.listWorkspaces().length > existing) await dsh.getWorkspace(ws.id)?.setTitle?.(String(body.title).slice(0, 200))
        audit({ action: 'workspace-create', outcome: 'accepted', status: 200, agent: entry.agent, workspace: ws.id })
        return send(res, 200, wsInfo(ws)), true
      }
      const workspace = parts[1] ? dsh.listWorkspaces().find((w) => w.id === parts[1] || String(w.title).toLowerCase() === parts[1].toLowerCase()) : undefined
      if (parts.length >= 2 && !workspace) throw fail(`no DSH workspace "${parts[1]}"`, 404)
      if (method === 'POST' && parts.length === 3 && parts[2] === 'title') {
        const body = await readBody(req)
        if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200) throw fail('title must contain 1-200 characters')
        await (dsh.getWorkspace(workspace.id) ?? workspace).setTitle(body.title)
        audit({ action: 'workspace-rename', outcome: 'accepted', status: 200, agent: entry.agent, workspace: workspace.id })
        return send(res, 200, { id: workspace.id, title: body.title }), true
      }
      if (method === 'GET' && parts.length === 3 && parts[2] === 'sessions') {
        const ids = new Set(workspace.sessionIds ?? [])
        const { items } = await listSessions(signal)
        return send(res, 200, { workspace: workspace.id, items: items.filter((i) => ids.has(i.sessionId)).map((i) => ({ sessionId: i.sessionId, title: i.projections?.values?.title, cwd: i.cwd, running: i.running, updatedAt: i.updatedAt })) }), true
      }
      return false
    }
    if (parts[0] === 'sessions' && parts.length === 3 && method === 'POST') {
      const sessionId = parts[1]
      if (parts[2] === 'title') {
        const body = await readBody(req)
        if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200) throw fail('title must contain 1-200 characters')
        await dsh.renameSession(sessionId, body.title)
        audit({ action: 'rename', outcome: 'accepted', status: 200, agent: entry.agent, sessionId })
        return send(res, 200, { sessionId, title: body.title }), true
      }
      if (Object.hasOwn(SESSION_ACTIONS, parts[2])) {
        await SESSION_ACTIONS[parts[2]](dsh, sessionId)
        audit({ action: parts[2], outcome: 'accepted', status: 200, agent: entry.agent, sessionId })
        return send(res, 200, { sessionId, [parts[2]]: true }), true
      }
    }
    return false
  }

  return { handle, templateNamed }
}
