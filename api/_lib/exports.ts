/**
 * The export service — GET /api/exports/:report's whole verdict (contracts
 * §exports, ARCHITECTURE §6). Rows come from the SAME isomorphic report folds
 * the on-screen tables read (src/lib/exports registry), so the file can never
 * disagree with the screen. This side owns everything store-shaped: the RBAC
 * gate, the page-based read withholding (readModuleState is the KPI layer's
 * own), the stream-vs-job verdict, the meta-stored job lifecycle, R2 storage
 * with presigned expiring downloads for job-sized files, and the audit row
 * (§6: exports are audited).
 *
 * Jobs: an export over EXPORT_STREAM_MAX_ROWS answers 202 + a job row; the
 * first poll computes it (serverless-honest: nothing idles), uploads the bytes
 * to R2 under exports/<id>.<ext> and presigns a short-lived download. Job
 * files REQUIRE R2 — a stream-sized export never does.
 */
import type { Caller } from './auth.js'
import { DomainError, auditId, auditStmt, isDeliveryAgent } from './domain.js'
import { readModuleState, readLastUpdated } from './kpis.js'
import { presignR2Get, presignR2Put, r2Configured } from './r2.js'
import { parseKpiWindow } from '../../src/lib/kpis/index.ts'
import { toCsvWithMeta, type ExportColumn } from '../../src/lib/exports/csv.ts'
import { exportSpec } from '../../src/lib/exports/index.ts'
import { canViewPage } from '../../src/lib/pages.ts'
import type {
  ExportFormat,
  ExportJob,
  ExportJobStatus,
  Freshness,
} from '../../src/lib/contracts.js'
import { renderPdf, renderXlsx, istStamp, type RenderedFile } from './exportFormats.js'
import type { AppState } from '../../src/types.ts'

type Stmt = { sql: string; params?: unknown[] }

/** Everything the service reads through — the KPI layer's store shape. */
export interface ExportStore {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>
  batch(stmts: Stmt[]): Promise<unknown[]>
}

/** §6: small = stream, large = background job. The plant's whole history is
 *  hundreds of documents; four thousand rows is far past anything it folds
 *  today, and cheap enough to still stream when it gets there. */
export const EXPORT_STREAM_MAX_ROWS = 4000

const DOWNLOAD_TTL_SEC = 600
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

interface JobRow {
  id: string
  report: string
  format: ExportFormat
  filters: Record<string, string>
  status: ExportJobStatus
  createdBy: string
  createdAt: string
  /** documents max(updated_at) at compute time — the freshness the job carries. */
  lastUpdated: string
  downloadKey?: string
  expiresAt?: string
  error?: string
}

export type ExportVerdict =
  | {
      kind: 'stream'
      file: RenderedFile
      filename: string
      lastUpdated: string
      staleAfterSec: number
    }
  | { kind: 'job'; job: ExportJob; status: number }

const readStaleAfter = async (d1: ExportStore): Promise<number> => {
  const rows = await d1.query<{ value: string }>(`SELECT value FROM meta WHERE setting = 'app_config'`)
  try {
    const config = JSON.parse(rows[0]?.value ?? '{}') as { kpiStaleAfterSec?: number }
    return typeof config.kpiStaleAfterSec === 'number' && config.kpiStaleAfterSec > 0
      ? config.kpiStaleAfterSec
      : 300
  } catch {
    return 300
  }
}

const FORMAT_TYPES: Record<ExportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
}

// ── the fold + render, shared by stream and job paths ───────────────────────

interface Folded {
  rows: unknown[]
  rowCount: number
  lastUpdated: string
  from: string
  to: string
  /** The extra filter values the fold honored, for the header and the job row. */
  extras: Record<string, string>
}

async function foldRows(
  d1: ExportStore,
  caller: Caller,
  report: string,
  q: Record<string, unknown>,
): Promise<{ folded: Folded; title: string; columns: ExportColumn<unknown>[] }> {
  const s = exportSpec(report)
  if (!s) throw new DomainError(404, `No such report: ${report}.`, 'invalid_report')
  const { from, to } = parseKpiWindow(q)
  const { state, read } = await readModuleState(d1, caller, s.collections)
  const today = new Date().toISOString().slice(0, 10)
  const rows = s.rows(state as Partial<AppState>, { from, to }, today)
  const extras: Record<string, string> = {}
  for (const k of s.filterKeys ?? []) {
    if (typeof q[k] === 'string' && q[k] !== '') extras[k] = String(q[k])
  }
  return {
    folded: { rows, rowCount: rows.length, lastUpdated: await readLastUpdated(d1, read), from, to, extras },
    title: s.title,
    columns: s.columns as ExportColumn<unknown>[],
  }
}

async function renderFile(
  caller: Caller,
  format: ExportFormat,
  folded: Folded,
  title: string,
  columns: ExportColumn<unknown>[],
): Promise<RenderedFile> {
  const meta = {
    title,
    lines: [
      `Window: ${folded.from} to ${folded.to}`,
      ...Object.entries(folded.extras).map(([k, v]) => `${k}: ${v}`),
      `Generated by ${caller.email} at ${istStamp(Date.now())}`,
    ],
  }
  if (format === 'csv') {
    // The BOM is what makes Excel read the file as UTF-8 (lib/export's note).
    return {
      bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(toCsvWithMeta(meta.lines, columns, folded.rows), 'utf8')]),
      contentType: FORMAT_TYPES.csv,
      ext: 'csv',
    }
  }
  if (format === 'xlsx') return renderXlsx(meta, columns, folded.rows)
  return renderPdf(meta, columns, folded.rows)
}

async function writeAudit(d1: ExportStore, caller: Caller, report: string, format: ExportFormat, details: unknown): Promise<void> {
  const now = new Date().toISOString()
  await d1.batch([
    auditStmt({
      id: auditId('report.export', `${report}:${format}`, now),
      at: now,
      actor: caller.email,
      action: 'report.export',
      doc: report,
      details: JSON.stringify(details),
    }),
  ])
}

// ── GET /api/exports/:report ────────────────────────────────────────────────

export async function exportFor(
  d1: ExportStore,
  caller: Caller,
  report: string,
  q: Record<string, unknown>,
  opts: { maxRows?: number } = {},
): Promise<ExportVerdict> {
  const s = exportSpec(report)
  if (!s) throw new DomainError(404, `No such report: ${report}.`, 'invalid_report')
  if (isDeliveryAgent(caller.permissions)) {
    throw new DomainError(403, 'Exports are not part of the delivery app.', 'role_allowed')
  }
  if (!s.pages.some((p) => canViewPage(caller.permissions, p))) {
    throw new DomainError(403, 'Your role does not run this export.', 'role_allowed')
  }
  const format = (
    ['csv', 'xlsx', 'pdf'].includes(String(q.format)) ? String(q.format) : 'csv'
  ) as ExportFormat

  const { folded, title, columns } = await foldRows(d1, caller, report, q)
  const staleAfterSec = await readStaleAfter(d1)

  if (folded.rowCount > (opts.maxRows ?? EXPORT_STREAM_MAX_ROWS)) {
    const id = crypto.randomUUID()
    const row: JobRow = {
      id,
      report,
      format,
      filters: { from: folded.from, to: folded.to, ...folded.extras },
      status: 'queued',
      createdBy: caller.email,
      createdAt: new Date().toISOString(),
      lastUpdated: folded.lastUpdated,
    }
    await writeJob(d1, row)
    await writeAudit(d1, caller, report, format, { format, rows: folded.rowCount, from: folded.from, to: folded.to, job: id })
    return { kind: 'job', job: jobResponse(row, staleAfterSec), status: 202 }
  }

  const file = await renderFile(caller, format, folded, title, columns)
  await writeAudit(d1, caller, report, format, { format, rows: folded.rowCount, from: folded.from, to: folded.to })
  const today = new Date().toISOString().slice(0, 10)
  return { kind: 'stream', file, filename: `${slug(title)}-${today}.${file.ext}`, lastUpdated: folded.lastUpdated, staleAfterSec }
}

// ── the job lifecycle: meta rows, R2 storage, presigned downloads ──────────

const jobKey = (id: string) => `export:${id}`

async function readJob(d1: ExportStore, id: string): Promise<JobRow | null> {
  const rows = await d1.query<{ value: string }>(`SELECT value FROM meta WHERE setting = ?`, [jobKey(id)])
  if (!rows[0]?.value) return null
  try {
    const row = JSON.parse(rows[0].value) as JobRow
    return row.id === id ? row : null
  } catch {
    return null
  }
}

async function writeJob(d1: ExportStore, row: JobRow): Promise<void> {
  await d1.batch([
    { sql: `INSERT INTO meta(setting, value) VALUES(?, ?) ON CONFLICT(setting) DO UPDATE SET value = excluded.value`, params: [jobKey(row.id), JSON.stringify(row)] },
  ])
}

const jobResponse = (row: JobRow, staleAfterSec: number): ExportJob & Freshness => {
  const ageSec = row.lastUpdated ? (Date.now() - Date.parse(row.lastUpdated)) / 1000 : Infinity
  return {
    id: row.id,
    report: row.report,
    format: row.format,
    status: row.status,
    ...(row.downloadKey ? { downloadUrl: presignR2Get(row.downloadKey, { expiresInSec: DOWNLOAD_TTL_SEC, downloadName: `${slug(row.report)}-${row.id}.${row.format}` }) } : {}),
    ...(row.error ? { error: row.error } : {}),
    last_updated: row.lastUpdated || row.createdAt,
    stale_after: staleAfterSec,
    stale: ageSec > staleAfterSec,
  }
}

export async function getExportJob(d1: ExportStore, caller: Caller, id: string): Promise<ExportJob> {
  const row = await readJob(d1, id)
  if (!row || row.createdBy !== caller.email) {
    // 404, never 403: the jobs list is nobody's — an id must not confirm a job exists.
    throw new DomainError(404, `No such export job.`, 'export_not_found')
  }
  const staleAfterSec = await readStaleAfter(d1)

  if (row.status === 'queued') {
    if (!r2Configured()) {
      row.status = 'failed'
      row.error = 'Large exports need file storage (R2 env missing).'
      await writeJob(d1, row)
      return jobResponse(row, staleAfterSec)
    }
    // First poll does the work — nothing idles between polls.
    row.status = 'running'
    await writeJob(d1, row)
    try {
      const { folded, title, columns } = await foldRows(d1, caller, row.report, { ...row.filters, format: row.format })
      const file = await renderFile(caller, row.format, folded, title, columns)
      const key = `exports/${row.id}.${file.ext}`
      const put = await fetch(presignR2Put(key, file.contentType), {
        method: 'PUT',
        headers: { 'content-type': file.contentType },
        body: file.bytes,
      })
      if (!put.ok) throw new DomainError(502, 'The export file could not be stored — poll again to retry.', 'export_store_failed')
      row.status = 'ready'
      row.downloadKey = key
      row.expiresAt = new Date(Date.now() + DOWNLOAD_TTL_SEC * 1000).toISOString()
      row.lastUpdated = folded.lastUpdated
    } catch (e) {
      row.status = 'failed'
      row.error = e instanceof DomainError ? e.message : 'The export could not be computed — poll again to retry.'
    }
    await writeJob(d1, row)
  }
  return jobResponse(row, staleAfterSec)
}
