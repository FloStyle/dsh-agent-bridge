// Find a JavaScript runtime for the CLI and the MCP client (R2.1).
//
// Order: DSH_NODE, then the Node that DeepSeek Harness ships, then the node
// running now (from PATH). DSH's own `dsh.cmd` starts its CLI the same way:
// `DeepSeek Harness.exe` with ELECTRON_RUN_AS_NODE=1 is a Node 24 runtime.
// Only the Windows install path is known; macOS and Linux use DSH_NODE or PATH.
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Known DeepSeek Harness executables, by platform. */
export function dshExecutables({ env = process.env, platform = process.platform } = {}) {
  if (platform === 'win32' && env.LOCALAPPDATA) {
    return [join(env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe')]
  }
  return []
}

/**
 * @returns {{source: 'env'|'dsh-electron'|'path', command: string, env: Record<string,string>}}
 */
export function findRuntime({ env = process.env, platform = process.platform, exists = existsSync, execPath = process.execPath } = {}) {
  if (env.DSH_NODE) return { source: 'env', command: env.DSH_NODE, env: {} }
  for (const exe of dshExecutables({ env, platform })) {
    if (exists(exe)) return { source: 'dsh-electron', command: exe, env: { ELECTRON_RUN_AS_NODE: '1' } }
  }
  return { source: 'path', command: execPath, env: {} }
}

/** Which runtime is executing this process, as set by the launchers. */
export function currentRuntimeSource(env = process.env) {
  if (env.DSH_BRIDGE_RUNTIME) return env.DSH_BRIDGE_RUNTIME
  return env.ELECTRON_RUN_AS_NODE === '1' ? 'dsh-electron' : 'path'
}
