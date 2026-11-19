// dsh-agent-bridge: exposes DSH sessions to local tools (any MCP agent) over HTTP + SSE.
// Listens on 127.0.0.1 only. Every request needs "Authorization: Bearer <token>".
// The endpoint is written to ~/.dsh/agent-bridge.json and the token to the
// private agent-bridge.token next to it. Routes: src/routes.js. The DSH
// context is only touched through src/dsh.js.
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createAccess } from './src/access.js'
import { createAudit } from './src/audit.js'
import { healthyOwner, makeAuthorized, resolveToken, writeListening, writeStale } from './src/auth.js'
import { createDsh } from './src/dsh.js'
import { createEventHub, relayDshEvents } from './src/events.js'
import { startPendingSweep } from './src/pending.js'
import { createPrompter } from './src/prompt.js'
import { bridgeTools } from './src/dsh-tools.js'
import { createMessenger } from './src/messages.js'
import { createHandler } from './src/routes.js'
import { createStatus } from './src/status.js'
import { PROTOCOL, VERSION as version } from './src/version.js'

export const name = 'agent-bridge'
// cordis runs service methods under the caller's context, so this plugin
// must inject everything SessionController itself injects.
export const inject = [
  'sessionController',
  'agentDefaultModel', 'agents', 'attachments', 'fileUploads', 'fs', 'llm',
  'remoteAccess', 'sessions', 'sessionProjections', 'sessionQuery', 'typert', 'workspaceRegistry',
  'connection', 'typertGateway',
]

export function apply(ctx, config = {}) {
  const port = Number(config.port ?? 7788)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid bridge port')
  const stateFile = process.env.DSH_BRIDGE_STATE_FILE || join(homedir(), '.dsh', 'agent-bridge.json')
  const token = resolveToken(config.token, stateFile)
  // Identifies this plugin load. SSE ids restart at 1 when DSH restarts, so a
  // client must reset its cursor when this value changes.
  const bootId = randomUUID()
  const dsh = createDsh(ctx)

  // A missing injected service means this DSH surface differs from the one the
  // bridge was built for. Name it once instead of failing silently.
  const missingServices = dsh.missingServices(inject)
  if (missingServices.length) {
    dsh.logger.warn(`agent-bridge: missing injected DSH service(s): ${missingServices.join(', ')}. Features that need them are disabled; this plugin targets DSH >=0.2.2-rc.1 <0.3.0.`)
  }

  const audit = createAudit({
    file: process.env.DSH_BRIDGE_AUDIT_FILE || join(homedir(), '.dsh', 'agent-bridge-audit.jsonl'),
    maxBytes: Number(config.auditMaxBytes ?? 1048576),
    bootId,
    logger: dsh.logger,
  })
  const hub = createEventHub({ bootId })
  const access = createAccess({ dsh, audit, stateFile })
  relayDshEvents(dsh, hub, { onSession: (session) => access.seen(session) })
  const pendingTimer = startPendingSweep(dsh, hub.emit, Number(config.pendingPollMs ?? 1500))
  const status = createStatus({ version, protocol: PROTOCOL, bootId, port, hub })
  const prompter = createPrompter({ dsh, audit, hub, bootId })
  const messenger = createMessenger({ dsh, hub, audit, prompter })
  dsh.registerTools(bridgeTools(messenger), 'agent-bridge: tools')

  /** Sessions whose DSH permission preset is full access, for the Bridge tab warning. */
  const fullAccessSessions = async () => {
    try {
      const { items } = await dsh.listSessions(new AbortController().signal)
      return items.filter((i) => i.projections?.values?.permissions?.currentValue === 'danger-full-access')
        .map((i) => ({ sessionId: i.sessionId, title: i.projections?.values?.title, cwd: i.cwd }))
    } catch { return [] }
  }
  // Same status data on DSH's own authenticated API, for the Bridge tab (same origin as the UI).
  dsh.registerRoute({
    path: '/api/agent-bridge/status',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => new Response(JSON.stringify({ ...status.payload(), fullAccess: await fullAccessSessions() }), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }),
  }, 'agent-bridge: status route')

  const health = () => ({
    ok: true, version, protocol: PROTOCOL, bootId, startedAt: status.startedAt, pid: process.pid, clients: hub.clients.size, lastEventId: hub.lastId(),
    services: { checked: inject.length, missing: missingServices },
    defaultAgentSeen: status.state.defaultAgentSeen,
  })
  const server = createServer(createHandler({ dsh, hub, status, authorized: makeAuthorized(token), audit, prompter, access, messenger, config, health, port }))

  // X2/F1: a failed listen writes a stale marker without the token, unless the
  // state file belongs to another live bridge on this port.
  server.on('error', (error) => {
    dsh.logger.error(`agent-bridge: cannot listen on 127.0.0.1:${port}: ${error?.code ?? error?.message ?? error}`)
    const owner = healthyOwner(stateFile, { port, bootId })
    if (owner) {
      dsh.logger.warn(`agent-bridge: port ${port} belongs to the bridge in process ${owner.pid}; its state file is left as is`)
      return
    }
    try { writeStale(stateFile, { port, error, protocol: PROTOCOL, version, bootId }) } catch (writeError) {
      dsh.logger.warn(`agent-bridge: could not write the stale state file: ${writeError}`)
    }
  })
  server.requestTimeout = 15000
  server.headersTimeout = 10000
  server.listen(port, '127.0.0.1', () => {
    writeListening(stateFile, { port, token, protocol: PROTOCOL, version, bootId, startedAt: status.startedAt })
    dsh.logger.info(`agent-bridge: listening on 127.0.0.1:${port}`)
  })

  dsh.onDispose(() => {
    if (pendingTimer) clearInterval(pendingTimer)
    hub.close()
    server.close()
  }, 'agent-bridge: http server')
  return server
}
