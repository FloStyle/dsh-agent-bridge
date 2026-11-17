// Phase 2 (0.6.0) / S3 and S4: a create must not mint a workspace for an
// arbitrary path string, and every delegated prompt must leave a durable record
// that cannot leak its text.
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

test('creating a session requires an absolute, existing directory', async (t) => {
  const dsh = recordingDsh()
  const bridge = await startBridge({
    controller: dsh.controller,
    context: { workspaceRegistry: { list: () => [], create: async (path, title) => ({ id: 'ws-test', title, path }) } },
  })
  const folder = mkdtempSync(join(tmpdir(), 'dsh-cwd-'))
  t.after(async () => { await bridge.stop(); rmSync(folder, { recursive: true, force: true }) })

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

test('a delegated prompt is audited by hash and length, never by text', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'dsh-audit-'))
  const auditFile = join(folder, 'audit.jsonl')
  const previous = process.env.DSH_BRIDGE_AUDIT_FILE
  process.env.DSH_BRIDGE_AUDIT_FILE = auditFile
  const dsh = recordingDsh()
  const bridge = await startBridge({ controller: dsh.controller })
  t.after(async () => {
    await bridge.stop()
    if (previous === undefined) delete process.env.DSH_BRIDGE_AUDIT_FILE
    else process.env.DSH_BRIDGE_AUDIT_FILE = previous
    rmSync(folder, { recursive: true, force: true })
  })

  const response = await bridge.get(`/sessions/${SESSION}/prompt`, {
    method: 'POST',
    body: JSON.stringify({ text: SECRET }),
    headers: { 'x-agent-name': 'claude-code' },
  })
  assert.equal(response.status, 200)

  const raw = readFileSync(auditFile, 'utf8')
  const lines = raw.trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(lines.length, 1)
  const [entry] = lines
  assert.equal(entry.action, 'prompt')
  assert.equal(entry.agent, 'claude-code')
  assert.equal(entry.sessionId, SESSION)
  assert.equal(entry.textLength, SECRET.length)
  assert.equal(entry.textSha256, createHash('sha256').update(SECRET).digest('hex'))
  assert.ok(!Number.isNaN(Date.parse(entry.time)), 'the audit entry carries a timestamp')
  assert.ok(!raw.includes(SECRET), 'the audit log must never contain prompt text')
})

test('the audit log rotates by size instead of growing without bound', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'dsh-audit-rotate-'))
  const auditFile = join(folder, 'audit.jsonl')
  const previous = process.env.DSH_BRIDGE_AUDIT_FILE
  process.env.DSH_BRIDGE_AUDIT_FILE = auditFile
  const dsh = recordingDsh()
  const bridge = await startBridge({ controller: dsh.controller, config: { auditMaxBytes: 300 } })
  t.after(async () => {
    await bridge.stop()
    if (previous === undefined) delete process.env.DSH_BRIDGE_AUDIT_FILE
    else process.env.DSH_BRIDGE_AUDIT_FILE = previous
    rmSync(folder, { recursive: true, force: true })
  })

  for (let i = 0; i < 4; i++) {
    await bridge.get(`/sessions/${SESSION}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ text: `prompt number ${i}` }),
      headers: { 'x-agent-name': 'claude-code' },
    })
  }
  assert.ok(existsSync(auditFile + '.1'), 'the previous audit file must be rotated to .1')
  assert.ok(existsSync(auditFile))
})

