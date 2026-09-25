export const APP_KEY = 'roligt_foods_ops_v1'

/**
 * How close two quantities have to be to count as the same number.
 *
 * Every quantity in the app is a float — litres, kilograms, a pack size converted
 * from millilitres — so `a + b === c` is not a question binary floating point can
 * answer. This is the tolerance every comparison of two quantities goes through, in
 * one place so the checks cannot drift apart from each other.
 */
export const QTY_EPSILON = 0.00001

/** Whether two quantities are the same number, to within `QTY_EPSILON`. */
export const sameQty = (a: number, b: number) => Math.abs((a || 0) - (b || 0)) <= QTY_EPSILON

/**
 * A quantity, printed. Trailing zeros trimmed, so forty packs read "40" rather than
 * "40.00" — which is what `fmtByUom` and every figure derived from it already did,
 * while several tables spelled it out longhand and disagreed with them.
 */
export const fmtQty = (n: number, places = 2) => String(Number((Number(n) || 0).toFixed(places)))

/** Whether `wanted` fits inside `available`, to within `QTY_EPSILON`. */
export const fitsWithin = (wanted: number, available: number) =>
  (wanted || 0) <= (available || 0) + QTY_EPSILON

/**
 * One word per state, wherever it is shown. The ledger, the QC record and the batch
 * each stored their own name for the same moment — stock said 'Quarantine', the QC
 * record said 'Pending' and the batch said 'Awaiting QC'. The stored values stay put,
 * because they are keys the whole history is written in; only the reading changes.
 */
const STATUS_LABELS: Record<string, string> = {
  Quarantine: 'Awaiting QC',
  Pending: 'Awaiting QC',
  Suspended: 'Inactive',
  Retired: 'Inactive',
  Approved: 'Active',
}

export const statusLabel = (value: string) => STATUS_LABELS[value] || value

export const PAGES: Record<string, [string, string]> = {
  dashboard: ['Plant Dashboard', 'Single source of truth from farmer lot to customer delivery.'],
  procurement: [
    'Procurement',
    'Everything received at the gate. Farm produce is graded and landed into its own traceable lot; packing material is booked in against the supplier and the rate every packing run will cost itself at.',
  ],
  roster: ['Staff Roster', 'Who is on which shift, and who turned up.'],
  'production-planning': [
    'Production Planning',
    'What must ship, what that leaves to make, and the week that makes it.',
  ],
  production: [
    'Production',
    'Two stages, one page. Extraction presses produce into bulk; a melange blends that bulk to a recipe. Either way you get a batch with its own lot, its own QC and its own packs.',
  ],
  packing: [
    'Packing',
    'Fill packs from a batch or melange run\'s bulk output to create finished goods.',
  ],
  quality: [
    'Quality Control',
    'Each product a batch made is tested on its own — the coconut water and the malai from one pressing are two records, and either can be released while the other waits. Pass every test needed for release to release a product; a fail on any test marks its stock Rejected where it stands, so it can no longer be packed, blended or dispatched.',
  ],
  'control-samples': [
    'Control Samples',
    'The bottles kept back off each packing run — who collected them, when they expire and when they were destroyed. Never stock; kept as a record.',
  ],
  reports: ['Lab Reports', 'Generate lab test reports and sensory evaluations for a batch, then attach them to QC.'],
  'live-reports': [
    'Live Reports',
    'Every operational figure derived straight off the records, over any range you point them at — nothing stored, so nothing to reconcile.',
  ],
  orders: [
    'Orders',
    'What each customer asked for. Raised once the goods are packed and cleared, and sent out complete on one challan.',
  ],
  dispatch: ['Dispatch & Delivery', 'Released stock only. Deduct at dispatch, not delivery.'],
  inventory: ['Inventory', 'Transaction-driven stock by item, lot, batch, status and storage area.'],
  'packing-materials': [
    'Packing Materials',
    'What is on hand of every BiB, bottle, cap and carton, and how much of it is left against the level somebody set. Received on the Procurement page.',
  ],
  'stock-issues': [
    'Stock Issues',
    'Stock out for something that is not a sale — lab samples, BTL activities, breakage and write-offs. No customer, no challan, no dispatch label.',
  ],
  storage: [
    'Storage',
    'Every storage area the plant keeps stock in. What an area is — cold room, dry store or hold area — decides what may go into it: bulk only ever into a cold room, and only stock QC has rejected into a hold area.',
  ],
  stickers: [
    'Stickers',
    'Print the lot details for anything in the plant — a crate of produce, a batch of bulk, a filled pack, a carton going out. Pick the stage, pick the record, print.',
  ],
  traceability: ['Traceability', 'Farmer to customer, and customer back to source.'],
  vendors: [
    'Suppliers',
    'Everyone you buy from, in one directory — farmers who grow produce and vendors who supply materials.',
  ],
  customers: ['Customers', 'Ship-to accounts and customer master data.'],
  'purchase-products': [
    'Products & Materials',
    'Everything the plant handles, in the order it handles it: what you buy, what you press it into, the blends you make from that, the materials a pack consumes, and the packs themselves. Every one of them is created here and nowhere else.',
  ],
  'test-parameters': [
    'Test Parameters',
    'The report types a product is tested on and what each one tests — parameters for a lab certificate, weighted attributes for a scored evaluation.',
  ],
  settings: ['Settings', 'Operational tolerances and plant configuration.'],
  audit: ['Audit Log', 'Every posting, in order. Entries are never edited or removed.'],
  'admin-users': [
    'Users',
    'Who can sign in to Operations Control, and in what state their access is. Accounts and roles live in WorkOS; every change here is audited.',
  ],
  'admin-roles': [
    'Roles & Permissions',
    'A role is a named bundle of permissions. Tick what each role may do — changes take effect on each user’s next sign-in.',
  ],
}

export const nowISO = () => new Date().toISOString()

/**
 * A calendar date as `2026-09-09`, read off the local clock.
 *
 * `toISOString().slice(0, 10)` looks like the same thing and is not: it is the date
 * in UTC, which in IST is the previous day until half past five in the morning. A
 * plant that takes in an early harvest, prints a shelf life and files a lot by date
 * needs the date on its own wall, not the one in Greenwich.
 */
export function toDateKey(d: Date = new Date()) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * The local calendar day of a stored date or timestamp. A timestamp saved with
 * `toISOString()` is in UTC, so the first ten characters of it are the day in Greenwich —
 * the previous day here until half past five in the morning, the same trap as above.
 */
export function localDay(s?: string): string {
  if (!s) return ''
  if (!s.includes('T')) return s.slice(0, 10)
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? s.slice(0, 10) : toDateKey(d)
}

export const inr = (n: number) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(Number(n || 0))

export const fmtDate = (s?: string) =>
  s
    ? new Date(s).toLocaleString('en-IN', {
        dateStyle: 'medium',
        timeStyle: s.includes('T') ? 'short' : undefined,
      })
    : ''

/**
 * Sequence within a millisecond. Ids are generated in bursts — reversing a batch
 * re-posts every ledger line it wrote in one go — and inside a single millisecond a
 * timestamp distinguishes nothing, so the counter does.
 */
let uidSeq = 0

/**
 * An internal key: a ledger line, a stock move, a test parameter.
 *
 * This used to be six base-36 characters of `Math.random`, which is two billion
 * possibilities and therefore a coin-flip that two of them collide by the
 * fifty-thousandth row — around ninety per cent by the hundred-thousandth. That was
 * survivable while the whole plant was one JSON blob, because nothing keyed on these:
 * stock is folded by item, lot, location, status and expiry, and a document is
 * reversed by its `doc`. It stopped being survivable the moment the ledger became a
 * table with `id` as its primary key, where a repeat means one line silently upserts
 * over another and the stock it represented is simply gone.
 *
 * A millisecond timestamp, a counter within it, and eight random characters. Two ids
 * now collide only if the same millisecond, the same slot in it, and one in three
 * quadrillion all coincide. The timestamp leading also makes them sort roughly in the
 * order they were written, which is a free convenience when reading the table by hand.
 */
export const uid = (p: string) => {
  uidSeq = (uidSeq + 1) % 46656 // 36^3
  return [
    p,
    Date.now().toString(36),
    uidSeq.toString(36).padStart(3, '0'),
    Math.random().toString(36).slice(2, 10).padEnd(8, '0'),
  ]
    .join('-')
    .toUpperCase()
}

export const deepClone = <T,>(o: T): T => JSON.parse(JSON.stringify(o))

export function statusClass(s?: string) {
  const v = (s || '').toLowerCase()
  // Every rule below is a substring match, and "inactive" contains "active" — a
  // deactivated supplier, customer or melange was painting itself the same healthy
  // green as an active one. It is settled first, before anything can match it.
  if (v.includes('inactive')) return 'neutral'
  if (
    [
      'pass',
      'passed',
      'posted',
      'released',
      'delivered',
      'accepted',
      'active',
      'approved',
      'done',
    ].some((x) => v.includes(x)))
    return 'success'
  // "reject" rather than "rejected", so a sensory decision to reject / hold reads as the
  // failure it is and not as the amber of an ordinary hold.
  if (['fail', 'reject', 'reversed', 'expired', 'destroyed'].some((x) => v.includes(x)))
    return 'danger'
  if (
    [
      'pending',
      'quarantine',
      'awaiting',
      'hold',
      'retest',
      'in transit',
      'planned',
    ].some((x) => v.includes(x))
  )
    return 'warning'
  if (['dispatched', 'picked', 'sampled', 'in test', 'in progress'].some((x) => v.includes(x)))
    return 'info'
  return 'neutral'
}

export function toLocalInputValue(d = new Date()) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
