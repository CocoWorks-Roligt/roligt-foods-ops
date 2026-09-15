import { QTY_EPSILON } from './utils'
import type { AppState, StockRow, StorageType } from '../types'

/**
 * Everything that makes one stock row a different row from another.
 *
 * This is what `stockRows` groups by, so it is also the right React key for any list
 * of stock. Three screens hand-rolled their own version of it and every one of them
 * left the expiry out, which gives two runs off one batch the same key.
 *
 * Not the same as `rowKey`: that one deliberately omits the status, because a screen
 * that offers stock to pick from has already filtered to the status it will accept.
 */
export const stockRowKey = (r: {
  item: string
  lot: string
  location: string
  status: string
  expiry?: string
}) => [r.item, r.lot, r.location, r.status, r.expiry || ''].map(encodeURIComponent).join('|')

export function stockRows(state: AppState): StockRow[] {
  const g: Record<string, StockRow> = {}
  for (const l of state.ledger) {
    // Expiry is part of the key: packs off one batch filled on two different days
    // carry two different dates, and pooling them would leave the later ones wearing
    // the earlier date on the challan that ships them.
    const k = stockRowKey({ ...l, expiry: l.expiry })
    if (!g[k]) {
      g[k] = {
        item: l.item,
        itemType: l.itemType,
        lot: l.lot,
        location: l.location,
        status: l.status,
        uom: l.uom,
        qty: 0,
        value: 0,
        unitCost: l.unitCost,
        expiry: l.expiry,
      }
    }
    g[k].qty += Number(l.qtyIn) - Number(l.qtyOut)
    g[k].value +=
      Number(l.qtyIn) * Number(l.unitCost) - Number(l.qtyOut) * Number(l.unitCost)
  }
  return Object.values(g)
    .filter((x) => Math.abs(x.qty) > QTY_EPSILON)
    .map((x) => ({ ...x, unitCost: x.qty ? x.value / x.qty : x.unitCost }))
}

/**
 * Stock as it stood before `doc` was posted. Editing a document re-posts its ledger
 * lines, so the form behind an edit has to offer what the document itself drew on —
 * otherwise the very stock a dispatch took out would not be selectable.
 */
export function stockRowsExcluding(state: AppState, doc: string): StockRow[] {
  return stockRows({ ...state, ledger: state.ledger.filter((l) => l.doc !== doc) })
}

/** What makes one stock row a different row from another. */
export interface RowIdentity {
  item: string
  lot: string
  location: string
  expiry?: string
}

/**
 * A stock row's identity as one string, for a `<select>` value, a React key or a map
 * of what an operator has picked.
 *
 * The expiry belongs in here. `stockRows` already keys on it — the same pack off the
 * same batch, filled three weeks apart, sits in one lot and one freezer under two
 * dates and is not interchangeable stock. Dispatch and orders both keyed their
 * dropdowns and their pick maps on item·lot·location alone, so the two rows collapsed
 * into one entry: only the first was ever selectable, an order pre-filled from both
 * and stored one, and the ledger line came out stamped with the wrong date. One
 * helper now, so the places that name a row cannot drift apart from the place that
 * defines one.
 *
 * Segments are URI-encoded because a location label is free text an admin types, and
 * a `|` in one would otherwise split a key in the wrong place.
 */
export const rowKey = (r: RowIdentity): string =>
  [r.item, r.lot, r.location, r.expiry || ''].map(encodeURIComponent).join('|')

/** `rowKey` read back. Missing segments come back empty rather than undefined. */
export function parseRowKey(key: string): RowIdentity {
  const [item = '', lot = '', location = '', expiry = ''] = (key || '')
    .split('|')
    .map((part) => {
      try {
        return decodeURIComponent(part)
      } catch {
        return part
      }
    })
  return { item, lot, location, expiry: expiry || undefined }
}

/** Whether a stock row is the row this identity names — expiry included. */
export const isRow = (r: RowIdentity, id: RowIdentity) =>
  r.item === id.item &&
  r.lot === id.lot &&
  r.location === id.location &&
  (r.expiry || '') === (id.expiry || '')

/**
 * One row per item and lot, pooling every place and status the same lot sits in.
 * A lot split across two shelves — or half-released by QC — is still one lot to the
 * operator picking it, and offering it twice would put two identical entries in a
 * dropdown that keys its options by value.
 */
export function poolByLot(rows: StockRow[]) {
  const byKey = new Map<
    string,
    { item: string; lot: string; itemType: string; qty: number; value: number; uom: string; statuses: string[] }
  >()
  for (const r of rows) {
    const key = `${r.item}|${r.lot}`
    const existing = byKey.get(key)
    if (existing) {
      existing.qty += r.qty
      existing.value += r.qty * r.unitCost
      if (!existing.statuses.includes(r.status)) existing.statuses.push(r.status)
    } else {
      byKey.set(key, {
        item: r.item,
        lot: r.lot,
        itemType: r.itemType,
        qty: r.qty,
        value: r.qty * r.unitCost,
        uom: r.uom,
        statuses: [r.status],
      })
    }
  }
  return [...byKey.values()]
    .filter((x) => x.qty > QTY_EPSILON)
    .map((x) => ({ ...x, unitCost: x.qty ? x.value / x.qty : 0 }))
    .sort((a, b) => `${a.item}${a.lot}`.localeCompare(`${b.item}${b.lot}`))
}

export function available(
  state: AppState,
  item: string,
  lot?: string,
  status = 'Available',
) {
  return stockRows(state)
    .filter((r) => r.item === item && (!lot || r.lot === lot) && r.status === status)
    .reduce((a, b) => a + b.qty, 0)
}

/**
 * The date a lot of one pack is good until, for stock and documents that carry no date
 * of their own. Where a batch was packed more than once this can only answer with the
 * earliest of them — the stock line's own `expiry` is what says which packs are which,
 * and this is the fallback for records written before it did.
 *
 * Shelf life is set when goods are packed, so it lives on the packing run. Batches
 * posted before packing was split out still carry it on their own outputs.
 */
export function expiryFor(state: AppState, lot: string, sku: string) {
  let earliest = ''
  for (const run of state.packingRuns || []) {
    if (run.batchId !== lot) continue
    const line = run.lines.find((l) => l.sku === sku)
    if (line?.expiry && (!earliest || line.expiry < earliest)) earliest = line.expiry
  }
  if (earliest) return earliest
  return state.batches.find((b) => b.id === lot)?.outputs.find((o) => o.sku === sku)?.expiry
}

/**
 * The date to *print* for a stock row: the one the row itself carries, falling back
 * to the lot-wide lookup for rows written before lines carried their own.
 *
 * Never build a row's identity out of this. `expiryFor` answers with the earliest
 * date across a lot, so keying on it would merge two rows that are not the same
 * stock — `rowKey` reads what the ledger actually recorded.
 */
export const displayExpiry = (
  state: AppState,
  r: { item: string; lot: string; expiry?: string },
) => r.expiry || expiryFor(state, r.lot, r.item)

/** Readable name for a location the ledger refers to by its internal key. */
export function locationLabel(state: AppState, name: string) {
  return state.storageLocations?.find((s) => s.name === name)?.label || name
}

/**
 * The word an operator reads for a stored item type. The ledger has said
 * 'Semi Finished' since the first migration and cannot be rewritten without touching
 * every row, but nobody on the floor says that — they say bulk, and so does every
 * other screen. One concept, one word.
 */
/**
 * Quantities held apart by the unit they are counted in. Coconuts are pieces and
 * beetroot is kilograms, so one plant total of "95 units" is a number with no
 * physical meaning — it is what you get by adding 80 pieces to 15 kilograms.
 * Everything that totals stock across items goes through here.
 */
export function sumByUom(rows: { qty: number; uom: string }[]): Map<string, number> {
  const by = new Map<string, number>()
  for (const r of rows) {
    if (!(r.qty > 0)) continue
    by.set(r.uom, (by.get(r.uom) || 0) + r.qty)
  }
  return by
}

/** "80 Piece · 15 Kg" — every unit named, in descending size. Never a bare sum. */
export function fmtByUom(by: Map<string, number>, empty = '0'): string {
  const parts = [...by.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([uom, qty]) => `${Number(qty.toFixed(2))} ${uom}`)
  return parts.length ? parts.join(' · ') : empty
}

/** The same total, ready to print: `fmtByUom` over the rows that match. */
export const fmtRowTotal = (rows: { qty: number; uom: string }[], empty = '0') =>
  fmtByUom(sumByUom(rows), empty)

const TYPE_LABELS: Record<string, string> = { 'Semi Finished': 'Bulk' }

export const itemTypeLabel = (type: string) => TYPE_LABELS[type] || type

export function itemName(state: AppState, id: string) {
  return state.items.find((i) => i.id === id)?.name || id
}

export function product(state: AppState, id: string) {
  return state.products.find((p) => p.id === id)
}

/**
 * The three sorts of storage area, and what each one is for.
 *
 * One list, one entity. The plant used to keep freezers, defrost areas, stores and
 * holds as four separate things with four separate sections on the screen, which made
 * a cold room and a chest freezer different kinds of object and left nobody sure
 * whether bulk belonged in a "store" or a "hold".
 */
export const STORAGE_TYPES: { value: StorageType; label: string; blurb: string }[] = [
  {
    value: 'Cold Room',
    label: 'Cold room',
    blurb:
      'Temperature-controlled — cold room, chest freezer, blast freezer. Bulk from production is kept here, and packs are filled into it and dispatched straight out of it.',
  },
  {
    value: 'Dry Store',
    label: 'Dry store',
    blurb: 'Ambient storage for what was bought in — produce waiting to be pressed, and packing material.',
  },
  {
    value: 'Hold Area',
    label: 'Hold area',
    blurb: 'Anything set aside — stock QC rejected, goods held until somebody decides what happens to them.',
  },
]

export const storageTypeLabel = (type: StorageType) =>
  STORAGE_TYPES.find((t) => t.value === type)?.label || type

/**
 * Which sort of area each sort of stock belongs in.
 *
 * For everything except bulk this is guidance, not a rule — a plant may genuinely use
 * an area for something unusual and refusing would strand stock. It decides what gets
 * offered first and what gets flagged, so a pallet of juice cannot slide into the
 * packing store unremarked.
 */
export const HOME_TYPES: Record<string, StorageType[]> = {
  'Finished Goods': ['Cold Room'],
  'Semi Finished': ['Cold Room'],
  'Raw Material': ['Dry Store', 'Cold Room'],
  'Packing Material': ['Dry Store'],
}

/** Whether an area of this type is a usual home for this sort of stock. */
export const roomSuits = (itemType: string, type: StorageType) =>
  (HOME_TYPES[itemType] || []).includes(type)

/**
 * Bulk is the one thing the app refuses to put anywhere else.
 *
 * What comes out of production is unsealed, unpasteurised and perishable — juice in
 * an open tank, malai in a tub. It goes into a cold room or it spoils, so this is a
 * rule the posting engine enforces rather than a hint the screen offers.
 */
export const needsColdRoom = (itemType: string) => itemType === 'Semi Finished'

/** Storage areas this stock may legally be put in — every active one, unless it is bulk. */
export function allowedAreas(state: AppState, itemType: string) {
  return state.storageLocations.filter(
    (s) => s.status === 'Active' && (!needsColdRoom(itemType) || s.type === 'Cold Room'),
  )
}

/** Active areas other than the one the stock is in, usual homes first. */
export function moveDestinations(state: AppState, from: string, itemType: string) {
  return allowedAreas(state, itemType)
    .filter((s) => s.name !== from)
    .sort((a, b) => Number(roomSuits(itemType, b.type)) - Number(roomSuits(itemType, a.type)))
}
