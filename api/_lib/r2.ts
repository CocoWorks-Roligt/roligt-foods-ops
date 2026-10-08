/**
 * Cloudflare R2 object storage — hand-rolled S3 SigV4 query presigning, the
 * same ethos as ZohoClient: no SDK, one small pure algorithm, injectable clock
 * for tests. R2's S3-compatible API accepts presigned URLs at
 * https://<accountId>.r2.cloudflarestorage.com/<bucket>/<key>?<sigv4 query>.
 *
 * Both directions a compliance document needs are just signed URLs:
 *  - PUT: the upload route mints one for a key IT chose, with the content type
 *    signed into it — the browser PUTs the bytes straight to R2, so Vercel's
 *    ~4.5 MB request-body cap never sees a file. (The size cap is enforced at
 *    mint time by the route and by the client; the signed content type is what
 *    R2 itself refuses to budge on.)
 *  - GET: the download route permission-checks, then 302s to a short-lived
 *    signed URL with an attachment disposition — the bytes stream from R2, and
 *    the URL is worthless minutes later.
 *
 * Region is 'auto' (R2's own scope for SigV4), the payload hash is
 * UNSIGNED-PAYLOAD on both methods, and the clock is UTC — the scope's date
 * and X-Amz-Date are derived from the same instant, so a presign minted near
 * UTC midnight stays internally consistent.
 */
import { createHash, createHmac } from 'node:crypto'

interface R2Env {
  accountId: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

function r2Env(): R2Env | null {
  const accountId = process.env.R2_ACCOUNT_ID
  const bucket = process.env.R2_BUCKET
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) return null
  return { accountId, bucket, accessKeyId, secretAccessKey }
}

export function r2Configured(): boolean {
  return r2Env() !== null
}

const sha256Hex = (data: string) => createHash('sha256').update(data).digest('hex')
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest()

/** RFC 3986, stricter than encodeURIComponent: AWS canonicalization also
 *  escapes ! ' ( ) *, which encodeURIComponent leaves bare. */
function awsUriEncode(value: string, encodeSlash = true): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%2F/g, encodeSlash ? '%2F' : '/')
}

export interface PresignOptions {
  /** Seconds the URL stays usable (default 5 minutes; R2 caps at 7 days). */
  expiresInSec?: number
  /** Injectable clock — tests pin the whole URL with it. */
  now?: number
}

/** One signed URL. Everything canonical is derived here and here only. */
function presign(
  method: 'PUT' | 'GET',
  key: string,
  opts: PresignOptions & {
    contentType?: string
    responseContentDisposition?: string
  } = {},
): string {
  const env = r2Env()
  if (!env) throw new Error('R2_ACCOUNT_ID / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY are not configured.')
  const host = `${env.accountId}.r2.cloudflarestorage.com`
  const now = new Date(opts.now ?? Date.now())
  const amzDate = `${now.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z` // 20261008T041500Z
  const date = amzDate.slice(0, 8)
  const scope = `${date}/auto/s3/aws4_request`
  const canonicalUri = `/${awsUriEncode(env.bucket, false)}/${awsUriEncode(key, false)}`

  const headers: Record<string, string> = { host }
  if (opts.contentType) headers['content-type'] = opts.contentType.toLowerCase()
  const signedHeaders = Object.keys(headers).sort().join(';')
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((h) => `${h}:${headers[h]}\n`)
    .join('')

  const query: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${env.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(Math.max(1, Math.floor(opts.expiresInSec ?? 300))),
    'X-Amz-SignedHeaders': signedHeaders,
  }
  if (opts.responseContentDisposition) {
    query['response-content-disposition'] = opts.responseContentDisposition
  }
  // canonical query: keys AND values encoded, entries sorted by encoded key
  const canonicalQuery = Object.entries(query)
    .map(([k, v]) => [awsUriEncode(k), awsUriEncode(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')

  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n')
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n')
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${env.secretAccessKey}`, date), 'auto'), 's3'), 'aws4_request')
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')

  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`
}

/** The URL the browser PUTs the file bytes to. The content type is signed: R2
 *  refuses the upload if the request carries any other one. */
export function presignR2Put(key: string, contentType: string, opts: PresignOptions = {}): string {
  return presign('PUT', key, { ...opts, contentType })
}

/** The URL the download route redirects to — attachment disposition baked in
 *  as a response param, so the browser saves rather than renders. */
export function presignR2Get(
  key: string,
  opts: PresignOptions & { downloadName?: string } = {},
): string {
  const name = (opts.downloadName ?? key.split('/').pop() ?? 'document').replace(/["\\\r\n]/g, '_')
  return presign('GET', key, {
    ...opts,
    responseContentDisposition: `attachment; filename="${name}"`,
  })
}
