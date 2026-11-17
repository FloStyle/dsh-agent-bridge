#!/usr/bin/env node
// Print the running bridge's /health so an update can be verified.
// Usage: node scripts/health.mjs
import { bridge } from '../mcp/lib.mjs'

let target
try {
  target = bridge()
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
const { url, token } = target
let res, body
try {
  res = await fetch(`${url}/health`, { headers: { authorization: `Bearer ${token}` }, redirect: 'error' })
  body = await res.json().catch(() => ({}))
} catch (error) {
  console.error(`bridge not reachable at ${url}: ${error.cause?.code ?? error.message}`)
  console.error('Start DeepSeek Harness, or restart it after installing the plugin.')
  process.exit(1)
}
console.log(JSON.stringify(body, null, 2))
if (!res.ok) {
  console.error(`bridge answered ${res.status}`)
  process.exit(1)
}
