#!/usr/bin/env node
/**
 * The E2E harness's R2 stand-in — an in-memory S3-compatible object store.
 *
 * The delivery legs are honest only if the bytes really travel: the PWA's
 * signature PNG goes browser → presigned PUT → object store, and the challan's
 * lazy render probes GET → renders → PUTs → redirects to a presigned GET. The
 * dev server is pointed here via R2_ENDPOINT (api/_lib/r2.ts), so every
 * presigned URL the app mints targets this process instead of Cloudflare.
 *
 * What it implements, and nothing more:
 *   - OPTIONS: the browser's cross-origin PUT preflight (real R2 answers this
 *     from the bucket's CORS config; the shim allows everything).
 *   - PUT /<bucket>/<key>: stores the body under the full path.
 *   - GET /<bucket>/<key>: 200 with the stored bytes, 404 when missing.
 *   - GET /health: readiness for up.mjs.
 * Signatures are ignored — the SigV4 algorithm itself is pinned by
 * api/_lib/r2.test.ts; the shim is a bucket, not a verifier.
 *
 * usage: node scripts/e2e/r2-shim.mjs [--port 8112]
 */
import { createServer } from 'node:http'

const args = process.argv.slice(2)
const i = args.indexOf('--port')
const port = Number(i >= 0 ? args[i + 1] : process.env.E2E_R2_PORT || '8112')

/** path → { bytes, type } — one journey's worth of objects, nothing durable. */
const objects = new Map()

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, PUT, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '600',
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  if (url.pathname === '/health') {
    res.writeHead(200).end('ok')
    return
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS).end()
    return
  }
  if (req.method === 'PUT') {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      objects.set(url.pathname, {
        bytes: Buffer.concat(chunks),
        type: String(req.headers['content-type'] ?? 'application/octet-stream'),
      })
      res.writeHead(200, { ...CORS, etag: `"e2e-${objects.size}"` }).end()
    })
    return
  }
  if (req.method === 'GET') {
    const hit = objects.get(url.pathname)
    if (hit) {
      res.writeHead(200, { ...CORS, 'content-type': hit.type, 'content-length': hit.bytes.length }).end(hit.bytes)
    } else {
      res.writeHead(404, { ...CORS, 'content-type': 'application/xml' }).end('<Error><Code>NoSuchKey</Code></Error>')
    }
    return
  }
  res.writeHead(405).end()
})

server.listen(port, '127.0.0.1', () => console.log(`[r2-shim] listening on http://127.0.0.1:${port} (${objects.size} objects)`))
