// The one place that touches the DSH (cordis) context. Every other module goes
// through this adapter, so a DSH change is fixed here and tests fake one shape.
// Members are read when called, never cached, because DSH may swap services.

export function createDsh(ctx) {
  const sc = () => ctx.sessionController
  // Sessions seen through events, as a fallback when the sessions service has no getter.
  const seenSessions = new Map()
  // DSH's sandbox policy and permission presets. They are optional: a plugin
  // that injects a missing service never starts, so they come through a small
  // sub-plugin and the bridge keeps working without them.
  let access
  if (typeof ctx.plugin === 'function') {
    try {
      ctx.plugin({
        name: 'agent-bridge-access',
        inject: ['sandboxPolicy', 'permissionPresets'],
        apply(sub) {
          access = { sandboxPolicy: sub.sandboxPolicy, permissionPresets: sub.permissionPresets }
          sub.effect(() => () => { access = undefined }, 'agent-bridge: access services')
        },
      })
    } catch (error) {
      ctx.logger?.warn?.(`agent-bridge: access features disabled: ${error}`)
    }
  } else if (ctx.sandboxPolicy && ctx.permissionPresets) {
    // Test contexts provide the services directly.
    access = { sandboxPolicy: ctx.sandboxPolicy, permissionPresets: ctx.permissionPresets }
  }
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

    /** The live session object, or undefined when DSH has not loaded it. */
    sessionById(sessionId) {
      let session
      try { session = ctx.sessions?.get?.(sessionId) } catch { session = undefined }
      return session ?? seenSessions.get(sessionId)
    },
    rememberSession: (session) => { if (session?.id) seenSessions.set(session.id, session) },
    /** {sandboxPolicy, permissionPresets} when this DSH build provides them. */
    accessServices: () => access,

    /** The agent status of a live session ('idle', …), or undefined. */
    agentStatus: (sessionId) => ctx.agents.get(sessionId)?.status,

    /** DSH's unsettled approval and question requests, per agent. */
    pendingRemoteEvents() {
      try { return ctx.typertGateway?.getPendingRemoteEvents?.() ?? [] } catch { return [] }
    },

    // Workspaces.
    listWorkspaces: () => ctx.workspaceRegistry.list(),
    createWorkspace: (path, title) => ctx.workspaceRegistry.create(path, title),
    getWorkspace: (id) => ctx.workspaceRegistry.get?.(id),
    renameSession: (sessionId, title) => sc().rename({ sessionId, title }),
    // Archive refuses a session with running work (DSH's default); the bridge never stops it.
    archiveSession: (sessionId) => ctx.workspaceRegistry.archiveSession(sessionId),
    unarchiveSession: (sessionId) => ctx.workspaceRegistry.unarchiveSession(sessionId),
    pinSession: (sessionId) => ctx.workspaceRegistry.pinSession(sessionId),
    unpinSession: (sessionId) => ctx.workspaceRegistry.unpinSession(sessionId),

    // Events and lifecycle.
    onSessionEvent: (handler) => ctx.on('session/event', handler),
    onAgentStatus: (handler) => ctx.on('agent/status', handler),
    onAgentError: (handler) => ctx.on('agent/error', handler),
    /** Register a route on DSH's own authenticated API, removed with the plugin. */
    registerRoute: (route, label) => ctx.effect(() => ctx.connection.fetch.register(route), label),
    /**
     * Give DSH agents tools. The tools service is optional like the access
     * services, so it comes through a sub-plugin; definitions go through DSH's
     * own defineTool when the plugin can load it.
     */
    registerTools(definitions, label) {
      if (typeof ctx.plugin === 'function') {
        try {
          ctx.plugin({
            name: 'agent-bridge-tools',
            inject: ['tools'],
            async apply(sub) {
              let define = (definition) => definition
              try { define = (await import('@deepseek-ai/dsh-tools')).defineTool ?? define } catch { /* plain definitions */ }
              for (const definition of definitions) sub.effect(() => sub.tools.register(define(definition)), `${label}: ${definition.name}`)
            },
          })
        } catch (error) {
          ctx.logger?.warn?.(`agent-bridge: DSH tools disabled: ${error}`)
        }
      } else if (ctx.tools?.register) {
        // Test contexts provide the service directly.
        for (const definition of definitions) ctx.tools.register(definition)
      }
    },
    /** Run `dispose` when the plugin unloads. */
    onDispose: (dispose, label) => ctx.effect(() => dispose, label),
  }
}
