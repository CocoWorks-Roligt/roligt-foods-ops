import type { AppState, ProductionPlan, ShiftAssignment, ShiftName } from '../types'
import {
  DEFAULT_STICKER_HEIGHT_MM,
  DEFAULT_STICKER_WIDTH_MM,
  defaultTemplates,
} from '../lib/stickers'
import { toDateKey, uid } from '../lib/utils'

export const seed: AppState = {
  counters: {
    grn: 0,
    lot: 0,
    batch: 0,
    qc: 0,
    dispatch: 0,
    order: 0,
    challan: 0,
    vendor: 0,
    vendorType: 2,
    customer: 0,
    purchaseProduct: 0,
    audit: 0,
    testReport: 0,
    storageLocation: 5,
    packing: 0,
    product: 0,
    bulkProduct: 0,
    melange: 0,
    melangeBatch: 0,
    sticker: 0,
    issue: 0,
    pmReceipt: 0,
    staff: 5,
    plan: 3,
  },
  counterPeriods: {},
  config: {
    yieldTolerance: 12,
    pmTolerance: 5,
    expiryAlertDays: 2,
    lowStockPacks: 50,
    reportCustomerName: 'Roligt Foods Private Limited',
    reportCustomerAddress: 'Sy No- 617, Pudur village, Medchal Mandal, Hyderabad, Telangana-501401.',
    defaultLabTechnician: '',
    frozenStorageLine: 'Always store in Cool (-18°C) Dry and Hygiene Place',
    chilledStorageLine: 'Always store in Cool (4°C) Dry & Hygiene Place',
    consumeWithinLine: 'Consume within 3 days of opening',
    stickerWidthMm: DEFAULT_STICKER_WIDTH_MM,
    stickerHeightMm: DEFAULT_STICKER_HEIGHT_MM,
  },
  vendorTypes: [
    {
      id: 'VT-FARMER',
      name: 'Farmer',
      sourceKind: 'Farmer',
      description: 'Produce suppliers',
      status: 'Active',
    },
    {
      id: 'VT-VENDOR',
      name: 'Vendor',
      sourceKind: 'Vendor',
      description: 'Material and packing suppliers',
      status: 'Active',
    },
  ],
  vendors: [],
  purchaseProducts: [],
  customers: [],
  // `name` is the ledger key and never changes; `label` is what people read.
  // One list of storage areas; `type` is what tells a cold room from a dry store.
  storageLocations: [
    {
      id: 'LOC-0001',
      name: 'RM Store',
      label: 'Raw Material Store',
      holds: 'Produce received from farmers — coconuts, beetroot, carrot, apple — waiting to be pressed',
      type: 'Dry Store',
      status: 'Active',
    },
    {
      id: 'LOC-0002',
      name: 'PM Store',
      label: 'Packaging Store',
      holds: 'BiBs, cartons, bottles, caps and malai covers',
      type: 'Dry Store',
      status: 'Active',
    },
    {
      id: 'LOC-0003',
      name: 'Bulk Store',
      label: 'Bulk Cold Room',
      holds: 'Extracted juice, coconut water, malai and blended melanges waiting to be packed',
      type: 'Cold Room',
      status: 'Active',
    },
    {
      id: 'LOC-0004',
      name: 'Cold Room',
      label: 'Finished Goods Cold Room',
      holds: 'Frozen finished packs, from the moment they come off the line until they are dispatched',
      type: 'Cold Room',
      status: 'Active',
    },
    {
      id: 'LOC-0005',
      name: 'Reject Hold',
      label: 'Rejected Stock',
      holds: 'Stock quality rejected — not sellable, waiting on a decision',
      type: 'Hold Area',
      status: 'Active',
    },
  ],
  items: [
    {
      id: 'RM-TCW-COCO',
      name: 'Tender Coconut',
      type: 'Raw Material',
      uom: 'Piece',
      lotControlled: true,
      reorder: 500,
      costMethod: 'Lot Actual',
    },
    {
      id: 'SF-TCW-WATER',
      name: 'Coconut Water (bulk)',
      type: 'Semi Finished',
      uom: 'Litre',
      lotControlled: true,
      reorder: 0,
      costMethod: 'Batch Actual',
    },
    {
      id: 'SF-TCW-MALAI',
      name: 'Malai (bulk)',
      type: 'Semi Finished',
      uom: 'Kg',
      lotControlled: true,
      reorder: 0,
      costMethod: 'By-product',
    },
    {
      id: 'PM-MALAI-COVER',
      name: 'Malai Cover',
      type: 'Packing Material',
      uom: 'Piece',
      lotControlled: true,
      reorder: 100,
      costMethod: 'Weighted Avg',
    },
    {
      id: 'FG-MALAI',
      name: 'Malai Pack',
      type: 'Finished Goods',
      uom: 'Kg',
      lotControlled: true,
      reorder: 10,
      costMethod: 'Batch Actual',
    },
    {
      id: 'PM-BIB-5L',
      name: '5 L BiB',
      type: 'Packing Material',
      uom: 'Piece',
      lotControlled: true,
      reorder: 100,
      costMethod: 'Weighted Avg',
    },
    {
      id: 'PM-CBOX-5L',
      name: '5 L C-Box',
      type: 'Packing Material',
      uom: 'Piece',
      lotControlled: true,
      reorder: 100,
      costMethod: 'Weighted Avg',
    },
    {
      id: 'PM-BIB-2.5L',
      name: '2.5 L BiB',
      type: 'Packing Material',
      uom: 'Piece',
      lotControlled: true,
      reorder: 100,
      costMethod: 'Weighted Avg',
    },
    {
      id: 'PM-CBOX-2.5L',
      name: '2.5 L C-Box',
      type: 'Packing Material',
      uom: 'Piece',
      lotControlled: true,
      reorder: 100,
      costMethod: 'Weighted Avg',
    },
    {
      id: 'PM-BOTTLE-250',
      name: '250 ml Glass Bottle',
      type: 'Packing Material',
      uom: 'Piece',
      lotControlled: true,
      reorder: 500,
      costMethod: 'Weighted Avg',
    },
    {
      id: 'PM-CAP-250',
      name: '250 ml Cap',
      type: 'Packing Material',
      uom: 'Piece',
      lotControlled: true,
      reorder: 500,
      costMethod: 'Weighted Avg',
    },
    {
      id: 'FG-TCW-5L',
      name: 'OG Tender Coconut Water 5 L',
      type: 'Finished Goods',
      uom: 'Pack',
      lotControlled: true,
      reorder: 30,
      costMethod: 'Batch Actual',
    },
    {
      id: 'FG-TCW-2.5L',
      name: 'OG Tender Coconut Water 2.5 L',
      type: 'Finished Goods',
      uom: 'Pack',
      lotControlled: true,
      reorder: 30,
      costMethod: 'Batch Actual',
    },
    {
      id: 'FG-TCW-250ML',
      name: 'OG Tender Coconut Water 250 ml',
      type: 'Finished Goods',
      uom: 'Bottle',
      lotControlled: true,
      reorder: 200,
      costMethod: 'Batch Actual',
    },
  ],
  products: [
    {
      id: 'FG-TCW-5L',
      name: 'OG TCW 5 L',
      type: 'BiB',
      size: 5,
      unit: 'L',
      packVolume: 5,
      shelfLifeDays: 7,
      medium: 'Water',
      bulkItem: 'SF-TCW-WATER',
      bom: [
        { item: 'PM-BIB-5L', qty: 1 },
        { item: 'PM-CBOX-5L', qty: 1 },
      ],
    },
    {
      id: 'FG-MALAI',
      name: 'Malai Cover 1 kg',
      type: 'Cover',
      size: 1,
      unit: 'kg',
      packVolume: 1,
      shelfLifeDays: 7,
      medium: 'Malai',
      bulkItem: 'SF-TCW-MALAI',
      bom: [{ item: 'PM-MALAI-COVER', qty: 1 }],
    },
    {
      id: 'FG-TCW-2.5L',
      name: 'OG TCW 2.5 L',
      type: 'BiB',
      size: 2.5,
      unit: 'L',
      packVolume: 2.5,
      shelfLifeDays: 7,
      medium: 'Water',
      bulkItem: 'SF-TCW-WATER',
      bom: [
        { item: 'PM-BIB-2.5L', qty: 1 },
        { item: 'PM-CBOX-2.5L', qty: 1 },
      ],
    },
    {
      id: 'FG-TCW-250ML',
      name: 'OG TCW 250 ml',
      type: 'Glass Bottle',
      size: 250,
      unit: 'ml',
      packVolume: 0.25,
      shelfLifeDays: 7,
      medium: 'Water',
      bulkItem: 'SF-TCW-WATER',
      bom: [
        { item: 'PM-BOTTLE-250', qty: 1 },
        { item: 'PM-CAP-250', qty: 1 },
      ],
    },
  ],
  melanges: [],
  grns: [],
  batches: [],
  packingRuns: [],
  orders: [],
  qcs: [],
  dispatches: [],
  ledger: [],
  audits: [],
  testParameters: [
    { id: uid('TP'), category: 'micro', name: 'Aerobic Plate count', method: 'IS 5402-1:2021', unit: 'Cfu/mL' },
    { id: uid('TP'), category: 'micro', name: 'Listeria monocytogenes', method: 'IS 14988-1:2020', unit: '/25mL' },
    { id: uid('TP'), category: 'micro', name: 'Staphylococcus aureus', method: 'IS 5887-2:1976', unit: '/mL' },
    { id: uid('TP'), category: 'micro', name: 'Vibrio cholerae', method: 'IS 5887-5/Sec-1:2023', unit: '/25mL' },
    { id: uid('TP'), category: 'micro', name: 'Yeast and Moulds', method: 'IS 5403:1999', unit: 'Cfu/mL' },
    { id: uid('TP'), category: 'micro', name: 'E. coli', method: 'IS 5887-1:1976', unit: '/mL' },
    { id: uid('TP'), category: 'micro', name: 'Salmonella spp', method: 'IS 5887-3/Sec-1:2020', unit: '/25mL' },
  ],
  labReports: [],
  stickerTemplates: defaultTemplates(),
  stickerPrints: [],
  stockIssues: [],
  staff: [
    { id: 'STF-0001', name: 'Ramesh Kumar', role: 'Supervisor', phone: '98450 11001', status: 'Active', addedOn: '2026-01-05' },
    { id: 'STF-0002', name: 'Suresh Naik', role: 'Extraction operator', phone: '98450 11002', status: 'Active', addedOn: '2026-01-05' },
    { id: 'STF-0003', name: 'Priya Shetty', role: 'QC analyst', phone: '98450 11003', status: 'Active', addedOn: '2026-01-05' },
    { id: 'STF-0004', name: 'Anita Fernandes', role: 'Packing line', phone: '98450 11004', status: 'Active', addedOn: '2026-01-05' },
    { id: 'STF-0005', name: 'Mohan Das', role: 'Driver', phone: '98450 11005', status: 'Active', addedOn: '2026-01-05' },
  ],
  // A Monday–Saturday pattern for the week the seed is first run, so the roster
  // opens with something on it. Sunday is left open — that is the plant's call.
  shifts: seedShifts(),
  attendance: [],
  // The week ahead, so planning opens with something to work against.
  productionPlans: seedPlans(),
}

/**
 * The week's opening pattern: Monday to Saturday, each person on the line they
 * own. Sunday is left open — whether the plant runs it is the plant's call.
 */
function seedShifts(): ShiftAssignment[] {
  const now = new Date()
  const monday = new Date(now)
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7))
  const day = (offset: number) => {
    const d = new Date(monday)
    d.setDate(monday.getDate() + offset)
    return toDateKey(d)
  }
  const pattern: [string, ShiftName, string][] = [
    ['STF-0001', 'General', 'General'],
    ['STF-0002', 'Morning', 'Extraction'],
    ['STF-0003', 'Morning', 'QC'],
    ['STF-0004', 'Morning', 'Packing'],
    ['STF-0005', 'General', 'Dispatch'],
  ]
  const out: ShiftAssignment[] = []
  for (let i = 0; i < 6; i++) {
    const date = day(i)
    for (const [staffId, shift, line] of pattern) {
      out.push({ id: `${staffId}|${date}`, staffId, date, shift, line })
    }
  }
  return out
}

/**
 * Three plans for the next few days — the shape of a normal week: press tomorrow,
 * blend the day after, pack at the end of it. Dated off today, so a fresh install
 * always has this week to look at.
 */
function seedPlans(): ProductionPlan[] {
  const today = new Date()
  const day = (n: number) => {
    const d = new Date(today)
    d.setDate(today.getDate() + n)
    return toDateKey(d)
  }
  const pln = (n: number) => `PLN-${today.getFullYear()}-${String(n).padStart(4, '0')}`
  return [
    {
      id: pln(1),
      date: day(1),
      stage: 'Extraction',
      product: 'Coconut Water (bulk)',
      qty: 200,
      uom: 'Litre',
      status: 'Planned',
      createdOn: toDateKey(today),
    },
    {
      id: pln(2),
      date: day(2),
      stage: 'Packing',
      product: 'OG TCW 5 L',
      qty: 40,
      uom: 'Packs',
      status: 'Planned',
      createdOn: toDateKey(today),
    },
    {
      id: pln(3),
      date: day(3),
      stage: 'Melange',
      product: 'Malai (bulk)',
      qty: 50,
      uom: 'Kg',
      note: 'For the malai cover run',
      status: 'Planned',
      createdOn: toDateKey(today),
    },
  ]
}
