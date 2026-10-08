import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { presignR2Get, presignR2Put, r2Configured } from './r2.js'

/**
 * The SigV4 query presigner is the one piece of Cloudflare plumbing with no
 * SDK behind it, so its suite pins what a wrong implementation gets silently
 * wrong: strict RFC 3986 encoding, query-sorted canonical form, the scope's
 * date agreeing with X-Amz-Date, determinism at a fixed instant. The final
 * proof is the live smoke against the real bucket once it exists (curl a
 * minted PUT then GET); these tests hold the algorithm still until then.
 */
const ENV = {
  R2_ACCOUNT_ID: 'testaccount',
  R2_BUCKET: 'roligt-compliance',
  R2_ACCESS_KEY_ID: 'testkeyid',
  R2_SECRET_ACCESS_KEY: 'testsecret',
}

/** 2026-10-08T04:15:00Z — fixed instant, fixed URL. */
const NOW = Date.UTC(2026, 9, 8, 4, 15, 0)

beforeEach(() => Object.assign(process.env, ENV))
afterEach(() => {
  for (const k of Object.keys(ENV)) delete process.env[k]
})

describe('r2 presigning', () => {
  it('knows when it is not configured', () => {
    delete process.env.R2_SECRET_ACCESS_KEY
    expect(r2Configured()).toBe(false)
    expect(() => presignR2Put('compliance/x.pdf', 'application/pdf')).toThrow(/R2_/)
  })

  it('builds the documented URL shape with a deterministic signature', () => {
    const url = presignR2Put('compliance/fssai.pdf', 'application/pdf', { now: NOW })
    expect(url.startsWith('https://testaccount.r2.cloudflarestorage.com/roligt-compliance/compliance/fssai.pdf?')).toBe(true)
    const query = new URL(url).searchParams
    expect(query.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
    expect(query.get('X-Amz-Credential')).toBe('testkeyid/20261008/auto/s3/aws4_request')
    expect(query.get('X-Amz-Date')).toBe('20261008T041500Z')
    expect(query.get('X-Amz-Expires')).toBe('300')
    expect(query.get('X-Amz-SignedHeaders')).toBe('content-type;host')
    expect(query.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
    // same instant + same inputs → byte-for-byte the same URL
    expect(presignR2Put('compliance/fssai.pdf', 'application/pdf', { now: NOW })).toBe(url)
  })

  it('encodes object keys strictly RFC 3986 — spaces, unicode and reserved characters', () => {
    const url = presignR2Get('compliance/fssai licence (résumé).pdf', { now: NOW })
    const path = new URL(url).pathname
    expect(path).toBe('/roligt-compliance/compliance/fssai%20licence%20%28r%C3%A9sum%C3%A9%29.pdf')
    expect(decodeURIComponent(path).endsWith('compliance/fssai licence (résumé).pdf')).toBe(true)
  })

  it('bakes an attachment disposition into the presigned GET', () => {
    const url = presignR2Get('compliance/fssai licence.pdf', { now: NOW })
    const query = new URL(url).searchParams
    expect(query.get('response-content-disposition')).toBe('attachment; filename="fssai licence.pdf"')
    expect(query.get('X-Amz-SignedHeaders')).toBe('host') // GET signs nothing but host
  })

  it('signs the content type, lowercased the way S3 canonicalizes headers', () => {
    const url = presignR2Put('compliance/x.png', 'IMAGE/PNG', { now: NOW })
    const query = new URL(url).searchParams
    expect(query.get('X-Amz-SignedHeaders')).toBe('content-type;host')
    // the canonical header value is part of the signed string and lowercased
    // here, so the client must send exactly the lowercase form the upload
    // route hands back — any other casing and R2 refuses the PUT
    const again = presignR2Put('compliance/x.png', 'image/png', { now: NOW })
    expect(again).toBe(url)
  })

  it('honors a custom expiry within the 7-day ceiling', () => {
    const url = presignR2Get('compliance/x.pdf', { now: NOW, expiresInSec: 120 })
    expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe('120')
  })
})
