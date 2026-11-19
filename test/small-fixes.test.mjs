// R1.7: three small safety fixes.
//   P1  install.ps1 must parse under Windows PowerShell 5.1 (the Windows default)
//   T6  a failed cancel is audited
//   X4  an unauthenticated request is logged as unauthorized with no agent name
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startBridge } from './helpers.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const SESSION = 'test-session'

test('P1: install.ps1 parses under Windows PowerShell 5.1', (t) => {
  const probe = spawnSync('powershell.exe', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' })
  if (probe.error || probe.status !== 0) {
    t.skip('Windows PowerShell 5.1 is not available on this machine')
    return
  }
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts', 'install.ps1'), '-?'], { encoding: 'utf8', timeout: 60000 })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  assert.ok(!/ParserError|Unexpected token/i.test(output), `PowerShell 5.1 cannot parse install.ps1:\n${output}`)
  assert.equal(result.status, 0, `install.ps1 -? must exit 0; output:\n${output}`)
})

test('T6: a failed cancel is audited as failed', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'dsh-cancel-'))
  const auditFile = join(folder, 'audit.jsonl')
  const previous = process.env.DSH_BRIDGE_AUDIT_FILE
  process.env.DSH_BRIDGE_AUDIT_FILE = auditFile
  const bridge = await startBridge({
    controller: {
      list: async () => ({ items: [{ sessionId: SESSION }] }),
      cancel: async () => { throw new Error('cancel exploded') },
      state: async () => ({ running: true, pendingInput: [] }),
      events: async () => ({ records: [], cursor: 0, hasMore: false }),
    },
  })
  t.after(async () => {
    await bridge.stop()
    if (previous === undefined) delete process.env.DSH_BRIDGE_AUDIT_FILE
    else process.env.DSH_BRIDGE_AUDIT_FILE = previous
    rmSync(folder, { recursive: true, force: true })
  })

  const response = await bridge.get(`/sessions/${SESSION}/cancel`, { method: 'POST', body: '{}' })
  assert.equal(response.status, 500)

  const entry = readFileSync(auditFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).find((line) => line.action === 'cancel')
  assert.equal(entry?.outcome, 'failed')
  assert.equal(entry?.status, 500)
  assert.equal(entry?.sessionId, SESSION)
})

test('X4: an unauthenticated request is logged without a client-chosen name', async (t) => {
  const bridge = await startBridge()
  t.after(() => bridge.stop())

  const response = await fetch(bridge.url + '/health', { headers: { authorization: 'Bearer wrong-token', 'x-agent-name': 'sneaky' } })
  assert.equal(response.status, 401)

  const status = await (await bridge.routes.get('/api/agent-bridge/status')()).json()
  const entry = status.requests.find((row) => row.kind === 'unauthorized')
  assert.ok(entry, `no unauthorized entry in the request log: ${JSON.stringify(status.requests)}`)
  assert.equal(entry.agent, null, 'an unauthenticated caller must not choose the agent name')
  assert.equal(entry.status, 401)
})
