/**
 * Attachments — interim, local-device edition.
 *
 * These used to live in a Supabase Storage bucket; that went away with the SDK.
 * Until the BFF grows its own upload endpoint, the bytes stay on this device for
 * the session: an attachment can be added and opened while you work, but one
 * saved on an earlier session (or another device) cannot be opened and says so
 * plainly. The record keeps its object key either way, so nothing has to be
 * rewritten when the server-side store arrives.
 */
export interface UploadedFile {
  fileName: string
  /** @deprecated kept so records written earlier still read. Use `signedUrlFor`. */
  url: string
  /** Object key of the attachment. What a view link is minted from. */
  path?: string
  uploadedAt: string
}

/** This session's files, by object key. */
const blobs = new Map<string, Blob>()

function safeName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80)
}

export async function uploadAttachment(file: File, prefix = 'qc'): Promise<UploadedFile> {
  const allowed = [
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/webp',
  ]
  if (!allowed.includes(file.type) && !file.name.toLowerCase().endsWith('.pdf')) {
    throw new Error('Only PDF or image files are allowed.')
  }
  if (file.size > 12 * 1024 * 1024) {
    throw new Error('File must be under 12 MB.')
  }

  const stamp = Date.now().toString(36)
  const path = `${safeName(prefix)}-${stamp}-${safeName(file.name)}`

  blobs.set(path, file)

  return {
    fileName: file.name,
    url: '',
    path,
    uploadedAt: new Date().toISOString(),
  }
}

/** The name this had while the store only ever held lab reports. */
export const uploadReport = uploadAttachment

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

/** A link that opens the attachment. */
export async function signedUrlFor(a: { path?: string; url?: string }): Promise<string> {
  const path = attachmentPath(a)
  if (!path) throw new Error('That report has no file attached any more.')
  const blob = blobs.get(path)
  if (!blob) {
    throw new Error(
      'That attachment is not on this device — attachment storage returns with the BFF upload endpoint.',
    )
  }
  return URL.createObjectURL(blob)
}
