// Small HTTP helpers for the control API.

export function send(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** Read a JSON object body of at most 64 KiB. */
export function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => { size += c.length; if (size > 65536) { reject(Object.assign(new Error('Request too large'), { status: 413 })); return } chunks.push(c) })
    req.on('end', () => {
      if (size > 65536) return
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error()
        resolve(body)
      } catch { reject(Object.assign(new Error('Expected a JSON object'), { status: 400 })) }
    })
    req.on('error', reject)
  })
}
