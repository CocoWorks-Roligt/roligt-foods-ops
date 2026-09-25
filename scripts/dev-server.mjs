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
 *   npx tsx scripts/dev-server.mjs --seed-scratch              # see below, then exit
 *
 * .env is parsed into process.env before the api modules load, because the shared
 * ZohoClient captures ZOHO_BASE_ID at import time.
 *
 * `--seed-scratch` is setup for the e2e gate, not part of it: it performs exactly
 * the write a browser's first boot against an empty base performs (the client seeds
 * from its own masters and pushes the whole seed up — see AppContext's null-snapshot
 * path), then resets the app_revision row to 0 so the plant reads as "installed, no
 * postings yet". It refuses to touch anything but the scratch base. With the base
 * pre-seeded, a fresh browser boots read-only and the first commit a gate observes
 * is the posting under test, which is what the brief's revision arithmetic assumes.
 * Never run it against production.
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

const SCRATCH_BASE = 'dhorj90a2ded0152a4f1d94ae8ce4ece09a5c'

if (process.argv.includes('--seed-scratch')) {
  if (process.env.ZOHO_BASE_ID !== SCRATCH_BASE) {
    console.error('--seed-scratch refuses to run against anything but the scratch base.')
    process.exit(1)
  }
  const { migrateState } = await import('../src/lib/migrate.ts')
  const { diffState } = await import('../src/lib/sync.ts')
  const { seed } = await import('../src/data/seed.ts')
  const { commitChanges } = await import('../api/_lib/commit.ts')
  const { zoho } = await import('../api/_lib/shared.ts')
  const { T } = await import('../api/_lib/baseSchema.ts')

  const t0 = Date.now()
  const changes = diffState(null, migrateState(seed))
  const size = changes.tables.reduce((a, t) => a + t.upsert.length + t.remove.length, 0)
  console.log(`seed-scratch: ${size} rows + ${Object.keys(changes.counters).length} counters …`)
  const { devPermissions } = await import('../src/lib/permissions.ts')
  const rev = await commitChanges(zoho, { email: 'dev@roligt.local', permissions: devPermissions('Admin') }, changes)
  const config = T['Config']
  await zoho.upsertByKey(config.id, config.fields['Setting'], 'app_revision', {
    [config.fields['Setting']]: 'app_revision',
    [config.fields['Value']]: '0',
  })
  console.log(`seed-scratch: committed at revision ${rev}, reset app_revision to 0 (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
  process.exit(0)
}

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
      const handler = API_ROUTES[path] ?? null
      if (!handler) {
        res.writeHead(404).end('no such api route')
        log(404)
        return
      }
      const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : undefined
      if (path === '/api/commit' && body) {
        // Keep the exact commit payload on disk — the diff engine is client-side, so
        // this is the only place the wire truth of "what changed" exists.
        writeFileSync(join(root, 'tmp-commit-body.json'), JSON.stringify(body, null, 2))
      }
      await handler(
        { method: req.method, url: req.url, headers: req.headers, ...(body !== undefined ? { body } : {}) },
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
