// The control API: authentication, the request log, and every route.
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { parseDenials } from './denials.js'
import { readBody, send } from './http.js'
import { flattenCatalog, resolveModel, sessionModel } from './models.js'
import { validatePrompt } from './prompt.js'
import { agentNameOf, clip, compact } from './transcript.js'
import { resolveWorkspace, wsInfo } from './workspaces.js'

export function createHandler({ dsh, hub, status, authorized, audit, prompter, access, messenger, config, health, port }) {
  // X3: only loopback names for this port; anything else is a rebinding or a mistake.
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
  const { counters, lastSeen } = status
  const { prompt, modelCatalog, selectModel, agentOfRequest } = prompter

  // P3: one session list per second at most; a create clears it.
  let listCache
  const listSessions = async (signal) => {
    if (listCache && Date.now() - listCache.at < 1000) return listCache.value
    const value = await dsh.listSessions(signal)
    listCache = { at: Date.now(), value }
    return value
  }

  /** Every event of a session, paging back with beforeSeq through at most `maxPages` pages. */
  const allEvents = async (sessionId, signal, maxPages = 50) => {
    const pages = []
    let beforeSeq
    let hasMore = true
    for (let page = 0; page < maxPages && hasMore; page++) {
      const history = await dsh.sessionEvents({ address: { kind: 'session', sessionId }, maxMessages: 1000, ...(beforeSeq === undefined ? {} : { beforeSeq }) }, signal)
      pages.unshift((history.records ?? []).map((record) => record.event).filter(Boolean))
      hasMore = Boolean(history.hasMore) && typeof history.cursor === 'number' && history.cursor !== beforeSeq
      beforeSeq = history.cursor
    }
    return { events: pages.flat(), truncated: hasMore }
  }

  return async (req, res) => {
    let url
    try { url = new URL(req.url, 'http://127.0.0.1') }
    catch { return send(res, 400, { error: 'Invalid URL' }) }
    const entry = { time: Date.now(), method: req.method, path: url.pathname, agent: agentNameOf(req.headers['x-agent-name']), status: 0, ms: 0 }
    res.on('finish', () => {
      entry.status = res.statusCode
      entry.ms = Date.now() - entry.time
      if (res.statusCode >= 400) counters.errors++
    })
    if (url.pathname !== '/events') { counters.total++; lastSeen.request = entry.time; status.track(entry) }
    try {
      if (port && !allowedHosts.has(String(req.headers.host ?? '').toLowerCase())) return send(res, 403, { error: 'Host not allowed' })
      if (!authorized(req.headers.authorization)) {
        counters.unauthorized++
        // X4: an unauthenticated caller must not choose the name shown to the
        // operator, and the request log must say what happened.
        entry.kind = 'unauthorized'
        entry.agent = null
        return send(res, 401, { error: 'unauthorized' })
      }
      // L2: the MCP client sends this name when DSH_AGENT_NAME is unset, and the
      // operator needs to see that some client is unnamed. Counted only after
      // auth, so an unauthenticated caller cannot set it.
      if (entry.agent === 'mcp-agent') status.state.defaultAgentSeen = true
      // Browser pages use DSH's authenticated UI route, never this control API.
      if (req.headers.origin) return send(res, 403, { error: 'Browser origins are not allowed' })
      if (url.pathname === '/events') { lastSeen.sse = Date.now(); res.__since = Date.now() }
      const parts = url.pathname.split('/').filter(Boolean)
      if (parts[1]) entry.sessionId = parts[1]
      const signal = new AbortController().signal

      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, health())

      if (req.method === 'GET' && url.pathname === '/events') {
        const raw = url.searchParams.get('since') ?? req.headers['last-event-id']
        if (raw !== undefined && raw !== null && !/^\d+$/.test(String(raw))) return send(res, 400, { error: 'since must be a non-negative integer' })
        const since = raw === undefined || raw === null ? hub.lastId() : Number(raw)
        if (!hub.attach(res, since)) return send(res, 429, { error: 'Too many event streams' })
        return
      }

      if (req.method === 'POST' && url.pathname === '/ping') {
        const body = await readBody(req)
        entry.kind = 'ping'
        return send(res, 200, await messenger.send(body, entry.agent))
      }

      if (req.method === 'GET' && url.pathname === '/models') return send(res, 200, flattenCatalog(await modelCatalog()))
      if (req.method === 'GET' && url.pathname === '/profiles') return send(res, 200, { items: access.list() })
      if (req.method === 'GET' && url.pathname === '/workspaces') return send(res, 200, { items: dsh.listWorkspaces().map(wsInfo) })

      if (parts[0] === 'sessions') {
        const sessionId = parts[1]
        if (req.method === 'GET' && parts.length === 1) {
          const { items } = await listSessions(signal)
          return send(res, 200, { items })
        }
        if (req.method === 'GET' && parts.length === 2) {
          const limit = Number(url.searchParams.get('limit') ?? 40)
          if (!Number.isInteger(limit) || limit < 0 || limit > 1000) return send(res, 400, { error: 'limit must be 0-1000' })
          const state = await dsh.sessionState(sessionId, signal)
          const history = await dsh.sessionEvents({ address: { kind: 'session', sessionId }, maxMessages: Math.min(1000, Math.max(1, limit || 1000)) }, signal)
          const events = (history.records ?? []).map((record) => record.event).filter(Boolean)
          counters.reads++; entry.kind = 'read'
          const row = (await listSessions(signal)).items.find((i) => i.sessionId === sessionId)
          return send(res, 200, { sessionId, title: row?.projections?.values?.title, cwd: row?.cwd, model: sessionModel(row?.projections?.values), running: state.running, pendingInput: state.pendingInput, cursor: history.cursor, hasMore: history.hasMore, entries: compact(events, limit, agentOfRequest) })
        }
        if (req.method === 'GET' && parts.length === 3 && parts[2] === 'access') return send(res, 200, access.view(sessionId))
        if (req.method === 'POST' && parts.length === 3 && parts[2] === 'profile') {
          const body = await readBody(req)
          entry.kind = 'profile'
          const row = (await listSessions(signal)).items.find((i) => i.sessionId === sessionId)
          return send(res, 200, { sessionId, access: access.apply(sessionId, body.profile, entry.agent, { cwd: dsh.sessionById(sessionId)?.header?.cwd ?? row?.cwd }) })
        }
        if (req.method === 'GET' && parts.length === 3 && parts[2] === 'denials') {
          // W4: read-only, structured sandbox denials for the access report.
          const { events, truncated } = await allEvents(sessionId, signal)
          counters.reads++; entry.kind = 'denials'
          const row = (await listSessions(signal)).items.find((i) => i.sessionId === sessionId)
          return send(res, 200, { sessionId, cwd: row?.cwd, truncated, denials: parseDenials(events) })
        }
        if (req.method === 'POST' && parts.length === 1) {
          const body = await readBody(req)
          if (body.text !== undefined) {
            // Refuse before a session exists, and leave the refusal in the audit trail.
            try { validatePrompt(body.text, body.mode) } catch (error) {
              audit({ action: 'prompt', outcome: 'refused', status: error.status ?? 400, agent: entry.agent, mode: body.mode ?? 'followup', text: body.text })
              throw error
            }
          }
          // A profile fixes the cwd; an agent names the profile, never a path.
          const profile = body.profile !== undefined ? access.profileNamed(body.profile) : undefined
          if (profile) {
            if (body.cwd !== undefined && body.cwd !== profile.cwd) return send(res, 400, { error: `profile "${profile.name}" sets the cwd; do not pass another one` })
            body.cwd = profile.cwd
          }
          for (const field of ['cwd', 'workspace']) if (body[field] !== undefined && (typeof body[field] !== 'string' || !body[field].trim() || body[field].length > 4096)) return send(res, 400, { error: `Invalid ${field}` })
          if (body.cwd !== undefined) {
            // A workspace is a real folder, not an arbitrary string DSH must guess about.
            if (!isAbsolute(body.cwd)) return send(res, 400, { error: 'cwd must be an absolute path' })
            let directory = false
            try { directory = statSync(body.cwd).isDirectory() } catch { directory = false }
            if (!directory) return send(res, 400, { error: 'cwd must be an existing directory' })
          }
          // Resolve the model before a session exists, so a bad choice creates nothing.
          // An explicit model wins; otherwise the bridge's configured default, if any.
          const wanted = body.model !== undefined ? { model: body.model, effort: body.reasoningEffort } : config.defaultModel ? { model: config.defaultModel, effort: config.defaultReasoningEffort } : undefined
          const selection = wanted ? resolveModel(wanted.model, wanted.effort, await modelCatalog()) : undefined
          counters.creates++; entry.kind = 'create'; entry.text = clip(body.text, 200); entry.cwd = body.cwd
          const ws = await resolveWorkspace(dsh, body.workspace, body.cwd)
          const created = await dsh.createSession(ws ? { workspaceId: ws.id } : body.cwd ? { cwd: body.cwd } : {})
          listCache = undefined
          entry.workspace = ws?.title
          entry.sessionId = created.sessionId
          audit({ action: 'create', outcome: 'accepted', status: 200, agent: entry.agent, sessionId: created.sessionId, cwd: body.cwd, workspace: ws?.title })
          const applied = profile ? access.apply(created.sessionId, profile.name, entry.agent, { cwd: profile.cwd }) : undefined
          const model = selection ? await selectModel(created.sessionId, selection, entry.agent) : undefined
          const prompted = body.text ? await prompt(created.sessionId, body.text, body.mode, entry.agent) : undefined
          return send(res, 200, { ...created, ...(applied ? { access: applied } : {}), ...(model ? { model } : {}), ...(prompted ?? {}), bootId: hub.bootId, eventId: prompted?.eventId ?? hub.lastId() })
        }
        if (req.method === 'POST' && parts.length === 3 && parts[2] === 'prompt') {
          const body = await readBody(req)
          counters.prompts++; entry.kind = body.mode === 'steer' ? 'steer' : 'prompt'; entry.text = clip(body.text, 200)
          // prompt() validates and audits the refusal itself.
          return send(res, 200, await prompt(sessionId, body.text, body.mode, entry.agent))
        }
        if (req.method === 'POST' && parts.length === 3 && parts[2] === 'model') {
          const body = await readBody(req)
          entry.kind = 'model'
          let selection
          try {
            selection = resolveModel(body.model, body.reasoningEffort, await modelCatalog())
          } catch (error) {
            audit({ action: 'model', outcome: 'refused', status: error.status ?? 400, agent: entry.agent, sessionId, model: typeof body.model === 'string' ? body.model : undefined })
            throw error
          }
          return send(res, 200, { sessionId, selected: await selectModel(sessionId, selection, entry.agent) })
        }
        if (req.method === 'POST' && parts.length === 3 && parts[2] === 'cancel') {
          try {
            const value = (await dsh.cancel(sessionId)) ?? { cancelled: true }
            audit({ action: 'cancel', outcome: 'accepted', status: 200, agent: entry.agent, sessionId })
            return send(res, 200, value)
          } catch (error) {
            // T6: SECURITY.md promises that failed actions are recorded too.
            audit({ action: 'cancel', outcome: 'failed', status: error?.status ?? 500, agent: entry.agent, sessionId, error: String(error?.message ?? error) })
            throw error
          }
        }
      }
      send(res, 404, { error: 'not found' })
    } catch (error) {
      entry.error = String(error?.message ?? error)
      send(res, error.status ?? 500, { error: entry.error, code: error?.code })
    }
  }
}
