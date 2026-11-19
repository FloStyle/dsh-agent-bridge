// The DSH model catalog, flattened, and model choices resolved against it.
//
// DSH's `sessionController.modelCatalog()` returns {default, routableProviders,
// groups: [{id: provider, name, models: [{id, name, reasoning?}]}]}. A choice
// is valid only if it names one routable model, and its reasoning effort (if
// any) is one the model offers.

const badRequest = (message) => Object.assign(new Error(message), { status: 400 })

/** One entry per routable model: {provider, id, ref, name, efforts, defaultEffort?}. */
export function flattenCatalog(catalog) {
  const routable = new Set(catalog?.routableProviders ?? [])
  const models = []
  for (const group of catalog?.groups ?? []) {
    if (routable.size && !routable.has(group.id)) continue
    for (const model of group.models ?? []) {
      const entry = {
        provider: group.id,
        id: model.id,
        ref: `${group.id}/${model.id}`,
        name: model.name,
        efforts: (model.reasoning?.efforts ?? []).map((effort) => effort.id),
      }
      if (model.reasoning?.defaultEffort) entry.defaultEffort = model.reasoning.defaultEffort
      if (model.description) entry.description = model.description
      models.push(entry)
    }
  }
  return { default: catalog?.default, providers: [...routable], models }
}

/**
 * Resolve a choice: {provider, model}, "provider/model", a model id that only
 * one provider offers, or a unique display name. Throws a 400 listing the
 * choices when it is unknown or ambiguous.
 * @returns {{provider: string, model: string, reasoningEffort?: string}}
 */
export function resolveModel(spec, reasoningEffort, catalog) {
  const { models } = flattenCatalog(catalog)
  const choices = () => models.map((m) => m.ref).join(', ')
  let hits
  if (spec && typeof spec === 'object') {
    hits = models.filter((m) => m.provider === spec.provider && m.id === spec.model)
    reasoningEffort ??= spec.reasoningEffort
  } else if (typeof spec === 'string' && spec.trim()) {
    const key = spec.trim()
    const lower = key.toLowerCase()
    hits = models.filter((m) => m.ref === key || m.ref === key.replace(':', '/'))
    if (!hits.length) hits = models.filter((m) => m.id === key)
    if (!hits.length) hits = models.filter((m) => String(m.name).toLowerCase() === lower)
  } else {
    throw badRequest('model must be "provider/model", a model id, a model name, or {provider, model}')
  }
  if (!hits.length) throw badRequest(`unknown model ${JSON.stringify(spec)}; available: ${choices()}`)
  if (hits.length > 1) throw badRequest(`model ${JSON.stringify(spec)} is ambiguous: ${hits.map((m) => m.ref).join(', ')}; use provider/model`)
  const [hit] = hits
  const selection = { provider: hit.provider, model: hit.id }
  if (reasoningEffort !== undefined && reasoningEffort !== null && reasoningEffort !== '') {
    if (!hit.efforts.includes(reasoningEffort)) {
      throw badRequest(hit.efforts.length
        ? `reasoning effort ${JSON.stringify(reasoningEffort)} is not offered by ${hit.ref}; use one of: ${hit.efforts.join(', ')}`
        : `${hit.ref} has no reasoning effort setting`)
    }
    selection.reasoningEffort = reasoningEffort
  }
  return selection
}

/** A session's model from DSH's `modelSelection` projection, as provider/model refs. */
export function sessionModel(values) {
  const selection = values?.modelSelection
  if (!selection) return undefined
  const ref = (pick) => (pick?.provider && pick?.model ? `${pick.provider}/${pick.model}` : undefined)
  const out = {}
  if (ref(selection.next)) out.next = ref(selection.next)
  if (selection.next?.reasoningEffort) out.reasoningEffort = selection.next.reasoningEffort
  if (ref(selection.lastUsed)) out.lastUsed = ref(selection.lastUsed)
  return Object.keys(out).length ? out : undefined
}
