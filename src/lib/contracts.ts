/**
 * The frozen contracts for the overhaul — docs/overhaul/ARCHITECTURE.md §8.
 *
 * Everything Phase 2 onwards builds against: the new entities, the state
 * machines the server enforces, and the request/response shapes of the new
 * dedicated endpoints. BACKEND implements this file, SHELL renders it, and
 * neither changes it — a change after freeze needs LEAD approval and a minor
 * version bump, recorded in ARCHITECTURE.md.
 *
 * v1.9 (2026-10-15, LEAD-approved additive delta — SHIPMENT B5a):
 * - The shipment read/PATCH wire: ShipmentVersionExtension (documents.version
 *   as a response-only ride-along, the PO's v1.4 rules verbatim), ShipmentLine
 *   (a dispatch row flattened for the board and the PWA), ShipmentChallanLink,
 *   ShipmentDetail / ShipmentListResponse / ShipmentEventsResponse for the
 *   GETs, and PatchShipmentRequest / PatchShipmentResponse for the board's
 *   reassign/ETA/vehicle moves and its two own status arrows
 *   (Created→Dispatched, Failed→Rescheduled). The four outcomes of Out for
 *   Delivery stay the submit endpoint's alone. CreateShipmentResponse and
 *   PatchShipmentResponse carry the ride-along too, so the board holds a CAS
 *   token from the moment a trip exists. The challan wire joins the same
 *   delta: ChallanListResponse, and ChallanCorrectRequest/Response for the
 *   supersede correction.
 * v1.8 (2026-10-14, LEAD-approved additive delta — WORKFLOW close-out):
 * - CommitVersionRide — POST /api/commit's response carries `versions`
 *   (table → row id → the documents.version the commit left each written row
 *   at; D1 engine only, absent when nothing was written). The saving client
 *   stamps these onto its own grns/batches at save-success: feed-degraded, the
 *   revision poll never re-reads the bump a device itself caused, so the
 *   versioned copy of its own write only ever arrived with somebody else's —
 *   and the follow-up calls that wait on it (the receipt→PO link's grn lookup,
 *   the run close's expectedVersion) stalled until another writer moved the
 *   plant. Found by HEAVY Journey A in the local harness, which runs the
 *   designed poll-fallback path (the SSE feed 404s there by design).
 * v1.7 (2026-10-14, LEAD-approved additive delta — WORKFLOW W8):
 * - BatchVersionExtension — the snapshot ride-along v1.6 gave grns now covers
 *   batches too, for the same reason and under the same rules: the Extraction
 *   stage form's POST /api/transformations/close needs the batch's
 *   expectedVersion, the column is attached at snapshot parse and overwrites
 *   any stale embedded value, and no write path consults the field.
 * v1.6 (2026-10-14, LEAD-approved additive delta — WORKFLOW W7):
 * - GrnVersionExtension — the D1 snapshot's grns carry their documents.version
 *   as a read-only ride-along, so the grading form's POST /api/grading can read
 *   the expectedVersion it must send (the client state carried no versions; a
 *   GET was the alternative, but one snapshot read already answers). The column
 *   stays the only truth: the value is attached at snapshot-parse time and
 *   overwrites whatever a round-tripped document embedded, and the stored json
 *   never needs it.
 * v1.5 (2026-10-13, LEAD-approved additive delta — WORKFLOW W5):
 * - POST /api/purchase-orders/:id/receive — the Receipt form books a GRN
 *   against its PO: PurchaseOrderReceiveRequest / PurchaseOrderReceiveResponse.
 *   Links the GRN (receivedGrnIds, append-once) and lands an acknowledged PO in
 *   received (the machine's own arrow); sent/draft POs refuse until acknowledged.
 * v1.4 (2026-10-13, LEAD-approved additive delta — WORKFLOW W4):
 * - PurchaseOrderVersionExtension — every PO the endpoints RETURN carries its
 *   documents.version, so the PO form's status moves can CAS-protect themselves
 *   (PATCH's expectedVersion had nothing to read on the v1.3 wire). Stored PO
 *   documents stay version-less; the version rides responses only.
 * v1.3 (2026-10-13, LEAD-approved additive delta — WORKFLOW W3):
 * - Purchase order wire shapes: PurchaseOrderCreateRequest / PurchaseOrderPatchRequest
 *   / PurchaseOrderResponse / PurchaseOrderListResponse for POST /api/purchase-orders,
 *   PATCH /api/purchase-orders/:id and GET /api/purchase-orders. The PurchaseOrder
 *   document itself was already frozen above (statuses lowercase, `po` counter).
 * v1.2 (2026-10-13, LEAD-approved additive delta — B4):
 * - RevisionEvent — the GET /api/events SSE stream's one message (event names
 *   hello / revision / bye; heartbeats are comments; poll fallback stays
 *   GET /api/revision). The KPI wire shape itself was already frozen above.
 * v1.1 (2026-10-13, LEAD-approved post-freeze deltas — additive only):
 * - MelangeExtension + recipeId?: string (B1 backfill stamps melanges so
 *   versioned edits keep their lineage).
 * - DispatchConfirmResponse + challan?: string (B3 returns the reserved DC
 *   number; contracts predated returning it).
 * - Naming record: ItemExtension.avgUnitWeight is the as-built name for the
 *   per-material count→kg conversion (B1 task text said otherwise); code and
 *   this file agree, no type change.
 *
 * Additions to existing entities are declared as `…Extension` partials meant to
 * be overlaid on the src/types.ts shape (`Item & ItemExtension`), never as edits
 * to it, so the Classic app keeps compiling against the old types until its
 * flag flips. Every field is optional on read: rows written before the overhaul
 * simply do not carry it yet.
 *
 * Types, constants and pure type-guards only — no behaviour, and nothing
 * imported from api/. The one runtime thing here is the guard set at the bottom,
 * so client and server parse the same wire data with the same definitions.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. Vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How a material enters the plant (ARCHITECTURE §2, items):
 * RAW needs in-house extraction (coconuts, lemons, fruit); READY_EXTRACT is
 * procured juice or tea extract that skips extraction into inventory;
 * DIRECT_USE — powders, stabilisers, sweeteners — goes straight to blending.
 */
export const PROCUREMENT_FORMS = ['RAW', 'READY_EXTRACT', 'DIRECT_USE'] as const
export type ProcurementForm = (typeof PROCUREMENT_FORMS)[number]

/** The physical condition a material must be kept under. Malai is ASSUMED
 *  chilled, not frozen — DECISIONS #4. */
export const STORAGE_CONDITIONS = ['ambient', 'cold', 'frozen'] as const
export type StorageCondition = (typeof STORAGE_CONDITIONS)[number]

/** The storage zones stock can sit in — a zone per storage location, on top of
 *  today's StorageType so the Cold Room/Dry/Hold mapping stays label-only. */
export const STORAGE_ZONES = ['ambient', 'cold_room', 'quarantine', 'dispatch_staging'] as const
export type StorageZone = (typeof STORAGE_ZONES)[number]

/**
 * What a batch output IS in the chain (§3.2): MAIN carries the cost, a
 * CO_PRODUCT is a second saleable output, a BY_PRODUCT leaves nearly free, and
 * an INTERMEDIATE (coconut milk) is stock downstream blends consume instead of
 * re-consuming what made it.
 */
export const OUTPUT_TYPES = ['MAIN', 'CO_PRODUCT', 'BY_PRODUCT', 'INTERMEDIATE'] as const
export type OutputType = (typeof OUTPUT_TYPES)[number]

/** The production stage a spoilage record belongs to. Reason codes are
 *  per-stage editable reference data — DECISIONS #3. */
export const SPILLAGE_STAGES = ['extraction', 'blend', 'fill'] as const
export type SpoilageStage = (typeof SPILLAGE_STAGES)[number]

/** How a customer's BIB pouches leave the plant: BOXED (pouches + cartons),
 *  LOOSE (carton stock untouched), or ASK at pick/pack (the default). */
export const DISPATCH_PACKAGING = ['BOXED', 'LOOSE', 'ASK'] as const
export type DispatchPackaging = (typeof DISPATCH_PACKAGING)[number]

/** The two first-class pack formats a SKU fills. */
export const PACK_FORMATS = ['glass', 'bib'] as const
export type PackFormat = (typeof PACK_FORMATS)[number]

/** BIB pouch sizes the plant fills, in litres. */
export type BibSize = 1 | 2.5 | 5

/** Whether a GRN's grades were typed on the receipt (today's only mode) or
 *  entered later through the staged grading form (pipeline flag). */
export const GRADING_MODES = ['embedded', 'staged'] as const
export type GradingMode = (typeof GRADING_MODES)[number]

/** Lifecycle of a versioned recipe template (blend recipes; no DSL, plain
 *  data). An edit creates a new version row; the old one stays for history. */
export const RECIPE_STATUSES = ['draft', 'active', 'retired'] as const
export type RecipeStatus = (typeof RECIPE_STATUSES)[number]

/** FEFO strictness — pick lists are FEFO-sorted today; enforcement is
 *  configurable (DECISIONS #8). */
export const FEFO_MODES = ['strict', 'relaxed'] as const
export type FefoMode = (typeof FEFO_MODES)[number]

// ─────────────────────────────────────────────────────────────────────────────
// 2. New entities (new wire tables — server-endpoint-only, never client
//    changeset tables, so no dual-write divergence; ARCHITECTURE §5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The mandatory spoilage record: a batch cannot close without one, and an
 * explicit zero (qty 0) satisfies the rule — §3.2. What a batch already books
 * as `spoiled`/`wastage` keeps its meaning; this is the reason-coded record on
 * top of it.
 */
export interface SpoilageRecord {
  id: string
  batchId: string
  stage: SpoilageStage
  /** Zero is a valid, deliberate entry. */
  qty: number
  uom: string
  /** Key into `spoilage_reasons` for this stage. */
  reasonCode: string
  /** R2 object key of the photo, when one was taken. */
  photoKey?: string
  at: string
  actor: string
}

/**
 * One editable reason code. Codes are per stage; 'any' applies to every stage
 * (QC reject). Seeded from DECISIONS #3, edited as reference data thereafter.
 */
export interface SpoilageReason {
  stage: SpoilageStage | 'any'
  code: string
  label: string
  active: boolean
}

/** The seed rows for `spoilage_reasons` — DECISIONS #3 defaults. */
export const SPOILAGE_REASON_SEEDS = [
  { stage: 'extraction', code: 'rotten', label: 'Rotten', active: true },
  { stage: 'extraction', code: 'cracked', label: 'Cracked', active: true },
  { stage: 'extraction', code: 'overripe', label: 'Overripe', active: true },
  { stage: 'extraction', code: 'pulp_loss', label: 'Pulp loss', active: true },
  { stage: 'blend', code: 'spillage', label: 'Spillage', active: true },
  { stage: 'blend', code: 'burst_pouch', label: 'Burst pouch', active: true },
  { stage: 'blend', code: 'line_loss', label: 'Line loss', active: true },
  { stage: 'fill', code: 'spillage', label: 'Spillage', active: true },
  { stage: 'fill', code: 'burst_pouch', label: 'Burst pouch', active: true },
  { stage: 'fill', code: 'line_loss', label: 'Line loss', active: true },
  { stage: 'any', code: 'qc_reject', label: 'QC reject', active: true },
] as const satisfies readonly SpoilageReason[]

/**
 * The pouch-to-carton configuration: which carton packing-material item a BIB
 * size fills into, and how many pouches fit. Seeded per DECISIONS #14, edited
 * as reference data at rollout.
 */
export interface CartonSpec {
  id: string
  bibSize: BibSize
  cartonItemId: string
  pouchesPerCarton: number
  active: boolean
}

/**
 * A purchase order raised on a vendor — the upstream document the plant has
 * never had (AUDIT §6: "No POs"). Receipts link back through `receivedGrnIds`,
 * which is what the PO funnel, supplier on-time and lead-time KPIs fold
 * (KPI.md). Statuses lowercase, like the event vocabulary.
 */
export interface PurchaseOrderLine {
  item: string
  qty: number
  uom: string
  rate: number
}

export const PURCHASE_ORDER_STATUSES = [
  'draft',
  'sent',
  'acknowledged',
  'received',
  'closed',
  'cancelled',
] as const
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number]

export interface PurchaseOrder {
  id: string
  /** From the PO counters series. */
  number: string
  vendorId: string
  lines: PurchaseOrderLine[]
  status: PurchaseOrderStatus
  /** Day the vendor promised delivery. */
  expectedOn?: string
  /** GRNs booked against this PO — several part-receipts is the normal case. */
  receivedGrnIds: string[]
}

/** One multi-stop trip carrying one order's dispatches out the gate. */
export interface Shipment {
  id: string
  orderId: string
  dispatchIds: string[]
  agentUserId?: string
  vehicle: string
  status: ShipmentStatus
  eta?: string
  stops: ShipmentStop[]
  times: ShipmentTimes
  /** Roll-up of the packaging decisions on its dispatch lines. */
  packaging: ShipmentPackaging
  /** Set by the submit endpoint; its presence is what "delivered" means. */
  signature?: DeliverySignature
}

/** The BOXED/LOOSE roll-up across a shipment's dispatch lines. */
export const SHIPMENT_PACKAGINGS = ['BOXED', 'LOOSE', 'MIXED'] as const
export type ShipmentPackaging = (typeof SHIPMENT_PACKAGINGS)[number]

export interface ShipmentTimes {
  created: string
  dispatched?: string
  outForDelivery?: string
  delivered?: string
}

/**
 * One customer on the trip — the multi-stop view today's one-modal-per-dispatch
 * flow cannot give (AUDIT friction 12).
 */
export interface ShipmentStop {
  customerId: string
  customerName: string
  address: string
  /** Dispatch lines delivered at this stop. */
  dispatchIds: string[]
  arrivedAt?: string
  completedAt?: string
}

/** Append-only history the delivery PWA posts; never edited, never deleted. */
export const DELIVERY_EVENT_TYPES = [
  'started',
  'arrived',
  'line_confirm',
  'signature',
  'otp',
  'failed',
  'rescheduled',
] as const
export type DeliveryEventType = (typeof DELIVERY_EVENT_TYPES)[number]

export interface DeliveryEvent {
  id: string
  shipmentId: string
  type: DeliveryEventType
  at: string
  gps?: { lat: number; lon: number }
  /** Type-specific detail — a line confirmation, a failure reason, an OTP verdict. */
  payload?: Record<string, unknown>
}

/** Proof of delivery captured on the canvas pad. Stored on the shipment. */
export interface DeliverySignature {
  /** R2 object key of the signature PNG. */
  signatureKey: string
  printedName: string
  phone: string
  /** True when the optional OTP check passed (flag per DECISIONS #12). */
  otpVerified?: boolean
}

/**
 * The delivery challan PDF — IMMUTABLE. A correction never edits a challan; it
 * issues a new linked version (`supersedesId`) with a reason and an audit
 * entry. Numbering is sequential out of the DC counters series (FY prefix
 * optional — DECISIONS #10).
 *
 * Tax fields are configurable and FLAGGED for accountant validation
 * (DECISIONS #11): do not rely on them until the business signs them off.
 */
export interface Challan {
  id: string
  /** Unique sequential number from the DC series. */
  number: string
  shipmentId: string
  orderId: string
  status: ChallanStatus
  version: number
  /** The challan this one corrects, on a new version. */
  supersedesId?: string
  reason?: string
  /** R2 object key of the rendered PDF. */
  pdfKey: string
  taxFields: ChallanTaxFields
  /** Snapshot of the delivered lines, frozen as they stood at delivery. */
  lines: ChallanLine[]
  agentId: string
  vehicle: string
  deliveredAt: string
}

export interface ChallanTaxFields {
  sellerGstin?: string
  buyerGstin?: string
  hsnCode?: string
  taxRatePct?: number
  eWayBillNo?: string
}

/** One delivered line as the challan reads it — copied, never looked up again. */
export interface ChallanLine {
  sku: string
  skuName: string
  lot: string
  qty: number
  uom: string
  expiry?: string
  packaging: 'BOXED' | 'LOOSE'
  /** BOXED only: cartons the line went out in. */
  cartons?: number
}

/**
 * Rejected or damaged items handed back at delivery. QC alone decides what the
 * stock suffers; until it decides, nothing moves.
 */
export interface ReturnRecord {
  id: string
  shipmentId: string
  status: ReturnStatus
  lines: ReturnLine[]
  qcDecision?: ReturnQcDecision
  decidedBy?: string
  /** The ledger movement that posted the QC decision. */
  ledgerRef?: string
}

export interface ReturnLine {
  item: string
  lot: string
  qty: number
  uom: string
  reason: string
  photoKey?: string
}

/** What QC decides a return does to inventory. */
export const RETURN_QC_DECISIONS = ['coldroom', 'quarantine', 'writeoff'] as const
export type ReturnQcDecision = (typeof RETURN_QC_DECISIONS)[number]

/**
 * A numeric result against spec limits — the shape that turns a Pass/Fail
 * string into a control chart (DECISIONS #9). `value` is the measured result;
 * `min`/`target`/`max` are the limits, copied from the parameter when the
 * record is judged so a later limit change never rescores an issued result.
 */
export interface QcSpecValue {
  value?: number
  min?: number
  target?: number
  max?: number
}

/** A feature flag row. Rollback for every phase is a flag switched off. */
export interface FlagRecord {
  key: string
  enabled: boolean
  note: string
  updatedBy: string
  updatedAt: string
}

/**
 * The flags the phases ride (ARCHITECTURE §7), plus `dashboards_<module>` for
 * Phase 5, one per module — hence the template member rather than a closed
 * list.
 */
export const FLAG_KEYS = [
  'shell_nav',
  'pipeline',
  'batch_v2',
  'qc_gate_v2',
  'dispatch_v2',
  'shipments',
] as const
export type FlagKey = (typeof FLAG_KEYS)[number] | (`dashboards_${string}`)

/** The version stamp of the recipe template a run followed. */
export interface RecipeMeta {
  id: string
  version: number
  status: RecipeStatus
}

/** When a run crossed each line — feeds cycle-time and stage-aging KPIs. */
export interface StageTimes {
  started?: string
  inputsDone?: string
  outputsDone?: string
  closed?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. State machines (ARCHITECTURE §3, mirrored exactly; enforced by the shared
//    rules module server-side, pre-checked client-side)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The lot lifecycle. Receipt is the GRN's booking; a material with QC-at-receipt
 * off (the default, DECISIONS #5) is put away straight to Released. Only
 * Released stock may be consumed or dispatched — under the qc_gate_v2 flag;
 * Classic keeps today's looser rule where Quarantine bulk is blendable.
 * Consumed/Dispatched/Written Off are terminal balances the ledger records as
 * movements; they are states here so the machine can name them.
 */
export const LOT_STATUSES = [
  'Receipt',
  'Quarantine',
  'Released',
  'Rejected',
  'Written Off',
  'Consumed',
  'Dispatched',
] as const
export type LotStatus = (typeof LOT_STATUSES)[number]

/** The run (batch) lifecycle: Draft→InProgress→Awaiting QC→Closed. */
export const RUN_STATUSES = ['Draft', 'In Progress', 'Awaiting QC', 'Closed'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

/**
 * Order statuses — today's three plus Partially Dispatched, which partial
 * dispatch (DECISIONS #15) introduces.
 */
export const ORDER_STATUSES = ['Open', 'Partially Dispatched', 'Dispatched', 'Cancelled'] as const
export type OrderStatus = (typeof ORDER_STATUSES)[number]

/** The shipment/delivery lifecycle (§3). Failed trips reschedule and go back
 *  out; the four outcomes of Out for Delivery are terminal. */
export const SHIPMENT_STATUSES = [
  'Created',
  'Dispatched',
  'Out for Delivery',
  'Delivered',
  'Partially Delivered',
  'Returned',
  'Failed',
  'Rescheduled',
] as const
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number]

/** A challan is Issued, and only ever superseded by a correction. */
export const CHALLAN_STATUSES = ['Issued', 'Superseded'] as const
export type ChallanStatus = (typeof CHALLAN_STATUSES)[number]

/** A return is recorded, QC decides, the ledger posts and it closes. */
export const RETURN_STATUSES = ['Open', 'QcDecision', 'Closed'] as const
export type ReturnStatus = (typeof RETURN_STATUSES)[number]

/**
 * The machine-readable reasons a transition can be refused. Every guard is
 * checked server-side; the client pre-checks the same keys so a disabled action
 * can say why in plain language. `role_allowed` (RBAC.md matrix) and
 * `cas_version` (optimistic lock) apply to every transition and are not
 * repeated on each one.
 */
export type GuardKey =
  /** The caller's role may not perform this transition (RBAC.md). */
  | 'role_allowed'
  /** The write carried a stale document version — conflict, re-sync (409). */
  | 'cas_version'
  /** The request needs an unused Idempotency-Key (or is a replay of one seen). */
  | 'idempotency_key'
  /** The flag turning on server-side QC enforcement; Classic keeps the old rule. */
  | 'qc_gate_v2'
  /** The lot must be Released to be blended, packed or dispatched. */
  | 'released_only'
  /** A run cannot close without a spoilage record — an explicit zero counts. */
  | 'spoilage_required'
  /** Base-unit mass-balance variance must sit within the configured tolerance. */
  | 'mass_balance_ok'
  /** BOXED decrements pouches and cartons in ONE transaction; LOOSE leaves
   *  carton stock untouched. */
  | 'atomic_carton_deduction'
  /** A challan is never edited; a correction issues a superseding version. */
  | 'challan_immutable'
  /** The challan number comes unbroken from the DC counters series. */
  | 'challan_sequential'
  /** Delivery events are append-only — history is never rewritten. */
  | 'append_only'
  /** A purchase order closes only once everything ordered has been received. */
  | 'fully_received'

/** Plain-language refusal text per guard — the single source the UI reads, so
 *  a disabled action always explains itself (WORKFLOW). */
export const GUARD_EXPLANATIONS: Record<GuardKey, string> = {
  role_allowed: 'Your role is not allowed to do this.',
  cas_version: 'This was changed by someone else first — reload and try again.',
  idempotency_key: 'This request was already sent — nothing was repeated.',
  qc_gate_v2: 'The QC gate is enforced here.',
  released_only: 'Only released stock can be used or dispatched.',
  spoilage_required: 'Record spoilage first — zero is fine, but it must be said.',
  mass_balance_ok: 'Inputs and outputs do not balance within tolerance.',
  atomic_carton_deduction: 'Pouches and cartons move together or not at all.',
  challan_immutable: 'A challan cannot be edited — raise a corrected version.',
  challan_sequential: 'Challan numbers run unbroken from the series.',
  append_only: 'Delivery history cannot be changed.',
  fully_received: 'Everything ordered has been received.',
}

/** One legal move: where to, and every guard that must pass. */
export interface Transition<S extends string> {
  to: S
  guards: readonly GuardKey[]
}

export interface StateMachineSpec<S extends string> {
  /** Where a new document starts. */
  initial: S
  /** From-status → the moves allowed out of it. Terminal statuses map to []. */
  transitions: Record<S, readonly Transition<S>[]>
}

/**
 * The legal transitions, entity by entity — ARCHITECTURE §3 verbatim, plus the
 * two practical arrows noted in comments. This is data: the same record the
 * server enforces from and the client renders menus from.
 */
export const LEGAL_TRANSITIONS = {
  lot: {
    initial: 'Receipt',
    transitions: {
      Receipt: [
        { to: 'Quarantine', guards: [] },
        // QC-at-receipt off (default) or a QC-exempt bulk: booked released.
        { to: 'Released', guards: [] },
      ],
      Quarantine: [
        { to: 'Released', guards: [] },
        { to: 'Rejected', guards: [] },
        // Rework: back onto the bench for a retest.
        { to: 'Quarantine', guards: [] },
      ],
      Released: [
        { to: 'Consumed', guards: ['qc_gate_v2', 'released_only'] },
        { to: 'Dispatched', guards: ['qc_gate_v2', 'released_only'] },
      ],
      Rejected: [{ to: 'Written Off', guards: [] }],
      'Written Off': [],
      Consumed: [],
      Dispatched: [],
    },
  },
  run: {
    initial: 'Draft',
    transitions: {
      Draft: [{ to: 'In Progress', guards: [] }],
      'In Progress': [{ to: 'Awaiting QC', guards: [] }],
      'Awaiting QC': [{ to: 'Closed', guards: ['spoilage_required', 'mass_balance_ok'] }],
      Closed: [],
    },
  },
  order: {
    initial: 'Open',
    transitions: {
      Open: [
        // Dispatch confirm — partial or whole — is the atomic carton transaction.
        { to: 'Partially Dispatched', guards: ['atomic_carton_deduction'] },
        { to: 'Dispatched', guards: ['atomic_carton_deduction'] },
        { to: 'Cancelled', guards: [] },
      ],
      'Partially Dispatched': [
        // Further part-dispatches stay in the state.
        { to: 'Partially Dispatched', guards: ['atomic_carton_deduction'] },
        { to: 'Dispatched', guards: ['atomic_carton_deduction'] },
        { to: 'Cancelled', guards: [] },
      ],
      Dispatched: [],
      Cancelled: [],
    },
  },
  shipment: {
    initial: 'Created',
    transitions: {
      Created: [{ to: 'Dispatched', guards: [] }],
      Dispatched: [{ to: 'Out for Delivery', guards: [] }],
      'Out for Delivery': [
        { to: 'Delivered', guards: [] },
        { to: 'Partially Delivered', guards: [] },
        { to: 'Returned', guards: [] },
        { to: 'Failed', guards: [] },
      ],
      Failed: [{ to: 'Rescheduled', guards: [] }],
      Rescheduled: [{ to: 'Out for Delivery', guards: [] }],
      Delivered: [],
      'Partially Delivered': [],
      Returned: [],
    },
  },
  challan: {
    // Minting an Issued challan also requires 'challan_sequential' and an
    // Idempotency-Key — entry conditions, not a transition.
    initial: 'Issued',
    transitions: {
      Issued: [{ to: 'Superseded', guards: ['challan_immutable'] }],
      Superseded: [],
    },
  },
  return: {
    initial: 'Open',
    transitions: {
      Open: [{ to: 'QcDecision', guards: ['role_allowed'] }],
      // Closing posts the decided inventory effect to the ledger.
      QcDecision: [{ to: 'Closed', guards: [] }],
      Closed: [],
    },
  },
  purchaseOrder: {
    initial: 'draft',
    transitions: {
      draft: [{ to: 'sent', guards: [] }],
      sent: [
        { to: 'acknowledged', guards: [] },
        { to: 'cancelled', guards: [] },
      ],
      acknowledged: [
        // A receipt lands the PO in received; further GRNs keep it there.
        { to: 'received', guards: [] },
        { to: 'cancelled', guards: [] },
      ],
      received: [
        { to: 'received', guards: [] },
        { to: 'closed', guards: ['fully_received'] },
        { to: 'cancelled', guards: [] },
      ],
      closed: [],
      cancelled: [],
    },
  },
} satisfies {
  lot: StateMachineSpec<LotStatus>
  run: StateMachineSpec<RunStatus>
  order: StateMachineSpec<OrderStatus>
  shipment: StateMachineSpec<ShipmentStatus>
  challan: StateMachineSpec<ChallanStatus>
  return: StateMachineSpec<ReturnStatus>
  purchaseOrder: StateMachineSpec<PurchaseOrderStatus>
}

export type StateMachineName = keyof typeof LEGAL_TRANSITIONS

// ─────────────────────────────────────────────────────────────────────────────
// 4. Additions to existing entities — additive partials; src/types.ts untouched
// ─────────────────────────────────────────────────────────────────────────────

/** items + material-master flags (§3.1, DECISIONS #13). */
export interface ItemExtension {
  procurementForm?: ProcurementForm
  /** Coconuts only — the single graded intake. */
  requiresGrading?: boolean
  requiresExtraction?: boolean
  shelfLifeDays?: number
  storageCondition?: StorageCondition
  /** kg per litre — litre-measured materials convert through this for mass balance. */
  densityKgPerL?: number
  /** kg per counting unit (one coconut) — count-measured materials convert
   *  through this. Default ~500 g configurable (DECISIONS #2). */
  avgUnitWeight?: number
  minStock?: number
  maxStock?: number
}

/** grns + grading mode (staged mode arrives with the pipeline flag). */
export interface GrnExtension {
  gradingMode?: GradingMode
}

/**
 * grns + the documents.version the snapshot rides (v1.6): POST /api/grading's
 * expectedVersion reads it. Attached by the D1 snapshot parse — never stored in
 * the document json, and absent on the Zoho arm's grns (there the pipeline flag
 * is off and the grading form is unreachable, so the field is optional).
 */
export interface GrnVersionExtension {
  version: number
}

/**
 * batches + the same ride-along (v1.7): POST /api/transformations/close's
 * expectedVersion reads it. Same rules as grns — snapshot-attached, read-only,
 * the column over any stale embedded value.
 */
export interface BatchVersionExtension {
  version: number
}

/** batches + recipe stamp and stage clock. */
export interface BatchExtension {
  recipe?: RecipeMeta
  stageTimes?: StageTimes
}

/**
 * outputLines[] +type — the output's place in the chain. After the one-off
 * backfill every line carries one: Extraction first output→MAIN, rest→
 * BY_PRODUCT; blend bulks→INTERMEDIATE (ARCHITECTURE §2).
 */
export interface BatchOutputExtension {
  type: OutputType
}

/** products + pack format, backfilled from SKU names. */
export interface ProductExtension {
  packFormat?: PackFormat
  bibSize?: BibSize
}

/** melanges + versioning: an edit creates a new version row; old ones stay. */
export interface MelangeExtension {
  /** Self-reference stamped by the B1 backfill: the melange id this recipe
   *  lineage descends from (v1.1). */
  recipeId?: string
  version?: number
  status?: RecipeStatus
}

/** customers + default dispatch packaging (default ASK). */
export interface CustomerExtension {
  dispatchPackaging?: DispatchPackaging
}

/** orders.lines[] + packaging override: ASK is the absence of an answer, so an
 *  override is always a definite BOXED or LOOSE. */
export interface OrderLineExtension {
  packaging?: 'BOXED' | 'LOOSE'
}

/** orders + partial-dispatch status and per-line lot reservations. */
export interface OrderExtension {
  status?: OrderStatus
  reservations?: OrderReservation[]
}

/** A lot held against an order line. CAS-protected: a commit carrying a stale
 *  version is refused (409) rather than silently re-allocating stock. */
export interface OrderReservation {
  sku: string
  lot: string
  location: string
  qty: number
  version: number
}

/** qcs + Rework disposition and numeric results against spec limits. */
export type QcDisposition = 'Pending' | 'Retest' | 'Rejected' | 'Released' | 'Rework'

export interface QcExtension {
  disposition?: QcDisposition
  /** Numeric results, by test key, alongside the existing Pass/Fail strings. */
  values?: Record<string, QcSpecValue>
}

/** packing_runs + the shift that ran them (throughput-per-shift KPI). */
export interface PackingRunExtension {
  shiftId?: string
}

/** controlSamples[] + the storage bin a kept sample sits in (§3.3-7: a control
 *  sample records timestamp, storage bin and retention expiry). */
export interface ControlSampleExtension {
  storageBin?: string
}

/** storage_locations + zone (map: Cold Room→cold_room, Dry→ambient, Hold→
 *  quarantine, +new dispatch_staging; NPD stays a tag) and capacity, which the
 *  cold-room occupancy heatmap fills against. */
export interface StorageLocationExtension {
  zone?: StorageZone
  capacity?: number
}

/** meta.app_config + the overhaul's configurable business parameters. */
export interface AppConfigExtension {
  massBalanceTolerancePct?: number
  avgNutWeightG?: number
  defaultDensityKgPerL?: number
  coldChainTimeoutMin?: number
  fefoMode?: FefoMode
  qcAtReceiptDefault?: boolean
  otpAtDelivery?: boolean
  challanFyPrefix?: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. API contracts — the new dedicated endpoints (ARCHITECTURE §5-6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every POST below requires an `Idempotency-Key` request header: api/_lib
 * stores a hash of key+body for 48h and replays the stored response on a
 * retry, so a flaky delivery-agent connection cannot post a delivery or burn a
 * challan number twice.
 */

/** Failure shape, as api/ already answers: `{ error }` prose. New endpoints
 *  add `code` — a stable key the UI can branch on (a GuardKey where a guard is
 *  what refused) — and field-level `details` for body validation. */
export interface ApiError {
  error: string
  code?: string
  details?: Record<string, string>
}

/**
 * Freshness stamp every dashboard, report and export carries — no silent stale
 * data. `stale_after` is seconds; `stale` is the server's own verdict at read
 * time so the badge cannot disagree with the data.
 */
export interface Freshness {
  last_updated: string
  stale_after: number
  stale: boolean
}

// ── POST /api/transformations/close ─────────────────────────────────────────

export interface SpoilageInput {
  stage: SpoilageStage
  /** Zero is a valid, deliberate entry. */
  qty: number
  uom: string
  reasonCode: string
  photoKey?: string
}

export interface CloseTransformationRequest {
  batchId: string
  /** documents.version as the caller read it — stale means 409, not overwrite. */
  expectedVersion: number
  /** Mandatory: at least one line, explicit zero allowed. */
  spoilage: SpoilageInput[]
}

export interface CloseTransformationResponse {
  batchId: string
  status: RunStatus
  massBalance: MassBalanceResult
  spoilage: SpoilageRecord[]
}

// ── POST /api/dispatch/confirm (carton math + FEFO + reservations) ──────────

export interface DispatchLineInput {
  sku: string
  lot: string
  location?: string
  expiry?: string
  qty: number
  /** ASK is resolved before confirm: every line goes out BOXED or LOOSE. */
  packaging: 'BOXED' | 'LOOSE'
  /** BOXED only: the suggested carton type/count, confirmed or edited. */
  cartonItemId?: string
  cartons?: number
}

export interface DispatchConfirmRequest {
  orderId: string
  expectedVersion: number
  lines: DispatchLineInput[]
  vehicle: string
  /** Cold-room out-time; the time-out-of-cold alert runs from it. */
  coldRoomOutAt?: string
}

export interface DispatchConfirmResponse {
  dispatchIds: string[]
  orderStatus: OrderStatus
  /** Cartons decremented in the same transaction as the pouches. */
  cartonsIssued: { cartonItemId: string; count: number }[]
  loadedAt: string
  /** The challan number reserved for this dispatch (v1.1). */
  challan?: string
}

// ── POST /api/shipments (+ /:id/events, /:id/submit) ────────────────────────

export interface ShipmentStopInput {
  customerId: string
  address?: string
  dispatchIds: string[]
}

export interface CreateShipmentRequest {
  orderId: string
  dispatchIds: string[]
  agentUserId?: string
  vehicle: string
  eta?: string
  /** Omitted on a single-stop trip: the stop is derived from the dispatches. */
  stops?: ShipmentStopInput[]
}

export interface CreateShipmentResponse {
  shipment: Shipment & ShipmentVersionExtension
}

export interface DeliveryEventRequest {
  type: DeliveryEventType
  /** Server-stamped when absent. */
  at?: string
  gps?: { lat: number; lon: number }
  payload?: Record<string, unknown>
}

export interface DeliveryEventResponse {
  event: DeliveryEvent
  shipmentStatus: ShipmentStatus
}

/** One line's outcome at the door. A rejected or damaged quantity raises a
 *  Return line; it does not fail the whole delivery. */
export interface DeliveryLineConfirmation {
  dispatchId?: string
  sku: string
  lot: string
  qtyDelivered: number
  qtyRejected: number
  reason?: string
  photoKey?: string
}

export interface SignatureInput {
  /** R2 object key the PWA just uploaded the canvas PNG to. */
  signatureKey: string
  printedName: string
  phone: string
  /** Present when OTP at delivery is enabled for the customer (default off). */
  otp?: string
}

/** Valid submission: signature captured, challan minted, PDF rendered, any
 *  rejected quantities opened as Return records. */
export interface SubmitDeliveryRequest {
  lines: DeliveryLineConfirmation[]
  signature: SignatureInput
}

export interface SubmitDeliveryResponse {
  shipment: Shipment & ShipmentVersionExtension
  challan: Challan
  /** Empty when nothing was rejected at the door. */
  returns: ReturnRecord[]
}

// ── GET/PATCH /api/shipments (v1.9) ─────────────────────────────────────────

/** documents.version ride-along — the board's CAS token for PATCH's
 *  expectedVersion, under the response-only rules of the PO's v1.4: the stored
 *  shipment document stays version-less; the documents table's column is the
 *  only truth. */
export interface ShipmentVersionExtension {
  version: number
}

/** One dispatch line as the board and the PWA read it — the dispatch row
 *  flattened (its `batchId` is the lot; its `challan` is the DC number the
 *  Classic dispatch already minted). */
export interface ShipmentLine {
  dispatchId: string
  sku: string
  lot: string
  qty: number
  expiry?: string
  customerId: string
  customerName: string
  challan: string
}

/** A challan link on the board — the PDF itself answers at /api/challans/:id/file. */
export interface ShipmentChallanLink {
  id: string
  number: string
  status: ChallanStatus
  version: number
}

/** One trip with everything the board draws for it. */
export interface ShipmentDetail {
  shipment: Shipment & ShipmentVersionExtension
  lines: ShipmentLine[]
  challans: ShipmentChallanLink[]
}

/** GET /api/shipments — newest first; an agent's list is their own trips only. */
export interface ShipmentListResponse {
  shipments: ShipmentDetail[]
}

/** GET /api/shipments/:id — the detail plus the append-only event history. */
export interface ShipmentEventsResponse extends ShipmentDetail {
  events: DeliveryEvent[]
}

/** PATCH /api/shipments/:id — reassign/ETA/vehicle on any non-terminal trip,
 *  or the board's own status arrows. The machine's other arrows are endpoint
 *  territory: Dispatched→Out for Delivery is the agent's `started` event, and
 *  the four outcomes of Out for Delivery are the submit's. */
export interface PatchShipmentRequest {
  expectedVersion: number
  agentUserId?: string
  vehicle?: string
  eta?: string
  status?: ShipmentStatus
}

export interface PatchShipmentResponse {
  shipment: Shipment & ShipmentVersionExtension
}

// ── GET /api/challans, POST /api/challans/:id/correct (v1.9) ────────────────

/** GET /api/challans — newest first; an agent's list is their own challans only. */
export interface ChallanListResponse {
  challans: Challan[]
}

/** POST /api/challans/:id/correct — a correction never edits a challan; it
 *  supersedes the old one with a fresh number and a reason (DECISIONS #10). */
export interface ChallanCorrectRequest {
  reason: string
  expectedVersion: number
  /** Corrected lines — the issued lines stand when omitted. */
  lines?: ChallanLine[]
}

export interface ChallanCorrectResponse {
  challan: Challan
}

// ── POST /api/returns ───────────────────────────────────────────────────────

export interface ReturnLineInput {
  item: string
  lot: string
  qty: number
  uom: string
  reason: string
  photoKey?: string
}

export interface CreateReturnRequest {
  shipmentId: string
  lines: ReturnLineInput[]
}

export interface CreateReturnResponse {
  record: ReturnRecord
}

/** POST /api/returns/:id/decision — QC's verdict: where the returned stock
 *  lands. coldroom → Released at a cold room; quarantine → Quarantine at a
 *  hold area; writeoff → the terminal Written Off balance. Closes the record
 *  and posts the movement (one ledger line per return line, type 'Return'). */
export interface ReturnDecisionRequest {
  decision: ReturnQcDecision
  note?: string
}

export interface ReturnDecisionResponse {
  record: ReturnRecord
}

// ── POST /api/grading (staged mode) ─────────────────────────────────────────

/** Grades for a staged GRN, entered later through the grading form. The scale
 *  is the one the plant uses (DECISIONS #1). */
export interface StagedGradingRequest {
  grnId: string
  expectedVersion: number
  a: number
  b: number
  c: number
  reject: number
  free?: number
}

export interface StagedGradingResponse {
  grnId: string
  lot: string
  accepted: number
}

/**
 * POST /api/purchase-orders (WORKFLOW W3, the Receipt stage's PO form —
 * KPI.md's decision: no PO form, no funnel/on-time/lead-time numbers). A new
 * PO starts as a draft unless the caller says it is already sent.
 */
export interface PurchaseOrderCreateRequest {
  vendorId: string
  lines: PurchaseOrderLine[]
  expectedOn?: string
  /** 'draft' (the default) or 'sent' when the caller raises it already sent. */
  status?: 'draft' | 'sent'
}

/** PATCH /api/purchase-orders/:id — a status move the machine allows. */
export interface PurchaseOrderPatchRequest {
  status: PurchaseOrderStatus
  expectedVersion: number
}

/**
 * purchase_orders + the documents.version every endpoint response carries —
 * the PO form's CAS token for PATCH's expectedVersion (v1.4). Response-only:
 * the stored document stays without it.
 */
export interface PurchaseOrderVersionExtension {
  version: number
}

export interface PurchaseOrderResponse {
  po: PurchaseOrder & PurchaseOrderVersionExtension
}

/** POST /api/purchase-orders/:id/receive — link a booked GRN to its PO (W5). */
export interface PurchaseOrderReceiveRequest {
  grnId: string
  expectedVersion: number
}

export interface PurchaseOrderReceiveResponse {
  po: PurchaseOrder & PurchaseOrderVersionExtension
}

/** GET /api/purchase-orders — newest first. */
export interface PurchaseOrderListResponse {
  pos: (PurchaseOrder & PurchaseOrderVersionExtension)[]
}

// ── GET /api/genealogy ──────────────────────────────────────────────────────

/** Where the trace starts: `LOT:BAT-2026-0002/2`, `RUN:B-2026-0123`, `ORD:…`. */
export type GenealogySeed = `${'LOT' | 'RUN' | 'ORD'}:${string}`
export type GenealogyDirection = 'forward' | 'backward'

export interface GenealogyRequest {
  seed: GenealogySeed
  dir: GenealogyDirection
  depth?: number
}

export type GenealogyNodeKind =
  | 'grn'
  | 'batch'
  | 'packing'
  | 'order'
  | 'dispatch'
  | 'shipment'
  | 'challan'

/** A node in the trace. `id` is its own `kind:id` key, the seed's shape. */
export interface GenealogyNode {
  id: string
  kind: GenealogyNodeKind
  label: string
  at?: string
}

/** An edge is a consumed/produced/fulfilled fact the server folded from
 *  documents — receipt→run inputs/outputs→packing→dispatch→shipment→challan. */
export interface GenealogyEdge {
  from: string
  to: string
  relation: 'input' | 'output' | 'fulfils' | 'ships' | 'challan_of'
}

export interface GenealogyResponse {
  nodes: GenealogyNode[]
  edges: GenealogyEdge[]
  /** True when depth cut the walk short — the UI must say so, not imply an end. */
  truncated: boolean
}

// ── GET /api/search (Ctrl/Cmd+K global search) ──────────────────────────────

export const SEARCH_KINDS = [
  'lot',
  'batch',
  'order',
  'challan',
  'customer',
  'vendor',
  'storageLocation',
  'shipment',
] as const
export type SearchKind = (typeof SEARCH_KINDS)[number]

export interface SearchRequest {
  q: string
}

export interface SearchResult {
  kind: SearchKind
  id: string
  label: string
  sublabel?: string
  /** Route the result opens. */
  href: string
}

export interface SearchResponse {
  results: SearchResult[]
}

// ── GET /api/kpis/:module (the one aggregation layer — ARCHITECTURE §6) ─────

/** The dashboard modules, in DASHBOARDS' build order — the same ten keys
 *  KPI.md's sections hang under. */
export const KPI_MODULES = [
  'procurement',
  'grading-extraction',
  'intermediates-blending',
  'packing',
  'qc',
  'control-samples',
  'inventory',
  'packaging-materials',
  'orders-dispatch',
  'shipment-tracking',
] as const
export type KpiModule = (typeof KPI_MODULES)[number]

/** Metric definitions live in KPI.md; the wire shape is this, for every
 *  module, so cards, charts and exports all read the same fold. */
export interface KpiCard {
  key: string
  label: string
  value: number
  unit?: string
  /** Change against the previous period, in percent. */
  deltaPct?: number
  /** Filtered record list the card click-throughs to. */
  href?: string
}

/** One chart's rows. Control charts draw each row's limits when present. */
export interface KpiChartRow {
  series?: string
  label: string
  value: number
  min?: number
  target?: number
  max?: number
}

export interface KpiChart {
  key: string
  label: string
  kind: 'line' | 'bar' | 'stacked' | 'treemap' | 'heatmap' | 'control'
  rows: KpiChartRow[]
}

export interface KpiModuleResponse extends Freshness {
  module: KpiModule
  cards: KpiCard[]
  charts: KpiChart[]
}

// ── GET /api/events (SSE — the live feed, ARCHITECTURE §5) ──────────────────

/** The one message the stream carries, on three event names: `hello` on
 *  connect (the token as of now), `revision` when the token changed — the
 *  client's cue to refetch whatever it holds (snapshot, kpis) — and `bye`
 *  when the server ends the stream (EventSource reconnects; hello re-syncs).
 *  Heartbeats are SSE comments, not events. The poll fallback is the existing
 *  GET /api/revision. */
export interface RevisionEvent {
  revision: string
  at: string
}

// ── GET /api/exports/:report ────────────────────────────────────────────────

export const EXPORT_FORMATS = ['csv', 'xlsx', 'pdf'] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]

export const EXPORT_JOB_STATUSES = ['queued', 'running', 'ready', 'failed'] as const
export type ExportJobStatus = (typeof EXPORT_JOB_STATUSES)[number]

/**
 * A large export runs as a background job and is polled; a small one streams
 * the bytes straight back (Content-Disposition attachment, injection-guarded).
 * Either way the data carries its freshness: streamed files put it in response
 * headers, jobs carry it on the row below. `downloadUrl` is signed and
 * expiring.
 */
export interface ExportJob extends Freshness {
  id: string
  report: string
  format: ExportFormat
  status: ExportJobStatus
  /** Present once status is 'ready'; expires. */
  downloadUrl?: string
  error?: string
}

export interface ExportRequest {
  format: ExportFormat
  /** Report-specific filters (date presets, batch, supplier, customer…). */
  filters?: Record<string, string>
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Mass balance — base units only; raw mixed units are never compared (§3.2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How a material's counting unit converts to the base unit (kg): count-measured
 * materials (coconuts) through a configured average weight per unit,
 * litre-measured ones through density. Per-material override, defaulting to
 * meta.app_config (DECISIONS #2).
 */
export type BaseUnitConversion =
  | { kind: 'count_weight'; avgUnitWeight: number }
  | { kind: 'density'; densityKgPerL: number }

/** The verdict a close computes and stores, in base units. */
export interface MassBalanceResult {
  inputBaseUnits: number
  outputBaseUnits: number
  /** (inputs − outputs − spoilage) as a percent of inputs. */
  variancePct: number
  withinTolerance: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Pure type-guards — the same definitions client and server parse wire data
//    with (the ISSUE_REASONS pattern: values are data, not just names)
// ─────────────────────────────────────────────────────────────────────────────

const oneOf =
  <T extends string>(values: readonly T[]) =>
  (v: unknown): v is T =>
    typeof v === 'string' && values.includes(v as T)

export const isProcurementForm = oneOf(PROCUREMENT_FORMS)
export const isStorageCondition = oneOf(STORAGE_CONDITIONS)
export const isStorageZone = oneOf(STORAGE_ZONES)
export const isOutputType = oneOf(OUTPUT_TYPES)
export const isSpoilageStage = oneOf(SPILLAGE_STAGES)
export const isDispatchPackaging = oneOf(DISPATCH_PACKAGING)
export const isPackFormat = oneOf(PACK_FORMATS)
export const isGradingMode = oneOf(GRADING_MODES)
export const isRecipeStatus = oneOf(RECIPE_STATUSES)
export const isFefoMode = oneOf(FEFO_MODES)
export const isLotStatus = oneOf(LOT_STATUSES)
export const isRunStatus = oneOf(RUN_STATUSES)
export const isOrderStatus = oneOf(ORDER_STATUSES)
export const isShipmentStatus = oneOf(SHIPMENT_STATUSES)
export const isChallanStatus = oneOf(CHALLAN_STATUSES)
export const isReturnStatus = oneOf(RETURN_STATUSES)
export const isReturnQcDecision = oneOf(RETURN_QC_DECISIONS)
export const isShipmentPackaging = oneOf(SHIPMENT_PACKAGINGS)
export const isSearchKind = oneOf(SEARCH_KINDS)
export const isKpiModule = oneOf(KPI_MODULES)
export const isExportFormat = oneOf(EXPORT_FORMATS)
export const isExportJobStatus = oneOf(EXPORT_JOB_STATUSES)
export const isDeliveryEventType = oneOf(DELIVERY_EVENT_TYPES)
export const isPurchaseOrderStatus = oneOf(PURCHASE_ORDER_STATUSES)

/** Structural guard for the one shape every endpoint failure answers with. */
export const isApiError = (v: unknown): v is ApiError =>
  typeof v === 'object' && v !== null && typeof (v as { error?: unknown }).error === 'string'
