// The bearer token: where it is stored, how it is loaded, how it is checked,
// and the state file that tells clients where the bridge listens.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

function loadToken(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')).token } catch { return undefined }
}

/** The token lives in a private sibling file of the state file (X2). */
export function tokenPathOf(stateFile) {
  return join(dirname(stateFile), 'agent-bridge.token')
}

function loadTokenFile(file) {
  try {
    const token = readFileSync(file, 'utf8').trim()
    return token.length >= 32 ? token : undefined
  } catch { return undefined }
}

/**
 * Order: configured token, the token file, then a 0.6.1 state file that still
 * carries the token (adopted, not rotated, so existing clients survive).
 * A missing or weak token is replaced by a new random one.
 */
export function resolveToken(configToken, stateFile) {
  const saved = configToken ?? loadTokenFile(tokenPathOf(stateFile)) ?? loadToken(stateFile)
  return typeof saved === 'string' && saved.length >= 32 ? saved : randomBytes(24).toString('hex')
}

/** A checker for "Authorization: Bearer <token>" that does not leak the matched prefix length. */
export function makeAuthorized(token) {
  const tokenBytes = Buffer.from(token, 'utf8')
  return (header) => {
    const prefix = 'Bearer '
    if (typeof header !== 'string' || !header.startsWith(prefix)) return false
    const given = Buffer.from(header.slice(prefix.length), 'utf8')
    return given.length === tokenBytes.length && timingSafeEqual(given, tokenBytes)
  }
}

function writePrivate(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text, { mode: 0o600 })
  if (process.platform !== 'win32') chmodSync(file, 0o600)
}

/**
 * After a successful listen: the token file, then the state file.
 * F2: 0.6.1 MCP clients read `token` from the state file, and a running client
 * keeps its old code after an upgrade. Keep a deprecated copy for 0.6.x;
 * protocol 2 (0.7.0) removes it. A stale marker never carries it.
 */
export function writeListening(stateFile, { port, token, protocol, version, bootId, startedAt }) {
  writePrivate(tokenPathOf(stateFile), `${token}\n`)
  writePrivate(stateFile, JSON.stringify({ url: `http://127.0.0.1:${port}`, token, tokenDeprecated: true, protocol, version, bootId, startedAt, pid: process.pid }, null, 2))
}

/** After a failed listen: a stale marker without the token. */
export function writeStale(stateFile, { port, error, protocol, version, bootId }) {
  writePrivate(stateFile, JSON.stringify({
    stale: true,
    error: `cannot listen on 127.0.0.1:${port}: ${error?.code ?? error?.message ?? 'listen failed'}`,
    protocol, version, bootId,
  }, null, 2))
}

/**
 * F1: when the state file belongs to another bridge instance that is still
 * alive on this port, that bridge owns the port: its file must be left alone.
 * Another instance means a different boot, in a process that still runs.
 */
export function healthyOwner(stateFile, { port, bootId }) {
  let current
  try { current = JSON.parse(readFileSync(stateFile, 'utf8')) } catch { return undefined }
  if (!current || current.stale || typeof current.url !== 'string') return undefined
  let currentPort
  try { currentPort = Number(new URL(current.url).port) } catch { return undefined }
  if (currentPort !== port || current.bootId === bootId || !Number.isInteger(current.pid)) return undefined
  try { process.kill(current.pid, 0) } catch (error) { if (error?.code !== 'EPERM') return undefined }
  return current
}
