/**
 * Fetch client for /api/compliance/* — the Compliance page's whole server surface.
 *
 * Carries dbApi's session semantics (same-origin cookie credential, one 401 is
 * final and swaps in the login screen) over the compliance endpoints' own
 * shapes: saves carry the Version token the list last saw as baseVersion, and
 * the server's 409 — someone else saved first — surfaces as a conflict the
 * page answers with a reload rather than a silent overwrite.
 */
import { notifyUnauthorized } from './authEvents'
import { UnauthorizedError } from './dbApi'
import type { ComplianceDoc } from './complianceRules'

export interface ComplianceRow {
  doc: ComplianceDoc
  /** The Version token this row was last saved with — an edit's baseVersion. */
  version: string
}

export type ComplianceResult =
  | { ok: true; doc?: ComplianceDoc; version?: string }
  | { ok: false; error: string; conflict?: boolean }

async function call(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (res.status === 401) {
    notifyUnauthorized()
    throw new UnauthorizedError()
  }
  return res
}

async function readError(res: Response): Promise<string> {
  const j = (await res.json().catch(() => ({}))) as { error?: string }
  return j.error ?? `request failed (HTTP ${res.status})`
}

export async function fetchComplianceDocs(): Promise<ComplianceRow[]> {
  const res = await call('/api/compliance/documents')
  if (!res.ok) throw new Error(await readError(res))
  return ((await res.json()) as { docs: ComplianceRow[] }).docs
}

async function post(body: Record<string, unknown>): Promise<ComplianceResult> {
  let res: Response
  try {
    res = await call('/api/compliance/documents', { method: 'POST', body: JSON.stringify(body) })
  } catch (e) {
    if (e instanceof UnauthorizedError) return { ok: false, error: e.message }
    throw e
  }
  if (res.ok) {
    const j = (await res.json().catch(() => ({}))) as { doc?: ComplianceDoc; version?: string }
    return { ok: true as const, doc: j.doc, version: j.version }
  }
  return {
    ok: false as const,
    error: await readError(res),
    conflict: res.status === 409,
  }
}

export function complianceSave(doc: ComplianceDoc, baseVersion?: string): Promise<ComplianceResult> {
  return post({ action: 'save', doc, baseVersion })
}

export function complianceRemove(id: string, baseVersion?: string): Promise<ComplianceResult> {
  return post({ action: 'remove', id, baseVersion })
}

/**
 * Upload a document file to the private Cloudflare R2 bucket. The gate route
 * (/api/compliance/upload) checks the session and the caps, then answers a
 * presigned PUT URL — the bytes go straight from the browser to R2, never
 * through the API, so Vercel's request-body cap cannot bound a licence scan.
 * Returns the store pathname to keep in the doc.
 */
export async function uploadComplianceFile(file: File): Promise<string> {
  const contentType = file.type || (file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : '')
  const res = await call('/api/compliance/upload', {
    method: 'POST',
    body: JSON.stringify({ fileName: file.name, contentType, sizeInBytes: file.size }),
  })
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(j.error ?? `The upload gate refused the file (HTTP ${res.status}).`)
  }
  const j = (await res.json()) as { path: string; url: string; method: string; headers: Record<string, string> }
  const put = await fetch(j.url, { method: j.method, headers: j.headers, body: file })
  if (!put.ok) throw new Error(`The file store refused the upload (HTTP ${put.status}).`)
  return j.path
}
