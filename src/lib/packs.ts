import type { BomLine, Pack, PackMedium, PackUnit, Product } from '../types'

/**
 * A pack's size is entered in whatever unit the format is sold in — a bottle in ml,
 * a BiB in litres, a malai cover in kg — while every stock, cost and ledger figure
 * in the app is in base units (litres for water, kg for malai). All of that
 * conversion lives here so no page has to remember that 250 ml is 0.25 L.
 */

export const PACK_UNITS: { value: PackUnit; label: string; medium: PackMedium }[] = [
  { value: 'L', label: 'Litre (L)', medium: 'Water' },
  { value: 'ml', label: 'Millilitre (ml)', medium: 'Water' },
  { value: 'kg', label: 'Kilogram (kg)', medium: 'Malai' },
  { value: 'g', label: 'Gram (g)', medium: 'Malai' },
]

/** How many base units one unit is worth. */
const FACTOR: Record<PackUnit, number> = { L: 1, ml: 0.001, kg: 1, g: 0.001 }

/** Which bulk output a pack sized in this unit is filled from. */
export const mediumForUnit = (unit: PackUnit): PackMedium =>
  unit === 'kg' || unit === 'g' ? 'Malai' : 'Water'

/** A pack size in its own unit, converted to litres or kg. */
export const toBase = (size: number, unit: PackUnit) => (Number(size) || 0) * FACTOR[unit]

/** The stock unit a pack sized in this unit draws — what its bulk item must be held in. */
export const bulkUomForUnit = (unit: PackUnit) => (unit === 'kg' || unit === 'g' ? 'Kg' : 'Litre')

/** Which medium a bulk held in this unit belongs to, for the legacy water/malai split. */
export const mediumForUom = (uom: string): PackMedium => (uom === 'Kg' ? 'Malai' : 'Water')

/** Trims the trailing zeros a fixed-decimal conversion leaves behind. */
const trim = (n: number, places = 3) => Number(n.toFixed(places)).toString()

/** "5 L", "250 ml", "3 kg" — how one pack is described wherever a size is shown. */
export const formatSize = (size: number, unit: PackUnit) => `${trim(size)} ${unit}`

/** The medium a product belongs to, derived from its unit and kept in step with it. */
export const mediumOf = (p: Product): PackMedium => p.medium || mediumForUnit(p.unit)

/**
 * The bulk a pack is filled from. Packs saved before the plant made more than
 * coconut water and malai carry no bulk item, so their medium still answers for them.
 */
export const bulkItemOf = (p: Product) =>
  p.bulkItem || (mediumOf(p) === 'Malai' ? 'SF-TCW-MALAI' : 'SF-TCW-WATER')

/**
 * The drink behind a bulk item's name — "Coconut Water (bulk)" reads as Coconut
 * Water. The one definition of the drink label, so every page that groups pack
 * formats under their drink (orders, planning) names them the same way.
 */
export const drinkName = (name: string) => name.replace(/ \(bulk\)$/i, '')

// ── the pack catalog ─────────────────────────────────────────────────────────
//
// On D1 a pack is a first-class master and each finished SKU points at it. Zoho
// cannot afford another swept table, so legacy snapshots derive the same master
// deterministically from their product projections until cutover.

/** What a pack is called wherever it is listed: the name the office gave it, or
 *  — for packs saved before names existed — the format and size read aloud. */
export const packLabel = (p: Pick<Product, 'packName' | 'size' | 'unit' | 'type'>) =>
  p.packName || `${formatSize(p.size, p.unit)} ${p.type}`

/** The key a pack with these physicals groups under — same name/type/size/unit is
 *  the same pack, so saving one that matches another merges into it. */
export const packKeyOfDef = (name: string, type: string, size: number, unit: PackUnit) =>
  `${name}|${type}|${size}|${unit}`

/** Members of one pack share this key; a different key is a different pack. */
const packKeyOf = (p: Product) => packKeyOfDef(packLabel(p), p.type, p.size, p.unit)

/** Stable id for a format which predates the D1 packs collection. The text is
 * deliberately readable: it is only a local/document key, never a display name. */
export const legacyPackIdOf = (p: Product) => `PACK:${packKeyOf(p)}`

/** The pack masters represented by legacy product rows. */
export function derivePacks(products: Product[]): Pack[] {
  const byId = new Map<string, Pack>()
  for (const p of products) {
    const id = p.packId || legacyPackIdOf(p)
    if (byId.has(id)) continue
    byId.set(id, {
      id,
      name: packLabel(p),
      type: p.type,
      size: p.size,
      unit: p.unit,
      packVolume: p.packVolume,
      bom: p.bom.map((b) => ({ ...b })),
      retired: p.retired,
    })
  }
  return [...byId.values()]
}

/** Normalise a snapshot around first-class masters. Missing masters are legacy
 * rows from Zoho/the initial D1 import and are derived exactly once by stable id.
 * A stored master is the truth for its members' physicals and materials: packing
 * reads `bom` off the product, so a member whose projection drifted from its
 * master (a legacy row grouped under a master derived from another SKU) would
 * consume the wrong packaging. Each such member is re-projected here. */
export function materializePacks(products: Product[], stored: Pack[]): { products: Product[]; packs: Pack[] } {
  const masters = new Map(stored.map((p) => [p.id, { ...p, bom: p.bom.map((b) => ({ ...b })) }]))
  const storedIds = new Set(stored.map((p) => p.id))
  const nextProducts = products.map((p) => {
    const packId = p.packId || legacyPackIdOf(p)
    const master = storedIds.has(packId) ? masters.get(packId) : undefined
    if (master) return projectPack(p, master)
    if (!masters.has(packId)) {
      masters.set(packId, {
        id: packId,
        name: packLabel(p),
        type: p.type,
        size: p.size,
        unit: p.unit,
        packVolume: p.packVolume,
        bom: p.bom.map((b) => ({ ...b })),
        retired: p.retired,
      })
    }
    return p.packId === packId ? p : { ...p, packId }
  })
  return { products: nextProducts, packs: [...masters.values()] }
}

const sameBom = (a: BomLine[], b: BomLine[]) =>
  a.length === b.length && a.every((l, i) => l.item === b[i].item && l.qty === b[i].qty)

/** A member carrying its master's physicals and materials — the same object when
 *  it already does, so a converged catalog costs no churn. */
function projectPack(p: Product, master: Pack): Product {
  if (
    p.packId === master.id &&
    p.packName === master.name &&
    p.type === master.type &&
    p.size === master.size &&
    p.unit === master.unit &&
    p.packVolume === master.packVolume &&
    sameBom(p.bom, master.bom)
  )
    return p
  return {
    ...p,
    packId: master.id,
    packName: master.name,
    type: master.type,
    size: master.size,
    unit: master.unit,
    packVolume: master.packVolume,
    bom: master.bom.map((b) => ({ ...b })),
  }
}

/** One pack as the catalog shows it: the physical format, with a member SKU per
 *  recipe filled into it. */
export interface PackDef {
  /** The stored pack id — pass back to `savePack` to say which pack is being edited. */
  key: string
  /** The physical identity used only to detect an intentional merge on create. */
  physicalKey: string
  name: string
  type: string
  size: number
  unit: PackUnit
  /** What one pack is made of. Members are written together, so they agree; the
   *  first member answers while an offline edit is still converging. */
  bom: BomLine[]
  retired: boolean
  /** One SKU per recipe assigned to this pack, named by the SKU. */
  members: Product[]
}

/** Every pack, one entry per stored physical format, ordered by name. The optional
 * masters argument keeps direct callers/tests over old product-only data working. */
export function packDefs(products: Product[], stored?: Pack[]): PackDef[] {
  const legacyView = stored === undefined
  const { products: members, packs } = materializePacks(products, stored ?? [])
  return packs
    .map((p) => {
      const physicalKey = packKeyOfDef(p.name, p.type, p.size, p.unit)
      const packMembers = members.filter((m) => m.packId === p.id).sort((a, b) => a.name.localeCompare(b.name))
      return {
        // Product-only callers retain the old derived-view key during the
        // transition; actual app state always supplies its pack masters.
        key: legacyView ? physicalKey : p.id,
        physicalKey,
        name: p.name,
        type: p.type,
        size: p.size,
        unit: p.unit,
        bom: p.bom.map((b) => ({ ...b })),
        retired: legacyView ? packMembers.every((m) => m.retired) : !!p.retired,
        members: packMembers,
      }
    })
    .filter((p) => p.members.length)
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** The pack a product belongs to, as `packDefs` would build it. */
export const packDefOf = (products: Product[], product: Product, packs: Pack[] = []): PackDef | undefined =>
  packDefs(products, packs).find((d) => d.members.some((m) => m.id === product.id))
