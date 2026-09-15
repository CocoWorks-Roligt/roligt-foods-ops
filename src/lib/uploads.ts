import { supabase } from './supabaseClient'

export interface UploadedFile {
  fileName: string
  /** @deprecated the bucket is private now; kept so records written earlier still read.
   *  Read through `signedUrlFor`, never used as an href directly. */
  url: string
  /** Object key inside the bucket. What a signed URL is minted from. */
  path?: string
  uploadedAt: string
}

/**
 * One private bucket for every file the plant attaches — lab reports and the
 * photographs taken at a delivery. Its name is historical: it was created for QC
 * reports, and renaming a bucket means moving every object already in it, which is a
 * far worse trade than a slightly dated name on a folder nobody sees.
 */
const BUCKET = 'qc-reports'

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

  const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
    contentType: file.type || 'application/pdf',
    upsert: false,
  })
  if (error) throw new Error(error.message || 'Upload failed.')

  return {
    fileName: file.name,
    url: '',
    path,
    uploadedAt: new Date().toISOString(),
  }
}

/** The name this had while the bucket only ever held lab reports. */
export const uploadReport = uploadAttachment

/**
 * The object key for an attachment, whichever shape it was saved in.
 *
 * Reports used to live in a public bucket, so what was stored was a public URL that
 * anybody who guessed it could open — lab results and customer names included. The
 * bucket is private now and attachments carry their key, but records written before
 * that still hold the old URL, and the key is the tail of it.
 */
export function attachmentPath(a: { path?: string; url?: string }): string | null {
  if (a.path) return a.path
  const marker = `/object/public/${BUCKET}/`
  const at = a.url?.indexOf(marker) ?? -1
  if (at < 0) return null
  return decodeURIComponent(a.url!.slice(at + marker.length))
}

/** A link that works for ten minutes, which is long enough to read a report. */
export async function signedUrlFor(a: { path?: string; url?: string }): Promise<string> {
  const path = attachmentPath(a)
  if (!path) throw new Error('That report has no file attached any more.')
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 600)
  if (error || !data?.signedUrl) throw new Error(error?.message || 'Could not open that report.')
  return data.signedUrl
}
