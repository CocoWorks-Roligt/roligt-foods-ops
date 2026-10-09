/**
 * Record attachments — QC lab reports and dispatch proof-of-delivery photos —
 * the pure rules shared by the page, the device outbox and /api/attachments/*.
 * Isomorphic (the client build and the api's nodenext build both compile it),
 * so the browser and the routes agree on what a key looks like and who may
 * touch it.
 *
 * Unlike compliance — where the route names the object and the client never
 * does — the CLIENT mints these keys. A QC row or a dispatch has to carry its
 * attachment's key the moment it is saved, and on the plant floor that is often
 * offline: the record rides the commit queue long before the bytes can reach
 * R2. So the key is minted here, travels in the doc, and the routes refuse any
 * key outside the grammar below and any area the caller's role cannot open.
 */
import { COMPLIANCE_CONTENT_TYPES, COMPLIANCE_FILE_MAX_BYTES } from './complianceRules.js'

/** The bucket prefix this feature owns — /api/attachments/file serves nothing else. */
export const ATTACHMENTS_PATH_PREFIX = 'attachments/'

/** Each area and the page permission that both uploads into it and opens from it. */
export const ATTACHMENT_AREAS = {
  qc: 'page.quality',
  pod: 'page.dispatch',
} as const

export type AttachmentArea = keyof typeof ATTACHMENT_AREAS

/** Same files compliance admits — one allow-list, one cap. */
export const ATTACHMENT_FILE_MAX_BYTES = COMPLIANCE_FILE_MAX_BYTES
export const ATTACHMENT_CONTENT_TYPES = COMPLIANCE_CONTENT_TYPES

/** A filename-safe slug of anything (the interim store's rule, unchanged). */
export function safeAttachmentName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80)
}

function randomSegment(): string {
  let out = ''
  while (out.length < 6) out += Math.random().toString(36).slice(2)
  return out.slice(0, 6)
}

/**
 * `attachments/<area>/<context>-<stamp>-<rand>-<name>`. The random segment
 * keeps two devices attaching the same-named file in the same millisecond from
 * landing on one object.
 */
export function mintAttachmentKey(
  area: AttachmentArea,
  context: string,
  fileName: string,
  now: number = Date.now(),
  rand: string = randomSegment(),
): string {
  const ctx = safeAttachmentName(context).slice(0, 60) || 'record'
  const name = safeAttachmentName(fileName) || 'file'
  return `${ATTACHMENTS_PATH_PREFIX}${area}/${ctx}-${now.toString(36)}-${safeAttachmentName(rand).slice(0, 6)}-${name}`
}

const KEY_GRAMMAR = /^attachments\/(qc|pod)\/[A-Za-z0-9._-]{1,200}$/

/** The area a key belongs to, or null when it is not one of ours. */
export function attachmentAreaOf(path: string): AttachmentArea | null {
  if (typeof path !== 'string' || path.includes('..')) return null
  const m = KEY_GRAMMAR.exec(path)
  return m ? (m[1] as AttachmentArea) : null
}

export function isAttachmentKey(path: string): boolean {
  return attachmentAreaOf(path) !== null
}

/** The page permission a caller needs to upload or open this key. */
export function attachmentPermissionFor(path: string): string | null {
  const area = attachmentAreaOf(path)
  return area ? ATTACHMENT_AREAS[area] : null
}
