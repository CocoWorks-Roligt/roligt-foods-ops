/**
 * Local harness for the BFF + built app — the `vercel dev` replacement.
 *
 * `vercel dev` refuses to run in an unlinked checkout (it demands an interactive
 * project link), so this serves what it would have served: the built SPA from
 * dist/ (with the SPA fallback vercel.json declares) and the three /api/* handlers
 * straight from their exported functions. The handlers are written as
 * `export default async function (req: VercelRequest, res: VercelResponse)`; node's
 * IncomingMessage/ServerResponse are adapted to just the surface those handlers
 * touch (method/url/headers/body, status().json()/setHeader()) — the same shape the
 * Task 9 throwaway runner pinned.
 *
 * Run it with tsx (devDependency) so the .ts imports resolve:
 *
 *   npm run build && npx tsx scripts/dev-server.mjs            # serve on :3000
 *
 * .env is parsed into process.env before the api modules load, because the shared
 * ZohoClient captures ZOHO_BASE_ID at import time.
 */
import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const port = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : process.env.PORT || 3000)

/** Minimal KEY=VALUE loader — a .env this small does not need a dependency. */
function loadDotEnv() {
  let lines
  try {
    lines = readFileSync(join(root, '.env'), 'utf8').split('\n')
  } catch {
    return // no .env — rely on the ambient environment
  }
  for (const line of lines) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
    if (!m) continue
    if (!(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
  }
}
loadDotEnv()

// Loaded only after .env is in process.env — the shared client snapshots ZOHO_BASE_ID
// at construction.
const snapshotHandler = (await import('../api/snapshot.ts')).default
const revisionHandler = (await import('../api/revision.ts')).default
const commitHandler = (await import('../api/commit.ts')).default
const authStart = (await import('../api/auth/start.ts')).default
const authCallback = (await import('../api/auth/callback.ts')).default
const authSignout = (await import('../api/auth/signout.ts')).default
const authSession = (await import('../api/auth/session.ts')).default
const adminUsers = (await import('../api/admin/users.ts')).default
const adminRoles = (await import('../api/admin/roles.ts')).default
const complianceDocuments = (await import('../api/compliance/documents.ts')).default
const complianceUpload = (await import('../api/compliance/upload.ts')).default
const complianceFile = (await import('../api/compliance/file.ts')).default
const complianceRemind = (await import('../api/compliance/remind.ts')).default
const attachmentsUpload = (await import('../api/attachments/upload.ts')).default
const attachmentsFile = (await import('../api/attachments/file.ts')).default
const gradingHandler = (await import('../api/grading.ts')).default
const purchaseOrdersHandler = (await import('../api/purchase-orders.ts')).default
const purchaseOrderItemHandler = (await import('../api/purchase-orders/[id].ts')).default
const purchaseOrderReceiveHandler = (await import('../api/purchase-orders/[id]/receive.ts')).default
const closeRunHandler = (await import('../api/transformations/close.ts')).default
const kpisModuleHandler = (await import('../api/kpis/[module].ts')).default
const searchHandler = (await import('../api/search.ts')).default
const genealogyHandler = (await import('../api/genealogy.ts')).default
const dispatchConfirmHandler = (await import('../api/dispatch/confirm.ts')).default
const shipmentsHandler = (await import('../api/shipments.ts')).default
const shipmentItemHandler = (await import('../api/shipments/[id].ts')).default
const shipmentEventsHandler = (await import('../api/shipments/[id]/events.ts')).default
const shipmentSubmitHandler = (await import('../api/shipments/[id]/submit.ts')).default
const challansHandler = (await import('../api/challans.ts')).default
const challanFileHandler = (await import('../api/challans/[id]/file.ts')).default
const challanCorrectHandler = (await import('../api/challans/[id]/correct.ts')).default
const returnsHandler = (await import('../api/returns.ts')).default
const returnDecisionHandler = (await import('../api/returns/[id]/decision.ts')).default
// /api/events is deliberately NOT wired here: its handler streams SSE, and the
// node adapter below only answers json()/end(). It 404s in this harness, which
// is the designed degraded path — the client's EventSource fails over to the
// /api/revision poll (B4), and the E2E journey exercises exactly that fallback.

const API_ROUTES = {
  '/api/snapshot': snapshotHandler,
  '/api/revision': revisionHandler,
  '/api/commit': commitHandler,
  '/api/auth/start': authStart,
  '/api/auth/callback': authCallback,
  '/api/auth/signout': authSignout,
  '/api/auth/session': authSession,
  '/api/admin/users': adminUsers,
  '/api/admin/roles': adminRoles,
  '/api/compliance/documents': complianceDocuments,
  '/api/compliance/upload': complianceUpload,
  '/api/compliance/file': complianceFile,
  '/api/compliance/remind': complianceRemind,
  '/api/attachments/upload': attachmentsUpload,
  '/api/attachments/file': attachmentsFile,
  '/api/grading': gradingHandler,
  '/api/purchase-orders': purchaseOrdersHandler,
  '/api/transformations/close': closeRunHandler,
  '/api/search': searchHandler,
  '/api/genealogy': genealogyHandler,
  '/api/dispatch/confirm': dispatchConfirmHandler,
  '/api/shipments': shipmentsHandler,
  '/api/challans': challansHandler,
  '/api/returns': returnsHandler,
}

/** Segment-pattern routes for the paths Vercel's file router parameterizes.
 * Each handler parses req.url itself, so matching only has to pick the file. */
const PARAM_API_ROUTES = [
  { pattern: '/api/purchase-orders/:id/receive', handler: purchaseOrderReceiveHandler },
  { pattern: '/api/purchase-orders/:id', handler: purchaseOrderItemHandler },
  { pattern: '/api/kpis/:module', handler: kpisModuleHandler },
  { pattern: '/api/shipments/:id/submit', handler: shipmentSubmitHandler },
  { pattern: '/api/shipments/:id/events', handler: shipmentEventsHandler },
  { pattern: '/api/shipments/:id', handler: shipmentItemHandler },
  { pattern: '/api/challans/:id/file', handler: challanFileHandler },
  { pattern: '/api/challans/:id/correct', handler: challanCorrectHandler },
  { pattern: '/api/returns/:id/decision', handler: returnDecisionHandler },
]

/** The first pattern that matches, with its params — handlers read `req.query`
 * (where Vercel's file router delivers path params), so the caller injects them. */
function matchParamRoute(path) {
  for (const route of PARAM_API_ROUTES) {
    const pattern = route.pattern.split('/')
    const actual = path.split('/')
    if (pattern.length !== actual.length) continue
    const params = {}
    // Param segments arrive DECODED, the way Vercel's file router delivers
    // them — a challan id is its DC number, and 'DC0017%2F2026' must reach
    // the handler as 'DC0017/2026'.
    if (
      pattern.every((seg, i) =>
        seg.startsWith(':') ? ((params[seg.slice(1)] = decodeURIComponent(actual[i])), true) : seg === actual[i],
      )
    ) {
      return { handler: route.handler, params }
    }
  }
  return null
}

const DIST = join(root, 'dist')
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
}

/** Node req/res → the slice of VercelRequest/VercelResponse the handlers use. */
function toVercelRes(res) {
  const fake = {
    statusCode: 200,
    setHeader(name, value) {
      res.setHeader(name, value)
      return fake
    },
    status(code) {
      fake.statusCode = code
      return fake
    },
    json(body) {
      // A failed commit is the one thing a gate must be able to see the insides of.
      if (fake.statusCode >= 400) console.error(`api error body: ${JSON.stringify(body)}`)
      res.writeHead(fake.statusCode, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    },
    end(body) {
      // The auth routes answer 302s: headers set through setHeader, then end().
      res.statusCode = fake.statusCode
      res.end(body)
      return fake
    },
  }
  return fake
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!chunks.length) return undefined
  const raw = Buffer.concat(chunks).toString('utf8')
  if ((req.headers['content-type'] || '').includes('application/json')) {
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }
  return raw
}

function serveStatic(res, path) {
  readFile(path)
    .then((bytes) => {
      res.writeHead(200, {
        'content-type': MIME[extname(path)] || 'application/octet-stream',
        'cache-control': 'no-store',
      })
      res.end(bytes)
    })
    .catch(() => {
      res.writeHead(500).end('dist read failed')
    })
}

const server = createServer(async (req, res) => {
  const path = (req.url || '/').split('?')[0]
  const began = Date.now()
  const log = (code) =>
    console.log(`${new Date().toISOString()} ${req.method} ${path} → ${code} (${((Date.now() - began) / 1000).toFixed(1)}s)`)

  try {
    if (path.startsWith('/api/')) {
      const exact = API_ROUTES[path]
      const paramHit = exact ? null : matchParamRoute(path)
      if (!exact && !paramHit) {
        res.writeHead(404).end('no such api route')
        log(404)
        return
      }
      const body =
        req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH'
          ? await readBody(req)
          : undefined
      if (path === '/api/commit' && body) {
        // Keep the exact commit payload on disk — the diff engine is client-side, so
        // this is the only place the wire truth of "what changed" exists.
        writeFileSync(join(root, 'tmp-commit-body.json'), JSON.stringify(body, null, 2))
      }
      // Vercel's req.query carries path params + search params; the param routes
      // read their segment from it, exact routes read search params at most.
      const query = Object.fromEntries(new URL(req.url || '/', 'http://localhost').searchParams)
      const params = paramHit ? { ...query, ...paramHit.params } : query
      const handler = exact ?? paramHit.handler
      await handler(
        {
          method: req.method, url: req.url, headers: req.headers,
          query: params, ...(body !== undefined ? { body } : {}),
        },
        toVercelRes(res),
      )
      log(res.statusCode)
      return
    }

    // Everything else is the SPA: a real file under dist/, else index.html.
    const clean = normalize(path).replace(/^([/\\]|\.\.)+/, '')
    const candidate = join(DIST, clean)
    const exists = candidate.startsWith(DIST) && await stat(candidate).then((s) => s.isFile()).catch(() => false)
    serveStatic(res, exists ? candidate : join(DIST, 'index.html'))
  } catch (e) {
    console.error(`${req.method} ${path} crashed:`, e)
    if (!res.headersSent) res.writeHead(500).end('handler crashed')
  }
})

server.listen(port, () => console.log(`dev harness on http://localhost:${port} — dist/ + /api/{snapshot,revision,commit} + /api/auth/{start,callback,signout,session}`))
