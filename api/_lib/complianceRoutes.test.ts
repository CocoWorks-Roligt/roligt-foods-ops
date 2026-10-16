import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VercelRequest, VercelResponse } from '@vercel/node'

/**
 * The /api/compliance routes at the handler level — the same harness shape as
 * routes.test.ts (session/auth mocked, statuses asserted), with the compliance
 * STORE mocked at its seam (a fake ComplianceStore behind engine.complianceStore):
 * what these tests pin is the route contract, not the storage (d1Engine.test.ts
 * owns the store arm). The cron's send-then-mark ordering lives here because it
 * is the route's own guarantee: a refused email must leave its document
 * unmarked so tomorrow's run retries it.
 */
const world = vi.hoisted(() => ({
  authError: null as string | null,
  caller: { email: 'lead@roligt.local', permissions: ['page.compliance'] },
  /** The register as seeded: {doc, version} rows the fake store serves. */
  docs: [] as { doc: Record<string, unknown>; version: string }[],
  saves: [] as { doc: Record<string, unknown>; observed: string | null; version: string }[],
  removes: [] as { id: string; handle: string }[],
  marks: [] as { doc: Record<string, unknown>; observed: string }[],
  /** When set, the fake store's save loses the write race — {saved:false}. */
  saveLoses: false,
  /** When set, the fake store's markSent loses to a human edit — false. */
  markLoses: false,
  leadDays: 30,
  audits: [] as unknown[][],
  emails: [] as unknown[],
  sendError: null as unknown,
  r2Ready: true,
  putUrl: 'https://acct.r2.cloudflarestorage.com/bkt/signed-put?X-Amz-Signature=put',
  getUrl: 'https://acct.r2.cloudflarestorage.com/bkt/signed-get?X-Amz-Signature=get',
}))

vi.mock('./auth.ts', () => ({
  authenticate: vi.fn(async () => {
    if (world.authError) throw new (class AuthError extends Error {})(world.authError)
    return { caller: world.caller, setCookies: [] }
  }),
  AuthError: class AuthError extends Error {},
}))

vi.mock('./engine.ts', async () => {
  const actual = await vi.importActual<typeof import('./engine.ts')>('./engine.ts')
  const { planFromToken } = await vi.importActual<typeof import('./complianceStore.ts')>('./complianceStore.ts')
  const { sortComplianceRows } = await vi.importActual<typeof import('./compliance.ts')>('./compliance.ts')
  /** The register's fake — one Map over world.docs, the seam's own grammar. */
  const rows = () => world.docs.map((r) => ({ doc: r.doc as never, version: r.version }))
  const fakeStore = {
    list: async () => sortComplianceRows(rows()),
    fetch: async (id: string) => {
      const found = world.docs.find((r) => r.doc.id === id)
      return found ? { doc: found.doc as never, version: found.version, handle: id } : null
    },
    save: async (doc: Record<string, unknown>, observed: string | null) => {
      if (world.saveLoses) return { saved: false as const }
      const plan = planFromToken(String(doc.id), observed ?? '')
      world.saves.push({ doc, observed, version: plan.next })
      const next = world.docs.filter((r) => r.doc.id !== doc.id)
      next.push({ doc, version: plan.next })
      world.docs = next
      return { saved: true as const, version: plan.next }
    },
    remove: async (id: string, handle: string) => {
      world.removes.push({ id, handle })
      world.docs = world.docs.filter((r) => r.doc.id !== id)
    },
    markSent: async (doc: Record<string, unknown>, observed: string) => {
      world.marks.push({ doc, observed })
      if (world.markLoses) return false
      const row = world.docs.find((r) => r.doc.id === doc.id)
      if (row) row.doc = doc
      return true
    },
    leadDays: async () => world.leadDays,
  }
  return {
    ...actual,
    complianceStore: () => fakeStore,
    writeAdminAudit: vi.fn(async (_s: unknown, caller: unknown, action: string, docTitle: string, details: string) => {
      world.audits.push([caller, action, docTitle, details])
    }),
  }
})

vi.mock('./mailer.ts', () => ({
  sendMail: vi.fn(async (mail: unknown) => {
    if (world.sendError) throw world.sendError
    world.emails.push(mail)
  }),
}))

vi.mock('./r2.ts', () => ({
  r2Configured: () => world.r2Ready,
  presignR2Put: vi.fn(() => world.putUrl),
  presignR2Get: vi.fn(() => world.getUrl),
}))

const documents = (await import('../compliance/documents.ts')).default
const upload = (await import('../compliance/upload.ts')).default
const file = (await import('../compliance/file.ts')).default
const remind = (await import('../compliance/remind.ts')).default
const { __resetCommitThrottle } = await import('./commitThrottle.js')

beforeEach(() => {
  __resetCommitThrottle()
  process.env.CRON_SECRET = 'sekrit'
  world.authError = null
  world.caller = { email: 'lead@roligt.local', permissions: ['page.compliance'] }
  world.docs = []
  world.saves = []
  world.removes = []
  world.marks = []
  world.saveLoses = false
  world.markLoses = false
  world.leadDays = 30
  world.audits = []
  world.emails = []
  world.sendError = null
  world.r2Ready = true
})

function fakeRes() {
  const res = {
    headers: {} as Record<string, unknown>,
    statusCode: 200,
    setHeader: vi.fn((name: string, value: unknown) => {
      res.headers[name] = value
      return res
    }),
    status: vi.fn((code: number) => {
      res.statusCode = code
      return res
    }),
    json: vi.fn(),
    end: vi.fn(),
  }
  return res as unknown as VercelResponse & typeof res
}

function fakeReq(
  url: string,
  headers: Record<string, string> = {},
  method = 'GET',
  body?: unknown,
  query?: Record<string, unknown>,
): VercelRequest {
  return { headers, url, method, body, query } as unknown as VercelRequest
}

const JSON_HEADERS = { 'content-type': 'application/json' }

const FRESH_DOC = {
  id: 'CMP-NEW-1',
  title: 'FSSAI licence',
  docType: 'license',
  authority: 'FSSAI',
  identifier: '12345',
  issuedOn: '2026-04-01',
  expiresOn: '2027-03-31',
  remindEmails: ['owner@example.in'],
}

describe('POST/GET /api/compliance/documents', () => {
  it('refuses a caller without the page', async () => {
    world.caller = { email: 'op@roligt.local', permissions: [] }
    const res = fakeRes()
    await documents(fakeReq('/api/compliance/documents'), res)
    expect(res.status).toHaveBeenCalledWith(403)
  })

  it('refuses a non-JSON POST before anything is spent', async () => {
    const res = fakeRes()
    await documents(fakeReq('/api/compliance/documents', { 'content-type': 'text/plain' }, 'POST', 'x'), res)
    expect(res.status).toHaveBeenCalledWith(415)
    expect(world.saves.length).toBe(0)
  })

  it('lists the register, soonest expiry first, with each row\'s version', async () => {
    world.docs = [
      { doc: { ...FRESH_DOC, id: 'CMP-B', title: 'B', expiresOn: '2027-06-01' }, version: 'CMP-B:1' },
      { doc: { ...FRESH_DOC, id: 'CMP-A', title: 'A', expiresOn: '2027-01-01' }, version: 'CMP-A:2' },
    ]
    const res = fakeRes()
    await documents(fakeReq('/api/compliance/documents'), res)
    expect(res.status).toHaveBeenCalledWith(200)
    const body = res.json.mock.calls[0][0] as { docs: { doc: { id: string }; version: string }[] }
    expect(body.docs.map((r) => r.doc.id)).toEqual(['CMP-A', 'CMP-B'])
    expect(body.docs[0].version).toBe('CMP-A:2')
  })

  it('saves a new document: versioned write, stamped by the caller, audited', async () => {
    const res = fakeRes()
    await documents(fakeReq('/api/compliance/documents', JSON_HEADERS, 'POST', { action: 'save', doc: FRESH_DOC }), res)
    expect(res.statusCode).toBe(200)
    expect(world.saves.length).toBe(1)
    expect(world.saves[0].doc.id).toBe('CMP-NEW-1')
    expect(world.saves[0].doc.updatedBy).toBe('lead@roligt.local')
    expect(world.saves[0].doc.reminderSentFor).toBeUndefined() // never taken from the wire
    expect((res.json.mock.calls[0][0] as { version: string }).version).toBe('CMP-NEW-1:1')
    expect(world.audits.length).toBe(1)
    expect(world.audits[0][1]).toBe('compliance document saved')
  })

  it('stamps the next token and hands the store the one it observed', async () => {
    world.docs = [{ doc: { ...FRESH_DOC, title: 'Old title' }, version: 'CMP-NEW-1:3' }]
    const res = fakeRes()
    await documents(
      fakeReq('/api/compliance/documents', JSON_HEADERS, 'POST', { action: 'save', doc: FRESH_DOC, baseVersion: 'CMP-NEW-1:3' }),
      res,
    )
    expect(res.statusCode).toBe(200)
    expect(world.saves[0].observed).toBe('CMP-NEW-1:3')
    expect(world.saves[0].version).toBe('CMP-NEW-1:4')
  })

  it('refuses a stale baseVersion with the commit 409 shape', async () => {
    world.docs = [{ doc: { ...FRESH_DOC }, version: 'CMP-NEW-1:3' }]
    const res = fakeRes()
    await documents(
      fakeReq('/api/compliance/documents', JSON_HEADERS, 'POST', { action: 'save', doc: FRESH_DOC, baseVersion: 'CMP-NEW-1:2' }),
      res,
    )
    expect(res.status).toHaveBeenCalledWith(409)
    expect((res.json.mock.calls[0][0] as { conflicts: unknown[] }).conflicts).toEqual([{ id: 'CMP-NEW-1', kind: 'changed' }])
    expect(world.saves.length).toBe(0)
  })

  it('maps a save that loses the write race to the same 409', async () => {
    world.docs = [{ doc: { ...FRESH_DOC, title: 'Old title' }, version: 'CMP-NEW-1:3' }]
    world.saveLoses = true
    const res = fakeRes()
    await documents(
      fakeReq('/api/compliance/documents', JSON_HEADERS, 'POST', { action: 'save', doc: FRESH_DOC, baseVersion: 'CMP-NEW-1:3' }),
      res,
    )
    expect(res.status).toHaveBeenCalledWith(409)
    expect(world.audits.length).toBe(0)
  })

  it('treats a retried identical save as a no-op — no write, no audit', async () => {
    world.docs = [
      { doc: { ...FRESH_DOC, updatedAt: '2026-10-07T10:00:00Z', updatedBy: 'lead@roligt.local' }, version: 'CMP-NEW-1:1' },
    ]
    const res = fakeRes()
    await documents(fakeReq('/api/compliance/documents', JSON_HEADERS, 'POST', { action: 'save', doc: FRESH_DOC }), res)
    expect(res.statusCode).toBe(200)
    expect(world.saves.length).toBe(0)
    expect(world.audits.length).toBe(0)
    expect((res.json.mock.calls[0][0] as { version: string }).version).toBe('CMP-NEW-1:1')
  })

  it('removes a stored document and audits what left', async () => {
    world.docs = [{ doc: { ...FRESH_DOC }, version: 'CMP-NEW-1:1' }]
    const res = fakeRes()
    await documents(fakeReq('/api/compliance/documents', JSON_HEADERS, 'POST', { action: 'remove', id: 'CMP-NEW-1' }), res)
    expect(res.statusCode).toBe(200)
    expect(world.removes.length).toBe(1)
    expect(world.audits[0][1]).toBe('compliance document removed')
  })

  it('treats removing an already-gone document as the asked-for outcome', async () => {
    const res = fakeRes()
    await documents(fakeReq('/api/compliance/documents', JSON_HEADERS, 'POST', { action: 'remove', id: 'CMP-NEW-1' }), res)
    expect(res.statusCode).toBe(200)
    expect(world.removes.length).toBe(0)
    expect(world.audits.length).toBe(0)
  })
})

describe('/api/compliance/upload', () => {
  const FILE = { fileName: 'fssai licence.pdf', contentType: 'application/pdf', sizeInBytes: 2_000_000 }

  it('refuses a caller without the page', async () => {
    world.caller = { email: 'op@roligt.local', permissions: [] }
    const res = fakeRes()
    await upload(fakeReq('/api/compliance/upload', JSON_HEADERS, 'POST', FILE), res)
    expect(res.status).toHaveBeenCalledWith(403)
  })

  it('answers 503 when the R2 store is not configured', async () => {
    world.r2Ready = false
    const res = fakeRes()
    await upload(fakeReq('/api/compliance/upload', JSON_HEADERS, 'POST', FILE), res)
    expect(res.status).toHaveBeenCalledWith(503)
  })

  it('refuses disallowed content types and sizes at the gate', async () => {
    for (const bad of [
      { ...FILE, contentType: 'application/zip' },
      { ...FILE, contentType: 'application/pdf', sizeInBytes: 13 * 1024 * 1024 },
      { ...FILE, contentType: 'application/pdf', sizeInBytes: 0 },
      { ...FILE, fileName: '' },
    ]) {
      const res = fakeRes()
      await upload(fakeReq('/api/compliance/upload', JSON_HEADERS, 'POST', bad), res)
      expect(res.status).toHaveBeenCalledWith(400)
    }
  })

  it('mints a presigned PUT for a key the route chose, content type signed in', async () => {
    const res = fakeRes()
    await upload(fakeReq('/api/compliance/upload', JSON_HEADERS, 'POST', FILE), res)
    expect(res.status).toHaveBeenCalledWith(200)
    const body = res.json.mock.calls[0][0] as { path: string; url: string; method: string; headers: Record<string, string> }
    expect(body.path).toMatch(/^compliance\/[a-z0-9]+-fssai_licence\.pdf$/)
    expect(body.url).toBe(world.putUrl)
    expect(body.method).toBe('PUT')
    expect(body.headers['content-type']).toBe('application/pdf')
  })
})

describe('/api/compliance/file', () => {
  it('refuses a caller without the page', async () => {
    world.caller = { email: 'op@roligt.local', permissions: [] }
    const res = fakeRes()
    await file(fakeReq('/api/compliance/file?path=compliance%2Fx.pdf'), res)
    expect(res.status).toHaveBeenCalledWith(403)
  })

  it('refuses paths outside the compliance prefix, however they are spelled', async () => {
    for (const path of ['qc/x.pdf', 'compliance/../x.pdf', '/compliance/x.pdf', '']) {
      const res = fakeRes()
      await file(fakeReq('/api/compliance/file', {}, 'GET', undefined, { path }), res)
      expect(res.status).toHaveBeenCalledWith(400)
    }
  })

  it('answers 503 when the R2 store is not configured', async () => {
    world.r2Ready = false
    const res = fakeRes()
    await file(fakeReq('/api/compliance/file', {}, 'GET', undefined, { path: 'compliance/x.pdf' }), res)
    expect(res.status).toHaveBeenCalledWith(503)
  })

  it('302s to a short-lived presigned GET for a permitted caller', async () => {
    const res = fakeRes()
    await file(fakeReq('/api/compliance/file', {}, 'GET', undefined, { path: 'compliance/x.pdf' }), res)
    expect(res.status).toHaveBeenCalledWith(302)
    expect(res.headers['Location']).toBe(world.getUrl)
    expect(res.headers['Cache-Control']).toBe('private, no-cache')
    expect(res.end).toHaveBeenCalled()
  })
})

describe('/api/compliance/remind (the cron)', () => {
  const DUE_SOON = { ...FRESH_DOC, id: 'CMP-DUE', expiresOn: '2026-10-20' } // 13 days out, inside a 30-day window
  const ALREADY_SENT = { ...FRESH_DOC, id: 'CMP-SENT', expiresOn: '2026-10-20', reminderSentFor: '2026-10-20', reminderSentAt: '2026-10-01T00:00:00Z' }
  const FAR_OUT = { ...FRESH_DOC, id: 'CMP-FAR', expiresOn: '2028-01-01' }

  const withDocs = (...docs: Record<string, unknown>[]) => {
    world.docs = docs.map((d, i) => ({ doc: d, version: `${String(d.id)}:1-${i}` }))
  }

  it('refuses to run open when CRON_SECRET is unset', async () => {
    delete process.env.CRON_SECRET
    const res = fakeRes()
    await remind(fakeReq('/api/compliance/remind'), res)
    expect(res.status).toHaveBeenCalledWith(500)
  })

  it('refuses a wrong bearer', async () => {
    const res = fakeRes()
    await remind(fakeReq('/api/compliance/remind', { authorization: 'Bearer nope' }), res)
    expect(res.status).toHaveBeenCalledWith(401)
  })

  it('sends one email per due document and marks it only after the send', async () => {
    withDocs(DUE_SOON, ALREADY_SENT, FAR_OUT)
    const res = fakeRes()
    await remind(fakeReq('/api/compliance/remind', { authorization: 'Bearer sekrit' }), res)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json.mock.calls[0][0]).toEqual({ ok: true, due: 1, sent: 1, failed: 0 })
    expect(world.emails.length).toBe(1)
    expect((world.emails[0] as { to: string[] }).to).toEqual(['owner@example.in'])
    expect(world.marks.length).toBe(1)
    expect(world.marks[0].doc.id).toBe('CMP-DUE')
    expect(world.marks[0].doc.reminderSentFor).toBe('2026-10-20')
    expect(world.audits.length).toBe(1)
    expect(world.audits[0][1]).toBe('compliance reminders sent')
  })

  it('leaves a refused send unmarked so the next run retries it', async () => {
    withDocs(DUE_SOON)
    world.sendError = new Error('Resend refused the email (HTTP 429)')
    const res = fakeRes()
    await remind(fakeReq('/api/compliance/remind', { authorization: 'Bearer sekrit' }), res)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json.mock.calls[0][0]).toEqual({ ok: true, due: 1, sent: 0, failed: 1 })
    expect(world.marks.length).toBe(0)
    expect(world.audits.length).toBe(0)
  })

  it('swallows a mark that loses to a human edit — the edit wins, the count stays honest', async () => {
    withDocs(DUE_SOON)
    world.markLoses = true
    const res = fakeRes()
    await remind(fakeReq('/api/compliance/remind', { authorization: 'Bearer sekrit' }), res)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json.mock.calls[0][0]).toEqual({ ok: true, due: 1, sent: 1, failed: 0 })
  })

  it('writes nothing at all on a quiet day', async () => {
    withDocs(ALREADY_SENT, FAR_OUT)
    const res = fakeRes()
    await remind(fakeReq('/api/compliance/remind', { authorization: 'Bearer sekrit' }), res)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json.mock.calls[0][0]).toEqual({ ok: true, due: 0, sent: 0, failed: 0 })
    expect(world.marks.length).toBe(0)
    expect(world.audits.length).toBe(0)
  })

  it('honors the configured lead window, not just the default', async () => {
    const atTwentyDays = { ...FRESH_DOC, id: 'CMP-20', expiresOn: '2026-10-27' }
    world.docs = [{ doc: atTwentyDays, version: 'CMP-20:1' }]
    world.leadDays = 7
    const res = fakeRes()
    await remind(fakeReq('/api/compliance/remind', { authorization: 'Bearer sekrit' }), res)
    expect(res.json.mock.calls[0][0]).toEqual({ ok: true, due: 0, sent: 0, failed: 0 })
  })
})
