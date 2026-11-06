#!/usr/bin/env node
// Minimal stdio MCP server exposing DeepSeek Harness sessions to any MCP client.
import { createInterface } from 'node:readline'
import { call as rawCall, events } from './lib.mjs'

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

const tools = [
  {
    name: 'dsh_list',
    description: 'List DeepSeek Harness sessions (id, title, cwd, running, activity). Session ids may be given in full, without the session- prefix, or as a unique prefix like 3a9e7ffb.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'max rows, default 20' } } },
    run: async ({ limit = 20 }) => (await call('GET', '/sessions')).items.slice(0, limit).map((i) => ({ sessionId: i.sessionId, shortId: i.sessionId.replace(/^session-/, '').slice(0, 8), title: i.projections?.values?.title, cwd: i.cwd, running: i.running, updatedAt: new Date(i.updatedAt).toISOString() })),
  },
  {
    name: 'dsh_workspaces',
    description: 'List DSH workspaces (id, title, folder, session ids).',
    inputSchema: { type: 'object', properties: {} },
    run: async () => (await call('GET', '/workspaces')).items,
  },
  {
    name: 'dsh_read',
    description: 'Read a DSH session as a compact transcript (user, assistant, tool calls/results, turn ends).',
    inputSchema: { type: 'object', required: ['sessionId'], properties: { sessionId: { type: 'string' }, limit: { type: 'number', description: 'last N entries, default 40; 0 = all' } } },
    run: async ({ sessionId, limit = 40 }) => (sessionId = await resolveId(sessionId), call('GET', `/sessions/${encodeURIComponent(sessionId)}?limit=${limit}`)),
  },
  {
    name: 'dsh_send',
    description: 'Dispatch work to DSH. With sessionId: send a prompt to that session. Without: create a new session in a workspace (by workspace name/id, or by cwd: the workspace owning that folder, created if missing) and send the prompt. Returns at once; use dsh_wait for the result.',
    inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' }, sessionId: { type: 'string' }, cwd: { type: 'string', description: 'working folder for a new session; it joins the workspace for that folder' }, workspace: { type: 'string', description: 'DSH workspace title or id for a new session' }, mode: { type: 'string', enum: ['followup', 'steer'] } } },
    run: async ({ text, sessionId, cwd, workspace, mode }) => (sessionId = await resolveId(sessionId))
      ? { sessionId, ...(await call('POST', `/sessions/${encodeURIComponent(sessionId)}/prompt`, { text, mode })) }
      : call('POST', '/sessions', { text, cwd, workspace, mode }),
  },
  {
    name: 'dsh_wait',
    description: 'Wait until a DSH session ends its turn, then return its last assistant text. Times out after timeoutSec (default 300).',
    inputSchema: { type: 'object', required: ['sessionId'], properties: { sessionId: { type: 'string' }, timeoutSec: { type: 'number' } } },
    run: async ({ sessionId, timeoutSec = 300 }) => {
      sessionId = await resolveId(sessionId)
      const deadline = Date.now() + Math.min(3600, Math.max(1, timeoutSec)) * 1000
      do {
        const state = await call('GET', `/sessions/${encodeURIComponent(sessionId)}?limit=40`)
        if (!state.running || state.pendingInput?.length) return state
        await new Promise(resolve => setTimeout(resolve, 750))
      } while (Date.now() < deadline)
      return { sessionId, timedOut: true }

    },
  },
  {
    name: 'dsh_cancel',
    description: 'Cancel the running turn of a DSH session.',
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
      return out({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'dsh-agent-bridge', version: '0.5.0' } } })
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
