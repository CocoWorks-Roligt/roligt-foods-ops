/**
 * Onboarding (WORKFLOW W16, behind the `pipeline` flag): the first-run tour's
 * steps, the one-line answer to "what is this screen for" that feeds the
 * sidebar tooltips and the cheat sheet, and the pipeline stage tiles' own
 * tooltips. Pure data and folds — no React, no browser globals (the
 * isomorphic-lib law) — so the words live in exactly one place and the
 * component layer only decides placement.
 *
 * The tooltips and the cheat sheet read PAGE_HELP; the tour anchors itself
 * with `data-tour` attributes the shell stamps on its own chrome (Layout,
 * Pipeline board). A step whose anchor is not on screen renders as a plain
 * centered card rather than being hidden — the words still teach, and the
 * tour never depends on viewport.
 */
import type { ViewId } from '../types.ts'

/**
 * One line per page in the catalog — the sidebar tooltip, the cheat-sheet
 * row, and the answer to "what is this screen for", all the same words. The
 * test pins every catalog row to a line, so a page can never ship without
 * its one-liner.
 */
export const PAGE_HELP: Partial<Record<ViewId, string>> = {
  dashboard: 'The day at a glance — arrivals, runs, and what waits.',
  pipeline: 'The whole process as one board — what waits where, bottlenecks first.',
  procurement: 'Buy and receive: purchase orders, goods receipts, coconut grading.',
  roster: 'Who is in today.',
  'production-planning': 'What the week will produce.',
  production: 'Runs and batches — pressings, blends, packing runs, batch detail.',
  quality: 'The QC bench: verdicts and holds, with the test-entry queue on its own tab.',
  'control-samples': 'Kept-back samples, and the destruction shelf they owe before expiry.',
  packing: 'The packing register — every run posted, glass bottles and loose BIB pouches.',
  orders: 'The order desk — raise an order, fill it, dispatch it.',
  dispatch: 'Dispatches in flight — each owes its proof of delivery.',
  shipments: 'Everything that left the gate — trips, delivery agents, signed challans.',
  'my-deliveries': 'Your own trips for today — confirm lines, take the signature, submit.',
  inventory: 'Stock by lot — balances, moves, and where everything sits.',
  'packing-materials': 'Bottles, pouches, caps, labels, cartons — with min/max reorder.',
  'stock-issues': 'Stock that left for reasons other than production.',
  storage: 'Areas and rooms — where stock may sit and what each is for.',
  npd: 'What production handed to new product development, and what it was used for.',
  stickers: 'Print lot and batch labels.',
  traceability: 'Lot ↔ batch genealogy, forward and backward.',
  reports: 'Lab reports and certificates — raise, review, attach.',
  'live-reports': 'Live dashboards (the overhaul’s “Dashboards”).',
  audit: 'Who changed what, when — every write, old value to new.',
  vendors: 'The supplier master.',
  customers: 'The customer master.',
  'purchase-products': 'The product & material master — procurement form, storage condition.',
  'test-parameters': 'The QC test definitions the bench fills against.',
  compliance: 'Licences and permits — expiries and reminders.',
  settings: 'Tolerances, numbering, and the plant’s other config.',
  'admin-users': 'Accounts and sign-in.',
  'admin-roles': 'Tick the pages each role holds — a tick carries that page’s writes.',
}

/**
 * The pipeline board's own tooltips (Pipeline.tsx tiles): what a tile's count
 * means and what its rows owe. Keyed by the stage ids pipelineStages emits —
 * the same ids the board and its tests pin.
 */
export const STAGE_HELP: Record<string, string> = {
  receipts: 'Loads booked today. A staged load moves on to Grading.',
  grading: 'Staged coconut lots that owe their grade split.',
  extraction: 'Pressing runs still open — a run leaves when it is closed (spoilage filed, balance stamped).',
  blending: 'Blend runs still open — a run leaves when it is closed (spoilage filed, balance stamped).',
  packing: 'Packing runs posted today. A run posts complete — nothing is left open.',
  qc: 'QC records awaiting a verdict, oldest first.',
  samples: 'Kept samples inside their 7-day window — destruction due before expiry.',
  stock: 'Lots on hold or near expiry, and materials below reorder.',
  orders: 'Open orders, soonest ship-by first.',
  dispatch: 'Dispatches that have left and not yet closed with a proof of delivery.',
}

export interface TourStep {
  id: string
  title: string
  body: string
  /** `data-tour` selector the spotlight tries; absent or hidden → centered card. */
  anchor?: string
  /** Step shown only when the caller holds one of these pages. */
  pages?: ViewId[]
}

/**
 * The first-run tour: six pointers, two minutes, in the order a new operator
 * meets the shell. Anchors are the shell's own chrome (Layout stamps
 * `data-tour`); no step anchors inside a routed page, so the tour works from
 * any screen it starts on.
 */
const TOUR: TourStep[] = [
  {
    id: 'welcome',
    title: 'The plant, in order',
    body: 'The screens are rearranged into the order the work happens: what arrived, what was made, what was checked, what is left, what shipped. Six quick pointers — about two minutes.',
  },
  {
    id: 'pipeline',
    title: 'Start on Pipeline',
    body: 'Every stage with what waits in it, bottlenecks called out first, one click to the records. The counts match the sidebar badges, and both move live.',
    anchor: '[data-tour="pipeline"]',
    pages: ['pipeline'],
  },
  {
    id: 'nav',
    title: 'The sidebar follows the process',
    body: 'What arrived, what was made, what was checked, what is left, what shipped — with live counts beside the waiting work. On a phone the same list sits behind More.',
    anchor: '[data-tour="nav-process"]',
  },
  {
    id: 'search',
    title: 'Find anything — Ctrl or ⌘ + K',
    body: 'Lots, runs, orders, customers, suppliers, storage locations. Type two letters, land on the thing.',
    anchor: '[data-tour="search"]',
  },
  {
    id: 'forms',
    title: 'Every stage has its own form',
    body: 'Receive goods, grade coconuts, run a pressing, run a blend, pack, enter QC results, put stock away, take an order, dispatch it. Each form asks only what that stage owes, prefilled from the one before — and a scanner gun fills any lot field.',
  },
  {
    id: 'trust',
    title: 'It keeps your work',
    body: 'A half-filled form comes back after a closed tab (drafts are held on this device). Offline entries are held and sync when the signal returns. Dark and light both work.',
    anchor: '[data-tour="theme"]',
  },
  {
    id: 'help',
    title: 'Help lives here',
    body: 'Replay this tour, open your cheat sheet — one line for every screen you hold — or send feedback (it copies to your clipboard, ready to paste to your admin).',
    anchor: '[data-tour="help"]',
  },
]

/** The tour steps this caller should see, in order (page-gated steps dropped). */
export function tourSteps(allowed: readonly ViewId[]): TourStep[] {
  const held = new Set(allowed)
  return TOUR.filter((s) => !s.pages || s.pages.some((p) => held.has(p)))
}

/** One cheat-sheet row per page the caller holds that has help words. */
export function cheatSheetRows(
  allowed: readonly { id: ViewId; label: string }[],
): { id: ViewId; label: string; line: string }[] {
  return allowed.flatMap(({ id, label }) => {
    const line = PAGE_HELP[id]
    return line ? [{ id, label, line }] : []
  })
}
