/**
 * Files kept in the private bucket — lab reports and delivery photographs — and how a
 * screen shows them.
 *
 * Nothing here can hold a plain `<img src>` or `<a href>`: the bucket is private, so
 * every object has to be opened through a signed URL that lasts ten minutes. That is
 * why a photograph is fetched on mount rather than simply rendered, and why a link
 * opens its tab on the click and points it at the file afterwards.
 */

import { useEffect, useState } from 'react'
import { signedUrlFor } from '../lib/uploads'
import type { Attachment } from '../types'

/**
 * Opens a stored file.
 *
 * The bucket used to be public, which meant every stored link handed the file — the
 * customer's name and the lab's findings on it — to anyone who guessed the URL. Links
 * are signed and short-lived now, so the tab is opened on the click and pointed at the
 * file once it has one: minting the URL first and opening after loses the user
 * gesture, and the popup blocker eats the tab.
 */
export function AttachmentLink({ file }: { file: Attachment }) {
  const [busy, setBusy] = useState(false)
  return (
    <button
      type="button"
      className="link-button"
      disabled={busy}
      onClick={async () => {
        const tab = window.open('', '_blank', 'noopener')
        setBusy(true)
        try {
          const url = await signedUrlFor(file)
          if (tab) tab.location.href = url
          else window.location.href = url
        } catch {
          tab?.close()
        } finally {
          setBusy(false)
        }
      }}
    >
      {file.fileName}
    </button>
  )
}

const isImage = (file: Attachment) =>
  /\.(png|jpe?g|webp|gif|heic)$/i.test(file.path || file.fileName || '')

/** One photograph, shown rather than merely linked. A PDF has no preview, so it links. */
function Thumb({ file, onRemove }: { file: Attachment; onRemove?: () => void }) {
  const [url, setUrl] = useState('')
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!isImage(file)) return
    let live = true
    signedUrlFor(file)
      .then((signed) => {
        if (live) setUrl(signed)
      })
      .catch(() => {
        // A photograph that cannot be fetched is still a record that one was taken —
        // the link below says so rather than the tile vanishing.
        if (live) setFailed(true)
      })
    return () => {
      live = false
    }
  }, [file])

  return (
    <figure className="proof-thumb">
      {url && !failed ? (
        <button
          type="button"
          className="proof-thumb-open"
          onClick={() => window.open(url, '_blank', 'noopener')}
          title={file.fileName}
        >
          <img src={url} alt={file.fileName} loading="lazy" />
        </button>
      ) : (
        <div className="proof-thumb-fallback">
          <AttachmentLink file={file} />
        </div>
      )}
      <figcaption className="small">{file.fileName}</figcaption>
      {onRemove ? (
        <button type="button" className="btn btn-light proof-thumb-remove" onClick={onRemove}>
          Remove
        </button>
      ) : null}
    </figure>
  )
}

/** A strip of photographs. `onRemove` is passed only where they are still being edited. */
export function PhotoStrip({
  files,
  onRemove,
  empty = 'No photos attached.',
}: {
  files: Attachment[]
  onRemove?: (index: number) => void
  empty?: string
}) {
  if (!files.length) return <div className="small">{empty}</div>
  return (
    <div className="proof-strip">
      {files.map((file, i) => (
        <Thumb
          key={file.path || `${file.fileName}-${i}`}
          file={file}
          onRemove={onRemove ? () => onRemove(i) : undefined}
        />
      ))}
    </div>
  )
}
