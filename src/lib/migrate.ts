import { seed } from '../data/seed'
import type { AppState, BomLine, BulkOutputLine, StorageType, Vendor, VendorType } from '../types'
import { batchInputQty, mainOutput, usableYield } from './batches'
import { batchDisposition } from './posting'
import { stockIdFor } from './stockIds'
import { toBase } from './packs'
import {
  DEFAULT_STICKER_HEIGHT_MM,
  DEFAULT_STICKER_WIDTH_MM,
  defaultTemplates,
} from './stickers'
import { expiryFor } from './stock'
import { addDays, retentionDays } from './controlSamples'
import { deepClone, localDay } from './utils'

/** Best guess at a pack format for a product saved before the type was recorded. */
function inferPackType(name = '', bom: BomLine[] = []) {
  const hay = `${name} ${bom.map((b) => b.item).join(' ')}`.toLowerCase()
  if (hay.includes('bib')) return 'BiB'
  if (hay.includes('bottle')) return 'Glass Bottle'
  if (hay.includes('cover')) return 'Cover'
  if (hay.includes('pouch')) return 'Pouch'
  if (hay.includes('can')) return 'Can'
  return 'Pack'
}

export const FIXED_VENDOR_TYPES: VendorType[] = [
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
]

/** Map any legacy type id/name to Farmer or Vendor. */
export function normalizeVendorTypeId(typeIdOrName?: string): 'VT-FARMER' | 'VT-VENDOR' {
  const v = (typeIdOrName || '').toLowerCase()
  if (!v) return 'VT-FARMER'
  if (
    v.includes('vendor') ||
    v.includes('material') ||
    v.includes('pack') ||
    v === 'vt-vendor' ||
    v === 'vt-material' ||
    v === 'vt-other' ||
    v.includes('transport')
  ) {
    return 'VT-VENDOR'
  }
  return 'VT-FARMER'
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

export interface MigrateOptions {
  /**
   * Fold the seed's items, packs and rooms in when the saved data is missing them.
   *
   * On by default, because that is what upgrades a database written before bulk
   * water and malai existed — without it, production would have nothing to book its
   * output against.
   *
   * It has to be off for a database that is deliberately empty. The back-fill cannot
   * tell "old, missing the new masters" from "wiped on purpose" by looking at the
   * data — both are an absent item — so the caller, which knows why it is loading,
   * decides. `AppContext` turns it off for anything read back from the database and
   * leaves it on for the first-run seed.
   */
  seedMasters?: boolean
}

/** Normalize older db.json shapes into the current AppState. */
export function migrateState(raw: unknown, opts: MigrateOptions = {}): AppState {
  const seedMasters = opts.seedMasters ?? true
  const base = deepClone(seed)
  const incoming = asRecord(raw)

  const next: AppState = {
    ...base,
    ...incoming,
    counters: { ...base.counters, ...asRecord(incoming.counters) } as AppState['counters'],
    counterPeriods: { ...asRecord(incoming.counterPeriods) } as Record<string, string>,
    config: { ...base.config, ...asRecord(incoming.config) } as AppState['config'],
    vendorTypes: FIXED_VENDOR_TYPES,
    vendors: (incoming.vendors as Vendor[]) || [],
    customers: (incoming.customers as AppState['customers']) || base.customers,
    purchaseProducts:
      (incoming.purchaseProducts as AppState['purchaseProducts']) || base.purchaseProducts,
    storageLocations:
      (incoming.storageLocations as AppState['storageLocations']) || base.storageLocations,
    items: (incoming.items as AppState['items']) || base.items,
    products: (incoming.products as AppState['products']) || base.products,
    melanges: (incoming.melanges as AppState['melanges']) || base.melanges,
    grns: (incoming.grns as AppState['grns']) || base.grns,
    batches: (incoming.batches as AppState['batches']) || base.batches,
    packingRuns: (incoming.packingRuns as AppState['packingRuns']) || base.packingRuns,
    orders: (incoming.orders as AppState['orders']) || [],
    qcs: (incoming.qcs as AppState['qcs']) || base.qcs,
    dispatches: (incoming.dispatches as AppState['dispatches']) || base.dispatches,
    ledger: (incoming.ledger as AppState['ledger']) || base.ledger,
    audits: (incoming.audits as AppState['audits']) || base.audits,
  }

  // Lab reports used to name their batch only in free text. The exact match is now the
  // link the reports list, the batch's detail view and the trace chain all read.
  for (const r of next.labReports) {
    if (r.batchId) continue
    const key = (r.batchLotDetails || '').trim()
    if (key && next.batches.some((b) => b.id === key)) r.batchId = key
  }

  if (!next.vendors.length) {
    const legacyFarmers = (incoming.farmers as Array<Record<string, string>>) || []
    next.vendors = legacyFarmers.map((f) => ({
      id: f.id,
      name: f.name,
      vendorTypeId: normalizeVendorTypeId(f.type),
      phone: f.phone || '',
      area: f.area || '',
      payment: f.payment || 'Bank Transfer',
      status: f.status || 'Active',
    }))
  }

  // Force every vendor onto Farmer / Vendor only, and onto the one pair of status
  // words the whole app now uses. 'Approved' / 'Suspended' here, 'Retired' on a
  // recipe and 'Inactive' on a customer were three names for two states.
  next.vendors = next.vendors.map((v) => ({
    ...v,
    vendorTypeId: normalizeVendorTypeId(v.vendorTypeId),
    status: v.status === 'Suspended' ? 'Inactive' : v.status === 'Approved' ? 'Active' : v.status,
  }))
  next.vendorTypes = FIXED_VENDOR_TYPES
  next.counters.vendorType = 2
  if (!next.counters.vendor) {
    next.counters.vendor = next.counters.farmer || next.vendors.length || 0
  }
  if (!next.counters.purchaseProduct) {
    next.counters.purchaseProduct = next.purchaseProducts.length || 0
  }

  // Items, products and locations live inside the saved database, so a database
  // written before bulk water/malai existed has to have the new masters folded in —
  // otherwise production has nothing to book its output against.
  if (seedMasters) {
    for (const item of base.items) {
      if (!next.items.some((i) => i.id === item.id)) next.items.push(item)
    }
    for (const p of base.products) {
      if (!next.products.some((x) => x.id === p.id)) next.products.push(p)
    }
  }
  // Pack type, size and unit became master data the admin sets; databases written
  // before that only carry packVolume, so the size is read back out of it.
  next.products = next.products.map((p) => {
    const medium = p.medium || 'Water'
    const seeded = base.products.find((x) => x.id === p.id)
    let unit = p.unit || seeded?.unit
    let size = p.size ?? seeded?.size
    if (!unit || !(size > 0)) {
      // A sub-litre water pack reads far better as ml than as 0.25 L, and a malai
      // cover with no size at all was one whose weight used to be typed per run.
      if (medium === 'Malai') {
        unit = 'kg'
        size = p.packVolume > 0 ? p.packVolume : 1
      } else if (p.packVolume > 0 && p.packVolume < 1) {
        unit = 'ml'
        size = Math.round(p.packVolume * 1000)
      } else {
        unit = 'L'
        size = p.packVolume || 1
      }
    }
    return {
      ...p,
      medium,
      unit,
      size,
      // Everything packed before the plant made more than one juice was filled from
      // coconut water or malai, so that is the bulk those packs still draw.
      bulkItem: p.bulkItem || (medium === 'Malai' ? 'SF-TCW-MALAI' : 'SF-TCW-WATER'),
      type: p.type || seeded?.type || inferPackType(p.name, p.bom),
      packVolume: toBase(size, unit),
    }
  })
  if (!next.counters.product) next.counters.product = next.products.length
  if (seedMasters) {
    for (const loc of base.storageLocations) {
      if (!next.storageLocations.some((s) => s.name === loc.name)) next.storageLocations.push(loc)
    }
  }
  // Locations saved before they had a readable name get one from the seed, so the
  // ledger keeps its "RM Store" key while the screen finally says "Coconut Store".
  // Wording we have since improved. A label still matching the old default gets the
  // new one; a name the user chose themselves is left alone.
  const SUPERSEDED_LABELS: Record<string, string> = {
    // A place and a state cannot share a name: the batch is what is awaiting QC, the
    // store is where it waits.
    'Awaiting QC': 'Quarantine Store',
    // The raw-material store holds beetroot, carrot and apple now, not only coconuts.
    'Coconut Store': 'Raw Material Store',
  }
  /**
   * Storage used to be four separate lists — freezers, defrost areas, stores and
   * holds — which is why nobody could say whether bulk lived in a "store" or a "hold".
   * There is one list of storage areas now and a `type` on each, so every saved area
   * has to be told which it is.
   *
   * A defrost area becomes a cold room: packs are not thawed before dispatch any more,
   * so what is left is simply another refrigerated room. A hold is a hold unless it is
   * plainly a cold one — the seeded "Bulk Store" is a hold by its old kind and a cold
   * room by every other measure.
   */
  const COLD_BY_NAME = /bulk|cold|freez|chill/i
  const typeFromKind = (
    s: AppState['storageLocations'][number] & { kind?: string },
  ): StorageType => {
    if (s.type) return s.type
    switch (s.kind) {
      case 'Freezer':
      case 'Defrost':
      case 'Thawing':
        return 'Cold Room'
      case 'Store':
        return 'Dry Store'
      case 'Hold':
        return COLD_BY_NAME.test(`${s.label} ${s.name}`) ? 'Cold Room' : 'Hold Area'
      default:
        return 'Dry Store'
    }
  }
  /**
   * Bulk may only be kept in a cold room. An area saved before areas had a type that is
   * holding bulk *right now* therefore has to be one, whatever its old kind said —
   * otherwise the migration would strand the stock standing in it. A type somebody has
   * set is theirs and is never overridden, and an area that merely held bulk once is not
   * forced back to a cold room on every load.
   */
  const bulkBalance = new Map<string, number>()
  for (const l of next.ledger) {
    if (l.itemType !== 'Semi Finished') continue
    bulkBalance.set(l.location, (bulkBalance.get(l.location) || 0) + Number(l.qtyIn) - Number(l.qtyOut))
  }
  const holdsBulk = new Set([...bulkBalance].filter(([, qty]) => qty > 1e-6).map(([location]) => location))
  next.storageLocations = next.storageLocations.map((s) => {
    const seeded = base.storageLocations.find((x) => x.name === s.name)
    const label = s.label || seeded?.label || s.name
    const withKind = s as AppState['storageLocations'][number] & { kind?: string }
    return {
      id: s.id,
      name: s.name,
      label: SUPERSEDED_LABELS[label] || label,
      holds: s.holds || seeded?.holds || '',
      type: withKind.type || (holdsBulk.has(s.name) ? 'Cold Room' : typeFromKind(withKind)),
      // An area saved without a status was in use; left blank it vanished from every picker.
      status: s.status || 'Active',
    }
  })

  // Batches posted before the extraction/packing split recorded litres straight on
  // their outputs; treat that as the water yield so yield reporting stays continuous.
  // Everything posted before the plant pressed anything but coconuts was a coconut
  // extraction: one raw material, water as the main output and malai as a by-product.
  next.batches = next.batches.map((b) => {
    const waterLitres = b.waterLitres ?? b.outputLitres ?? 0
    const malaiKg = b.malaiKg ?? 0
    const outputLines: BulkOutputLine[] = b.outputLines?.length
      ? b.outputLines
      : [
          ...(waterLitres > 0
            ? [{ item: 'SF-TCW-WATER', qty: waterLitres, uom: 'Litre', costShare: 100 }]
            : []),
          ...(malaiKg > 0 ? [{ item: 'SF-TCW-MALAI', qty: malaiKg, uom: 'Kg', costShare: 0 }] : []),
        ]
    // `productFamily` was free text typed on every batch and is gone: a batch is named
    // by what it actually produced. Dropped here rather than left to ride along, so it
    // is not written back to the database on the next save.
    const { productFamily: _dropped, ...rest } = b as typeof b & { productFamily?: string }
    void _dropped
    return {
      ...rest,
      kind: b.kind || 'Extraction',
      waterLitres,
      malaiKg,
      outputLines,
      sourceLines: (b.sourceLines || []).map((s) => ({
        ...s,
        item: s.item || 'RM-TCW-COCO',
        uom: s.uom || 'Piece',
      })),
      inputQty: b.inputQty ?? b.coconuts ?? 0,
      inputUom: b.inputUom || 'Piece',
      yieldPerUnit: b.yieldPerUnit ?? b.yieldPerCoconut ?? 0,
    }
  })

  // Runs posted before more than one juice existed drew whichever bulk their medium names.
  // Runs posted before control samples were a register counted their sample bottles and
  // nothing else; they become one register line each, expiring the way a new one does.
  next.packingRuns = next.packingRuns.map((r) => {
    const { samples, ...rest } = r
    const legacy =
      !r.controlSamples?.length && samples && samples.count > 0 && samples.sizeMl > 0
        ? [
            {
              count: samples.count,
              sizeMl: samples.sizeMl,
              perBottle: samples.sizeMl / 1000,
              collectedBy: '',
              expiresOn: addDays(localDay(r.date), retentionDays(next.config)),
            },
          ]
        : undefined
    return {
      ...rest,
      bulkItem: r.bulkItem || (r.medium === 'Malai' ? 'SF-TCW-MALAI' : 'SF-TCW-WATER'),
      ...(legacy ? { controlSamples: legacy } : {}),
    }
  })

  /**
   * Expiry used to be looked up from the batch, which could only ever answer with one
   * date — so a batch packed twice showed the first run's date on every pack it made,
   * including the ones filled weeks later. The date now travels on the stock line, and
   * a line written before it did knows the run that wrote it, so it can be told.
   */
  const runExpiry = new Map<string, string>()
  for (const run of next.packingRuns) {
    for (const line of run.lines) {
      if (line.expiry) runExpiry.set(`${run.id}\u0000${line.sku}`, line.expiry)
    }
  }
  for (const l of next.ledger) {
    if (l.expiry || l.itemType !== 'Finished Goods') continue
    const packed = runExpiry.get(`${l.doc}\u0000${l.item}`)
    if (packed) l.expiry = packed
  }
  // Stock QC moved, or a store transfer relocated, carries the doc of the transfer
  // rather than the run that packed it. Those lines fall back to the batch, which is
  // the best the old data can say.
  for (const l of next.ledger) {
    if (l.expiry || l.itemType !== 'Finished Goods') continue
    const dated = expiryFor(next, l.lot, l.item)
    if (dated) l.expiry = dated
  }
  for (const d of next.dispatches) {
    if (!d.expiry) d.expiry = expiryFor(next, d.batchId, d.sku)
  }

  // Receipts posted before produce other than coconuts could be bought are all coconuts.
  next.grns = next.grns.map((g) => ({
    ...g,
    itemId: g.itemId || 'RM-TCW-COCO',
    uom: g.uom || 'Piece',
    // Where its own receipt line put it; the seed name only guessed, and printed as-is
    // wherever that area no longer existed.
    location: g.location || next.ledger.find((l) => l.doc === g.id && l.type === 'Receipt')?.location || '',
  }))

  // A melange recipe owns the bulk item it is booked as, so a database carrying
  // recipes must carry their outputs too or a blend would have nothing to book into.
  for (const m of next.melanges) {
    // 'Retired' was a third word for a state the rest of the app calls Inactive.
    if (m.status === 'Retired') m.status = 'Inactive'
    if (next.items.some((i) => i.id === m.outputItem)) continue
    next.items.push({
      id: m.outputItem,
      name: `${m.name} (bulk)`,
      type: 'Semi Finished',
      uom: m.uom || 'Litre',
      lotControlled: true,
      reorder: 0,
      costMethod: 'Batch Actual',
    })
  }
  next.counters.melange = Math.max(Number(next.counters.melange) || 0, next.melanges.length)

  /**
   * Packing materials and raw produce were only ever stock items — a pack product
   * could name a bottle and a receipt could add stock of it, but nothing in the app
   * could create one, and the Products page's section for them sat empty. Give every
   * one the master row it should always have had, keeping the item id it is already
   * booked against so no ledger line moves.
   */
  /**
   * Rows that were already in the saved database, before this migration mints any.
   * Only these can be old enough to need their supplier links guessed — a row minted
   * a few lines below has simply never been given one.
   */
  const storedProducts = new Set(next.purchaseProducts.map((p) => p.id))
  const ppNumber = (id: string) => Number(/^PP-(\d+)$/.exec(id)?.[1] || 0)
  next.counters.purchaseProduct = next.purchaseProducts.reduce(
    (highest, p) => Math.max(highest, ppNumber(p.id)),
    Number(next.counters.purchaseProduct) || 0,
  )
  const sameName = (a = '', b = '') => a.trim().toLowerCase() === b.trim().toLowerCase()
  // Adding a product minted its stock item from its own id, so naming one after produce
  // the plant was already receiving — tender coconuts above all — split that produce
  // across two ids. The ledger keys stock by item, so the two never pool: one coconut
  // reads as two half-empty lines and production stops recognising either. The minted
  // id is the one that gives way, since the older stock is booked against the other.
  const mintedItem = /^(?:RM|PM|OT)-PP-\d+$/
  const mergedItems = new Map<string, string>()
  for (const item of next.items) {
    if (item.type !== 'Packing Material' && item.type !== 'Raw Material') continue
    // An id already merged away is not an item any more, only a forwarding address.
    if (mergedItems.has(item.id)) continue
    if (next.purchaseProducts.some((p) => p.itemId === item.id)) continue
    const category = item.type === 'Packing Material' ? 'Packing Material' : 'Farm Produce'
    // A row already carrying this name is the same produce under a minted id, not a
    // second product — the app forbids two rows named alike, so one has to give way.
    const twin = next.purchaseProducts.find(
      (p) => sameName(p.name, item.name) && p.itemId && p.itemId !== item.id,
    )
    if (twin) {
      // Only ever fold a minted id into a hand-written one. Two minted ids, or two
      // hand-written ones, give no ground for choosing a survivor, and different units
      // cannot be pooled at all — their quantities do not mean the same thing.
      const foldable =
        mintedItem.test(twin.itemId as string) &&
        !mintedItem.test(item.id) &&
        sameName(twin.uom, item.uom)
      if (!foldable) continue
      mergedItems.set(twin.itemId as string, item.id)
      twin.itemId = item.id
      continue
    }
    next.counters.purchaseProduct += 1
    next.purchaseProducts.push({
      id: `PP-${String(next.counters.purchaseProduct).padStart(4, '0')}`,
      name: item.name,
      category,
      uom: item.uom,
      description: '',
      vendorIds: [],
      itemId: item.id,
      status: 'Active',
    })
  }
  if (mergedItems.size) {
    // Every reference to the abandoned id moves across, so the stock it held is not
    // stranded — the merge must never lose a quantity, only the duplicate id.
    for (const l of next.ledger) {
      const merged = mergedItems.get(l.item)
      if (merged) l.item = merged
    }
    for (const g of next.grns) {
      const merged = mergedItems.get(g.itemId as string)
      if (merged) g.itemId = merged
    }
    for (const b of next.batches) {
      for (const s of b.sourceLines) {
        const merged = mergedItems.get(s.item as string)
        if (merged) s.item = merged
      }
    }
    for (const p of next.products) {
      for (const line of p.bom) {
        const merged = mergedItems.get(line.item)
        if (merged) line.item = merged
      }
    }
    next.items = next.items.filter((i) => !mergedItems.has(i.id))
  }

  // A receipt posted before produce was master data carries no product, so the row it
  // belongs to is the one holding the item it booked. Without this the produce a
  // receipt names could not be shown, and editing one would demand a product nobody
  // could supply.
  next.grns = next.grns.map((g) =>
    g.purchaseProductId
      ? g
      : {
          ...g,
          purchaseProductId: next.purchaseProducts.find((p) => p.itemId === g.itemId)?.id,
        },
  )

  /**
   * Packing runs used to be numbered `packing-0003` — lowercase, no year, the only
   * document that broke the `XXX-2026-NNNN` pattern the rest of the app reads by. The
   * id is a key the ledger and the audit trail are written in, so renaming it means
   * rewriting every reference to it in the same pass.
   */
  const renamedRuns = new Map<string, string>()
  for (const run of next.packingRuns) {
    const legacy = /^packing-(\d+)$/.exec(run.id)
    if (!legacy) continue
    const renamed = `PKG-2026-${legacy[1].padStart(4, '0')}`
    renamedRuns.set(run.id, renamed)
    run.id = renamed
  }
  if (renamedRuns.size) {
    for (const line of next.ledger) {
      const renamed = renamedRuns.get(line.doc)
      if (renamed) line.doc = renamed
    }
    for (const entry of next.audits) {
      const renamed = renamedRuns.get(entry.doc)
      if (renamed) entry.doc = renamed
    }
  }
  // The trail is a table of its own now, so each entry needs a key. Entries written
  // when it was a list inside the blob have none; they are given one here, derived from
  // their position and time so re-running the migration cannot mint a second row for
  // the same entry.
  next.audits = next.audits.map((a, i) =>
    a.id ? a : { ...a, id: `AUD-LEGACY-${i}-${Date.parse(a.time) || 0}` },
  )

  next.counters.melangeBatch = Math.max(
    Number(next.counters.melangeBatch) || 0,
    next.batches.filter((b) => b.kind === 'Melange').length,
  )
  if (!next.counters.bulkProduct) {
    next.counters.bulkProduct = next.items.filter((i) => i.id.startsWith('SF-') && /SF-\d+$/.test(i.id)).length
  }

  // Older plants filed finished goods under "FG Quarantine". It is renamed before the
  // areas are checked against the ledger below — the other way round, the check made an
  // area for the old name and the rename then left the stock under a name with none.
  next.ledger = next.ledger.map((l) =>
    l.location === 'FG Quarantine' ? { ...l, location: 'Quarantine Store' } : l,
  )
  const oldQuarantine = next.storageLocations.find((s) => s.name === 'FG Quarantine')
  if (oldQuarantine && !next.storageLocations.some((s) => s.name === 'Quarantine Store')) {
    oldQuarantine.name = 'Quarantine Store'
  }

  // Any location name the ledger already used must exist in the master, or its
  // stock would become unmovable and — worse — silently undispatchable. Names
  // written before locations were data were all freely dispatchable, so keep them so.
  for (const l of next.ledger) {
    if (!l.location || next.storageLocations.some((s) => s.name === l.location)) continue
    // A fresh id past every one in use. Counting the list gave the new area the id of one
    // still in it whenever an earlier area had been deleted, and the save then lost one.
    const highest = Math.max(
      Number(next.counters.storageLocation) || 0,
      ...next.storageLocations.map((s) => Number(/(\d+)$/.exec(s.id)?.[1]) || 0),
    )
    const taken = new Set(next.storageLocations.map((s) => (s.label || '').toLowerCase()))
    let label = l.location
    for (let n = 2; taken.has(label.toLowerCase()); n++) label = `${l.location} (${n})`
    next.storageLocations.push({
      id: `LOC-${String(highest + 1).padStart(4, '0')}`,
      name: l.location,
      label,
      holds: '',
      // Nothing is known about an area the ledger merely mentions except what it held:
      // bulk and packs are only ever kept cold.
      type: next.ledger.some(
        (x) =>
          x.location === l.location &&
          (x.itemType === 'Semi Finished' || x.itemType === 'Finished Goods'),
      )
        ? 'Cold Room'
        : 'Dry Store',
      status: 'Active',
    })
    next.counters.storageLocation = highest + 1
  }
  next.counters.storageLocation = Math.max(
    Number(next.counters.storageLocation) || 0,
    next.storageLocations.length,
  )

  const farmerIds = next.vendors
    .filter((v) => v.vendorTypeId === 'VT-FARMER')
    .map((v) => v.id)
  const vendorIds = next.vendors
    .filter((v) => v.vendorTypeId === 'VT-VENDOR')
    .map((v) => v.id)

  // Clarify production/QC statuses from older "FG Quarantine" naming.
  next.batches = next.batches.map((b) => {
    // Yield used to be measured against everything issued, spoiled produce included,
    // which read every load's rot as a pressing failure. The figure is derived and
    // `spoiled` was always stored, so history is restated rather than left carrying
    // two different meanings of the same column.
    const main = mainOutput(b)
    const y = usableYield(batchInputQty(b), b.spoiled || 0, main?.qty ?? 0)
    return {
      ...b,
      status: b.status === 'FG Quarantine' ? 'Awaiting QC' : b.status,
      yieldPerUnit: y,
      yieldPerCoconut: y,
      wastage: y * (b.spoiled || 0),
    }
  })

  next.purchaseProducts = next.purchaseProducts.map((p) => {
    const raw = p as AppState['purchaseProducts'][number] & {
      sourceKind?: string
      reorder?: number
      vendorIds?: string[]
    }
    let linked = Array.isArray(raw.vendorIds) ? [...raw.vendorIds] : []
    // Guessing only ever applies to a row that predates supplier links — one carrying
    // the old `sourceKind` field. A row minted from a stock item just now has no
    // supplier because nobody has chosen one yet, and silently handing it every farmer
    // on the books meant the first farmer added to a fresh plant turned up as the
    // supplier of produce nobody had said they sold.
    const legacy = storedProducts.has(raw.id) && raw.sourceKind !== undefined
    if (!linked.length && legacy) {
      const kind = (raw.sourceKind || '').toLowerCase()
      // Produce with no recorded source came from the farmers, back when farmers were
      // the only source there was. A bottle never did — defaulting a packing material
      // to every farmer says the caps are grown in Mandya.
      if (raw.category === 'Packing Material') linked = kind ? vendorIds : []
      else if (kind.includes('vendor')) linked = vendorIds
      else if (kind.includes('either')) linked = [...farmerIds, ...vendorIds]
      else linked = farmerIds
    }
    // Keep only ids that still exist.
    linked = linked.filter((id) => next.vendors.some((v) => v.id === id))
    return {
      id: raw.id,
      name: raw.name,
      category: raw.category,
      uom: raw.uom || 'Piece',
      description: raw.description || '',
      status: raw.status || 'Active',
      vendorIds: linked,
      itemId: raw.itemId,
    }
  })

  // Stickers arrived after the first databases were written, so a state saved before
  // them has neither. Templates are reconciled field-by-field on read, so seeding the
  // defaults here is enough — it never has to be repeated when a field is added.
  if (!Array.isArray(next.stickerTemplates) || !next.stickerTemplates.length) {
    next.stickerTemplates = defaultTemplates()
  }
  if (!Array.isArray(next.stickerPrints)) next.stickerPrints = []
  next.counters.sticker = Math.max(
    Number(next.counters.sticker) || 0,
    next.stickerPrints.length,
  )
  /**
   * Where new stock goes by default is set on the Storage page. A plant saved before that
   * existed gets the areas its names point at — the guess the postings used to make on
   * every save, made once, with finished packs kept out of the bulk cold room.
   */
  if (!next.config.defaultAreas) {
    const open = next.storageLocations.filter((s) => s.status === 'Active')
    const pick = (type: StorageType, prefer: RegExp, avoid?: string) => {
      const of = open.filter((s) => s.type === type && s.id !== avoid)
      return (of.find((s) => prefer.test(`${s.label} ${s.name}`)) || of[0])?.id
    }
    const bulk = pick('Cold Room', /bulk/i)
    const produce = pick('Dry Store', /raw|produce|\brm\b/i)
    next.config.defaultAreas = {
      produce,
      packingMaterial: pick('Dry Store', /pack|\bpm\b/i, produce) || produce,
      bulk,
      packs: pick('Cold Room', /finish|\bfg\b|pack|freez|cold/i, bulk) || bulk,
    }
  }
  if (!next.config.stickerWidthMm) next.config.stickerWidthMm = DEFAULT_STICKER_WIDTH_MM
  if (!next.config.stickerHeightMm) next.config.stickerHeightMm = DEFAULT_STICKER_HEIGHT_MM

  // Stock issues arrived after the first databases were written. Nothing to rebuild —
  // an older state simply never issued any, and the counter starts where the list does.
  if (!Array.isArray(next.stockIssues)) next.stockIssues = []
  next.counters.issue = Math.max(Number(next.counters.issue) || 0, next.stockIssues.length)

  // The roster arrived the same way: an older state had no staff, no shifts and no
  // attendance, and its staff counter starts where the (empty) list does.
  if (!Array.isArray(next.staff)) next.staff = []
  if (!Array.isArray(next.shifts)) next.shifts = []
  if (!Array.isArray(next.attendance)) next.attendance = []
  next.counters.staff = Math.max(Number(next.counters.staff) || 0, next.staff.length)

  // Production plans arrived with the Planning screens; an older state made none.
  if (!Array.isArray(next.productionPlans)) next.productionPlans = []
  next.counters.plan = Math.max(Number(next.counters.plan) || 0, next.productionPlans.length)

  /**
   * A QC record used to cover a whole batch, which was wrong the moment a pressing
   * gave two products: one verdict decided the fate of both the water and the malai,
   * though they are different foods tested on different benches. A record covers one
   * output now, and a record written before that covers the batch's main one.
   *
   * Records for the *other* outputs of an older batch are deliberately not invented
   * here. Minting a document code is the posting engine's job and has to happen once,
   * against a counter — the Quality screen offers to raise the missing record instead.
   */
  next.qcs = next.qcs.map((q) => {
    if (q.item) return q
    const b = next.batches.find((x) => x.id === q.batchId)
    return { ...q, item: (b && mainOutput(b)?.item) || '' }
  })
  for (const b of next.batches) {
    b.qcIds = next.qcs.filter((q) => q.batchId === b.id).map((q) => q.id)
    // A batch is the roll-up of its outputs' verdicts now, so restate the ones saved
    // under the old single-verdict rule rather than leave two meanings in one column.
    const records = next.qcs.filter((q) => q.batchId === b.id)
    if (records.length) b.status = batchDisposition(records)
  }

  /**
   * Every item of stock carries its own stock ID. Batches and runs posted before IDs
   * existed are given theirs here, from the document and the line's position — the same
   * answer on every load and every device, so nothing has to be written back for the
   * IDs to hold. After the packing-run rename above, because a run's ID is built on its
   * code.
   */
  for (const b of next.batches) {
    if (!b.outputLines?.length) continue
    b.outputLines = b.outputLines.map((l, i) =>
      l.stockId ? l : { ...l, stockId: stockIdFor(b.id, i + 1) },
    )
  }
  for (const r of next.packingRuns) {
    r.lines = r.lines.map((l, i) => (l.stockId ? l : { ...l, stockId: stockIdFor(r.id, i + 1) }))
  }

  return next
}
