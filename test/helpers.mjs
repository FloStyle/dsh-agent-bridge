// Shared fixtures: start the bridge plugin against a fake DSH context.
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
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
  const realState = join(homedir(), '.dsh', 'agent-bridge.json')
  const realAudit = join(homedir(), '.dsh', 'agent-bridge-audit.jsonl')
  // A test must never adopt the live bridge's endpoint and token, or append to
  // the owner's audit log.
  if (resolve(file) === resolve(realState)) throw new Error('refusing to point a test bridge at the real ~/.dsh/agent-bridge.json')
  const auditFile = process.env.DSH_BRIDGE_AUDIT_FILE ?? join(folder ?? dirname(file), 'audit.jsonl')
  if (resolve(auditFile) === resolve(realAudit)) throw new Error('refusing to write the real ~/.dsh/agent-bridge-audit.jsonl')
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
  // The plugin reads these paths while `apply` runs. Set them for that call only:
  // an await between here and there used to let another bridge's teardown clear
  // them, and the next bridge then wrote the live ~/.dsh files.
  const previous = process.env.DSH_BRIDGE_STATE_FILE
  const previousAudit = process.env.DSH_BRIDGE_AUDIT_FILE
  process.env.DSH_BRIDGE_STATE_FILE = file
  process.env.DSH_BRIDGE_AUDIT_FILE = auditFile
  let server
  try {
    server = apply(ctx, { port: listenPort, ...config })
  } finally {
    if (previousAudit === undefined) delete process.env.DSH_BRIDGE_AUDIT_FILE
    else process.env.DSH_BRIDGE_AUDIT_FILE = previousAudit
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

/**
 * Read one SSE frame from a response body reader, or reject after `ms`.
 * A chunk can carry several frames, so leftover bytes stay with the reader.
 */
const frameBuffers = new WeakMap()
export async function nextFrame(reader, _decoder, ms = 4000) {
  const state = frameBuffers.get(reader) ?? { text: '', decoder: new TextDecoder() }
  frameBuffers.set(reader, state)
  const deadline = Date.now() + ms
  for (;;) {
    const split = state.text.indexOf('\n\n')
    if (split >= 0) {
      const frame = state.text.slice(0, split)
      state.text = state.text.slice(split + 2)
      const data = frame.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n')
      if (data) return JSON.parse(data)
      continue
    }
    const left = deadline - Date.now()
    if (left <= 0) throw new Error('timed out waiting for an SSE frame')
    const chunk = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve(undefined), left)),
    ])
    if (!chunk) throw new Error('timed out waiting for an SSE frame')
    if (chunk.done) throw new Error('SSE stream ended')
    state.text += state.decoder.decode(chunk.value, { stream: true })
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

const root = fileURLToPath(new URL('..', import.meta.url))

/**
 * Spawn `mcp/mcp.mjs` and speak JSON-RPC over stdio, the way an MCP client does.
 * The child inherits the caller's environment, so set DSH_BRIDGE_STATE_FILE in
 * `env` to point it at a test bridge.
 */
export function startMcp({ env = {} } = {}) {
  const child = spawn(process.execPath, [join(root, 'mcp', 'mcp.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  })
  const pending = new Map()
  let nextId = 1
  let buffer = ''
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let split
    while ((split = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, split).trim()
      buffer = buffer.slice(split + 1)
      if (!line) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      const settle = pending.get(message.id)
      if (!settle) continue
      pending.delete(message.id)
      settle(message)
    }
  })
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`mcp timeout on ${method}; stderr: ${stderr}`))
    }, 15000)
    pending.set(id, (message) => { clearTimeout(timer); resolve(message) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  /** Call a tool and return its JSON payload, or throw its error text. */
  const callTool = async (name, args = {}) => {
    const response = await request('tools/call', { name, arguments: args })
    if (response.error) throw new Error(response.error.message)
    const result = response.result
    if (result?.isError) throw new Error(result.content?.[0]?.text ?? 'tool failed')
    return JSON.parse(result.content[0].text)
  }
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve()
    child.once('exit', () => resolve())
    child.kill()
  })
  return { request, callTool, stop, child, stderr: () => stderr }
}
