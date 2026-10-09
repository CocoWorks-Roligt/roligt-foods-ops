/**
 * Attachments — QC lab reports and dispatch proof-of-delivery photos.
 *
 * The bytes live in the private R2 bucket under attachments/<qc|pod>/, behind
 * /api/attachments/*. Attaching never waits on the network: the key is minted
 * on this device (lib/attachmentRules.ts), the record saves through the
 * ordinary commit queue, and the bytes go into the device outbox
 * (lib/attachmentQueue.ts), which uploads them the moment the device is online.
 * Until then the file still opens here, from the outbox.
 *
 * Older records hold keys from before the store existed — the interim
 * session-only keys and the Supabase-era URLs. Those bytes were never uploaded
 * anywhere, and opening one says so plainly rather than asking a server for a
 * file it never had.
 */
import {
  ATTACHMENTS_PATH_PREFIX,
  ATTACHMENT_CONTENT_TYPES,
  ATTACHMENT_FILE_MAX_BYTES,
  mintAttachmentKey,
  type AttachmentArea,
} from './attachmentRules'
import { drainAttachmentQueue, enqueueAttachment, getQueuedBlob } from './attachmentQueue'
import { notifyUnauthorized } from './authEvents'
import { UnauthorizedError } from './dbApi'

export interface UploadedFile {
  fileName: string
  /** @deprecated kept so records written earlier still read. Use `signedUrlFor`. */
  url: string
  /** Object key of the attachment. What a view link is minted from. */
  path?: string
  uploadedAt: string
  /** True: the device would not keep the bytes, so they exist only for this session. */
  sessionOnly: boolean
}

/** Bytes this session already holds, by object key — added here or fetched once. */
const blobs = new Map<string, Blob>()

const ALLOWED: readonly string[] = ATTACHMENT_CONTENT_TYPES

/** The type the bytes are stored under — a PDF the OS could not label still goes up as one. */
function contentTypeOf(file: File): string {
  const type = file.type.toLowerCase()
  if (ALLOWED.includes(type)) return type
  return 'application/pdf'
}

/**
 * Attach a file to a record in `area`. `context` names the record (and the
 * slot on it) inside the key, so a stray object in the bucket still says what
 * it belonged to.
 */
export async function uploadAttachment(file: File, area: AttachmentArea, context: string): Promise<UploadedFile> {
  if (!ALLOWED.includes(file.type) && !file.name.toLowerCase().endsWith('.pdf')) {
    throw new Error('Only PDF or image files are allowed.')
  }
  if (file.size > ATTACHMENT_FILE_MAX_BYTES) {
    throw new Error('File must be under 12 MB.')
  }

  const path = mintAttachmentKey(area, context, file.name)
  blobs.set(path, file)
  const queued = await enqueueAttachment({ path, fileName: file.name, contentType: contentTypeOf(file), blob: file })

  return {
    fileName: file.name,
    url: '',
    path,
    uploadedAt: new Date().toISOString(),
    sessionOnly: !queued,
  }
}

/**
 * The object key for an attachment, whichever shape it was saved in.
 *
 * Reports used to live in a public bucket, so what was stored was a public URL that
 * anybody who guessed it could open — lab results and customer names included. The
 * bucket went private and attachments carried their key instead, but records written
 * before that still hold the old URL, and the key is the tail of it.
 */
export function attachmentPath(a: { path?: string; url?: string }): string | null {
  if (a.path) return a.path
  const marker = '/object/public/qc-reports/'
  const at = a.url?.indexOf(marker) ?? -1
  if (at < 0) return null
  return decodeURIComponent(a.url!.slice(at + marker.length))
}

const objectUrl = (blob: Blob) => URL.createObjectURL(blob)

/** A link that opens the attachment — always a local object URL, whatever held the bytes. */
export async function signedUrlFor(a: { path?: string; url?: string }): Promise<string> {
  const path = attachmentPath(a)
  if (!path) throw new Error('That report has no file attached any more.')

  const held = blobs.get(path)
  if (held) return objectUrl(held)

  if (!path.startsWith(ATTACHMENTS_PATH_PREFIX)) {
    throw new Error(
      a.path
        ? 'That attachment was never uploaded — it was added before the file store existed, and only the device that added it held the file.'
        : 'That attachment was in the old storage, which no longer exists.',
    )
  }

  const queued = await getQueuedBlob(path)
  if (queued) {
    // still waiting here — a nudge costs nothing and may be all it needed
    void drainAttachmentQueue()
    return objectUrl(queued)
  }

  let res: Response
  try {
    res = await fetch(`/api/attachments/file?path=${encodeURIComponent(path)}`, { credentials: 'same-origin' })
  } catch {
    throw new Error('The file could not be fetched — check the connection and try again.')
  }
  if (res.status === 401) {
    notifyUnauthorized()
    throw new UnauthorizedError()
  }
  if (res.status === 404) {
    throw new Error('Not uploaded yet — this file is still waiting on the device that added it.')
  }
  if (res.status === 403) throw new Error('You do not have permission to open this file.')
  if (res.status === 503) throw new Error('Attachment storage is not configured yet.')
  if (!res.ok) throw new Error(`The file could not be opened (HTTP ${res.status}).`)

  const blob = await res.blob()
  blobs.set(path, blob)
  return objectUrl(blob)
}
