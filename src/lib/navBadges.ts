/**
 * Sidebar live badges (ARCHITECTURE §1): the count of things waiting on each
 * page of the process, folded from the plant the tab already holds. Pure on
 * purpose — Layout memoises it over `state`, and the same fold is trivially
 * testable without a renderer.
 *
 * Every predicate here is the page's own existing definition of "needs
 * somebody", not a new rule invented for the badge: QC counts records without
 * a verdict, Orders counts status 'Open', batches roll up through
 * batchRollUp's vocabulary, materials sit below their reorder level. Items
 * whose waiting-state has no vocabulary yet (Packing runs, Dispatch staging,
 * Inventory reorder for finished goods, Home's holds+aging) carry no badge
 * until their phase gives them one — a missing badge is honest, a wrong one
 * trains people to ignore the column.
 */
import { lowStockItems } from './alerts.ts'
import { addDays, controlSampleRows } from './controlSamples.ts'
import { stockRows } from './stock.ts'
import { toDateKey } from './utils.ts'
import type { AppState, ViewId } from '../types.ts'

export type NavBadges = Partial<Record<ViewId, number>>

/** Batch statuses that mean the run is finished — everything else is open work.
 *  'Closed' is what the run-close endpoint stamps (W8's form). */
const CLOSED_BATCH = new Set(['Released', 'Rejected', 'Closed'])

export function navBadges(state: AppState, today = toDateKey()): NavBadges {
  const out: NavBadges = {}
  const add = (id: ViewId, n: number) => {
    if (n > 0) out[id] = n
  }

  // Procurement and Packing Materials share the one list that matters to both:
  // packing material standing below its reorder level (lowStockItems walks the
  // materials, not the lots, so three healthy lots of a short material is one
  // alert, and a never-bought material is none).
  const lowMaterials = lowStockItems(state, stockRows(state)).length
  add('procurement', lowMaterials)
  add('packing-materials', lowMaterials)

  // Production hosts both stages today (Extraction and blend runs): extraction
  // batches not yet Released or Rejected are runs still open, blend batches
  // still 'Awaiting QC' are blends waiting on their verdict.
  const inFlight = state.batches.filter((b) => b.kind === 'Extraction' && !CLOSED_BATCH.has(b.status))
  const blendsAwaitingQc = state.batches.filter((b) => b.kind === 'Melange' && b.status === 'Awaiting QC')
  add('production', inFlight.length + blendsAwaitingQc.length)

  // Quality Control: records without a verdict yet.
  add('quality', state.qcs.filter((q) => q.disposition === 'Pending').length)

  // Control Samples: bottles still kept whose expiry is within the week — an
  // expiry already past counts too, because the shelf owes a destruction
  // record either way; a destroyed bottle never does.
  const horizon = addDays(today, 7)
  add(
    'control-samples',
    controlSampleRows(state, today).filter(
      (r) => r.status !== 'Destroyed' && !!r.sample.expiresOn && r.sample.expiresOn <= horizon,
    ).length,
  )

  // Orders: open orders waiting to be filled.
  add('orders', state.orders.filter((o) => o.status === 'Open').length)

  return out
}
