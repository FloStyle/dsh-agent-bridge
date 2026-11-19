// Parse the warning that `dsh plugin <profile> list` prints for plugins DSH
// refuses to mount on this runtime.
//
// DSH 0.2.2-rc.3 persists no refusal record: `compatibility.json` only holds
// granted exemptions, `version-exemptions` prints `{}` when nothing is granted,
// there is no DSH log directory, and `--dump-config` refuses the desktop
// profile. The CLI warning is the only observable source, so doctor parses it.
// Anything that does not match the warning is ignored, which makes a changed
// message a silent no-op rather than a wrong report.
const DENIED = /^Plugin (.+?)@([^@\s]+) is incompatible with dsh (\S+):/

export function parseDeniedPlugins(text) {
  const denied = []
  const seen = new Set()
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = DENIED.exec(line.trim())
    if (!match) continue
    const [, name, version, runtime] = match
    if (seen.has(name)) continue
    seen.add(name)
    denied.push({ name, version, runtime })
  }
  return denied
}

/** The exact command DSH itself suggests; confirmed by its usage line. */
export function deniedPluginHint(profile, plugin) {
  return `dsh plugin --profile ${profile} allow-version ${plugin.name}@${plugin.version} --dsh-version ${plugin.runtime} --accept-risk`
}
