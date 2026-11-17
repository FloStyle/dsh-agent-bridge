#!/usr/bin/env node
// Print the running bridge's /health so an update can be verified.
// Usage: node scripts/health.mjs
import { bridge } from '../mcp/lib.mjs'

const { url, token } = bridge()
const res = await fetch(`${url}/health`, { headers: { authorization: `Bearer ${token}` }, redirect: 'error' })
const body = await res.json().catch(() => ({}))
console.log(JSON.stringify(body, null, 2))
if (!res.ok) process.exitCode = 1
