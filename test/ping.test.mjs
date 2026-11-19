// R3.5 ping-lite: a short message between agents, with a thread, a hop limit,
// an audit line, delivery into a DSH session, and a watcher that wakes on it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startBridge, startMcp, nextFrame, withTimeout } from './helpers.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const EXECUTOR = 'session-3a9e7ffb-0000-4000-8000-000000000001'

function fakeDsh({ status = 'idle' } = {}) {
  const prompts = []
  const registered = []
  return {
    prompts, registered,
    controller: {
      list: async () => ({ items: [{ sessionId: EXECUTOR, cwd: 'D:\\w', updatedAt: Date.now() }] }),
      prompt: async (request) => { prompts.push(request); return { accepted: true } },
    },
    context: {
      agents: { get: () => ({ status }) },
      tools: { register: (definition) => { registered.push(definition); return () => {} } },
    },
  }
}

test('POST /ping emits a message event, audits it and returns the message', async (t) => {
  const dsh = fakeDsh()
  const bridge = await startBridge({ controller: dsh.controller, context: dsh.context })
  t.after(() => bridge.stop())
  const stream = await bridge.get('/events?since=0')
  const reader = stream.body.getReader()
  t.after(() => reader.cancel().catch(() => {}))
  const res = await bridge.get('/ping', { method: 'POST', headers: { 'x-agent-name': 'reviewer' }, body: JSON.stringify({ to: 'executor', kind: 'review-request', summary: 'PR ready', ref: { repo: 'o/r', pr: 4 } }) })
  assert.equal(res.status, 200, await res.clone().text())
  const message = await res.json()
  assert.match(message.id, /^msg-/)
  assert.match(message.threadId, /^thr-/)
  assert.equal(message.from, 'reviewer')
  assert.equal(message.hop, 1)
  const event = await nextFrame(reader)
  assert.equal(event.type, 'message')
  assert.equal(event.id > 0, true)
  assert.equal(event.messageId, message.id)
  assert.equal(event.to, 'executor')
  assert.equal(event.summary, 'PR ready')
  const audit = readFileSync(join(bridge.folder, 'audit.jsonl'), 'utf8')
  assert.match(audit, /"action":"ping"/)
  assert.doesNotMatch(audit, /PR ready/, 'the audit keeps a hash, not the text')
})

test('ping validation and the hop limit of 6', async (t) => {
  const dsh = fakeDsh()
  const bridge = await startBridge({ controller: dsh.controller, context: dsh.context })
  t.after(() => bridge.stop())
  const ping = (body) => bridge.post('/ping', body)
  assert.equal((await ping({ to: 'x', kind: 'shout', summary: 'hi' })).status, 400)
  assert.equal((await ping({ to: 'x', kind: 'ping', summary: 'y'.repeat(2001) })).status, 400)
  assert.equal((await ping({ kind: 'ping', summary: 'hi' })).status, 400)
  let parent = await (await ping({ to: 'b', kind: 'ping', summary: 'hop 1' })).json()
  for (let hop = 2; hop <= 6; hop++) {
    const reply = await (await ping({ to: 'b', kind: 'ping', summary: `hop ${hop}`, inReplyTo: parent.id })).json()
    assert.equal(reply.hop, hop)
    assert.equal(reply.threadId, parent.threadId, 'a reply stays in the thread')
    parent = reply
  }
  const seventh = await ping({ to: 'b', kind: 'ping', summary: 'hop 7', inReplyTo: parent.id })
  assert.equal(seventh.status, 429)
  assert.match((await seventh.json()).error, /hop limit/)
})

test('a ping to dsh:<id> is delivered as a queued prompt with provenance', async (t) => {
  const dsh = fakeDsh({ status: 'running' })
  const bridge = await startBridge({ controller: dsh.controller, context: dsh.context })
  t.after(() => bridge.stop())
  const res = await bridge.get('/ping', { method: 'POST', headers: { 'x-agent-name': 'reviewer' }, body: JSON.stringify({ to: 'dsh:3a9e7ffb', kind: 'review-result', summary: '2 findings' }) })
  assert.equal(res.status, 200, await res.clone().text())
  const message = await res.json()
  assert.equal(message.delivered.sessionId, EXECUTOR)
  assert.equal(dsh.prompts.length, 1, 'a busy session gets the ping through the DSH queue, not a 409')
  assert.equal(dsh.prompts[0].mode, 'queue')
  assert.match(dsh.prompts[0].content[0].text, /^\[dsh-agent-bridge\] from reviewer/)
  assert.match(dsh.prompts[0].content[0].text, /review-result/)
  assert.match(dsh.prompts[0].content[0].text, /2 findings/)
})

test('the DSH tool bridge_ping takes the sender from the calling session', async (t) => {
  const dsh = fakeDsh()
  const bridge = await startBridge({ controller: dsh.controller, context: dsh.context })
  t.after(() => bridge.stop())
  const tool = dsh.registered.find((d) => d.name === 'bridge_ping')
  assert.ok(tool, 'bridge_ping is registered as a DSH tool')
  assert.ok(!('from' in (tool.parameters ?? {})), 'from is never a parameter')
  const result = await tool.execute({ to: 'reviewer', kind: 'review-request', summary: 'ready' }, { agent: { id: EXECUTOR, session: { id: EXECUTOR } } })
  assert.equal(result.from, 'dsh:3a9e7ffb')
  assert.match(result.id, /^msg-/)
})

test('MCP bridge_ping sends with DSH_AGENT_NAME as the sender', async (t) => {
  const dsh = fakeDsh()
  const bridge = await startBridge({ controller: dsh.controller, context: dsh.context })
  t.after(() => bridge.stop())
  const mcp = startMcp({ env: { DSH_BRIDGE_STATE_FILE: bridge.file, DSH_AGENT_NAME: 'reviewer' } })
  t.after(() => mcp.stop())
  const sent = await withTimeout(mcp.callTool('bridge_ping', { to: 'executor', kind: 'ping', summary: 'hello' }), 10000, 'bridge_ping')
  assert.equal(sent.from, 'reviewer')
})

test('watch --agent --until message --exit prints one JSON line and exits 0', async (t) => {
  const dsh = fakeDsh()
  const bridge = await startBridge({ controller: dsh.controller, context: dsh.context })
  t.after(() => bridge.stop())
  const child = spawn(process.execPath, [join(root, 'mcp', 'watch.mjs'), '--agent', 'reviewer', '--until', 'message', '--exit'], {
    env: { ...process.env, DSH_BRIDGE_STATE_FILE: bridge.file, DSH_AGENT_NAME: 'test' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => child.kill())
  let out = ''
  child.stdout.on('data', (c) => { out += c })
  // Wait until the watcher's event stream is connected, so no ping is missed.
  await withTimeout((async () => { while ((await (await bridge.get('/health')).json()).clients < 1) await new Promise((r) => setTimeout(r, 100)) })(), 8000, 'watcher connect')
  await bridge.post('/ping', { to: 'someone-else', kind: 'ping', summary: 'not for you' })
  await bridge.post('/ping', { to: 'reviewer', kind: 'review-request', summary: 'for you' })
  const code = await withTimeout(new Promise((resolve) => child.once('close', resolve)), 8000, 'watch exit')
  assert.equal(code, 0)
  const lines = out.trim().split('\n')
  assert.equal(lines.length, 1, out)
  const event = JSON.parse(lines[0])
  assert.equal(event.type, 'message')
  assert.equal(event.summary, 'for you')
})
