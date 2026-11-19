// dsh-bridge live-check (R2.6): the release live checks as one command.
//
// Use it against a test profile whose DSH runs with its own state file
// (DSH_BRIDGE_STATE_FILE). On `desktop` it refuses unless --read-only, which
// runs only checks that change nothing.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bridge, call, follow } from '../../mcp/lib.mjs'

export async function liveCheck(options, out = console) {
  const profile = options.profile ?? 'bridge-test'
  const readOnly = Boolean(options['read-only'])
  if (profile === 'desktop' && !readOnly) throw new Error('live-check changes state (it creates and cancels a scratch session); on the desktop profile pass --read-only')
  const results = []
  const check = async (name, fn) => {
    try { results.push([name, 'PASS', await fn()]) } catch (error) { results.push([name, 'FAIL', error.message]) }
  }
  const { url, token } = bridge()

  await check('health', async () => {
    const health = await call('GET', '/health')
    return `version ${health.version}, protocol ${health.protocol}, services missing: ${health.services?.missing?.length ?? '?'}`
  })
  await check('wrong token refused', async () => {
    const res = await fetch(`${url}/health`, { headers: { authorization: `Bearer ${'x'.repeat(token.length)}` } })
    if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`)
    return '401'
  })
  await check('list sessions', async () => `${(await call('GET', '/sessions')).items.length} session(s)`)

  if (!readOnly) {
    let sessionId
    await check('send then wait', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'dsh-live-check-'))
      const sent = await call('POST', '/sessions', { cwd, text: 'Reply with the single word PONG.' })
      sessionId = sent.sessionId
      const event = await waitFor(sessionId, sent.eventId, 180)
      if (event.type !== 'turn-end') throw new Error(`ended with ${event.type}`)
      return `turn-end reason ${event.reason}`
    })
    await check('provenance', async () => {
      const read = await call('GET', `/sessions/${encodeURIComponent(sessionId)}?limit=0`)
      const own = read.entries.find((entry) => entry.role === 'agent-bridge')
      if (!own) throw new Error('no agent-bridge entry in the transcript')
      return `role agent-bridge, agent ${own.agent}`
    })
    await check('cancel', async () => {
      const sent = await call('POST', `/sessions/${encodeURIComponent(sessionId)}/prompt`, { text: 'Count slowly from 1 to 500, one number per line.' })
      await new Promise((resolve) => setTimeout(resolve, 1500))
      await call('POST', `/sessions/${encodeURIComponent(sessionId)}/cancel`)
      const event = await waitFor(sessionId, sent.eventId, 60)
      if (event.reason !== 'cancelled') throw new Error(`reason ${event.reason}`)
      return 'reason cancelled'
    })
  }

  for (const [name, status, detail] of results) out.log(`${status.padEnd(5)} ${name}: ${detail}`)
  return results.some(([, status]) => status === 'FAIL') ? 1 : 0
}

async function waitFor(sessionId, since, seconds) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), seconds * 1000)
  try {
    for await (const event of follow({ since, signal: controller.signal, retryMs: 250 })) {
      if (event.sessionId === sessionId && (event.type === 'turn-end' || event.type === 'error')) return event
    }
  } finally { clearTimeout(timer) }
  throw new Error(`no turn-end within ${seconds} s`)
}
