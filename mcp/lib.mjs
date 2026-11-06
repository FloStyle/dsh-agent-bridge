// Shared client for the dsh-agent-bridge plugin running inside DeepSeek Harness.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function bridge() {
  const file = process.env.DSH_BRIDGE_STATE_FILE || join(homedir(), '.dsh', 'agent-bridge.json')
  let state
  try { state = JSON.parse(readFileSync(file, 'utf8')) } catch {
    throw new Error(`DSH bridge not found (${file}). Is DeepSeek Harness running with the dsh-agent-bridge plugin?`)
  }
  const endpoint = new URL(state.url)
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw new Error('Bridge URL must be plain HTTP on 127.0.0.1')
  if (typeof state.token !== 'string' || state.token.length < 32) throw new Error('Invalid bridge token')
  return state
}

export async function call(method, path, body) {
  const { url, token } = bridge()
  let res
  try {
    res = await fetch(url + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-agent-name': process.env.DSH_AGENT_NAME || 'mcp-agent' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (e) {
    throw new Error(`DSH bridge unreachable at ${url}: ${e.cause?.code ?? e.message}. Start DeepSeek Harness.`)
  }
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`DSH bridge ${res.status}: ${json.error ?? res.statusText}`)
  return json
}

/** Yield parsed SSE events from the bridge until the signal aborts. */
export async function* events({ since, signal } = {}) {
  const { url, token } = bridge()
  const q = since === undefined ? '' : `?since=${since}`
  const res = await fetch(`${url}/events${q}`, { headers: { authorization: `Bearer ${token}` }, signal, redirect: 'error' })
  if (!res.ok) throw new Error(`DSH bridge ${res.status}`)
  const decoder = new TextDecoder()
  let buf = ''
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i)
      buf = buf.slice(i + 2)
      const data = frame.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n')
      if (data) yield JSON.parse(data)
    }
  }
}
