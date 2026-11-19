// Sending prompts and choosing models, with provenance and an audit line for
// every accepted, refused and failed action.
import { randomUUID } from 'node:crypto'
import { tagPrompt } from './transcript.js'

const fail = (message, status) => Object.assign(new Error(message), { status })

export function validatePrompt(text, mode) {
  if (typeof text !== 'string' || !text.trim() || text.length > 50000) throw fail('text must contain 1-50000 characters', 400)
  if (mode !== undefined && mode !== 'followup' && mode !== 'steer') throw fail('Invalid prompt mode', 400)
}

export function createPrompter({ dsh, audit, hub, bootId }) {
  // The requestIds this plugin minted, so a transcript can tell its own prompts
  // from a human typing the same header. Bounded: the oldest entries drop off.
  const bridgedRequests = new Map()
  const rememberRequest = (requestId, agent) => {
    bridgedRequests.set(requestId, agent)
    if (bridgedRequests.size > 1000) bridgedRequests.delete(bridgedRequests.keys().next().value)
  }
  const promptLocks = new Set()

  async function prompt(sessionId, text, mode, agent) {
    const refusedMode = mode ?? 'followup'
    try {
      validatePrompt(text, mode)
    } catch (error) {
      audit({ action: 'prompt', outcome: 'refused', status: error.status ?? 400, agent, sessionId, mode: refusedMode, text })
      throw error
    }
    const status = dsh.agentStatus(sessionId)
    if (promptLocks.has(sessionId) || (status && status !== 'idle' && mode !== 'steer')) {
      audit({ action: 'prompt', outcome: 'refused', status: 409, agent, sessionId, mode: refusedMode, text })
      throw fail('Session busy; use explicit steer mode', 409)
    }
    promptLocks.add(sessionId)
    // Capture the cursor before the turn starts: the wait must end on a turn-end
    // that is strictly newer than this.
    const eventId = hub.lastId()
    const requestId = randomUUID()
    try {
      const value = await dsh.prompt({
        sessionId,
        content: [{ type: 'text', text: tagPrompt(text, agent) }],
        requestId,
        mode: mode === 'steer' ? 'steer' : 'followup',
      }, new AbortController().signal)
      rememberRequest(requestId, agent)
      audit({ action: 'prompt', outcome: 'accepted', status: 200, agent, sessionId, requestId, mode: refusedMode, text, eventId })
      return { ...(value ?? {}), sessionId, requestId, eventId, bootId }
    } catch (error) {
      audit({ action: 'prompt', outcome: 'failed', status: error.status ?? 500, agent, sessionId, requestId, mode: refusedMode, text, eventId })
      throw error
    } finally { promptLocks.delete(sessionId) }
  }

  async function modelCatalog() {
    if (!dsh.hasModelCatalog()) throw fail('this DSH build has no model catalog', 501)
    return dsh.modelCatalog()
  }

  async function selectModel(sessionId, selection, agent) {
    const ref = `${selection.provider}/${selection.model}`
    try {
      const value = await dsh.selectModel({ sessionId, ...selection })
      audit({ action: 'model', outcome: 'accepted', status: 200, agent, sessionId, model: ref, reasoningEffort: selection.reasoningEffort })
      return value?.selected ?? selection
    } catch (error) {
      audit({ action: 'model', outcome: 'failed', status: error.status ?? 500, agent, sessionId, model: ref, error: String(error?.message ?? error) })
      throw error
    }
  }

  return {
    prompt,
    modelCatalog,
    selectModel,
    agentOfRequest: (requestId) => (requestId ? bridgedRequests.get(requestId) : undefined),
  }
}
