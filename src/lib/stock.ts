import { QTY_EPSILON } from './utils'
import type { AppState, AreaPurpose, StockRow, StorageLocation, StorageType } from '../types'

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
export const STORAGE_TYPES: { value: StorageType; label: string; plural: string; blurb: string }[] = [
  {
    value: 'Cold Room',
    label: 'Cold room',
    plural: 'Cold rooms',
    blurb:
      'Temperature-controlled — a cold room, chest freezer or blast freezer. Bulk from production has to be kept in one; finished packs go into one off the line and are dispatched from it; produce can be kept cold too.',
  },
  {
    value: 'Dry Store',
    label: 'Dry store',
    plural: 'Dry stores',
    blurb:
      'Ambient storage for what was bought in — produce waiting to be pressed, and packing material. Bulk can never go into one.',
  },
  {
    value: 'Hold Area',
    label: 'Hold area',
    plural: 'Hold areas',
    blurb:
      'Where stock QC has rejected is set aside until somebody decides what happens to it. It only takes rejected stock, so nothing in it can be packed, blended or dispatched — write it off from Stock Issues.',
  },
]

export const storageTypeLabel = (type: StorageType) =>
  STORAGE_TYPES.find((t) => t.value === type)?.label || type

/** "1 cold room", "2 cold rooms". */
export const storageTypeCount = (type: StorageType, n: number) => {
  const t = STORAGE_TYPES.find((x) => x.value === type)
  return `${n} ${((n === 1 ? t?.label : t?.plural) || type).toLowerCase()}`
}

/**
 * Which sort of area each sort of stock usually lives in.
 *
 * Beyond the two rules in `areaRefusal` this is guidance, not a rule — a plant may
 * genuinely keep something somewhere unusual, and refusing would strand stock. It decides
 * what is offered first and what gets flagged, so a pallet of bottles cannot slide into a
 * cold room unremarked.
 */
export const HOME_TYPES: Record<string, StorageType[]> = {
  'Finished Goods': ['Cold Room'],
  'Semi Finished': ['Cold Room'],
  'Raw Material': ['Dry Store', 'Cold Room'],
  'Packing Material': ['Dry Store'],
}

/** Whether an area of this type is a usual home for this stock. A hold area is the home of rejected stock of any kind. */
export const roomSuits = (itemType: string, type: StorageType, status?: string) =>
  type === 'Hold Area' ? status === 'Rejected' : (HOME_TYPES[itemType] || []).includes(type)

/**
 * Bulk is the one thing that may never sit in a dry store.
 *
 * What comes out of production is unsealed, unpasteurised and perishable — juice in
 * an open tank, malai in a tub. It goes into a cold room or it spoils, so this is a
 * rule the posting engine enforces rather than a hint the screen offers.
 */
export const needsColdRoom = (itemType: string) => itemType === 'Semi Finished'

/**
 * Why stock of this sort, in this QC status, may not go into an area — or null when it may.
 *
 * Two rules, enforced wherever stock is put away or moved:
 *  - bulk never goes into a dry store: it is unsealed and perishable;
 *  - a hold area only takes stock QC has rejected. Nothing else may be parked there, so
 *    nothing sitting in one can be packed, blended or dispatched.
 * Everything else is allowed, and the screens flag what is unusual.
 */
export function areaRefusal(
  area: StorageLocation | undefined,
  itemType: string,
  status = 'Available',
): string | null {
  if (!area || area.status !== 'Active') return 'Pick an active storage area.'
  if (area.type === 'Hold Area' && status !== 'Rejected') {
    return `${area.label} is a hold area — it only takes stock QC has rejected.`
  }
  if (needsColdRoom(itemType) && area.type === 'Dry Store') {
    return `${area.label} is a dry store. Bulk is unsealed and perishable — it has to go into a cold room.`
  }
  return null
}

/** Whether stock sitting in this area has been set aside in a hold area. */
export const inHoldArea = (state: AppState, location: string) =>
  state.storageLocations.find((s) => s.name === location)?.type === 'Hold Area'

/** Storage areas this stock may be put into, usual homes first. */
export function allowedAreas(state: AppState, itemType: string, status = 'Available') {
  return state.storageLocations
    .filter((s) => !areaRefusal(s, itemType, status))
    .sort(
      (a, b) =>
        Number(roomSuits(itemType, b.type, status)) - Number(roomSuits(itemType, a.type, status)),
    )
}

/** Areas the stock in one row can be moved to: every area it may go into but its own. */
export function moveDestinations(state: AppState, from: string, itemType: string, status = 'Available') {
  return allowedAreas(state, itemType, status).filter((s) => s.name !== from)
}

/**
 * The options a storage-area dropdown lists for stock of this sort.
 *
 * Every picker in the app builds its options here so they all read the same way: the
 * area's name and type, what it is for, and a flag when it is not a usual home. A record
 * being edited keeps its own area on the list even after that area was deactivated,
 * marked as such — the dropdown used to show a different area from the one saved.
 */
export function areaChoices(state: AppState, itemType: string, status = 'Available', current?: string) {
  const areas = allowedAreas(state, itemType, status)
  const own = current ? state.storageLocations.find((s) => s.name === current) : undefined
  if (own && !areas.includes(own)) areas.unshift(own)
  const kind = itemTypeLabel(itemType).toLowerCase()
  return areas.map((area) => {
    const flag =
      area.status !== 'Active'
        ? 'inactive'
        : areaRefusal(area, itemType, status)
          ? `no longer takes ${kind}`
          : roomSuits(itemType, area.type, status)
            ? ''
            : `not usually for ${kind}`
    return {
      area,
      value: area.name,
      text: [`${area.label} · ${storageTypeLabel(area.type)}`, area.holds, flag]
        .filter(Boolean)
        .join(' — '),
    }
  })
}

/** The kinds of new stock put away somewhere by default, as the Storage page names them. */
export const AREA_PURPOSES: { key: AreaPurpose; label: string; itemType: string }[] = [
  { key: 'produce', label: 'Produce received', itemType: 'Raw Material' },
  { key: 'packingMaterial', label: 'Packing material received', itemType: 'Packing Material' },
  { key: 'bulk', label: 'Bulk from production', itemType: 'Semi Finished' },
  { key: 'packs', label: 'Finished packs off the line', itemType: 'Finished Goods' },
]

/**
 * Where new stock of one kind goes unless somebody picks another area: the default set on
 * the Storage page, for as long as that area is active and may hold the stock. Nothing is
 * guessed behind it — a default that is not set is not there, and the form asks.
 */
export function defaultArea(state: AppState, purpose: AreaPurpose): StorageLocation | undefined {
  const itemType = AREA_PURPOSES.find((p) => p.key === purpose)?.itemType || ''
  const area = state.storageLocations.find((s) => s.id === state.config?.defaultAreas?.[purpose])
  return area && !areaRefusal(area, itemType) ? area : undefined
}

/** The kinds of new stock an area is the default for. */
export const defaultsOf = (state: AppState, area: StorageLocation) =>
  AREA_PURPOSES.filter((p) => state.config?.defaultAreas?.[p.key] === area.id)

/** Why an area cannot be deleted, or null when nothing depends on it. */
export function areaDeleteBlocker(state: AppState, area: StorageLocation): string | null {
  if (state.ledger.some((l) => l.location === area.name)) {
    return `${area.label} has held stock — deactivate it instead.`
  }
  const doc =
    state.batches.find((b) => b.location === area.name)?.id ||
    state.packingRuns.find((r) => r.location === area.name)?.id ||
    state.grns.find((g) => g.location === area.name)?.id
  if (doc) return `${doc} names ${area.label} — deactivate it instead.`
  const purposes = defaultsOf(state, area)
  if (purposes.length) {
    return `${area.label} is the default for ${purposes.map((p) => p.label.toLowerCase()).join(' and ')} — choose another default first.`
  }
  return null
}
