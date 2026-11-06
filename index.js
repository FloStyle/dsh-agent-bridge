// dsh-agent-bridge: exposes DSH sessions to local tools (any MCP agent) over HTTP + SSE.
// Listens on 127.0.0.1 only. Every request needs "Authorization: Bearer <token>";
// the token and URL are written to ~/.dsh/agent-bridge.json at load.
//
// GET  /health
// GET  /sessions                      -> list summaries
// GET  /sessions/:id?limit=N          -> compact transcript (last N entries)
// POST /sessions            {cwd?, text}   -> create a session and send the first prompt
// POST /sessions/:id/prompt {text, mode?}  -> send a prompt (mode: followup | steer)
// POST /sessions/:id/cancel           -> cancel the running turn
// GET  /events?since=ID               -> SSE stream: turn-end, status, error, user-message

import { randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const name = 'agent-bridge'
// cordis runs service methods under the caller's context, so this plugin
// must inject everything SessionController itself injects.
export const inject = [
  'sessionController',
  'agentDefaultModel', 'agents', 'attachments', 'fileUploads', 'fs', 'llm',
  'remoteAccess', 'sessions', 'sessionProjections', 'sessionQuery', 'typert', 'workspaceRegistry',
  'connection', 'typertGateway',
]

function loadToken(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')).token } catch { return undefined }
}

function textOf(content, kinds = ['text']) {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : ''
  return content.filter((p) => kinds.includes(p?.type)).map((p) => p.text ?? '').join('\n').trim()
}

function clip(s, n) {
  s = String(s ?? '')
  return s.length > n ? s.slice(0, n) + `\u2026 [+${s.length - n} chars]` : s
}

function lastAssistantText(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e?.type === 'assistant/message') {
      const t = textOf(e.data?.message?.content)
      if (t) return t
    }
  }
  return ''
}

/** Turn raw session events into a compact, model-friendly transcript. */
function compact(events, limit) {
  const out = []
  for (const e of events) {
    const d = e?.data ?? {}
    switch (e?.type) {
      case 'user/message':
        if (d.source?.kind && d.source.kind !== 'user') break
        out.push({ seq: e.seq, role: d.source?.kind === 'user' ? 'user' : (d.source?.kind ?? 'user'), text: clip(textOf(d.content), 4000) })
        break
      case 'assistant/message': {
        const t = textOf(d.message?.content)
        if (t) out.push({ seq: e.seq, role: 'assistant', turn: d.turn, text: clip(t, 6000) })
        break
      }
      case 'tool/call':
        out.push({ seq: e.seq, role: 'tool-call', name: d.name, args: clip(d.arguments, 400) })
        break
      case 'tool/result':
        out.push({ seq: e.seq, role: 'tool-result', isError: d.message?.isError ?? false, text: clip(textOf(d.message?.content), 600) })
        break
      case 'turn/end':
        out.push({ seq: e.seq, role: 'turn-end', turn: d.turn, reason: d.reason?.kind })
        break
      case 'session/title':
        out.push({ seq: e.seq, role: 'title', text: d.title ?? textOf(d.content) })
        break
    }
  }
  return limit > 0 ? out.slice(-limit) : out
}

export function apply(ctx, config = {}) {
  const port = Number(config.port ?? 7788)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid bridge port')
  const stateFile = process.env.DSH_BRIDGE_STATE_FILE || join(homedir(), '.dsh', 'agent-bridge.json')
  const savedToken = config.token ?? loadToken(stateFile)
  const token = typeof savedToken === 'string' && savedToken.length >= 32 ? savedToken : randomBytes(24).toString('hex')

  const sc = ctx.sessionController
  const clients = new Set()
  const ring = []
  let seq = 0

  const emit = (ev) => {
    ev = { id: ++seq, time: Date.now(), ...ev }
    ring.push(ev)
    if (ring.length > 500) ring.shift()
    const frame = `id: ${ev.id}\ndata: ${JSON.stringify(ev)}\n\n`
    for (const res of clients) if (!res.write(frame)) res.destroy()
  }

  const titleOf = (session) => session?.header?.title ?? session?.title

  ctx.on('session/event', (session, event) => {
    try {
      if (event.type === 'turn/end') {
        emit({ type: 'turn-end', sessionId: session.id, title: titleOf(session), cwd: session.header?.cwd, reason: event.data?.reason?.kind, lastText: clip(lastAssistantText(session.snapshotEvents?.() ?? []), 4000) })
      } else if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
        emit({ type: 'user-message', sessionId: session.id, source: event.data?.source?.kind, text: clip(textOf(event.data?.content), 500) })
      } else if (/^(approval|permission)\/(request|pending|ask)/.test(event.type)) {
        emit({ type: 'needs-approval', sessionId: session.id, event: event.type })
      }
    } catch (error) {
      ctx.logger?.warn?.(`agent-bridge: event relay failed: ${error}`)
    }
  })
  ctx.on('agent/status', ({ agent, status }) => emit({ type: 'status', sessionId: agent.id, status }))
  ctx.on('agent/error', ({ agent, error }) => emit({ type: 'error', sessionId: agent.id, message: String(error?.message ?? error) }))

  const send = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => { size += c.length; if (size > 65536) { reject(Object.assign(new Error('Request too large'), { status: 413 })); return } chunks.push(c) })
    req.on('end', () => {
      if (size > 65536) return
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error()
        resolve(body)
      } catch { reject(Object.assign(new Error('Expected a JSON object'), { status: 400 })) }
    })
    req.on('error', reject)
  })
  const promptLocks = new Set()
  const validatePrompt = (text, mode) => {
    if (typeof text !== 'string' || !text.trim() || text.length > 50000) throw Object.assign(new Error('text must contain 1-50000 characters'), { status: 400 })
    if (mode !== undefined && mode !== 'followup' && mode !== 'steer') throw Object.assign(new Error('Invalid prompt mode'), { status: 400 })
  }
  const prompt = async (sessionId, text, mode) => {
    validatePrompt(text, mode)
    if (promptLocks.has(sessionId) || (ctx.agents.get(sessionId)?.status && ctx.agents.get(sessionId).status !== 'idle' && mode !== 'steer')) throw Object.assign(new Error('Session busy; use explicit steer mode'), { status: 409 })
    promptLocks.add(sessionId)
    try { return await sc.prompt({
    sessionId,
    content: [{ type: 'text', text }],
    requestId: randomUUID(),
    mode: mode === 'steer' ? 'steer' : 'followup',
  }, new AbortController().signal) } finally { promptLocks.delete(sessionId) }
  }

  // ---- request log for the Bridge tab ------------------------------------------------------------
  const startedAt = Date.now()
  const requests = []
  const counters = { total: 0, errors: 0, prompts: 0, creates: 0, reads: 0, unauthorized: 0 }
  const lastSeen = { request: 0, sse: 0 }
  const track = (entry) => {
    requests.push(entry)
    if (requests.length > 100) requests.shift()
  }
  const sseClients = () => [...clients].map((r) => ({ since: r.__since }))
  const wsInfo = (w) => ({ id: w.id, title: w.title, path: w.path, sessionIds: [...(w.sessionIds ?? [])] })
  const samePath = (a, b) => {
    const normalize = p => process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p)
    return typeof a === 'string' && typeof b === 'string' && normalize(a) === normalize(b)
  }
  /** Workspace by id or title, else the one owning cwd, else a new one for cwd. */
  const resolveWorkspace = async (name, cwd) => {
    const all = ctx.workspaceRegistry.list()
    if (name) {
      const hit = all.find((w) => w.id === name) ?? all.find((w) => String(w.title).toLowerCase() === String(name).toLowerCase())
      if (!hit) throw new Error(`no DSH workspace named "${name}" (have: ${all.map((w) => w.title).join(', ')})`)
      return hit
    }
    if (!cwd) return undefined
    return all.find((w) => samePath(w.path, cwd)) ?? await ctx.workspaceRegistry.create(cwd, cwd.split(/[\/]/).filter(Boolean).pop())
  }

  const statusPayload = () => ({
    ok: true, port, startedAt, now: Date.now(), counters, lastSeen,
    sse: sseClients(), lastEventId: seq,
    // Status UI gets metadata only, not prompt/response snippets or local paths.
    requests: requests.slice(-50).reverse().map(({ time, method, status, ms, kind, sessionId, agent }) => ({ time, method, status, ms, kind, sessionId, agent })),
    events: ring.slice(-30).reverse().map(({ id, time, type, sessionId, status, reason }) => ({ id, time, type, sessionId, status, reason })),
  })

  // Same data on DSH's own authenticated API, for the Bridge tab (same origin as the UI).
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agent-bridge/status',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: () => new Response(JSON.stringify(statusPayload()), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }),
  }), 'agent-bridge: status route')

  const server = createServer(async (req, res) => {
    let url
    try { url = new URL(req.url, 'http://127.0.0.1') }
    catch { return send(res, 400, { error: 'Invalid URL' }) }
    const entry = { time: Date.now(), method: req.method, path: url.pathname, agent: clip(req.headers['x-agent-name'] ?? 'generic', 80), status: 0, ms: 0 }
    res.on('finish', () => {
      entry.status = res.statusCode
      entry.ms = Date.now() - entry.time
      if (res.statusCode >= 400) counters.errors++
    })
    if (url.pathname !== '/events') { counters.total++; lastSeen.request = entry.time; track(entry) }
    try {
      if (req.headers.authorization !== `Bearer ${token}`) { counters.unauthorized++; return send(res, 401, { error: 'unauthorized' }) }
      // Browser pages use DSH's authenticated UI route, never this control API.
      if (req.headers.origin) return send(res, 403, { error: 'Browser origins are not allowed' })
      if (url.pathname === '/events') { lastSeen.sse = Date.now(); res.__since = Date.now() }
      const sid = url.pathname.split('/').filter(Boolean)[1]
      if (sid) entry.sessionId = sid
      if (req.method === 'POST') {
        req.__entry = entry
      }
      const parts = url.pathname.split('/').filter(Boolean)
      const signal = new AbortController().signal

      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, clients: clients.size, lastEventId: seq })

      if (req.method === 'GET' && url.pathname === '/events') {
        if (clients.size >= 16) return send(res, 429, { error: 'Too many event streams' })
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        res.flushHeaders()
        const since = Number(url.searchParams.get('since') ?? req.headers['last-event-id'] ?? seq)
        for (const ev of ring) if (ev.id > since) res.write(`id: ${ev.id}\ndata: ${JSON.stringify(ev)}\n\n`)
        clients.add(res)
        const ping = setInterval(() => res.write(': ping\n\n'), 25000)
        res.on('close', () => { clearInterval(ping); clients.delete(res) })
        return
      }

      if (req.method === 'GET' && url.pathname === '/workspaces') {
        return send(res, 200, { items: ctx.workspaceRegistry.list().map(wsInfo) })
      }

      if (parts[0] === 'sessions') {
        if (req.method === 'GET' && parts.length === 1) {
          const { items } = await sc.list({}, signal)
          return send(res, 200, { items })
        }
        if (req.method === 'GET' && parts.length === 2) {
          const limit = Number(url.searchParams.get('limit') ?? 40)
          if (!Number.isInteger(limit) || limit < 0 || limit > 1000) return send(res, 400, { error: 'limit must be 0-1000' })
          const state = await sc.state({ sessionId: parts[1] }, signal)
          const history = await sc.events({ address: { kind: 'session', sessionId: parts[1] }, maxMessages: Math.min(1000, Math.max(1, limit || 1000)) }, signal)
          const events = (history.records ?? []).map(record => record.event).filter(Boolean)
          counters.reads++; entry.kind = 'read'
          const row = (await sc.list({}, signal)).items.find((i) => i.sessionId === parts[1])
          return send(res, 200, { sessionId: parts[1], title: row?.projections?.values?.title, cwd: row?.cwd, running: state.running, pendingInput: state.pendingInput, cursor: history.cursor, hasMore: history.hasMore, entries: compact(events, limit) })
        }
        if (req.method === 'POST' && parts.length === 1) {
          const body = await readBody(req)
          if (body.text !== undefined) validatePrompt(body.text, body.mode)
          for (const field of ['cwd', 'workspace']) if (body[field] !== undefined && (typeof body[field] !== 'string' || !body[field].trim() || body[field].length > 4096)) return send(res, 400, { error: `Invalid ${field}` })
          counters.creates++; entry.kind = 'create'; entry.text = clip(body.text, 200); entry.cwd = body.cwd
          const ws = await resolveWorkspace(body.workspace, body.cwd)
          const created = await sc.create(ws ? { workspaceId: ws.id } : body.cwd ? { cwd: body.cwd } : {})
          entry.workspace = ws?.title
          entry.sessionId = created.sessionId
          if (body.text) await prompt(created.sessionId, body.text, body.mode)
          return send(res, 200, created)
        }
        if (req.method === 'POST' && parts.length === 3 && parts[2] === 'prompt') {
          const body = await readBody(req)
          counters.prompts++; entry.kind = body.mode === 'steer' ? 'steer' : 'prompt'; entry.text = clip(body.text, 200)
          validatePrompt(body.text, body.mode)
          return send(res, 200, await prompt(parts[1], body.text, body.mode))
        }
        if (req.method === 'POST' && parts.length === 3 && parts[2] === 'cancel') {
          return send(res, 200, (await sc.cancel({ sessionId: parts[1] })) ?? { cancelled: true })
        }
      }
      send(res, 404, { error: 'not found' })
    } catch (error) {
      entry.error = String(error?.message ?? error)
      send(res, error.status ?? 500, { error: entry.error, code: error?.code })
    }
  })

  server.on('error', (error) => ctx.logger?.error?.(`agent-bridge: server error: ${error}`))
  server.requestTimeout = 15000
  server.headersTimeout = 10000
  server.listen(port, '127.0.0.1', () => {
    mkdirSync(dirname(stateFile), { recursive: true })
    writeFileSync(stateFile, JSON.stringify({ url: `http://127.0.0.1:${port}`, token, protocol: 1 }, null, 2), { mode: 0o600 })
    if (process.platform !== 'win32') chmodSync(stateFile, 0o600)
    ctx.logger?.info?.(`agent-bridge: listening on 127.0.0.1:${port}`)
  })

  ctx.effect(() => () => {
    for (const res of clients) res.end()
    clients.clear()
    server.close()
  }, 'agent-bridge: http server')
  return server
}
