#!/usr/bin/env node
// dsh-bridge: one command for everything around dsh-agent-bridge.
// Start it with bin/dsh-bridge.cmd (Windows) or bin/dsh-bridge (POSIX): they
// pick DSH's own Node when DeepSeek Harness is installed.
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { VERSION } from '../src/version.js'
import { currentRuntimeSource } from '../src/cli/runtime.js'

const root = fileURLToPath(new URL('..', import.meta.url))

const HELP = `dsh-bridge ${VERSION}

  install     [--source release|github|local|file] [--version x] [--tarball p --sha256 h] [--profile p] [--dry-run]
  uninstall   [--profile p] [--purge] [--dry-run]
  connect     claude|codex|generic [--name agent] [--profile p] [--execute]
  doctor      [--profile p]
  health
  profile     list|show|add|remove|validate [name] [--cwd d --root d... --preset p --description t] [--yes]
  live-check  [--profile p] [--read-only]
  watch       [--session id] [--all]
  access-report [--session id|--workspace name] [--since 7d] [--json]
  mcp         run the stdio MCP server
  runtime     show which JavaScript runtime runs this command`

/** --key value, --flag, and positional arguments. */
function parse(argv) {
  const options = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) { options._.push(arg); continue }
    const key = arg.slice(2)
    const next = argv[i + 1]
    const value = next === undefined || next.startsWith('--') ? true : (i++, next)
    // A repeated option (--root a --root b) becomes a list.
    options[key] = key in options ? [].concat(options[key], value) : value
  }
  return options
}

/** Run one of the existing script entry points with its own argv. */
async function delegate(file, args) {
  process.argv = [process.argv[0], file, ...args]
  await import(pathToFileURL(file).href)
}

const [command, ...rest] = process.argv.slice(2)
const options = parse(rest)

try {
  switch (command) {
    case 'runtime':
      console.log(`${currentRuntimeSource()} ${process.versions.node} ${process.execPath}`)
      break
    case 'install':
      process.exitCode = await (await import('../src/cli/install.js')).install(options)
      break
    case 'uninstall':
      process.exitCode = await (await import('../src/cli/uninstall.js')).uninstall(options)
      break
    case 'connect':
      process.exitCode = (await import('../src/cli/connect.js')).connect(options)
      break
    case 'profile':
      process.exitCode = (await import('../src/cli/access-profiles.js')).profileCommand(options)
      break
    case 'live-check':
      process.exitCode = await (await import('../src/cli/live-check.js')).liveCheck(options)
      break
    case 'doctor':
      await delegate(join(root, 'scripts', 'doctor.mjs'), rest)
      break
    case 'health':
      await delegate(join(root, 'scripts', 'health.mjs'), rest)
      break
    case 'access-report':
      await delegate(join(root, 'scripts', 'access-report.mjs'), rest)
      break
    case 'watch':
      await delegate(join(root, 'mcp', 'watch.mjs'), rest)
      break
    case 'mcp':
      await delegate(join(root, 'mcp', 'mcp.mjs'), rest)
      break
    case undefined: case 'help': case '--help': case '-h':
      console.log(HELP)
      break
    default:
      console.error(`unknown command "${command}"\n\n${HELP}`)
      process.exitCode = 2
  }
} catch (error) {
  console.error(`dsh-bridge ${command}: ${error.message}`)
  process.exitCode = 1
}
