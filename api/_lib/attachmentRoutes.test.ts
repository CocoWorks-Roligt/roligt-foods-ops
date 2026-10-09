/**
 * /api/attachments/upload + /api/attachments/file — the route contract: the
 * status ladder's order (auth, then the key's grammar, then the key's area
 * permission, then storage), the client-minted key echoed verbatim, and the
 * presigner called only once every check has passed. Session and R2 are mocked;
 * the rules lib is real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VercelRequest, VercelResponse } from '@vercel/node'

const world = vi.hoisted(() => ({
  AuthError: class AuthError extends Error {},
  authFails: false,
  caller: { email: 'qc@roligt.local', permissions: ['page.quality'] as string[] },
  r2Ready: true,
}))
// referenced lazily from the hoisted mock factory below, so declaring them here is safe
const put = vi.fn((..._a: unknown[]) => 'https://r2.example/signed-put')
const get = vi.fn((..._a: unknown[]) => 'https://r2.example/signed-get')

vi.mock('./auth.ts', () => ({
  authenticate: vi.fn(async () => {
    if (world.authFails) throw new world.AuthError('Not signed in.')
    return { caller: world.caller, setCookies: [] }
  }),
  AuthError: world.AuthError,
}))

vi.mock('./vercel.ts', () => ({
  toWebRequest: () => new Request('https://ops.example/api/attachments'),
}))

vi.mock('./r2.ts', () => ({
  r2Configured: () => world.r2Ready,
  presignR2Put: (...a: unknown[]) => put(...a),
  presignR2Get: (...a: unknown[]) => get(...a),
}))

const upload = (await import('../attachments/upload.ts')).default
const file = (await import('../attachments/file.ts')).default

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

const JSON_CT = { 'content-type': 'application/json' }
const QC_KEY = 'attachments/qc/QC-1.micro-lx2-ab12cd-report.pdf'
const POD_KEY = 'attachments/pod/DSP-4-lx2-ab12cd-door.jpg'
const pdf = (path = QC_KEY, over: Record<string, unknown> = {}) => ({
  path,
  fileName: 'report.pdf',
  contentType: 'application/pdf',
  sizeInBytes: 1_024,
  ...over,
})

async function callUpload(body: unknown, headers: Record<string, string> = JSON_CT) {
  const res = fakeRes()
  await upload({ headers, body } as unknown as VercelRequest, res)
  return res
}

async function callFile(path?: string) {
  const res = fakeRes()
  await file({ headers: {}, query: path === undefined ? {} : { path } } as unknown as VercelRequest, res)
  return res
}

beforeEach(() => {
  world.authFails = false
  world.caller = { email: 'qc@roligt.local', permissions: ['page.quality'] }
  world.r2Ready = true
  put.mockClear()
  get.mockClear()
})

describe('POST /api/attachments/upload', () => {
  it('presigns the client-minted key verbatim for a permitted upload', async () => {
    const res = await callUpload(pdf())
    expect(res.statusCode).toBe(200)
    expect(put).toHaveBeenCalledWith(QC_KEY, 'application/pdf', { expiresInSec: 300 })
    expect(res.json).toHaveBeenCalledWith({
      path: QC_KEY,
      url: 'https://r2.example/signed-put',
      method: 'PUT',
      headers: { 'content-type': 'application/pdf' },
    })
  })

  it('accepts a string body the way Vercel sometimes hands it over', async () => {
    const res = await callUpload(JSON.stringify(pdf()))
    expect(res.statusCode).toBe(200)
  })

  it('answers 401 when the session is gone', async () => {
    world.authFails = true
    const res = await callUpload(pdf())
    expect(res.statusCode).toBe(401)
    expect(put).not.toHaveBeenCalled()
  })

  it('refuses a non-JSON request with 415', async () => {
    const res = await callUpload(pdf(), { 'content-type': 'text/plain' })
    expect(res.statusCode).toBe(415)
  })

  it('refuses any key outside the grammar with 400 — compliance/ included', async () => {
    for (const path of ['compliance/licence.pdf', 'qc/x.pdf', 'attachments/qc/../x.pdf', 'attachments/other/x.pdf', '']) {
      const res = await callUpload(pdf(path))
      expect(res.statusCode, path).toBe(400)
    }
    expect(put).not.toHaveBeenCalled()
  })

  it("refuses an area the caller's role cannot open with 403", async () => {
    const res = await callUpload(pdf(POD_KEY, { fileName: 'door.jpg', contentType: 'image/jpeg' }))
    expect(res.statusCode).toBe(403)
    world.caller = { email: 'driver@roligt.local', permissions: ['page.dispatch'] }
    expect((await callUpload(pdf(POD_KEY, { contentType: 'image/jpeg' }))).statusCode).toBe(200)
    expect((await callUpload(pdf())).statusCode).toBe(403)
  })

  it('checks the key before the permission, so a malformed key never reads as forbidden', async () => {
    world.caller = { email: 'nobody@roligt.local', permissions: [] }
    expect((await callUpload(pdf('compliance/x.pdf'))).statusCode).toBe(400)
  })

  it('answers 503 when R2 is not configured, before the caps', async () => {
    world.r2Ready = false
    const res = await callUpload(pdf(QC_KEY, { contentType: 'application/x-msdownload' }))
    expect(res.statusCode).toBe(503)
    expect(res.json).toHaveBeenCalledWith({ error: 'Attachment storage is not configured (R2 env missing).' })
  })

  it('refuses a bad name, type or size with 400', async () => {
    for (const over of [
      { fileName: '' },
      { fileName: 'x'.repeat(121) },
      { contentType: 'application/octet-stream' },
      { sizeInBytes: 0 },
      { sizeInBytes: 12 * 1024 * 1024 + 1 },
      { sizeInBytes: 'lots' },
    ]) {
      const res = await callUpload(pdf(QC_KEY, over))
      expect(res.statusCode, JSON.stringify(over)).toBe(400)
    }
    expect(put).not.toHaveBeenCalled()
  })
})

describe('GET /api/attachments/file', () => {
  it('302s a permitted caller to a short-lived signed GET', async () => {
    const res = await callFile(QC_KEY)
    expect(res.statusCode).toBe(302)
    expect(get).toHaveBeenCalledWith(QC_KEY, { expiresInSec: 120 })
    expect(res.headers.Location).toBe('https://r2.example/signed-get')
    expect(res.headers['Cache-Control']).toBe('private, no-cache')
  })

  it('answers 401 when the session is gone', async () => {
    world.authFails = true
    expect((await callFile(QC_KEY)).statusCode).toBe(401)
  })

  it('refuses keys outside the grammar with 400', async () => {
    for (const path of ['compliance/licence.pdf', 'attachments/qc/..', undefined]) {
      expect((await callFile(path)).statusCode, String(path)).toBe(400)
    }
    expect(get).not.toHaveBeenCalled()
  })

  it("refuses another area's key with 403", async () => {
    expect((await callFile(POD_KEY)).statusCode).toBe(403)
    expect(get).not.toHaveBeenCalled()
  })

  it('answers 503 when R2 is not configured', async () => {
    world.r2Ready = false
    expect((await callFile(QC_KEY)).statusCode).toBe(503)
  })
})
