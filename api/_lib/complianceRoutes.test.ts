import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VercelRequest, VercelResponse } from '@vercel/node'

/**
 * The /api/compliance routes at the handler level — the same harness shape as
 * routes.test.ts (session/auth mocked, statuses asserted), with the Zoho
 * client mocked wholesale: what these tests pin is the route contract, not the
 * transport (handlers.test.ts owns that). The cron's send-then-mark ordering
 * lives here because it is the route's own guarantee: a refused email must
 * leave its document unmarked so tomorrow's run retries it.
 */
const world = vi.hoisted(() => ({
  authError: null as string | null,
  caller: { email: 'lead@roligt.local', permissions: ['page.compliance'] },
  fetchAllImpl: null as null | ((tableId: string) => unknown[]),
  byKey: null as null | ((ids: string[]) => unknown[]),
  upserts: [] as unknown[][],
  upsertError: null as unknown,
  deletes: [] as unknown[],
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

vi.mock('./shared.ts', () => ({
  zoho: {
    baseId: 'dhorj90a2ded0152a4f1d94ae8ce4ece09a5c',
    fetchAll: vi.fn(async (tableId: string) => (world.fetchAllImpl ? world.fetchAllImpl(tableId) : [])),
    fetchByKeyIn: vi.fn(async (_t: string, _k: string, ids: string[]) => (world.byKey ? world.byKey(ids) : [])),
    upsertByKey: vi.fn(async (...args: unknown[]) => {
      if (world.upsertError) throw world.upsertError
      world.upserts.push(args)
    }),
    deleteRecord: vi.fn(async (...args: unknown[]) => {
      world.deletes.push(args)
      return undefined
    }),
  },
}))

vi.mock('./adminAudit.ts', () => ({
  writeAdminAudit: vi.fn(async (_z: unknown, caller: unknown, action: string, docTitle: string, details: string) => {
    world.audits.push([caller, action, docTitle, details])
  }),
}))

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
const { T } = await import('./baseSchema.js')
const { ZohoCasConflictError } = await import('./zoho.js')
const CT = T['Compliance Documents']

beforeEach(() => {
  __resetCommitThrottle()
  process.env.CRON_SECRET = 'sekrit'
  world.authError = null
  world.caller = { email: 'lead@roligt.local', permissions: ['page.compliance'] }
  world.fetchAllImpl = null
  world.byKey = null
  world.upserts = []
  world.upsertError = null
  world.deletes = []
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

function docRow(d: Record<string, unknown>, version: string) {
  return {
    recordID: `rec-${String(d.id)}`,
    data: { [CT.appId]: d.id, [CT.dataJson!]: JSON.stringify(d), [CT.fields['Version']]: version },
  }
}

function configRows(appConfig: string) {
  const cfg = T['Config']
  return [{ recordID: 'rec-cfg', data: { [cfg.fields['Setting']]: 'app_config', [cfg.fields['Value']]: appConfig } }]
}

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
    expect(world.upserts.length).toBe(0)
  })

  it('lists the register, soonest expiry first, with each row\'s version', async () => {
    world.fetchAllImpl = () => [
      docRow({ ...FRESH_DOC, id: 'CMP-B', title: 'B', expiresOn: '2027-06-01' }, 'CMP-B:1'),
      docRow({ ...FRESH_DOC, id: 'CMP-A', title: 'A', expiresOn: '2027-01-01' }, 'CMP-A:2'),
    ]
    const res = fakeRes()
    await documents(fakeReq('/api/compliance/documents'), res)
    expect(res.status).toHaveBeenCalledWith(200)
    const body = res.json.mock.calls[0][0] as { docs: { doc: { id: string }; version: string }[] }
    expect(body.docs.map((r) => r.doc.id)).toEqual(['CMP-A', 'CMP-B'])
    expect(body.docs[0].version).toBe('CMP-A:2')
  })

  it('saves a new document: versioned write, stamped by the caller, audited', async () => {
    world.byKey = () => []
    const res = fakeRes()
    await documents(fakeReq('/api/compliance/documents', JSON_HEADERS, 'POST', { action: 'save', doc: FRESH_DOC }), res)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(world.upserts.length).toBe(1)
    const [tableId, , keyValue, values] = world.upserts[0] as [string, string, string, Record<string, unknown>]
    expect(tableId).toBe(CT.id)
    expect(keyValue).toBe('CMP-NEW-1')
    expect(values[CT.appId]).toBe('CMP-NEW-1')
    const stored = JSON.parse(String(values[CT.dataJson!])) as Record<string, unknown>
    expect(stored.updatedBy).toBe('lead@roligt.local')
    expect(stored.reminderSentFor).toBeUndefined() // never taken from the wire
    expect(values[CT.fields['Title']]).toBe('FSSAI licence')
    expect(values[CT.fields['Version']]).toBe('CMP-NEW-1:1')
    expect(world.audits.length).toBe(1)
    expect(world.audits[0][1]).toBe('compliance document saved')
  })

  it('stamps the next token and conditions an edit on the stored one', async () => {
    world.byKey = () => [docRow({ ...FRESH_DOC, title: 'Old title' }, 'CMP-NEW-1:3')]
    const res = fakeRes()
    await documents(
      fakeReq('/api/compliance/documents', JSON_HEADERS, 'POST', { action: 'save', doc: FRESH_DOC, baseVersion: 'CMP-NEW-1:3' }),
      res,
    )
    expect(res.status).toHaveBeenCalledWith(200)
    const [, , , values, cas] = world.upserts[0] as [string, string, string, Record<string, unknown>, { expected: string }]
    expect(values[CT.fields['Version']]).toBe('CMP-NEW-1:4')
    expect(cas.expected).toBe('CMP-NEW-1:3')
  })

  it('refuses a stale baseVersion with the commit 409 shape', async () => {
    world.byKey = () => [docRow(FRESH_DOC, 'CMP-NEW-1:3')]
    const res = fakeRes()
    await documents(
      fakeReq('/api/compliance/documents', JSON_HEADERS, 'POST', { action: 'save', doc: FRESH_DOC, baseVersion: 'CMP-NEW-1:2' }),
      res,
    )
    expect(res.status).toHaveBeenCalledWith(409)
    expect((res.json.mock.calls[0][0] as { conflicts: unknown[] }).conflicts).toEqual([{ id: 'CMP-NEW-1', kind: 'changed' }])
    expect(world.upserts.length).toBe(0)
  })

  it('maps a CAS race on the write itself to the same 409', async () => {
    world.byKey = () => [docRow({ ...FRESH_DOC, title: 'Old title' }, 'CMP-NEW-1:3')]
    world.upsertError = new ZohoCasConflictError('CMP-NEW-1')
    const res = fakeRes()
    await documents(
      fakeReq('/api/compliance/documents', JSON_HEADERS, 'POST', { action: 'save', doc: FRESH_DOC, baseVersion: 'CMP-NEW-1:3' }),
      res,
    )
    expect(res.status).toHaveBeenCalledWith(409)
    expect(world.audits.length).toBe(0)
  })

  it('treats a retried identical save as a no-op — no write, no audit', async () => {
    world.byKey = () => [docRow({ ...FRESH_DOC, updatedAt: '2026-10-07T10:00:00Z', updatedBy: 'lead@roligt.local' }, 'CMP-NEW-1:1')]
    const res = fakeRes()
    await documents(fakeReq('/api/compliance/documents', JSON_HEADERS, 'POST', { action: 'save', doc: FRESH_DOC }), res)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(world.upserts.length).toBe(0)
    expect(world.audits.length).toBe(0)
    expect((res.json.mock.calls[0][0] as { version: string }).version).toBe('CMP-NEW-1:1')
  })

  it('removes a stored document and audits what left', async () => {
    world.byKey = () => [docRow(FRESH_DOC, 'CMP-NEW-1:1')]
    const res = fakeRes()
    await documents(fakeReq('/api/compliance/documents', JSON_HEADERS, 'POST', { action: 'remove', id: 'CMP-NEW-1' }), res)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(world.deletes.length).toBe(1)
    expect(world.audits[0][1]).toBe('compliance document removed')
  })

  it('treats removing an already-gone document as the asked-for outcome', async () => {
    world.byKey = () => []
    const res = fakeRes()
    await documents(fakeReq('/api/compliance/documents', JSON_HEADERS, 'POST', { action: 'remove', id: 'CMP-NEW-1' }), res)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(world.deletes.length).toBe(0)
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
    world.fetchAllImpl = (tableId: string) =>
      tableId === T['Config'].id ? configRows(JSON.stringify({ complianceLeadDays: 30 })) : docs.map((d, i) => docRow(d, `${String(d.id)}:1-${i}`))
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
    expect(world.upserts.length).toBe(1)
    const [, , keyValue, values] = world.upserts[0] as [string, string, string, Record<string, unknown>]
    expect(keyValue).toBe('CMP-DUE')
    const marked = JSON.parse(String(values[CT.dataJson!])) as { reminderSentFor?: string }
    expect(marked.reminderSentFor).toBe('2026-10-20')
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
    expect(world.upserts.length).toBe(0)
    expect(world.audits.length).toBe(0)
  })

  it('swallows a CAS race on the mark — the edit wins, the count stays honest', async () => {
    withDocs(DUE_SOON)
    world.upsertError = new ZohoCasConflictError('CMP-DUE')
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
    expect(world.upserts.length).toBe(0)
    expect(world.audits.length).toBe(0)
  })

  it('honors the configured lead window, not just the default', async () => {
    const atTwentyDays = { ...FRESH_DOC, id: 'CMP-20', expiresOn: '2026-10-27' }
    world.fetchAllImpl = (tableId: string) =>
      tableId === T['Config'].id ? configRows(JSON.stringify({ complianceLeadDays: 7 })) : [docRow(atTwentyDays, 'CMP-20:1')]
    const res = fakeRes()
    await remind(fakeReq('/api/compliance/remind', { authorization: 'Bearer sekrit' }), res)
    expect(res.json.mock.calls[0][0]).toEqual({ ok: true, due: 0, sent: 0, failed: 0 })
  })
})
