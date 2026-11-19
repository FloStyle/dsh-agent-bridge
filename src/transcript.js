// Text helpers: provenance headers, clipping, turn-end text and the compact
// transcript that clients read.

/** The bridge's own sender line. Only this exact form is stripped from client text. */
const BRIDGE_HEADER = /^[ \t]*\[[ \t]*dsh-agent-bridge[ \t]*\][ \t]*from[ \t]+[^\]\n]{0,64}[ \t]*(?:\r?\n)+/i

/** Keep an agent label printable, bounded and header-safe. */
export function agentNameOf(value) {
  const clean = (typeof value === 'string' ? value : '').replace(/[^\w.:@+-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
  return clean || 'generic'
}

/**
 * Drop leading copies of the bridge's own header so a client cannot stack a
 * forged one in front of its text. Every other leading line, including a
 * bracketed label such as "[WIP]", is left alone.
 */
export function stripProvenance(text) {
  let out = text
  for (;;) {
    const next = out.replace(BRIDGE_HEADER, '')
    if (next === out) return out
    out = next
  }
}

export function tagPrompt(text, agent) {
  return `[dsh-agent-bridge] from ${agent}\n\n${stripProvenance(text)}`
}

export function textOf(content, kinds = ['text']) {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : ''
  return content.filter((p) => kinds.includes(p?.type)).map((p) => p.text ?? '').join('\n').trim()
}

export function clip(s, n) {
  s = String(s ?? '')
  return s.length > n ? s.slice(0, n) + `… [+${s.length - n} chars]` : s
}

/**
 * Assistant text of one turn only. A cancelled turn has none, so it must not
 * inherit the previous turn's answer (L1).
 */
export function lastAssistantText(events, turn) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e?.type !== 'assistant/message') continue
    if (turn !== undefined && e.data?.turn !== turn) continue
    const t = textOf(e.data?.message?.content)
    if (t) return t
  }
  return null
}

/**
 * DSH TurnEndReason kinds to the values clients act on. DSH 0.2.2-rc.3 defines
 * completed, aborted, interrupted, error, max-tokens, blocked and forked. Only
 * `completed` means the turn finished; everything else that is not a cancel
 * or an error, including kinds a later DSH adds, is `incomplete`.
 */
export function turnEndReason(kind) {
  if (kind === 'completed') return 'completed'
  if (kind === 'aborted' || kind === 'interrupted') return 'cancelled'
  if (kind === 'error') return 'error'
  return 'incomplete'
}

/**
 * Turn raw session events into a compact, model-friendly transcript.
 * `agentOfRequest(requestId)` returns the agent that sent a bridged prompt, or
 * undefined for a message the bridge did not send. Text alone is not evidence:
 * a human can type the same header into the DSH window.
 */
export function compact(events, limit, agentOfRequest = () => undefined) {
  const out = []
  for (const e of events) {
    const d = e?.data ?? {}
    switch (e?.type) {
      case 'user/message': {
        const text = textOf(d.content)
        // DSH records the requestId the bridge minted as source.rpcId.
        const agent = agentOfRequest(d.source?.rpcId)
        if (agent) {
          out.push({ seq: e.seq, role: 'agent-bridge', agent, text: clip(stripProvenance(text), 4000) })
        } else if (d.source?.kind && d.source.kind !== 'user') {
          break
        } else {
          out.push({ seq: e.seq, role: 'user', text: clip(text, 4000) })
        }
        break
      }
      case 'assistant/message': {
        const t = textOf(d.message?.content)
        if (t) out.push({ seq: e.seq, role: 'assistant', turn: d.turn, text: clip(t, 6000) })
        break
      }
      case 'tool/call':
        out.push({ seq: e.seq, role: 'tool-call', name: d.name, args: clip(d.arguments, 400) })
        break
      case 'tool/result':
        out.push({ seq: e.seq, role: 'tool-result', isError: d.message?.isError ?? false, text: clip(textOf(d.message?.content), 600) })
        break
      case 'turn/end':
        out.push({ seq: e.seq, role: 'turn-end', turn: d.turn, reason: d.reason?.kind })
        break
      case 'session/title':
        out.push({ seq: e.seq, role: 'title', text: d.title ?? textOf(d.content) })
        break
    }
  }
  return limit > 0 ? out.slice(-limit) : out
}
