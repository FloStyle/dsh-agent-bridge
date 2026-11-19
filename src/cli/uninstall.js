// dsh-bridge uninstall: remove the bridge from a profile. The private files
// (state, token, audit) are kept unless the user confirms or passes --purge.
import { existsSync, rmSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { PACKAGE } from '../version.js'
import { bundlesOf, dshAvailable, privateFiles, readManifest, runDsh, writeManifest } from './profile.js'

async function confirm(question) {
  if (!process.stdin.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try { return /^(y|yes)$/i.test((await rl.question(question)).trim()) } finally { rl.close() }
}

export async function uninstall(options, out = console) {
  const profile = options.profile ?? 'desktop'
  const dryRun = Boolean(options['dry-run'])
  const files = privateFiles().filter((file) => existsSync(file))
  const manifest = readManifest(profile)
  const bundled = bundlesOf(manifest).includes(PACKAGE)

  if (dryRun) {
    out.log('Dry run: nothing will be changed.')
    out.log(`  run:       dsh plugin --profile ${profile} remove ${PACKAGE}`)
    out.log(`  bundles:   ${bundled ? `remove ${PACKAGE} from dsh.profile.bundles` : 'not listed'}`)
    out.log(`  private files (kept unless --purge or confirmed):${files.length ? '' : ' none'}`)
    for (const file of files) out.log(`    ${file}`)
    return 0
  }

  if (!dshAvailable()) throw new Error('the dsh CLI is not on PATH; use the dsh bundled with DeepSeek Harness')
  out.log(`Removing ${PACKAGE} from profile '${profile}'`)
  const removed = runDsh(['plugin', '--profile', profile, 'remove', PACKAGE])
  if (removed.status !== 0) out.log(`warning: dsh plugin remove failed (exit ${removed.status}); the package may already be absent`)
  const after = readManifest(profile)
  if (after && bundlesOf(after).includes(PACKAGE)) {
    after.dsh.profile.bundles = bundlesOf(after).filter((name) => name !== PACKAGE)
    writeManifest(profile, after)
    out.log(`Removed ${PACKAGE} from dsh.profile.bundles`)
  }
  if (!files.length) {
    out.log('No private bridge files to remove.')
  } else {
    const purge = options.purge || await confirm(`Delete ${files.length} private file(s)? They hold the bridge token and audit history [y/N] `)
    if (purge) for (const file of files) { rmSync(file, { force: true }); out.log(`Deleted ${file}`) }
    else out.log(`Kept the private bridge files (pass --purge to delete them).`)
  }
  out.log('Restart DeepSeek Harness to unload the plugin.')
  return 0
}
