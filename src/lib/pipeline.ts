/**
 * Pipeline Home's fold (WORKFLOW, ARCHITECTURE §1 "Home"): the process as one
 * horizontal board — every stage with what waits in it, and what makes that
 * stage a bottleneck: work open longer than the configured days, lots on hold,
 * intermediates nearing expiry, orders past their ship-by day.
 *
 * Same contract as navBadges: pure over the plant the tab already holds, every
 * count in each stage's own existing vocabulary, never a rule invented for the
 * board. A stage whose waiting-state has no vocabulary yet honestly reads
 * zero. Bottleneck notes are sentences, not codes — they go on screen as
 * written.
 */
import { lowStockItems } from './alerts.ts'
import { addDays, controlSampleRows } from './controlSamples.ts'
import { inHoldArea, itemName, stockRows } from './stock.ts'
import { toDateKey } from './utils.ts'
import type { AppState } from '../types.ts'

/** A thing waiting in a stage (or done today, on an activity stage). */
export interface PipelineRow {
  id: string
  label: string
  detail?: string
  status: string
  date?: string
  /** The page that owns the record — the drill-down links there. */
  href: string
}

export type PipelineFlagKind = 'stuck' | 'hold' | 'expiry' | 'overdue'

/** The loudest problem in a stage, worded for the board. */
export interface PipelineFlag {
  kind: PipelineFlagKind
  note: string
}

export type PipelineStageId =
  | 'receipts'
  | 'grading'
  | 'extraction'
  | 'blending'
  | 'packing'
  | 'qc'
  | 'samples'
  | 'stock'
  | 'orders'
  | 'dispatch'

export interface PipelineStage {
  id: PipelineStageId
  label: string
  /** True when the count is work waiting on somebody; false when it is what
   *  happened today (receipts, packing runs — stages with no open-work
   *  vocabulary of their own yet, counted as activity instead). */
  queue: boolean
  count: number
  rows: PipelineRow[]
  flag?: PipelineFlag
}

/** Batch statuses that mean the run is finished — everything else is open work. */
const CLOSED_BATCH = new Set(['Released', 'Rejected', 'Closed'])

/** Calendar days between two yyyy-mm-dd keys, negative when `from` is later. */
const ageDays = (from: string, today: string) =>
  Math.round((Date.parse(`${today}T00:00:00`) - Date.parse(`${from}T00:00:00`)) / 86_400_000)

/**
 * Work sitting open longer than this many days marks its stage a bottleneck.
 * DECISIONS #16: ASSUMED 2 days until the plant says otherwise.
 */
export const DEFAULT_PIPELINE_STUCK_DAYS = 2

export function pipelineStuckDays(config: { pipelineStuckDays?: number }): number {
  const n = Math.round(Number(config.pipelineStuckDays))
  return n >= 1 ? n : DEFAULT_PIPELINE_STUCK_DAYS
}

/** Days before expiry an intermediate counts as near-expiry (Config.expiryAlertDays). */
const nearExpiryDays = (config: { expiryAlertDays: number }) =>
  config.expiryAlertDays > 0 ? config.expiryAlertDays : 7

/** The board, in the order the work happens (§3.3). */
export function pipelineStages(state: AppState, today = toDateKey()): PipelineStage[] {
  const stuckDays = pipelineStuckDays(state.config)
  const alertDays = nearExpiryDays(state.config)

  // —— Receipts: what arrived today (activity — a GRN is complete when posted).
  const receipts = state.grns.filter((g) => g.date === today)

  // —— Grading: RAW lots received into staged mode still waiting their grades.
  //  Zero everywhere today: the plant grades at the door (embedded), and the
  //  staged form (WORKFLOW) is what starts writing these.
  const grading = state.grns.filter((g) => g.gradingMode === 'staged' && !g.gradedOn)

  // —— Extraction and blending: runs not yet Released or Rejected. A run with
  //  no verdict is 'Awaiting QC'; 'On Hold' and 'Partly Released' are open too.
  const openRuns = (kind: string) => state.batches.filter((b) => b.kind === kind && !CLOSED_BATCH.has(b.status))
  const extraction = openRuns('Extraction')
  const blending = openRuns('Melange')

  // —— Packing: runs posted today (activity — a run posts complete today).
  const packing = state.packingRuns.filter((r) => r.date === today)

  // —— QC: records without a verdict yet, oldest first for the aging note.
  const qc = state.qcs.filter((q) => q.disposition === 'Pending')
  const qcAged = qc
    .map((q) => ({ q, batch: state.batches.find((b) => b.id === q.batchId) }))
    .sort((a, b) => (a.batch?.date ?? '').localeCompare(b.batch?.date ?? ''))

  // —— Control samples: still kept and expiring inside the week (an expiry
  //  already past counts too — the shelf owes a destruction record either way).
  const sampleHorizon = addDays(today, 7)
  const samples = controlSampleRows(state, today).filter(
    (r) => r.status !== 'Destroyed' && !!r.sample.expiresOn && r.sample.expiresOn <= sampleHorizon,
  )

  // —— Stock: lots held (Quarantine status or a hold area) and intermediates
  //  nearing expiry — the two stock states that stop the line.
  const held = stockRows(state).filter((r) => r.qty > 0 && (r.status === 'Quarantine' || inHoldArea(state, r.location)))
  const expiryHorizon = addDays(today, alertDays)
  const nearExpiry = stockRows(state).filter(
    (r) => r.qty > 0 && r.itemType === 'Semi Finished' && !!r.expiry && r.expiry <= expiryHorizon,
  )
  const lowMaterials = lowStockItems(state, stockRows(state))

  // —— Orders: open, and whether the oldest is past its ship-by day.
  const openOrders = state.orders.filter((o) => o.status === 'Open')
  const overdue = openOrders.filter((o) => !!o.dueDate && o.dueDate < today)

  // —— Dispatch: gone out but not yet delivered.
  const inFlight = state.dispatches.filter((d) => d.status === 'Dispatched' || d.status === 'In Transit')

  // Bottleneck notes: the first honest problem per stage, as a sentence.
  const stuckNote = (runs: typeof extraction): PipelineFlag | undefined => {
    const oldest = runs.reduce<string | undefined>((acc, b) => (!acc || b.date < acc ? b.date : acc), undefined)
    if (!oldest) return undefined
    const age = ageDays(oldest, today)
    return age >= stuckDays ? { kind: 'stuck', note: `Oldest run open ${age} days (over ${stuckDays}-day mark)` } : undefined
  }
  const qcNote = (): PipelineFlag | undefined => {
    const oldest = qcAged[0]?.batch?.date
    if (!oldest) return undefined
    const age = ageDays(oldest, today)
    return age >= stuckDays ? { kind: 'stuck', note: `Oldest verdict waiting ${age} days` } : undefined
  }

  return [
    {
      id: 'receipts',
      label: 'Receipts',
      queue: false,
      count: receipts.length,
      rows: receipts.map((g) => ({
        id: g.id,
        label: g.lot,
        detail: g.farmerName,
        status: g.status,
        date: g.date,
        href: '/procurement',
      })),
    },
    {
      id: 'grading',
      label: 'Grading',
      queue: true,
      count: grading.length,
      rows: grading.map((g) => ({ id: g.id, label: g.lot, detail: g.farmerName, status: 'Pending', date: g.date, href: '/procurement?tab=grading' })),
    },
    {
      id: 'extraction',
      label: 'Extraction',
      queue: true,
      count: extraction.length,
      // rows land on the Extraction stage form with the run picked — the close
      // (spoilage filed, balance stamped) is the action a waiting run owes
      rows: stageRows(extraction).map((r) => ({ ...r, href: `/production?stage=run&run=${r.id}` })),
      flag: stuckNote(extraction),
    },
    {
      id: 'blending',
      label: 'Blending',
      queue: true,
      count: blending.length,
      rows: stageRows(blending),
      flag: stuckNote(blending),
    },
    {
      id: 'packing',
      label: 'Packing',
      queue: false,
      count: packing.length,
      rows: packing.map((r) => ({
        id: r.id,
        label: r.id,
        detail: r.lines.length === 1 ? `${r.lines[0].packs} packs` : `${r.lines.length} lines`,
        status: r.status,
        date: r.date,
        href: '/packing',
      })),
    },
    {
      id: 'qc',
      label: 'QC',
      queue: true,
      count: qc.length,
      rows: qcAged.map(({ q, batch }) => ({
        id: q.id,
        label: q.item ? itemName(state, q.item) : q.batchId,
        detail: q.batchId,
        status: q.disposition,
        date: batch?.date,
        href: '/quality',
      })),
      flag: qcNote(),
    },
    {
      id: 'samples',
      label: 'Control samples',
      queue: true,
      count: samples.length,
      rows: samples.map((r) => ({
        id: r.key,
        label: r.product,
        detail: `Batch ${r.run.batchId}`,
        status: r.status,
        date: r.sample.expiresOn,
        href: '/control-samples',
      })),
      flag: samples.some((r) => r.status === 'Expired')
        ? { kind: 'expiry', note: 'Samples past expiry still on the shelf' }
        : undefined,
    },
    {
      id: 'stock',
      label: 'Stock',
      queue: true,
      count: held.length + nearExpiry.length,
      rows: [
        ...held.map((r) => ({
          id: `${r.lot}/${r.location}`,
          label: itemName(state, r.item),
          detail: `${r.lot} · ${r.location}`,
          status: 'On Hold',
          href: '/inventory',
        })),
        ...nearExpiry.map((r) => ({
          id: `${r.lot}/${r.location}`,
          label: itemName(state, r.item),
          detail: `${r.lot} · expires ${r.expiry}`,
          status: r.expiry! < today ? 'Failed' : 'Pending',
          date: r.expiry,
          href: '/inventory',
        })),
      ],
      flag: held.length
        ? { kind: 'hold', note: `${held.length} lot${held.length === 1 ? '' : 's'} on hold` }
        : nearExpiry.length
          ? { kind: 'expiry', note: `${nearExpiry.length} intermediate lot${nearExpiry.length === 1 ? '' : 's'} near expiry` }
          : lowMaterials.length
            ? { kind: 'overdue', note: `${lowMaterials.length} material${lowMaterials.length === 1 ? '' : 's'} below reorder` }
            : undefined,
    },
    {
      id: 'orders',
      label: 'Orders',
      queue: true,
      count: openOrders.length,
      rows: openOrders.map((o) => ({
        id: o.id,
        label: o.customerName,
        detail: o.dueDate ? `ship by ${o.dueDate}` : 'no ship-by date',
        status: o.status,
        date: o.dueDate,
        href: '/orders',
      })),
      flag: overdue.length ? { kind: 'overdue', note: `${overdue.length} order${overdue.length === 1 ? '' : 's'} past ship-by` } : undefined,
    },
    {
      id: 'dispatch',
      label: 'Dispatch',
      queue: true,
      count: inFlight.length,
      rows: inFlight.map((d) => ({
        id: d.id,
        label: d.customerName,
        detail: `challan ${d.challan}`,
        status: d.status,
        date: d.dispatchTime,
        href: '/dispatch',
      })),
    },
  ]
}

function stageRows(runs: { id: string; date: string; status: string }[]): PipelineRow[] {
  return [...runs]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((b) => ({ id: b.id, label: b.id, status: b.status, date: b.date, href: `/batch/${b.id}` }))
}

/**
 * Where each role lands when the pipeline flag is on (RBAC §a). A caller
 * holding exactly one of the stage slugs lands on their stage; a caller
 * holding none (the open tier) or several (manager, admin) lands on the board
 * itself. Held slugs read like the session's permission list.
 */
const LANDING_SLUGS: readonly [slug: string, path: string][] = [
  ['page.procurement', '/procurement'],
  ['page.production', '/production'],
  ['page.packing', '/packing'],
  ['page.quality', '/quality'],
  ['page.dispatch', '/dispatch'],
  ['page.npd', '/npd'],
]

export function roleLandingPath(held: readonly string[]): string {
  const mine = LANDING_SLUGS.filter(([slug]) => held.includes(slug))
  return mine.length === 1 ? mine[0][1] : '/pipeline'
}
