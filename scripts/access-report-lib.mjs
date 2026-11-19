// Grouping and suggestions for the access report. Pure functions, no I/O.

/** Tool caches that are better redirected than granted. */
const CACHES = [
  ['pip', /[\\/]pip[\\/]cache([\\/]|$)|[\\/]AppData[\\/]Local[\\/]pip([\\/]|$)/i],
  ['npm', /[\\/]npm-cache([\\/]|$)|[\\/]\.npm([\\/]|$)/i],
  ['pnpm', /[\\/]pnpm[\\/]store([\\/]|$)|[\\/]\.pnpm-store([\\/]|$)/i],
  ['nuget', /[\\/]\.nuget[\\/]packages([\\/]|$)|[\\/]NuGet[\\/](v3-cache|Cache)([\\/]|$)/i],
  ['unreal-ddc', /DerivedDataCache([\\/]|$)/i],
  ['cargo', /[\\/]\.cargo[\\/]registry([\\/]|$)/i],
  ['dotnet', /[\\/]\.dotnet([\\/]|$)/i],
]

const sep = (path) => (path.includes('\\') ? '\\' : '/')
const split = (path) => path.split(/[\\/]+/).filter((part, i) => part !== '' || i === 0)

/** The folder of a file path; a path that ends with a separator is a folder already. */
function folderOf(path) {
  const parts = split(path)
  return parts.length > 1 ? parts.slice(0, -1) : parts
}

function commonPrefix(a, b) {
  const out = []
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i].toLowerCase() !== b[i].toLowerCase()) break
    out.push(a[i])
  }
  return out
}

function cacheOf(path) {
  for (const [name, pattern] of CACHES) if (pattern.test(path)) return name
  return undefined
}

function suggestionFor(kind, folder, cache) {
  if (cache) return `cache folder: redirect the ${cache} cache inside the session cwd (see docs/access-guide.md)`
  if (folder === null) return 'path unknown: read the denied call in the transcript'
  if (kind === 'shell') return `shell write outside cwd under ${folder}: registered roots do not apply to shell commands on Windows; move this work inside the cwd (see docs/access-guide.md)`
  return `add root ${folder}`
}

/**
 * Group denials by kind and by the deepest common folder of paths that share
 * their first three path components (drive or root plus two folders).
 * @returns {Array<{kind:string,folder:string|null,count:number,tools:string[],modes:string[],cache?:string,examples:string[],suggestion:string}>}
 */
export function groupDenials(denials) {
  const buckets = new Map()
  for (const denial of denials) {
    const cache = denial.path ? cacheOf(denial.path) : undefined
    const parts = denial.path ? folderOf(denial.path) : null
    const head = parts ? parts.slice(0, 3).join('/').toLowerCase() : '(unknown)'
    const key = `${denial.kind}|${cache ?? ''}|${head}`
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { kind: denial.kind, cache, parts, separator: denial.path ? sep(denial.path) : '\\', count: 0, tools: new Set(), modes: new Set(), examples: [] }
      buckets.set(key, bucket)
    }
    bucket.count++
    bucket.tools.add(denial.tool)
    if (denial.mode) bucket.modes.add(denial.mode)
    if (parts) bucket.parts = bucket.parts ? commonPrefix(bucket.parts, parts) : parts
    if (denial.path && bucket.examples.length < 3 && !bucket.examples.includes(denial.path)) bucket.examples.push(denial.path)
  }
  const groups = [...buckets.values()].map((bucket) => {
    const folder = bucket.parts ? bucket.parts.join(bucket.separator) || bucket.separator : null
    const group = {
      kind: bucket.kind,
      folder,
      count: bucket.count,
      tools: [...bucket.tools].sort(),
      modes: [...bucket.modes].sort(),
      examples: bucket.examples,
      suggestion: suggestionFor(bucket.kind, folder, bucket.cache),
    }
    if (bucket.cache) group.cache = bucket.cache
    return group
  })
  return groups.sort((a, b) => b.count - a.count || String(a.folder).localeCompare(String(b.folder)))
}

/** Parse "7d", "12h" or "30m" into milliseconds; undefined when absent or invalid. */
export function parseSince(value) {
  const match = /^(\d+)\s*([dhm])$/i.exec(String(value ?? '').trim())
  if (!match) return undefined
  const unit = { d: 86400000, h: 3600000, m: 60000 }[match[2].toLowerCase()]
  return Number(match[1]) * unit
}
