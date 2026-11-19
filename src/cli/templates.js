// dsh-bridge template: the owner edits session templates. `add` and `remove`
// preview by default and change the file only with --yes.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadTemplates, saveTemplates, validateTemplate } from '../templates.js'

const defaultFile = () => process.env.DSH_BRIDGE_TEMPLATES_FILE
  || join(process.env.DSH_BRIDGE_STATE_FILE ? join(process.env.DSH_BRIDGE_STATE_FILE, '..') : join(homedir(), '.dsh'), 'agent-bridge-templates.json')

export function templateCommand(options, out = console) {
  const [action = 'list', name] = options._
  const file = options.file ?? defaultFile()
  const templates = loadTemplates(file)
  if (action === 'list') {
    const names = Object.keys(templates)
    if (!names.length) out.log(`No templates in ${file}.`)
    for (const n of names) out.log(`${n}  ${templates[n].profile ? `profile ${templates[n].profile}` : templates[n].cwd ?? ''}${templates[n].model ? `  model ${templates[n].model}` : ''}`)
    return 0
  }
  if (action === 'show') {
    if (!templates[name]) throw new Error(`no template "${name}" in ${file}`)
    out.log(JSON.stringify({ [name]: templates[name] }, null, 2))
    return 0
  }
  if (action === 'add') {
    if (!name) throw new Error('usage: dsh-bridge template add <name> [--profile p | --cwd d] [--model m] [--reasoning-effort e] [--agent-preset p] [--first-prompt text] [--yes]')
    const { errors, template } = validateTemplate(name, {
      profile: options.profile, cwd: options.cwd, model: options.model, reasoningEffort: options['reasoning-effort'],
      agentPreset: options['agent-preset'], firstPrompt: options['first-prompt'],
    })
    if (errors.length) throw new Error(errors.join('; '))
    out.log(`${options.yes ? 'Writing' : 'Would write'} to ${file}:`)
    out.log(JSON.stringify({ [name]: template }, null, 2))
    if (!options.yes) { out.log('\nRe-run with --yes to write it.'); return 0 }
    saveTemplates(file, { ...templates, [name]: template })
    return 0
  }
  if (action === 'remove') {
    if (!templates[name]) throw new Error(`no template "${name}" in ${file}`)
    if (!options.yes) { out.log(`Would remove "${name}" from ${file}. Re-run with --yes.`); return 0 }
    const { [name]: _, ...rest } = templates
    saveTemplates(file, rest)
    out.log(`Removed "${name}".`)
    return 0
  }
  throw new Error(`unknown action "${action}"; use list, show, add or remove`)
}
