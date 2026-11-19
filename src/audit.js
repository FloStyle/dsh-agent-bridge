// Append-only audit trail for everything the bridge dispatches, accepted or
// not. It records a hash and a length, never the prompt text itself.
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

export function createAudit({ file, maxBytes = 1048576, bootId, logger }) {
  return ({ action, outcome, status, agent, sessionId, text, ...rest }) => {
    try {
      mkdirSync(dirname(file), { recursive: true })
      try {
        if (statSync(file).size >= maxBytes) renameSync(file, `${file}.1`)
      } catch { /* first write, or a file another process is rotating */ }
      const entry = { time: new Date().toISOString(), bootId, action, outcome, status, agent, sessionId, ...rest }
      if (typeof text === 'string') {
        entry.textLength = text.length
        entry.textSha256 = createHash('sha256').update(text, 'utf8').digest('hex')
      }
      appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 })
    } catch (error) {
      logger.warn(`agent-bridge: audit write failed: ${error}`)
    }
  }
}
