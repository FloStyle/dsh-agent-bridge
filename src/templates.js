// Session templates: owner-written starting points for new sessions.
//
//   { "templates": { "<name>": { "profile"?, "cwd"?, "model"?, "reasoningEffort"?, "agentPreset"?, "firstPrompt"? } } }
//
// A template only fills fields the caller did not set. Paths and profiles are
// checked again when the session is created.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const FIELDS = ['profile', 'cwd', 'model', 'reasoningEffort', 'agentPreset', 'firstPrompt']

export function templatesFileFor(stateFile) {
  return process.env.DSH_BRIDGE_TEMPLATES_FILE || join(dirname(stateFile), 'agent-bridge-templates.json')
}

export function loadTemplates(file) {
  if (!existsSync(file)) return {}
  const data = JSON.parse(readFileSync(file, 'utf8'))
  return data?.templates && typeof data.templates === 'object' ? data.templates : {}
}

export function saveTemplates(file, templates) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ templates }, null, 2) + '\n', { mode: 0o600 })
}

/** @returns {{errors: string[], template: object}} */
export function validateTemplate(name, input) {
  const errors = []
  if (!NAME.test(String(name))) errors.push(`template name must be 1-64 letters, digits, dot, dash or underscore: ${name}`)
  const template = {}
  for (const field of FIELDS) {
    const value = input?.[field]
    if (value === undefined || value === null || value === '') continue
    if (typeof value !== 'string') { errors.push(`${field} must be text`); continue }
    if (field === 'firstPrompt' ? value.length > 20000 : value.length > 4096) errors.push(`${field} is too long`)
    template[field] = value
  }
  if (template.cwd && !isAbsolute(template.cwd)) errors.push('cwd must be an absolute path')
  if (template.cwd && template.profile) errors.push('use either cwd or profile, not both: the profile sets the cwd')
  return { errors, template }
}
