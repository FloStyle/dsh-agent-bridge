// Phase 2 (0.6.0) / S3 and S4: a create must not mint a workspace for an
// arbitrary path string, and every delegated prompt must leave a durable record
// that cannot leak its text — including the prompts that never ran.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBridge } from './helpers.mjs'

const SESSION = 'test-session'
const SECRET = 'audited unique sentence that must not be stored'

function recordingDsh() {
  const created = []
  const prompts = []
  return {
    created,
    prompts,
    controller: {
      list: async () => ({ items: [{ sessionId: SESSION }] }),
      create: async (request) => { created.push(request); return { sessionId: SESSION } },
      prompt: async (request) => { prompts.push(request.content[0].text); return { accepted: true } },
      state: async () => ({ running: false, pendingInput: [] }),
      events: async () => ({ records: [], cursor: 0, hasMore: false }),
    },
  }
}

/** Start a bridge whose audit log is a private temp file, and read it back. */
async function startAudited(t, { controller, context, config } = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'dsh-audit-'))
  const auditFile = join(folder, 'audit.jsonl')
  const previous = process.env.DSH_BRIDGE_AUDIT_FILE
  process.env.DSH_BRIDGE_AUDIT_FILE = auditFile
  const bridge = await startBridge({ controller, context, config })
  t.after(async () => {
    await bridge.stop()
    if (previous === undefined) delete process.env.DSH_BRIDGE_AUDIT_FILE
    else process.env.DSH_BRIDGE_AUDIT_FILE = previous
    rmSync(folder, { recursive: true, force: true })
  })
  const readAudit = () => readFileSync(auditFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const rawAudit = () => readFileSync(auditFile, 'utf8')
  return { bridge, auditFile, readAudit, rawAudit }
}

const postPrompt = (bridge, body, agent = 'claude-code') => bridge.get(`/sessions/${SESSION}/prompt`, {
  method: 'POST',
  body: JSON.stringify(body),
  headers: { 'x-agent-name': agent },
})

test('creating a session requires an absolute, existing directory', async (t) => {
  const dsh = recordingDsh()
  const bridge = await startBridge({
    controller: dsh.controller,
    context: { workspaceRegistry: { list: () => [], create: async (path, title) => ({ id: 'ws-test', title, path }) } },
  })
  const folder = mkdtempSync(join(tmpdir(), 'dsh-cwd-'))
  t.after(() => { bridge.stop(); rmSync(folder, { recursive: true, force: true }) })

  const relative = await bridge.get('/sessions', { method: 'POST', body: JSON.stringify({ text: 'x', cwd: 'relative/folder' }) })
  assert.equal(relative.status, 400)
  assert.match((await relative.json()).error, /absolute/i)

  const missing = await bridge.get('/sessions', {
    method: 'POST',
    body: JSON.stringify({ text: 'x', cwd: join(folder, 'does-not-exist') }),
  })
  assert.equal(missing.status, 400)
  assert.match((await missing.json()).error, /existing|director/i)

  const ok = await bridge.get('/sessions', { method: 'POST', body: JSON.stringify({ text: 'x', cwd: folder }) })
  assert.equal(ok.status, 200)
  assert.equal(dsh.created.length, 1, 'only the valid request may create a session')
})

test('an accepted prompt is audited by hash and length, never by text', async (t) => {
  const dsh = recordingDsh()
  const { bridge, readAudit, rawAudit } = await startAudited(t, { controller: dsh.controller })

  const response = await postPrompt(bridge, { text: SECRET })
  assert.equal(response.status, 200)

  const [entry] = readAudit()
  assert.equal(entry.action, 'prompt')
  assert.equal(entry.outcome, 'accepted')
  assert.equal(entry.status, 200)
  assert.equal(entry.agent, 'claude-code')
  assert.equal(entry.sessionId, SESSION)
  assert.equal(entry.textLength, SECRET.length)
  assert.equal(entry.textSha256, createHash('sha256').update(SECRET).digest('hex'))
  assert.ok(!Number.isNaN(Date.parse(entry.time)), 'the audit entry carries a timestamp')
  assert.ok(!rawAudit().includes(SECRET), 'the audit log must never contain prompt text')
})

test('a busy refusal is audited', async (t) => {
  const dsh = recordingDsh()
  const { bridge, readAudit, rawAudit } = await startAudited(t, {
    controller: dsh.controller,
    context: { agents: { get: () => ({ status: 'running' }) } },
  })

  const response = await postPrompt(bridge, { text: SECRET })
  assert.equal(response.status, 409)
  assert.equal(dsh.prompts.length, 0, 'a refused prompt must not reach DSH')

  const [entry] = readAudit()
  assert.equal(entry.action, 'prompt')
  assert.equal(entry.outcome, 'refused')
  assert.equal(entry.status, 409)
  assert.equal(entry.sessionId, SESSION)
  assert.equal(entry.textSha256, createHash('sha256').update(SECRET).digest('hex'))
  assert.ok(!rawAudit().includes(SECRET))
})

test('a validation refusal is audited', async (t) => {
  const dsh = recordingDsh()
  const { bridge, readAudit } = await startAudited(t, { controller: dsh.controller })

  const response = await postPrompt(bridge, { text: 42 })
  assert.equal(response.status, 400)
  assert.equal(dsh.prompts.length, 0)

  const [entry] = readAudit()
  assert.equal(entry.action, 'prompt')
  assert.equal(entry.outcome, 'refused')
  assert.equal(entry.status, 400)
})

test('a DSH prompt error is audited as failed', async (t) => {
  const { bridge, readAudit, rawAudit } = await startAudited(t, {
    controller: {
      list: async () => ({ items: [{ sessionId: SESSION }] }),
      prompt: async () => { throw new Error('dsh exploded') },
      state: async () => ({ running: false, pendingInput: [] }),
      events: async () => ({ records: [], cursor: 0, hasMore: false }),
    },
  })

  const response = await postPrompt(bridge, { text: SECRET })
  assert.equal(response.status, 500)

  const [entry] = readAudit()
  assert.equal(entry.action, 'prompt')
  assert.equal(entry.outcome, 'failed')
  assert.equal(entry.status, 500)
  assert.equal(entry.textSha256, createHash('sha256').update(SECRET).digest('hex'))
  assert.ok(!rawAudit().includes(SECRET))
})

test('the audit log rotates by size instead of growing without bound', async (t) => {
  const dsh = recordingDsh()
  const { bridge, auditFile } = await startAudited(t, {
    controller: dsh.controller,
    config: { auditMaxBytes: 300 },
  })

  for (let i = 0; i < 4; i++) {
    await postPrompt(bridge, { text: `prompt number ${i}` })
  }
  assert.ok(existsSync(auditFile + '.1'), 'the previous audit file must be rotated to .1')
  assert.ok(existsSync(auditFile))
})
