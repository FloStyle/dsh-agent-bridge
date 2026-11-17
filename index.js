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
// GET  /events?since=ID               -> SSE stream: turn-end, status, error, user-message, pending-input

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const { version } = createRequire(import.meta.url)('./package.json')
/** Wire contract for HTTP and SSE. Bump only for a breaking change. */
const PROTOCOL = 1

/** The bridge's own sender line. Only this exact form is stripped from client text. */
const BRIDGE_HEADER = /^[ \t]*\[[ \t]*dsh-agent-bridge[ \t]*\][ \t]*from[ \t]+[^\]\n]{0,64}[ \t]*(?:\r?\n)+/i

/** Keep an agent label printable, bounded and header-safe. */
function agentNameOf(value) {
  const clean = (typeof value === 'string' ? value : '').replace(/[^\w.:@+-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
  return clean || 'generic'
}

/**
 * Drop leading copies of the bridge's own header so a client cannot stack a
 * forged one in front of its text. Every other leading line, including a
 * bracketed label such as "[WIP]", is left alone.
 */
function stripProvenance(text) {
  let out = text
  for (;;) {
    const next = out.replace(BRIDGE_HEADER, '')
    if (next === out) return out
    out = next
  }
}

function tagPrompt(text, agent) {
  return `[dsh-agent-bridge] from ${agent}\n\n${stripProvenance(text)}`
}

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

/**
 * Assistant text of one turn only. A cancelled turn has none, so it must not
 * inherit the previous turn's answer (L1).
 */
function lastAssistantText(events, turn) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e?.type !== 'assistant/message') continue
    if (turn !== undefined && e.data?.turn !== turn) continue
    const t = textOf(e.data?.message?.content)
    if (t) return t
  }
  return null
}

/** DSH TurnEndReason kinds to the three values clients act on. */
function turnEndReason(kind) {
  if (kind === 'aborted' || kind === 'interrupted') return 'cancelled'
  if (kind === 'error') return 'error'
  return 'completed'
}

/**
 * Turn raw session events into a compact, model-friendly transcript.
 * `agentOfRequest(requestId)` returns the agent that sent a bridged prompt, or
 * undefined for a message the bridge did not send. Text alone is not evidence:
 * a human can type the same header into the DSH window.
 */
function compact(events, limit, agentOfRequest = () => undefined) {
  const out = []
  for (const e of events) {
    const d = e?.data ?? {}
    switch (e?.type) {
      case 'user/message': {
        const text = textOf(d.content)
        // DSH records the requestId the bridge minted as source.rpcId.
        const agent = agentOfRequest(d.source?.rpcId)
        if (agent) {
          out.push({ seq: e.seq, role: 'agent-bridge', agent, text: clip(stripProvenance(text), 4000) })
        } else if (d.source?.kind && d.source.kind !== 'user') {
          break
        } else {
          out.push({ seq: e.seq, role: 'user', text: clip(text, 4000) })
        }
        break
      }
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
  const tokenBytes = Buffer.from(token, 'utf8')
  /** Compare without leaking the matched prefix length. */
  const authorized = (header) => {
    const prefix = 'Bearer '
    if (typeof header !== 'string' || !header.startsWith(prefix)) return false
    const given = Buffer.from(header.slice(prefix.length), 'utf8')
    return given.length === tokenBytes.length && timingSafeEqual(given, tokenBytes)
  }

  const sc = ctx.sessionController
  const clients = new Set()
  const ring = []
  let seq = 0
  // Identifies this plugin load. SSE ids restart at 1 when DSH restarts, so a
  // client must reset its cursor when this value changes.
  const bootId = randomUUID()

  // A missing injected service means this DSH surface differs from the one the
  // bridge was built for. Name it once instead of failing silently.
  const missingServices = inject.filter((service) => {
    try { return ctx[service] === undefined || ctx[service] === null } catch { return true }
  })
  if (missingServices.length) {
    ctx.logger?.warn?.(`agent-bridge: missing injected DSH service(s): ${missingServices.join(', ')}. Features that need them are disabled; this plugin targets DSH >=0.2.2-rc.1 <0.3.0.`)
  }

  // Append-only audit trail for everything the bridge dispatches, accepted or
  // not. It records a hash and a length, never the prompt text itself.
  const auditFile = process.env.DSH_BRIDGE_AUDIT_FILE || join(homedir(), '.dsh', 'agent-bridge-audit.jsonl')
  const auditMaxBytes = Number(config.auditMaxBytes ?? 1048576)
  const audit = ({ action, outcome, status, agent, sessionId, text, ...rest }) => {
    try {
      mkdirSync(dirname(auditFile), { recursive: true })
      try {
        if (statSync(auditFile).size >= auditMaxBytes) renameSync(auditFile, `${auditFile}.1`)
      } catch { /* first write, or a file another process is rotating */ }
      const entry = { time: new Date().toISOString(), bootId, action, outcome, status, agent, sessionId, ...rest }
      if (typeof text === 'string') {
        entry.textLength = text.length
        entry.textSha256 = createHash('sha256').update(text, 'utf8').digest('hex')
      }
      appendFileSync(auditFile, JSON.stringify(entry) + '\n', { mode: 0o600 })
    } catch (error) {
      ctx.logger?.warn?.(`agent-bridge: audit write failed: ${error}`)
    }
  }

  // The requestIds this plugin minted, so a transcript can tell its own prompts
  // from a human typing the same header. Bounded: the oldest entries drop off.
  const bridgedRequests = new Map()
  const rememberRequest = (requestId, agent) => {
    bridgedRequests.set(requestId, agent)
    if (bridgedRequests.size > 1000) bridgedRequests.delete(bridgedRequests.keys().next().value)
  }
  const agentOfRequest = (requestId) => (requestId ? bridgedRequests.get(requestId) : undefined)

  const emit = (ev) => {
    ev = { id: ++seq, bootId, time: Date.now(), ...ev }
    ring.push(ev)
    if (ring.length > 500) ring.shift()
    const frame = `id: ${ev.id}\ndata: ${JSON.stringify(ev)}\n\n`
    for (const res of clients) if (!res.write(frame)) res.destroy()
  }

  const titleOf = (session) => session?.header?.title ?? session?.title

  ctx.on('session/event', (session, event) => {
    try {
      if (event.type === 'turn/end') {
        const turn = event.data?.turn
        const reasonKind = event.data?.reason?.kind
        const text = lastAssistantText(session.snapshotEvents?.() ?? [], turn)
        emit({
          type: 'turn-end', sessionId: session.id, title: titleOf(session), cwd: session.header?.cwd,
          turn, reason: turnEndReason(reasonKind), reasonKind,
          lastText: text === null ? null : clip(text, 4000),
        })
      } else if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
        emit({ type: 'user-message', sessionId: session.id, source: event.data?.source?.kind, text: clip(textOf(event.data?.content), 500) })
      }
    } catch (error) {
      ctx.logger?.warn?.(`agent-bridge: event relay failed: ${error}`)
    }
  })
  ctx.on('agent/status', ({ agent, status }) => emit({ type: 'status', sessionId: agent.id, status }))
  ctx.on('agent/error', ({ agent, error }) => emit({ type: 'error', sessionId: agent.id, message: String(error?.message ?? error) }))

  // DSH exposes the unsettled approval/request and user-questions/request events
  // per Agent. That table is the real source of "this session waits for a human",
  // unlike the guessed session event names the first version listened for.
  const pendingSeen = new Map()
  const pendingKind = (info) => (info?.event === 'approval/request' ? 'approval' : info?.event === 'user-questions/request' ? 'question' : 'other')
  /** Announce one pending-input change, plus the deprecated needs-approval alias. */
  const announcePending = (sessionId, kinds) => {
    emit({ type: 'pending-input', sessionId, kinds })
    // Kept for one release so 0.5.x SSE consumers keep working; PROTOCOL stays 1
    // only because this alias exists. Remove it with a protocol bump in 0.7.0.
    emit({
      type: 'needs-approval',
      sessionId,
      kinds,
      event: kinds.includes('approval') ? 'approval/request' : kinds.length ? 'user-questions/request' : undefined,
      deprecated: true,
    })
  }
  const pendingSweep = () => {
    let unsettled = []
    try { unsettled = ctx.typertGateway?.getPendingRemoteEvents?.() ?? [] } catch { unsettled = [] }
    const current = new Map()
    for (const info of unsettled) {
      if (!info?.agentId) continue
      if (!current.has(info.agentId)) current.set(info.agentId, new Set())
      current.get(info.agentId).add(pendingKind(info))
    }
    for (const [sessionId, kinds] of current) {
      const key = [...kinds].sort().join(',')
      if (pendingSeen.get(sessionId) === key) continue
      pendingSeen.set(sessionId, key)
      announcePending(sessionId, [...kinds].sort())
    }
    for (const sessionId of [...pendingSeen.keys()]) {
      if (current.has(sessionId)) continue
      pendingSeen.delete(sessionId)
      announcePending(sessionId, [])
    }
  }
  const pendingPollMs = Number(config.pendingPollMs ?? 1500)
  const pendingTimer = pendingPollMs > 0 ? setInterval(pendingSweep, pendingPollMs) : undefined
  pendingTimer?.unref?.()

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
  const prompt = async (sessionId, text, mode, agent) => {
    const refusedMode = mode ?? 'followup'
    try {
      validatePrompt(text, mode)
    } catch (error) {
      audit({ action: 'prompt', outcome: 'refused', status: error.status ?? 400, agent, sessionId, mode: refusedMode, text })
      throw error
    }
    if (promptLocks.has(sessionId) || (ctx.agents.get(sessionId)?.status && ctx.agents.get(sessionId).status !== 'idle' && mode !== 'steer')) {
      const error = Object.assign(new Error('Session busy; use explicit steer mode'), { status: 409 })
      audit({ action: 'prompt', outcome: 'refused', status: 409, agent, sessionId, mode: refusedMode, text })
      throw error
    }
    promptLocks.add(sessionId)
    // Capture the cursor before the turn starts: the wait must end on a turn-end
    // that is strictly newer than this.
    const eventId = seq
    const requestId = randomUUID()
    try {
      const value = await sc.prompt({
        sessionId,
        content: [{ type: 'text', text: tagPrompt(text, agent) }],
        requestId,
        mode: mode === 'steer' ? 'steer' : 'followup',
      }, new AbortController().signal)
      rememberRequest(requestId, agent)
      audit({ action: 'prompt', outcome: 'accepted', status: 200, agent, sessionId, requestId, mode: refusedMode, text, eventId })
      return { ...(value ?? {}), sessionId, requestId, eventId, bootId }
    } catch (error) {
      audit({ action: 'prompt', outcome: 'failed', status: error.status ?? 500, agent, sessionId, requestId, mode: refusedMode, text, eventId })
      throw error
    } finally { promptLocks.delete(sessionId) }
  }

  // ---- request log for the Bridge tab ------------------------------------------------------------
  const startedAt = Date.now()
  const requests = []
  const counters = { total: 0, errors: 0, prompts: 0, creates: 0, reads: 0, unauthorized: 0 }
  let defaultAgentSeen = false
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
    ok: true, version, protocol: PROTOCOL, bootId, pid: process.pid, port, startedAt, now: Date.now(), counters, lastSeen,
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
    const entry = { time: Date.now(), method: req.method, path: url.pathname, agent: agentNameOf(req.headers['x-agent-name']), status: 0, ms: 0 }
    // L2: the MCP client sends this name when DSH_AGENT_NAME is unset, and the
    // operator needs to see that some client is unnamed.
    if (entry.agent === 'mcp-agent') defaultAgentSeen = true
    res.on('finish', () => {
      entry.status = res.statusCode
      entry.ms = Date.now() - entry.time
      if (res.statusCode >= 400) counters.errors++
    })
    if (url.pathname !== '/events') { counters.total++; lastSeen.request = entry.time; track(entry) }
    try {
      if (!authorized(req.headers.authorization)) { counters.unauthorized++; return send(res, 401, { error: 'unauthorized' }) }
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

      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, {
          ok: true, version, protocol: PROTOCOL, bootId, startedAt, pid: process.pid, clients: clients.size, lastEventId: seq,
          services: { checked: inject.length, missing: missingServices },
          defaultAgentSeen,
        })
      }

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
          return send(res, 200, { sessionId: parts[1], title: row?.projections?.values?.title, cwd: row?.cwd, running: state.running, pendingInput: state.pendingInput, cursor: history.cursor, hasMore: history.hasMore, entries: compact(events, limit, agentOfRequest) })
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
          for (const field of ['cwd', 'workspace']) if (body[field] !== undefined && (typeof body[field] !== 'string' || !body[field].trim() || body[field].length > 4096)) return send(res, 400, { error: `Invalid ${field}` })
          if (body.cwd !== undefined) {
            // A workspace is a real folder, not an arbitrary string DSH must guess about.
            if (!isAbsolute(body.cwd)) return send(res, 400, { error: 'cwd must be an absolute path' })
            let directory = false
            try { directory = statSync(body.cwd).isDirectory() } catch { directory = false }
            if (!directory) return send(res, 400, { error: 'cwd must be an existing directory' })
          }
          counters.creates++; entry.kind = 'create'; entry.text = clip(body.text, 200); entry.cwd = body.cwd
          const ws = await resolveWorkspace(body.workspace, body.cwd)
          const created = await sc.create(ws ? { workspaceId: ws.id } : body.cwd ? { cwd: body.cwd } : {})
          entry.workspace = ws?.title
          entry.sessionId = created.sessionId
          audit({ action: 'create', outcome: 'accepted', status: 200, agent: entry.agent, sessionId: created.sessionId, cwd: body.cwd, workspace: ws?.title })
          const prompted = body.text ? await prompt(created.sessionId, body.text, body.mode, entry.agent) : undefined
          return send(res, 200, { ...created, ...(prompted ?? {}), bootId, eventId: prompted?.eventId ?? seq })
        }
        if (req.method === 'POST' && parts.length === 3 && parts[2] === 'prompt') {
          const body = await readBody(req)
          counters.prompts++; entry.kind = body.mode === 'steer' ? 'steer' : 'prompt'; entry.text = clip(body.text, 200)
          // prompt() validates and audits the refusal itself.
          return send(res, 200, await prompt(parts[1], body.text, body.mode, entry.agent))
        }
        if (req.method === 'POST' && parts.length === 3 && parts[2] === 'cancel') {
          const value = (await sc.cancel({ sessionId: parts[1] })) ?? { cancelled: true }
          audit({ action: 'cancel', outcome: 'accepted', status: 200, agent: entry.agent, sessionId: parts[1] })
          return send(res, 200, value)
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
    writeFileSync(stateFile, JSON.stringify({ url: `http://127.0.0.1:${port}`, token, protocol: PROTOCOL, version, bootId, startedAt, pid: process.pid }, null, 2), { mode: 0o600 })
    if (process.platform !== 'win32') chmodSync(stateFile, 0o600)
    ctx.logger?.info?.(`agent-bridge: listening on 127.0.0.1:${port}`)
  })

  ctx.effect(() => () => {
    if (pendingTimer) clearInterval(pendingTimer)
    for (const res of clients) res.end()
    clients.clear()
    server.close()
  }, 'agent-bridge: http server')
  return server
}
