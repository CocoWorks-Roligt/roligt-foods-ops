/**
 * What a signed-in user may do.
 *
 * This existed as the single string 'Admin' and was never read anywhere, so every
 * authenticated user could delete batches, wipe records from a date and rewrite the
 * numbering series. The values here are the ones `public.app_user.role` is checked
 * against in the database, so the screen and the row-level policies cannot disagree.
 */
export type Role = 'Operator' | 'QualityTester' | 'Admin'

export type ViewId =
  | 'dashboard'
  | 'storage'
  | 'orders'
  | 'procurement'
  | 'production'
  | 'packing'
  | 'quality'
  | 'control-samples'
  | 'reports'
  | 'live-reports'
  | 'dispatch'
  | 'inventory'
  | 'packing-materials'
  | 'stock-issues'
  | 'stickers'
  | 'traceability'
  | 'roster'
  | 'production-planning'
  | 'vendors'
  | 'customers'
  | 'purchase-products'
  | 'test-parameters'
  | 'settings'
  | 'audit'
  | 'admin-users'
  | 'admin-roles'

/** The kinds of new stock that are put away somewhere by default. */
export type AreaPurpose = 'produce' | 'packingMaterial' | 'bulk' | 'packs'

export interface Config {
  yieldTolerance: number
  pmTolerance: number
  expiryAlertDays: number
  lowStockPacks: number
  reportCustomerName: string
  reportCustomerAddress: string
  defaultLabTechnician: string
  /** Printed at the foot of each label. Worded by the plant — the app never invents
   *  its own food-safety copy. */
  frozenStorageLine?: string
  chilledStorageLine?: string
  consumeWithinLine?: string
  /** Label stock the stickers print on, in millimetres. */
  stickerWidthMm?: number
  stickerHeightMm?: number
  /** Admin-set shape of each auto-numbered series. Absent means the built-in shape. */
  numbering?: NumberingRule[]
  /**
   * Where new stock goes when nobody picks another area: one storage area, by id, for
   * each kind of stock that arrives. Set on the Storage page.
   */
  defaultAreas?: Partial<Record<AreaPurpose, string>>
  /**
   * The kinds of test report the plant issues and which of them a product needs to
   * pass before release. Absent means the built-in list — see `lib/qcCategories`.
   */
  testCategories?: TestCategoryDef[]
  /** Days a control sample is kept, counted from the day it was produced. */
  controlSampleDays?: number
}

/**
 * How one auto-numbered series is written. Every document code in the app is a
 * prefix, an optional dated middle and a zero-padded running number, so one rule
 * describes them all: `RFTC20260007`, `DC0007/2026`, `LOT-20260909-004`.
 *
 * The running number itself is not stored here — it lives in `counters`, which is
 * what actually advances when a document is minted.
 */
export interface NumberingRule {
  /** The series this shapes, by its key in `counters`. */
  key: string
  /** Letters the plant reads the series by — RFTC, DC, VEN. */
  prefix: string
  /**
   * Where each part goes: `{P}` the prefix, `{N}` the running number, `{YYYY}` the
   * year, `{YYYYMMDD}` the date. Everything else prints literally, so
   * `{P}{N}/{YYYY}` is `DC0001/2026` and `{P}{YYYY}{N}` is `RFTC20260001`.
   * A fixed prefix-then-date-then-number order could not write either.
   */
  pattern: string
  /** Digits the running number is padded to — 4 gives 0007. */
  pad: number
  /** @deprecated the prefix·middle·number shape this replaced; read once, then rewritten */
  middle?: 'none' | 'year' | 'date'
  /** @deprecated see `middle` */
  separator?: string
}

export interface VendorType {
  id: string
  name: string
  sourceKind: 'Farmer' | 'Vendor' | 'Other'
  description: string
  status: string
}

export interface Vendor {
  id: string
  name: string
  vendorTypeId: string
  phone: string
  area: string
  payment: string
  status: string
  email?: string
  notes?: string
}

/** The shifts a plant day is cut into. */
export type ShiftName = 'Morning' | 'Evening' | 'General'

/** Someone on the plant roster. Masters like the vendors: never deleted, only deactivated. */
export interface StaffMember {
  id: string
  name: string
  role: string
  phone?: string
  status: 'Active' | 'Inactive'
  addedOn: string
}

/**
 * One person's shift on one day. The id is `staffId|date`, so a second save for the
 * same person and day replaces the first — there is no such thing as two shifts.
 */
export interface ShiftAssignment {
  id: string
  staffId: string
  date: string
  shift: ShiftName
  /** What they are on that day — Extraction, Packing, QC, Dispatch, General. */
  line: string
  note?: string
}

/** Whether one person turned up on one day. Id is `staffId|date`, as with shifts. */
export interface AttendanceRecord {
  id: string
  staffId: string
  date: string
  status: 'Present' | 'Absent' | 'Leave' | 'Half day'
}

/** The stages a plan can be for — the same three the plant actually runs. */
export type PlanStage = 'Extraction' | 'Melange' | 'Packing'

export type PlanStatus = 'Planned' | 'In progress' | 'Done' | 'Cancelled'

/**
 * What the plant intends to make on a day, written before it makes it. A plan is
 * not a batch: nothing is issued, nothing is booked, and it can be cancelled
 * without a trace on stock. When the day comes, the run is posted as usual on
 * the Production or Packing page — the plan only ever said what was coming.
 */
export interface ProductionPlan {
  id: string
  date: string
  stage: PlanStage
  /** Free text: a bulk item, a melange, or a pack product name. */
  product: string
  qty: number
  uom: 'Litre' | 'Kg' | 'Packs'
  note?: string
  /** Order ids this plan was raised to serve — set when it is planned from open
   *  orders, so the link is data the page can read back, not note text. */
  serves?: string[]
  status: PlanStatus
  createdOn: string
}


export interface Customer {
  id: string
  name: string
  shipTo: string
  gst: string
  status: string
  phone?: string
  email?: string
  contactPerson?: string
  notes?: string
}

export type PurchaseCategory = 'Farm Produce' | 'Packing Material' | 'Other'

export interface PurchaseProduct {
  id: string
  name: string
  category: PurchaseCategory
  uom: string
  description: string
  status: string
  /** Specific farmers/vendors this product can be bought from */
  vendorIds: string[]
  itemId?: string
}

/**
 * What a storage area is, physically.
 *
 * There used to be four — Freezer, Defrost, Store and Hold — and the plant kept a
 * separate list for each, which meant a cold room and a chest freezer were different
 * kinds of thing while a bulk store and a quarantine shelf were the same one. There
 * is one list of storage areas now, and this says what each area is.
 */
export type StorageType = 'Cold Room' | 'Dry Store' | 'Hold Area'

/**
 * A physical place stock can sit — a cold room, a dry store, a hold shelf. One
 * entity for all of them: what tells them apart is `type`, not which list they are in.
 *
 * The ledger records locations by `name`, so that stays fixed forever while `label` —
 * the only one anyone sees — is free to change.
 */
export interface StorageLocation {
  id: string
  /** Ledger key. Set once when the location is created and never changed, because
   *  the ledger records locations by name and is never rewritten. Not shown in the UI. */
  name: string
  /** What people call it on the floor. Free to rename at any time. */
  label: string
  /** One line explaining what belongs here. */
  holds: string
  /** Cold room, dry store or hold area. Decides what may be kept here. */
  type: StorageType
  status: string
}

export interface Item {
  id: string
  name: string
  type: 'Raw Material' | 'Packing Material' | 'Semi Finished' | 'Finished Goods'
  uom: string
  lotControlled: boolean
  reorder: number
  costMethod: string
}

export interface BomLine {
  item: string
  qty: number
}

/** Bulk output a pack is filled from. Water is measured in litres, malai in kg. */
export type PackMedium = 'Water' | 'Malai'

/** Units a pack size can be entered in. The unit decides the medium: a pack sized in
 *  L or ml is filled from water, one sized in kg or g from malai. */
export type PackUnit = 'L' | 'ml' | 'kg' | 'g'

export interface Product {
  id: string
  name: string
  /** Pack format, named by the admin — BiB, Glass Bottle, Cover, Pouch … */
  type: string
  /** How much one pack holds, in `unit`. Set on the Products page and fixed from
   *  there: the packing run picks the product and enters how many, nothing else. */
  size: number
  unit: PackUnit
  /** `size` converted to the medium's base unit — litres for water, kg for malai.
   *  Stored because every cost, ledger and stock figure in the app is in base units,
   *  so nothing downstream has to know that 250 ml is 0.25 L. */
  packVolume: number
  /** Frozen life, in days, from the day it was packed. This is the clock the stock
   *  itself runs on — what the expiry on the shelf means. */
  shelfLifeDays: number
  /** Chilled life, in days, from the day the dispatch label is printed. Only ever
   *  printed on that label; it never touches stock, because the pack leaves. */
  chilledShelfLifeDays?: number
  /** Printed on the dispatch label. */
  mrp?: number
  bom: BomLine[]
  /** Semi-finished item this pack is filled from — coconut water, malai, an ABC
   *  melange. What decides which bulk a packing run may draw for this pack. */
  bulkItem?: string
  /** @deprecated derived from `bulkItem`'s unit; kept so older packs still read */
  medium?: PackMedium
}

export interface Grn {
  id: string
  date: string
  farmerId: string
  farmerName: string
  /** Farmer who actually grew/harvested this lot (free text, may differ from the vendor) */
  farmer?: string
  /** Farm / area the lot was harvested from */
  area?: string
  /** Harvest date (yyyy-mm-dd) */
  harvestedOn?: string
  lot: string
  total: number
  /** Extra coconuts given free — inside `total`, but excluded from the priced quantity */
  free?: number
  a: number
  b: number
  c: number
  reject: number
  rate: number
  transport: number
  accepted: number
  materialValue: number
  landed: number
  grossCost: number
  usableCost: number
  status: string
  notes?: string
  purchaseProductId?: string
  /** Raw-material item the receipt booked. Receipts posted before produce other than
   *  coconuts could be bought are all tender coconuts. */
  itemId?: string
  /** What was counted — Piece, Kg, Litre — copied off the product. */
  uom?: string
  /** Store the lot was put away in, by ledger key. */
  location?: string
  /** Purchase product name as it read when the receipt was posted. */
  productName?: string
}

export interface SourceLine {
  lot: string
  /** Raw material issued. Lines written before production handled more than one
   *  raw material are all tender coconuts. */
  item?: string
  /** Unit the issue was measured in, copied off the item when the batch was posted. */
  uom?: string
  farmerId?: string
  qty: number
  unitCost: number
}

/**
 * Bulk drawn out of another batch to be blended. The lot is the batch the bulk came
 * from, which is what keeps a melange traceable back to the fruit it was pressed from.
 */
export interface BlendLine {
  /** Semi-finished item drawn — beetroot juice, coconut water … */
  item: string
  /** Batch the bulk was produced by; the ledger records it as the lot. */
  lot: string
  uom?: string
  qty: number
  unitCost: number
}

/**
 * One bulk output of a batch. `costShare` is the percentage of the batch's input
 * cost this output carries: the main output takes all of it, and a by-product such
 * as malai takes none, so the cost per litre of the main output is unaffected by
 * how much by-product a batch happens to yield.
 */
export interface BulkOutputLine {
  /**
   * This output's own stock ID — `BAT-2026-0002/2` for the second thing the batch
   * made. The batch code alone is shared by the water and the malai it pressed, so it
   * cannot name either of them. See `lib/stockIds`.
   */
  stockId?: string
  item: string
  qty: number
  uom: string
  costShare: number
}

/** Extraction presses raw material into bulk; a melange blends bulks into one. */
export type BatchKind = 'Extraction' | 'Melange'

/** A component of a melange recipe, as a percentage of the finished blend. */
export interface MelangeComponent {
  /** Semi-finished item that goes into the blend. */
  item: string
  share: number
}

/**
 * A blend formulation — ABC is apple, beetroot and carrot juice in fixed shares.
 * The recipe owns its own bulk item (`outputItem`), created and renamed with it, so
 * blended stock is never confused with the single-fruit juice it was made from.
 */
export interface Melange {
  id: string
  name: string
  outputItem: string
  /** What the blend is measured in — 'Litre' or 'Kg'. */
  uom: string
  components: MelangeComponent[]
  description: string
  status: string
}

export interface OutputLine {
  sku: string
  packs: number
  litres: number
  unitCost: number
  expiry: string
}

export interface Batch {
  id: string
  /** Extraction (raw material to bulk) or Melange (bulk to blended bulk). Batches
   *  posted before blending existed are all extractions. */
  kind?: BatchKind
  date: string
  /** Recipe a melange run followed. */
  melangeId?: string
  /** Where the bulk it made was put away. */
  location?: string
  /** Nuts that never made it into the press, and the litres they would have given —
   *  yield per usable nut times the number spoiled. Stored rather than derived so a
   *  later change to the yield rule cannot quietly restate what a batch lost. */
  wastage?: number
  /** Raw material issued. Empty on a melange, which draws bulk instead. */
  sourceLines: SourceLine[]
  /** Bulk components a melange drew from other batches. */
  blendLines?: BlendLine[]
  /** Every bulk this batch produced. Supersedes waterLitres/malaiKg, which are still
   *  written for coconut batches so older reports keep reading. */
  outputLines?: BulkOutputLine[]
  /** @deprecated use `inputQty` — the coconut-only name for the same figure */
  coconuts: number
  /** Everything issued to the batch: pieces of coconut, kg of beetroot, litres of bulk. */
  inputQty?: number
  inputUom?: string
  spoiled: number
  /** Extraction yield: water in litres and malai in kg. Malai is a by-product and
   *  carries no coconut cost, so the whole batch cost sits on the water. */
  waterLitres?: number
  malaiKg?: number
  /** @deprecated packs are created by packing runs now; kept for batches posted earlier */
  outputs: OutputLine[]
  outputLitres: number
  /** @deprecated use `yieldPerUnit` — the coconut-only name for the same figure */
  yieldPerCoconut: number
  /** Main output per unit of input: litres of water per coconut, litres of juice per
   *  kg of beetroot, litres of blend per litre of component. */
  yieldPerUnit?: number
  rmCost: number
  pmCost: number
  directCost: number
  costPerL: number
  /**
   * The batch as a whole, rolled up from its per-output QC records. A batch whose
   * water passed and whose malai failed is `Partly Released` — see `batchDisposition`.
   */
  status: string
  /** @deprecated a batch has one QC record per output now — see `qcIds` */
  qcId: string
  /** One QC record per bulk this batch produced, in the order the outputs were booked. */
  qcIds?: string[]
}

export interface PackingLine {
  /** This line's own stock ID — `PKG-2026-0003/1`. See `lib/stockIds`. */
  stockId?: string
  sku: string
  /** Number of packs/covers filled. */
  packs: number
  /** What one pack held, in base units, at the time of the run. Copied off the
   *  product so a later size change on the master cannot rewrite history. */
  perPack?: number
  /** @deprecated malai covers used to be sized per run; kept so older runs still read */
  kgPerPack?: number
  /** Bulk drawn: litres for water, kg for malai. */
  drawn: number
  /** Packs for water SKUs, kg for malai. */
  qty: number
  unitCost: number
  expiry: string
}

/**
 * Bottles kept back off a packing run as control samples — the plant's control
 * sampling tracking sheet. They draw bulk and, when filled into a pack, its packing
 * material, but they are never stock: nothing can dispatch, issue or move them. What
 * is kept is the record — who collected them, when they expire and when they went.
 */
export interface ControlSample {
  /** Pack product the bottles were filled into. Absent for any other container. */
  sku?: string
  count: number
  /** Another container only: what one held, in ml (g for bulk sold by weight). */
  sizeMl?: number
  /** Bulk one bottle drew, in the bulk's base unit, as it stood when the run was posted. */
  perBottle?: number
  collectedBy?: string
  /** The day the bottles expire: the day they were produced plus the retention days. */
  expiresOn?: string
  /** The day they were destroyed. Empty while they are still kept. */
  destroyedOn?: string
  remark?: string
}

export interface PackingRun {
  id: string
  date: string
  batchId: string
  /** Where the filled packs were put away. */
  location?: string
  /** @deprecated read once into `controlSamples` — bottles counted with no record of
   *  what they were, who took them or when they expire */
  samples?: { count: number; sizeMl: number }
  /** Bottles kept back off the run as control samples. They draw bulk like a pack
   *  does but are never stock and carry no stock ID, so they are recorded here rather
   *  than as a pack line. */
  controlSamples?: ControlSample[]
  /** Bulk item the run drew. Runs posted before more than one juice existed drew
   *  whichever bulk their `medium` names. */
  bulkItem?: string
  medium: PackMedium
  lines: PackingLine[]
  drawn: number
  pmCost: number
  bulkCost: number
  status: string
}

/**
 * A file uploaded and kept in the private bucket — a lab report, a delivery photo.
 *
 * The file itself is never stored in the database; what travels with a record is its
 * object key, which a short-lived signed URL is minted from when somebody opens it.
 */
export interface Attachment {
  fileName: string
  /** @deprecated the bucket is private now — read through `signedUrlFor`.
   *  Attachments saved while it was public still carry their public URL here. */
  url: string
  /** Object key inside the private bucket. */
  path?: string
  uploadedAt: string
}

/** The same thing, under the name the QC record has always called it. */
export type QcAttachment = Attachment

/**
 * One product's test results, for one batch.
 *
 * A batch makes more than one thing — a coconut pressing gives water and malai, and
 * they are tested apart because they are different foods with different results. So a
 * QC record covers one bulk output of one batch, and a batch with two outputs has two
 * of them: the water can be released while the malai is still on the bench.
 */
export interface QcRecord {
  id: string
  batchId: string
  /** The bulk output this record covers. Records written before a batch could be
   *  tested per product carry the batch's main output. */
  item?: string
  micro: string
  pesticides: string
  heavyMetals: string
  physico: string
  microNote?: string
  pesticidesNote?: string
  heavyMetalsNote?: string
  physicoNote?: string
  microReport?: QcAttachment | null
  pesticidesReport?: QcAttachment | null
  heavyMetalsReport?: QcAttachment | null
  physicoReport?: QcAttachment | null
  /**
   * Every test beyond the four above — the sensory evaluation, and any report type an
   * admin adds — by its key. The four keep their own fields, which is what every record
   * saved before report types were configurable already carries.
   */
  tests?: Record<string, QcTestResult>
  /**
   * The tests this record was judged on when it was last reviewed. A product released
   * before a new required test existed stays released on the tests it passed; a record
   * still waiting is judged on whatever is required now.
   */
  requiredTests?: string[]
  disposition: string
  reviewedBy: string
  reviewedAt: string
}

/** One test's result on a QC record. */
export interface QcTestResult {
  status: string
  note?: string
  report?: QcAttachment | null
}

/**
 * Which report type a test parameter, a lab report or a QC result belongs to — one of
 * the four the plant started with (`micro`, `pesticides`, `heavyMetals`, `physico`),
 * the sensory evaluation, or one an admin has added since.
 */
export type TestCategory = string

/**
 * How a report type writes its results down. A lab certificate is a table of
 * parameter, method, unit and result; a sensory evaluation scores weighted
 * attributes 1–5 and reaches a decision from the total.
 */
export type ReportFormat = 'results' | 'scored'

/** What to taste for in one kind of product — the sheet's product-specific checks. */
export interface SensoryProductGroup {
  name: string
  checkpoints: string
  defects: string
  focus: string
}

/**
 * A kind of test report the plant issues, and whether a product has to pass it before
 * release. Admin data, kept in config; the built-in list stands until an admin changes it.
 */
export interface TestCategoryDef {
  /** Fixed once created — results, parameters and reports are filed under it. */
  key: TestCategory
  title: string
  format: ReportFormat
  /** A QC record needs a Pass on this test before its product can be released. */
  requiredForRelease: boolean
  /** Active · Inactive. An inactive type takes no new reports and gates nothing. */
  status: string
  /** Placeholder for the QC note on this test. */
  hint?: string
  /** Printed under the signature on a results report. */
  signatory?: string
  /** Scored only: the score out of 100 a product passes at. */
  passScore?: number
  /** Scored only: at or above this it passes with minor modification; below, R&D review. */
  minorScore?: number
  /** Scored only: what to watch for in each kind of product. */
  productGroups?: SensoryProductGroup[]
}

export interface TestParameter {
  id: string
  category: TestCategory
  name: string
  method: string
  unit: string
  /** Scored only: the heading the attribute sits under — Appearance, Aroma … */
  section?: string
  /** Scored only: the share of the score out of 100 this attribute carries. */
  weight?: number
  /** Scored only: a score below 3 here holds the product whatever the total says. */
  critical?: boolean
}

export interface LabReportResult {
  name: string
  method: string
  unit: string
  result: string
}

/** One attribute of a sensory evaluation, as it was scored. */
export interface SensoryScore {
  section: string
  name: string
  weight: number
  critical: boolean
  /** 1–5, or null while it has not been scored. */
  score: number | null
  observation: string
  action: string
}

export interface LabReport {
  id: string
  category: TestCategory
  customerName: string
  customerAddress: string
  issueDate: string
  /** The evaluator, on a sensory evaluation. */
  labTechnician: string
  sampleQtyAmount: number
  sampleQtyUnit: string
  /** The product / variant, on a sensory evaluation. */
  sampleName: string
  /** The batch or trial number, on a sensory evaluation. */
  batchLotDetails: string
  /** The batch this report tested, when its details name one exactly. The free-text
   *  field stays as it is: trial numbers name R&D samples that are not batches. */
  batchId?: string
  sampleDate: string
  results: LabReportResult[]
  /** Scored reports: every attribute as it was scored. Copied off the blueprint, so
   *  re-weighting an attribute later cannot rescore a report already issued. */
  scores?: SensoryScore[]
  /** Scored reports: Coconut Water, Coconut Melange … */
  productGroup?: string
  /** Scored reports: that product's checks as they read when it was scored. */
  productChecks?: SensoryProductGroup
  servingTemp?: string
  storageCondition?: string
  /** R&D / QA comments and corrective action. */
  comments?: string
  /** Scored reports: the thresholds it was decided against, copied for the same reason. */
  passScore?: number
  minorScore?: number
  createdAt: string
}

/**
 * A customer order. Raised only when the goods are already packed and cleared, so
 * there is nothing to reserve — the stock is checked when the order is dispatched,
 * and an order goes out complete or not at all.
 */
export interface Order {
  id: string
  customerId: string
  customerName: string
  date: string
  /** Ship-by day, as a date key — when the customer expects it out. Optional:
   *  planning scopes open orders into weeks by it, and never hides an order
   *  that is undated or past it. */
  dueDate?: string
  lines: OrderLine[]
  /** Open · Dispatched · Cancelled. */
  status: string
  notes?: string
  /** Challan the fulfilling dispatches were raised under. */
  challan?: string
  dispatchedAt?: string
}

export interface OrderLine {
  /** Pack product ordered — a BiB, a bottle, a malai cover. */
  sku: string
  qty: number
}

export interface Dispatch {
  id: string
  customerId: string
  customerName: string
  batchId: string
  sku: string
  qty: number
  /** Copied off the stock that went out, so the challan keeps saying what was true
   *  when it was issued even after that stock is gone. */
  expiry?: string
  challan: string
  /** Order this line fulfils, when it came from one. Dispatches raised straight off
   *  the packed-stock table have none. */
  orderId?: string
  vehicle: string
  dispatchTime: string
  expected?: string
  status: string
  pod: string
  /** Photographs taken at the door — the signed slip, the stacked cartons, the
   *  temperature reading. Proof of what was handed over, beyond a typed name. */
  podPhotos?: Attachment[]
  deliveredTime?: string
  notes?: string
  deliveryNote?: string
}

export interface LedgerEntry {
  id: string
  type: string
  doc: string
  item: string
  itemType: string
  lot: string
  location: string
  status: string
  qtyIn: number
  qtyOut: number
  uom: string
  unitCost: number
  time: string
  /** Finished goods only: the date the packs on this line are good until. Two runs off
   *  one batch sit in the same lot with different dates, so the date has to travel on
   *  the line rather than be looked up from the batch. */
  expiry?: string
  /** Packing-material receipts only: the vendor it was bought from. Produce carries its
   *  supplier on the GRN; packing material has no such document, so the receipt line is
   *  the only place the link can live. */
  vendorId?: string
}

export interface AuditEntry {
  /** Its own key, so the trail can be an insert-only table rather than a list inside
   *  a blob every client could rewrite. Entries written before that carry one from
   *  the migration. */
  id: string
  time: string
  role: string
  action: string
  doc: string
  details: string
}

export interface Counters {
  grn: number
  lot: number
  batch: number
  packing: number
  qc: number
  dispatch: number
  order: number
  challan: number
  vendor: number
  vendorType: number
  customer: number
  purchaseProduct: number
  /** Pack products (finished-goods SKUs) created on the Products page. */
  product?: number
  /** Bulk products (semi-finished outputs) created on the Products page. */
  bulkProduct?: number
  /** Melange recipes. */
  melange?: number
  /** Melange runs, numbered apart from extraction batches. */
  melangeBatch?: number
  audit: number
  testReport: number
  /** Sticker print jobs. */
  sticker?: number
  /** Stock issued for something other than a sale. */
  issue?: number
  /** Packing-material receipts. Booked ad hoc before this existed, under a random
   *  code that no series could configure or audit. */
  pmReceipt?: number
  storageLocation: number
  /** People on the plant roster. */
  staff?: number
  /** Production plans. */
  plan?: number
  /** legacy */
  farmer?: number
}

export interface AppState {
  counters: Counters
  /**
   * The period each counter's current run of numbers belongs to — `{"lot":"YYYYMMDD:20260909"}`.
   *
   * A series whose code carries a date is a fresh run of numbers each period, so the
   * counter has to know when it has crossed into a new one. Kept beside the counters
   * rather than inside them because it is bookkeeping about a series, not a number
   * the series ever issues. See `periodKeyFor`.
   */
  counterPeriods?: Record<string, string>
  config: Config
  vendorTypes: VendorType[]
  vendors: Vendor[]
  customers: Customer[]
  purchaseProducts: PurchaseProduct[]
  storageLocations: StorageLocation[]
  items: Item[]
  products: Product[]
  melanges: Melange[]
  grns: Grn[]
  batches: Batch[]
  packingRuns: PackingRun[]
  orders: Order[]
  qcs: QcRecord[]
  dispatches: Dispatch[]
  ledger: LedgerEntry[]
  audits: AuditEntry[]
  testParameters: TestParameter[]
  labReports: LabReport[]
  stickerTemplates: StickerTemplate[]
  stickerPrints: StickerPrint[]
  stockIssues: StockIssue[]
  staff: StaffMember[]
  shifts: ShiftAssignment[]
  attendance: AttendanceRecord[]
  productionPlans: ProductionPlan[]
}

/** The stages a sticker can be printed for, in the order the plant works through them. */
export type StickerStage = 'raw' | 'bulk' | 'pack' | 'material' | 'dispatch'

/**
 * One line on a sticker. `key` names the value to read off the record and never
 * changes; `label` is what actually prints beside it and is the admin's to reword.
 */
export interface StickerField {
  key: string
  label: string
  show: boolean
}

/** What a stage's sticker prints, and in what order. */
export interface StickerTemplate {
  stage: StickerStage
  /** Heading across the top of the sticker. */
  title: string
  fields: StickerField[]
}

/**
 * A sticker as it was actually printed. The values are frozen rather than looked up
 * again, for the same reason a packing run copies its pack size and a dispatch copies
 * its expiry: renaming a product must not rewrite a sticker that is already on a box.
 */
export interface StickerPrint {
  id: string
  stage: StickerStage
  /** Lot, batch, run or dispatch the sticker was printed for. */
  reference: string
  title: string
  lines: { label: string; value: string }[]
  copies: number
  widthMm: number
  heightMm: number
  printedAt: string
}

export interface StockRow {
  item: string
  itemType: string
  lot: string
  location: string
  status: string
  uom: string
  qty: number
  value: number
  unitCost: number
  /** Finished goods only. Part of what makes a row distinct: the same pack off the
   *  same batch, packed three weeks apart, is not interchangeable stock. */
  expiry?: string
}

/**
 * Why stock left for something that was not a sale.
 *
 * Every one of these used to have the same two bad options: leave the stock on the
 * books and overstate inventory, or raise a dispatch against an invented customer —
 * which also burns a number out of a delivery-challan sequence that is supposed to
 * run unbroken.
 */
export const ISSUE_REASONS = [
  'Lab / testing',
  'BTL / marketing',
  'Damage / breakage',
  'Expired',
  'Internal use',
  'Other',
] as const

export type IssueReason = (typeof ISSUE_REASONS)[number]

/**
 * One line of an issue: a specific stock row and how much of it went.
 *
 * The row is named in full — down to the location, the status and the expiry —
 * because that is what makes stock interchangeable or not. Two bottles off one batch
 * packed three weeks apart are not the same stock, and an issue has to say which of
 * them actually left the building.
 */
export interface StockIssueLine {
  item: string
  itemType: string
  lot: string
  location: string
  status: string
  uom: string
  qty: number
  /** What the stock carried when it left. Copied, not looked up: revaluing the item
   *  later must not rewrite what this issue cost. */
  unitCost: number
  expiry?: string
}

/**
 * Stock out for something that is not a sale — samples to a lab, goods for a BTL
 * activity, breakage, an expiry write-off.
 *
 * Deliberately not a dispatch. There is no customer, no challan and no dispatch
 * label, it never reaches sales or delivery reporting, and it carries its own
 * document series so the challan numbering stays unbroken.
 */
export interface StockIssue {
  id: string
  date: string
  reason: IssueReason
  /** The lab, the event, the person — whoever it went to. Free text by design. */
  recipient?: string
  notes?: string
  lines: StockIssueLine[]
  /** What left, at the cost the stock carried. */
  value: number
}
