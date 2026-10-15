import type { ExportFormat, ExportJob } from './contracts.ts'

/**
 * The dashboards' export door: one call folds a register through
 * /api/exports/:report with the dashboard's own window applied. Small exports
 * stream straight back (the bytes land as a download); large ones answer 202
 * and this polls the job until its presigned URL is ready (D0's lifecycle).
 *
 * The browser side (anchor click / navigation) sits behind `open` so tests can
 * pin the decision — the stream-vs-job verdict, the polling, and the failure
 * words — without a DOM.
 */

export interface ExportDownload {
  /** How the file arrived: streamed bytes, or a job's ready URL. */
  kind: 'streamed' | 'job'
  filename?: string
}

const JOB_POLL_MS = 1500
const JOB_MAX_POLLS = 40 // ~a minute — a register fold that takes longer is broken, not busy

type OpenFn = (url: string, filename?: string) => void

const openInBrowser: OpenFn = (url, filename) => {
  // A presigned job URL lives on R2's origin — navigate to it and let the
  // Content-Disposition name the file. A streamed blob is same-origin.
  if (filename == null) {
    window.location.assign(url)
    return
  }
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

export async function downloadExport(
  report: string,
  opts: { format: ExportFormat; from?: string; to?: string },
  open: OpenFn = openInBrowser,
): Promise<ExportDownload> {
  const qs = new URLSearchParams({ format: opts.format })
  if (opts.from) qs.set('from', opts.from)
  if (opts.to) qs.set('to', opts.to)

  const res = await fetch(`/api/exports/${encodeURIComponent(report)}?${qs}`)
  if (res.status === 202) {
    const job = (await res.json()) as ExportJob
    const ready = await pollJob(job, report, opts.format)
    open(ready.downloadUrl as string) // ready ⇒ the URL is present
    return { kind: 'job' }
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `Could not export (${res.status}).`)
  }

  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const filename = filenameFrom(res.headers.get('content-disposition')) ?? `${report}-${opts.from ?? 'all'}.${opts.format}`
  open(url, filename)
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return { kind: 'streamed', filename }
}

async function pollJob(job: ExportJob, report: string, format: ExportFormat): Promise<ExportJob> {
  for (let i = 0; i < JOB_MAX_POLLS; i++) {
    if (job.status === 'ready' && job.downloadUrl) return job
    if (job.status === 'failed') throw new Error(job.error ?? 'The export job failed.')
    await new Promise((r) => setTimeout(r, JOB_POLL_MS))
    const res = await fetch(`/api/exports/jobs/${encodeURIComponent(job.id)}`)
    if (!res.ok) throw new Error(`Could not reach the export job (${res.status}).`)
    job = (await res.json()) as ExportJob
  }
  throw new Error(`${report} (${format}) is still running — try again in a moment.`)
}

/** `attachment; filename="x.csv"` → `x.csv` — the server's own name wins. */
function filenameFrom(disposition: string | null): string | undefined {
  if (!disposition) return undefined
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)
  return m?.[1]
}
