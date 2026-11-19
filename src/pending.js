// "This session waits for a human": DSH exposes the unsettled approval/request
// and user-questions/request events per agent. That table is the real source,
// unlike the guessed session event names the first version listened for.

const kindOf = (info) => (info?.event === 'approval/request' ? 'approval' : info?.event === 'user-questions/request' ? 'question' : 'other')

/** Poll DSH every `pollMs` and emit `pending-input` on each change. Returns the timer. */
export function startPendingSweep(dsh, emit, pollMs = 1500) {
  const seen = new Map()
  /** Announce one pending-input change, plus the deprecated needs-approval alias. */
  const announce = (sessionId, kinds) => {
    emit({ type: 'pending-input', sessionId, kinds })
    // Kept for one release so 0.5.x SSE consumers keep working; PROTOCOL stays 1
    // only because this alias exists. Remove it with a protocol bump in 0.7.0.
    emit({
      type: 'needs-approval',
      sessionId,
      kinds,
      event: kinds.includes('approval') ? 'approval/request' : kinds.length ? 'user-questions/request' : undefined,
      deprecated: true,
    })
  }
  const sweep = () => {
    const current = new Map()
    for (const info of dsh.pendingRemoteEvents()) {
      if (!info?.agentId) continue
      if (!current.has(info.agentId)) current.set(info.agentId, new Set())
      current.get(info.agentId).add(kindOf(info))
    }
    for (const [sessionId, kinds] of current) {
      const key = [...kinds].sort().join(',')
      if (seen.get(sessionId) === key) continue
      seen.set(sessionId, key)
      announce(sessionId, [...kinds].sort())
    }
    for (const sessionId of [...seen.keys()]) {
      if (current.has(sessionId)) continue
      seen.delete(sessionId)
      announce(sessionId, [])
    }
  }
  const timer = pollMs > 0 ? setInterval(sweep, pollMs) : undefined
  timer?.unref?.()
  return timer
}
