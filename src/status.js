// The request log and counters behind /health and the Bridge tab.

export function createStatus({ version, protocol, bootId, port, hub }) {
  const startedAt = Date.now()
  const requests = []
  const counters = { total: 0, errors: 0, prompts: 0, creates: 0, reads: 0, unauthorized: 0 }
  const lastSeen = { request: 0, sse: 0 }
  const state = { defaultAgentSeen: false }

  return {
    startedAt,
    counters,
    lastSeen,
    state,
    track(entry) {
      requests.push(entry)
      if (requests.length > 100) requests.shift()
    },
    /** For the Bridge tab: metadata only, never prompt or response text or local paths. */
    payload: () => ({
      ok: true, version, protocol, bootId, pid: process.pid, port, startedAt, now: Date.now(), counters, lastSeen,
      sse: [...hub.clients].map((r) => ({ since: r.__since })), lastEventId: hub.lastId(),
      requests: requests.slice(-50).reverse().map(({ time, method, status, ms, kind, sessionId, agent }) => ({ time, method, status, ms, kind, sessionId, agent })),
      events: hub.ring.slice(-30).reverse().map(({ id, time, type, sessionId, status, reason }) => ({ id, time, type, sessionId, status, reason })),
    }),
  }
}
