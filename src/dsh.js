// The one place that touches the DSH (cordis) context. Every other module goes
// through this adapter, so a DSH change is fixed here and tests fake one shape.
// Members are read when called, never cached, because DSH may swap services.

export function createDsh(ctx) {
  const sc = () => ctx.sessionController
  const logger = {
    info: (message) => ctx.logger?.info?.(message),
    warn: (message) => ctx.logger?.warn?.(message),
    error: (message) => ctx.logger?.error?.(message),
  }
  return {
    logger,

    /** Injected services that are missing or null in this DSH build. */
    missingServices(names) {
      return names.filter((service) => {
        try { return ctx[service] === undefined || ctx[service] === null } catch { return true }
      })
    },

    // Sessions.
    listSessions: (signal) => sc().list({}, signal),
    sessionState: (sessionId, signal) => sc().state({ sessionId }, signal),
    sessionEvents: (request, signal) => sc().events(request, signal),
    prompt: (request, signal) => sc().prompt(request, signal),
    cancel: (sessionId) => sc().cancel({ sessionId }),
    createSession: (request) => sc().create(request),
    hasModelCatalog: () => typeof sc()?.modelCatalog === 'function',
    modelCatalog: () => sc().modelCatalog(),
    selectModel: (request) => sc().selectModel(request),

    /** The agent status of a live session ('idle', …), or undefined. */
    agentStatus: (sessionId) => ctx.agents.get(sessionId)?.status,

    /** DSH's unsettled approval and question requests, per agent. */
    pendingRemoteEvents() {
      try { return ctx.typertGateway?.getPendingRemoteEvents?.() ?? [] } catch { return [] }
    },

    // Workspaces.
    listWorkspaces: () => ctx.workspaceRegistry.list(),
    createWorkspace: (path, title) => ctx.workspaceRegistry.create(path, title),

    // Events and lifecycle.
    onSessionEvent: (handler) => ctx.on('session/event', handler),
    onAgentStatus: (handler) => ctx.on('agent/status', handler),
    onAgentError: (handler) => ctx.on('agent/error', handler),
    /** Register a route on DSH's own authenticated API, removed with the plugin. */
    registerRoute: (route, label) => ctx.effect(() => ctx.connection.fetch.register(route), label),
    /** Run `dispose` when the plugin unloads. */
    onDispose: (dispose, label) => ctx.effect(() => dispose, label),
  }
}
