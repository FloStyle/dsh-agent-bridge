// dsh-bridge install (R2.2, R2.4): add the bridge to a DSH profile.
//
// Backs up the profile files, adds the new build before anything is removed,
// restores the backup when `dsh plugin add` fails, and makes sure the package
// is listed in dsh.profile.bundles. It never reads or prints the token.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PACKAGE, REPO_SLUG, VERSION } from '../version.js'
import { BACKUP_FILES, backupProfile, bundlesOf, dshAvailable, profileDir, readManifest, restoreProfile, runDsh, writeManifest } from './profile.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

async function latestRelease() {
  const res = await fetch(`https://api.github.com/repos/${REPO_SLUG}/releases/latest`, {
    headers: { 'user-agent': 'dsh-agent-bridge-install' }, signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
  return String((await res.json()).tag_name).replace(/^v/, '')
}

function sha256Of(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function expectedSha(options) {
  if (options['sha256']) return String(options['sha256']).trim().toLowerCase()
  if (options['sha256-file']) return readFileSync(options['sha256-file'], 'utf8').trim().split(/\s+/)[0].toLowerCase()
  return undefined
}

export async function install(options, out = console) {
  const profile = options.profile ?? 'desktop'
  const source = options.source ?? 'release'
  const dryRun = Boolean(options['dry-run'])
  if (!['release', 'github', 'local', 'file'].includes(source)) throw new Error(`unknown --source ${source}; use release, github, local or file`)

  let version = options.version
  let spec
  if (source === 'file') {
    const tarball = options.tarball
    if (!tarball) throw new Error('--source file needs --tarball <path>')
    const path = isAbsolute(tarball) ? tarball : resolve(tarball)
    if (!existsSync(path)) throw new Error(`no tarball at ${path}`)
    const expected = expectedSha(options)
    if (!expected) throw new Error('--source file needs --sha256 <hex> or --sha256-file <path>')
    const actual = sha256Of(path)
    if (actual !== expected) throw new Error(`SHA-256 mismatch for ${path}: expected ${expected}, got ${actual}. Nothing was changed.`)
    out.log(`SHA-256 verified: ${actual}`)
    spec = `file:${path.replace(/\\/g, '/')}`
  } else if (source === 'local') {
    version ??= VERSION
    spec = `file:${repoRoot.replace(/\\/g, '/').replace(/\/$/, '')}`
  } else {
    if (!version) {
      try { version = await latestRelease() } catch (error) {
        if (!dryRun) throw new Error(`could not read the latest release (${error.message}); pass --version`)
        version = '<latest>'
      }
    }
    if (version !== '<latest>' && !/^\d+\.\d+\.\d+/.test(version)) throw new Error(`invalid --version ${version}`)
    spec = source === 'github'
      ? `github:${REPO_SLUG}#v${version}`
      : `https://github.com/${REPO_SLUG}/releases/download/v${version}/${PACKAGE}-${version}.tgz`
  }

  const manifest = readManifest(profile)
  const backupNames = BACKUP_FILES.filter((name) => existsSync(resolve(profileDir(profile), name)))
  const bundled = bundlesOf(manifest).includes(PACKAGE)

  if (dryRun) {
    out.log(`Dry run: nothing will be changed.`)
    out.log(`  profile:   ${profile} (${profileDir(profile)}${manifest ? '' : ', does not exist yet'})`)
    out.log(`  back up ${backupNames.length ? backupNames.join(', ') : '(nothing to back up)'}`)
    out.log(`  run:       dsh plugin --profile ${profile} add ${spec}`)
    out.log(`  bundles:   ${bundled ? `${PACKAGE} already listed` : `add ${PACKAGE} to dsh.profile.bundles`}`)
    out.log(`  dsh CLI:   ${dshAvailable() ? 'found' : 'NOT FOUND on PATH'}`)
    return 0
  }

  if (!dshAvailable()) throw new Error('the dsh CLI is not on PATH; use the dsh bundled with DeepSeek Harness')
  const backup = backupProfile(profile)
  if (backup.copied.length) out.log(`Backed up ${backup.copied.length} file(s) to ${backup.folder}`)
  out.log(`Installing ${PACKAGE} ${version ?? ''} from ${source} into profile '${profile}'\n  ${spec}`)
  const added = runDsh(['plugin', '--profile', profile, 'add', spec])
  if (added.status !== 0) {
    restoreProfile(profile, backup)
    throw new Error(`dsh plugin add failed (exit ${added.status}); the profile was restored from ${backup.folder}`)
  }
  const after = readManifest(profile)
  if (after && !bundlesOf(after).includes(PACKAGE)) {
    after.dsh ??= {}
    after.dsh.profile ??= {}
    after.dsh.profile.bundles = [...bundlesOf(after), PACKAGE]
    writeManifest(profile, after)
    out.log(`Added ${PACKAGE} to dsh.profile.bundles`)
  }
  out.log('')
  out.log('Restart DeepSeek Harness while no session is working, then run: dsh-bridge doctor')
  if (backup.copied.length) out.log(`Rollback: copy ${backup.folder} back to ${profileDir(profile)} and restart DSH`)
  return 0
}
