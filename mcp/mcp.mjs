#!/usr/bin/env node
// Minimal stdio MCP server exposing DeepSeek Harness sessions to any MCP client.
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
import { call as rawCall, follow } from './lib.mjs'

const { version } = createRequire(import.meta.url)('../package.json')
/** MCP revisions this server implements, newest first. */
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']
const MAX_PROMPT = 50000
const MAX_TIMEOUT_SEC = 3600
const MAX_LIMIT = 1000

/** Accept a full id ("session-3a9e…"), the bare uuid, or any unique prefix ("3a9e7ffb"). */
async function resolveId(id) {
  if (!id) return id
  const key = String(id).trim().replace(/^session-/, '').toLowerCase()
  const { items } = await rawCall('GET', '/sessions')
  const hits = items.filter((i) => i.sessionId.replace(/^session-/, '').toLowerCase().startsWith(key))
  if (hits.length === 1) return hits[0].sessionId
  if (hits.length > 1) throw new Error(`session id "${id}" is ambiguous: ${hits.map((h) => h.sessionId).join(', ')}`)
  throw new Error(`no DSH session matches "${id}"`)
}

const call = rawCall
const readOnly = (title) => ({ title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false })
const write = (title, { destructive = false } = {}) => ({ title, readOnlyHint: false, destructiveHint: destructive, idempotentHint: !destructive, openWorldHint: false })

const tools = [
  {
    name: 'dsh_list',
    description: 'List DeepSeek Harness sessions (id, title, cwd, running, activity). Session ids may be given in full, without the session- prefix, or as a unique prefix like 3a9e7ffb.',
    annotations: readOnly('List DSH sessions'),
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: 'max rows, default 20' } } },
    run: async ({ limit = 20 }) => (await call('GET', '/sessions')).items.slice(0, limit).map((i) => ({ sessionId: i.sessionId, shortId: i.sessionId.replace(/^session-/, '').slice(0, 8), title: i.projections?.values?.title, cwd: i.cwd, running: i.running, updatedAt: new Date(i.updatedAt).toISOString() })),
  },
  {
    name: 'dsh_workspaces',
    description: 'List DSH workspaces (id, title, folder, session ids).',
    annotations: readOnly('List DSH workspaces'),
    inputSchema: { type: 'object', properties: {} },
    run: async () => (await call('GET', '/workspaces')).items,
  },
  {
    name: 'dsh_read',
    description: 'Read a DSH session as a compact transcript (user, agent-bridge, assistant, tool calls/results, turn ends).',
    annotations: readOnly('Read a DSH session'),
    inputSchema: { type: 'object', required: ['sessionId'], properties: { sessionId: { type: 'string' }, limit: { type: 'integer', minimum: 0, maximum: MAX_LIMIT, description: 'last N entries, default 40; 0 = all' } } },
    run: async ({ sessionId, limit = 40 }) => (sessionId = await resolveId(sessionId), call('GET', `/sessions/${encodeURIComponent(sessionId)}?limit=${limit}`)),
  },
  {
    name: 'dsh_send',
    description: 'Dispatch work to DSH. With sessionId: send a prompt to that session. Without: create a new session in a workspace (by workspace name/id, or by cwd: the workspace owning that folder, created if missing) and send the prompt. Returns at once with the requestId and eventId: pass both to dsh_wait to wait for exactly this turn.',
    annotations: write('Send work to DSH'),
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string', minLength: 1, maxLength: MAX_PROMPT },
        sessionId: { type: 'string' },
        cwd: { type: 'string', maxLength: 4096, description: 'absolute, existing working folder for a new session; it joins the workspace for that folder' },
        workspace: { type: 'string', maxLength: 4096, description: 'DSH workspace title or id for a new session' },
        mode: { type: 'string', enum: ['followup', 'steer'] },
      },
    },
    run: async ({ text, sessionId, cwd, workspace, mode }) => (sessionId = await resolveId(sessionId))
      ? { sessionId, ...(await call('POST', `/sessions/${encodeURIComponent(sessionId)}/prompt`, { text, mode })) }
      : call('POST', '/sessions', { text, cwd, workspace, mode }),
  },
  {
    name: 'dsh_wait',
    description: 'Wait for a DSH turn to end, then return its transcript. Pass the eventId from dsh_send as `since` (and its bootId) to wait for exactly that turn; without a cursor it waits until the session looks idle. Times out after timeoutSec (default 300).',
    annotations: readOnly('Wait for a DSH turn'),
    inputSchema: {
      type: 'object',
      required: ['sessionId'],
      properties: {
        sessionId: { type: 'string' },
        since: { type: 'integer', minimum: 0, description: 'eventId returned by dsh_send; wait for a turn-end newer than it' },
        bootId: { type: 'string', description: 'bootId returned by dsh_send; a different bridge boot invalidates the cursor' },
        timeoutSec: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_SEC },
        limit: { type: 'integer', minimum: 0, maximum: MAX_LIMIT, description: 'entries to return, default 40' },
      },
    },
    run: async ({ sessionId, since, bootId, timeoutSec = 300, limit = 40 }) => {
      sessionId = await resolveId(sessionId)
      const seconds = Math.min(MAX_TIMEOUT_SEC, Math.max(1, Number(timeoutSec) || 300))
      const read = () => call('GET', `/sessions/${encodeURIComponent(sessionId)}?limit=${limit}`)
      if (typeof since !== 'number') {
        // No cursor: the pre-0.6 behaviour, kept for callers that only poll.
        const deadline = Date.now() + seconds * 1000
        do {
          const state = await read()
          if (!state.running || state.pendingInput?.length) return state
          await new Promise((resolve) => setTimeout(resolve, 750))
        } while (Date.now() < deadline)
        return { sessionId, timedOut: true }
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), seconds * 1000)
      try {
        for await (const event of follow({ since, signal: controller.signal, retryMs: 250 })) {
          if (bootId && event.bootId && event.bootId !== bootId) return { sessionId, timedOut: true, bootChanged: event.bootId }
          if (event.sessionId !== sessionId) continue
          if (event.type === 'turn-end' || event.type === 'error') {
            const state = await read()
            return { ...state, turnEndEventId: event.id, ...(event.type === 'error' ? { error: event.message } : {}) }
          }
        }
      } finally {
        clearTimeout(timer)
      }
      return { sessionId, timedOut: true, since }
    },
  },
  {
    name: 'dsh_cancel',
    description: 'Cancel the running turn of a DSH session.',
    annotations: write('Cancel a DSH turn', { destructive: true }),
    inputSchema: { type: 'object', required: ['sessionId'], properties: { sessionId: { type: 'string' } } },
    run: async ({ sessionId }) => call('POST', `/sessions/${encodeURIComponent(await resolveId(sessionId))}/cancel`),
  },
]

const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  const { id, method, params } = msg
  if (id === undefined) return
  try {
    if (method === 'initialize') {
      const requested = params?.protocolVersion
      const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0]
      return out({ jsonrpc: '2.0', id, result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'dsh-agent-bridge', version } } })
    }
    if (method === 'ping') return out({ jsonrpc: '2.0', id, result: {} })
    if (method === 'tools/list') {
      return out({ jsonrpc: '2.0', id, result: { tools: tools.map(({ run, ...t }) => t) } })
    }
    if (method === 'tools/call') {
      const tool = tools.find((t) => t.name === params.name)
      if (!tool) throw new Error(`unknown tool ${params.name}`)
      try {
        const result = await tool.run(params.arguments ?? {})
        return out({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] } })
      } catch (e) {
        return out({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: String(e.message ?? e) }] } })
      }
    }
    out({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
  } catch (e) {
    out({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e.message ?? e) } })
  }
})
