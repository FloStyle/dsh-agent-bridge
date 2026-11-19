// The one place that names the bridge version and wire protocol (R2.5).
import { createRequire } from 'node:module'

const pkg = createRequire(import.meta.url)('../package.json')

export const PACKAGE = pkg.name
export const VERSION = pkg.version
/** Wire contract for HTTP and SSE. Bump only for a breaking change. */
export const PROTOCOL = 1
export const REPO_SLUG = 'FloStyle/dsh-agent-bridge'
