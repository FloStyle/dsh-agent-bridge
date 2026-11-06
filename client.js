// Browser half of dsh-agent-bridge: a "Bridge" tab in every conversation that shows
// the bridge status, the last requests from any MCP agent and the last notifications.
window.__ModuleLoader__.load({
  id: 'dsh-agent-bridge',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState } = React

    const STATUS_URL = '/api/agent-bridge/status'
    const POLL_MS = 2000

    const short = (id) => (id ? String(id).replace(/^session-/, '').slice(0, 8) : '')
    const ago = (t, now) => {
      if (!t) return 'never'
      const s = Math.max(0, Math.round((now - t) / 1000))
      if (s < 60) return `${s}s ago`
      if (s < 3600) return `${Math.round(s / 60)}m ago`
      return `${Math.round(s / 3600)}h ago`
    }
    const clock = (t) => new Date(t).toLocaleTimeString()

    const css = {
      root: { padding: '16px 20px', fontSize: 13, lineHeight: 1.5, overflow: 'auto', height: '100%', boxSizing: 'border-box' },
      h2: { fontSize: 13, fontWeight: 600, margin: '18px 0 8px', opacity: 0.85 },
      row: { display: 'flex', gap: 10, flexWrap: 'wrap' },
      card: { border: '1px solid var(--dsw-alias-border-default, rgba(128,128,128,.25))', borderRadius: 8, padding: '8px 12px', minWidth: 110 },
      big: { fontSize: 18, fontWeight: 600 },
      dim: { opacity: 0.6 },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
      th: { textAlign: 'left', fontWeight: 500, opacity: 0.6, padding: '4px 6px', borderBottom: '1px solid rgba(128,128,128,.25)' },
      td: { padding: '4px 6px', borderBottom: '1px solid rgba(128,128,128,.12)', verticalAlign: 'top' },
      mono: { fontFamily: 'ui-monospace, Consolas, monospace' },
      here: { background: 'rgba(80,140,255,.10)' },
      dot: (ok) => ({ display: 'inline-block', width: 8, height: 8, borderRadius: 4, marginRight: 6, background: ok ? '#3fb950' : '#f85149' }),
    }

    function Card({ label, value, sub }) {
      return h('div', { style: css.card },
        h('div', { style: css.dim }, label),
        h('div', { style: css.big }, value),
        sub ? h('div', { style: { ...css.dim, fontSize: 11 } }, sub) : null)
    }

    function BridgeTab(props) {
      const here = props.sessionId
      const [data, setData] = useState(null)
      const [err, setErr] = useState(null)
      const [onlyHere, setOnlyHere] = useState(false)

      useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const r = await fetch(STATUS_URL, { cache: 'no-store', credentials: 'include' })
            const j = await r.json()
            if (!alive) return
            if (!r.ok) throw new Error(j.error || r.statusText)
            setData(j); setErr(null)
          } catch (e) { if (alive) setErr(String(e.message || e)) }
        }
        tick()
        const id = setInterval(tick, POLL_MS)
        return () => { alive = false; clearInterval(id) }
      }, [])

      const now = data ? data.now : Date.now()
      const filt = (list) => (onlyHere && here ? list.filter((x) => x.sessionId === here) : list)
      const reqs = data ? filt(data.requests) : []
      const evs = data ? filt(data.events) : []

      return h('div', { style: css.root },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
          h('div', null,
            h('span', { style: css.dot(!!data && !err) }),
            h('b', null, 'agents bridge'),
            h('span', { style: { ...css.dim, marginLeft: 8 } },
              err ? `unreachable: ${err}` : data ? `listening on 127.0.0.1:${data.port} \u00b7 up ${ago(data.startedAt, now).replace(' ago', '')}` : 'connecting\u2026')),
          h('label', { style: { fontSize: 12, cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: onlyHere, onChange: (e) => setOnlyHere(e.target.checked), style: { marginRight: 6 } }),
            `only this session (${short(here)})`)),

        data && h('div', { style: { ...css.row, marginTop: 14 } },
          h(Card, { label: 'agents listening', value: data.sse.length ? `${data.sse.length} watcher${data.sse.length > 1 ? 's' : ''}` : 'no', sub: `SSE \u00b7 last connect ${ago(data.lastSeen.sse, now)}` }),
          h(Card, { label: 'Last request', value: ago(data.lastSeen.request, now), sub: `${data.counters.total} total` }),
          h(Card, { label: 'Dispatched', value: data.counters.prompts + data.counters.creates, sub: `${data.counters.creates} new \u00b7 ${data.counters.prompts} prompts` }),
          h(Card, { label: 'Reads', value: data.counters.reads }),
          h(Card, { label: 'Errors', value: data.counters.errors, sub: data.counters.unauthorized ? `${data.counters.unauthorized} unauthorized` : null })),

        h('div', { style: css.h2 }, 'Last requests from agents'),
        reqs.length === 0 ? h('div', { style: css.dim }, 'None yet.') :
          h('table', { style: css.table },
            h('thead', null, h('tr', null, ['Time', 'Kind', 'Session', 'Status', 'ms', 'Agent'].map((t) => h('th', { key: t, style: css.th }, t)))),
            h('tbody', null, reqs.map((r, i) => h('tr', { key: i, style: r.sessionId && r.sessionId === here ? css.here : null },
              h('td', { style: css.td }, clock(r.time)),
              h('td', { style: css.td }, r.kind || r.method),
              h('td', { style: { ...css.td, ...css.mono } }, short(r.sessionId)),
              h('td', { style: { ...css.td, color: r.status >= 400 ? '#f85149' : undefined } }, r.status || '\u2026'),
              h('td', { style: css.td }, r.ms),
              h('td', { style: { ...css.td, ...css.dim, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, r.agent || 'generic'))))),

        h('div', { style: css.h2 }, 'Notifications sent to agents'),
        evs.length === 0 ? h('div', { style: css.dim }, 'None yet.') :
          h('table', { style: css.table },
            h('thead', null, h('tr', null, ['Time', 'Event', 'Session', 'Detail'].map((t) => h('th', { key: t, style: css.th }, t)))),
            h('tbody', null, evs.map((e) => h('tr', { key: e.id, style: e.sessionId === here ? css.here : null },
              h('td', { style: css.td }, clock(e.time)),
              h('td', { style: css.td }, e.type === 'status' ? `status: ${e.status}` : e.type),
              h('td', { style: { ...css.td, ...css.mono } }, short(e.sessionId)),
              h('td', { style: { ...css.td, ...css.dim, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } },
                e.reason || e.status || ''))))))
    }

    function apply(ctx) {
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'agent-bridge',
        order: 90,
        label: () => 'Bridge',
      }, (props) => h(BridgeTab, props)))
    }

    return { name: 'dsh-agent-bridge', inject: ['slots'], apply }
  },
})
