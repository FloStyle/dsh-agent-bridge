// The SSE event hub: a bounded ring of recent events, live clients, and the
// relay from DSH session and agent events.
import { clip, lastAssistantText, textOf, turnEndReason } from './transcript.js'

export function createEventHub({ bootId, ringSize = 500, maxClients = 16 }) {
  const clients = new Set()
  const ring = []
  let seq = 0
  const frame = (ev) => `id: ${ev.id}\ndata: ${JSON.stringify(ev)}\n\n`

  return {
    bootId,
    clients,
    ring,
    /** The id of the newest event; a wait must end on an event newer than this. */
    lastId: () => seq,
    emit(ev) {
      ev = { id: ++seq, bootId, time: Date.now(), ...ev }
      ring.push(ev)
      if (ring.length > ringSize) ring.shift()
      const text = frame(ev)
      for (const res of clients) if (!res.write(text)) res.destroy()
    },
    /** Stream events newer than `since` to `res`, then keep it subscribed. Returns false when full. */
    attach(res, since) {
      if (clients.size >= maxClients) return false
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.flushHeaders()
      // T5: the client missed events that left the ring; say so before the rest.
      if (ring.length && since < ring[0].id - 1) res.write(`data: ${JSON.stringify({ type: 'gap', bootId, from: since, oldest: ring[0].id })}\n\n`)
      for (const ev of ring) if (ev.id > since) res.write(frame(ev))
      clients.add(res)
      const ping = setInterval(() => res.write(': ping\n\n'), 25000)
      res.on('close', () => { clearInterval(ping); clients.delete(res) })
      return true
    },
    close() {
      for (const res of clients) res.end()
      clients.clear()
    },
  }
}

/** Relay DSH session and agent events to the hub. */
export function relayDshEvents(dsh, hub, { onSession } = {}) {
  const titleOf = (session) => session?.header?.title ?? session?.title
  dsh.onSessionEvent((session, event) => {
    try {
      dsh.rememberSession(session)
      onSession?.(session)
      if (event.type === 'turn/end') {
        const turn = event.data?.turn
        const reasonKind = event.data?.reason?.kind
        const text = lastAssistantText(session.snapshotEvents?.() ?? [], turn)
        hub.emit({
          type: 'turn-end', sessionId: session.id, title: titleOf(session), cwd: session.header?.cwd,
          turn, reason: turnEndReason(reasonKind), reasonKind,
          lastText: text === null ? null : clip(text, 4000),
        })
      } else if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
        hub.emit({ type: 'user-message', sessionId: session.id, source: event.data?.source?.kind, text: clip(textOf(event.data?.content), 500) })
      }
    } catch (error) {
      dsh.logger.warn(`agent-bridge: event relay failed: ${error}`)
    }
  })
  dsh.onAgentStatus(({ agent, status }) => hub.emit({ type: 'status', sessionId: agent.id, status }))
  dsh.onAgentError(({ agent, error }) => hub.emit({ type: 'error', sessionId: agent.id, message: String(error?.message ?? error) }))
}
