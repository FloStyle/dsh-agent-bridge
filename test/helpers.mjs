// Shared fixtures: start the bridge plugin against a fake DSH context.
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { apply } from '../index.js'

/** Reserve an ephemeral loopback port, then release it for the bridge. */
export async function freePort() {
  const probe = createServer().listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  return port
}

/**
 * Start the plugin against a fake DSH context and wait until it listens.
 * `controller` replaces `ctx.sessionController`; `context` adds or replaces
 * other context members. Every bridge writes its state file, so pass the same
 * `stateFile` to simulate one process restarting on the same port.
 */
export async function startBridge({ port, stateFile, controller = {}, context = {}, config = {}, keepStateEnv = false } = {}) {
  const folder = stateFile ? undefined : mkdtempSync(join(tmpdir(), 'dsh-bridge-test-'))
  const file = stateFile ?? join(folder, 'state.json')
  // A test must never adopt the live bridge's endpoint and token.
  if (resolve(file) === resolve(join(homedir(), '.dsh', 'agent-bridge.json'))) {
    throw new Error('refusing to point a test bridge at the real ~/.dsh/agent-bridge.json')
  }
  const listenPort = port ?? await freePort()
  const disposers = []
  const handlers = new Map()
  const routes = new Map()
  const ctx = {
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    on(event, handler) { handlers.set(event, handler) },
    logger: { info() {}, warn() {}, error() {} },
    connection: { fetch: { register(route) { routes.set(route.path, route.fetch); return () => {} } } },
    workspaceRegistry: { list: () => [] },
    agents: { get: () => ({ status: 'idle' }) },
    typertGateway: { getPendingRemoteEvents: () => [] },
    sessionController: {
      list: async () => ({ items: [] }),
      create: async () => ({ sessionId: 'test-session' }),
      prompt: async () => ({ accepted: true }),
      cancel: async () => ({ accepted: true }),
      state: async () => ({ running: false, pendingInput: [] }),
      events: async () => ({ records: [], cursor: 0, hasMore: false }),
      ...controller,
    },
    ...context,
  }
  // The plugin reads this path while `apply` runs. Set it for that call only:
  // an await between here and there used to let another bridge's teardown clear
  // it, and the next bridge then wrote the live ~/.dsh state file.
  const previous = process.env.DSH_BRIDGE_STATE_FILE
  process.env.DSH_BRIDGE_STATE_FILE = file
  let server
  try {
    server = apply(ctx, { port: listenPort, ...config })
  } finally {
    if (!keepStateEnv) {
      if (previous === undefined) delete process.env.DSH_BRIDGE_STATE_FILE
      else process.env.DSH_BRIDGE_STATE_FILE = previous
    }
  }
  await once(server, 'listening')
  const state = JSON.parse(readFileSync(file, 'utf8'))
  const headers = { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' }
  const get = (path, init) => fetch(state.url + path, { ...init, headers: { ...headers, ...init?.headers } })
  const post = (path, body) => get(path, { method: 'POST', body: JSON.stringify(body) })
  const emit = (event, ...args) => handlers.get(event)?.(...args)
  const stop = async () => {
    for (const dispose of disposers.reverse()) dispose()
    // The plugin ends its SSE responses first; only force-close if a socket lingers.
    const closed = new Promise((resolve) => server.close(() => resolve()))
    const timer = setTimeout(() => server.closeAllConnections?.(), 500)
    await closed
    clearTimeout(timer)
    if (folder) rmSync(folder, { recursive: true, force: true })
  }
  return {
    server, port: listenPort, folder, file, state, url: state.url, token: state.token,
    headers, get, post, emit, handlers, routes, ctx, stop,
  }
}

/** Read one SSE frame from a response body reader, or reject after `ms`. */
export async function nextFrame(reader, decoder = new TextDecoder(), ms = 4000) {
  let text = ''
  const deadline = Date.now() + ms
  for (;;) {
    const left = deadline - Date.now()
    if (left <= 0) throw new Error('timed out waiting for an SSE frame')
    const chunk = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve(undefined), left)),
    ])
    if (!chunk) throw new Error('timed out waiting for an SSE frame')
    if (chunk.done) throw new Error('SSE stream ended')
    text += decoder.decode(chunk.value, { stream: true })
    const split = text.indexOf('\n\n')
    if (split >= 0) {
      const frame = text.slice(0, split)
      const data = frame.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n')
      if (data) return JSON.parse(data)
    }
  }
}

/** Reject when `promise` settles after `ms`, so a broken wait cannot hang CI. */
export function withTimeout(promise, ms, label = 'operation') {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms) }),
  ]).finally(() => clearTimeout(timer))
}
