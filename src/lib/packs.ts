import type { BomLine, PackMedium, PackUnit, Product } from '../types'

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
// The plant was asked, once too often, to re-enter the same 5 L BiB inside every
// recipe that filled one. The fix is not a second master record: the pack IS the
// group of SKUs that share its name, type, size and unit. Each SKU below is one
// recipe filled into that pack, the way the model has always read it downstream
// (posting, tracing, planning — they all read the SKU). A pack "edit" is the same
// write onto every member, so there is no def row to sync, no second BOM to keep
// in step, and nothing new for either store engine to carry.

/** What a pack is called wherever it is listed: the name the office gave it, or
 *  — for packs saved before names existed — the format and size read aloud. */
export const packLabel = (p: Product) => p.packName || `${formatSize(p.size, p.unit)} ${p.type}`

/** The key a pack with these physicals groups under — same name/type/size/unit is
 *  the same pack, so saving one that matches another merges into it. */
export const packKeyOfDef = (name: string, type: string, size: number, unit: PackUnit) =>
  `${name}|${type}|${size}|${unit}`

/** Members of one pack share this key; a different key is a different pack. */
const packKeyOf = (p: Product) => packKeyOfDef(packLabel(p), p.type, p.size, p.unit)

/** One pack as the catalog shows it: the physical format, with a member SKU per
 *  recipe filled into it. */
export interface PackDef {
  /** The shared key — pass back to `savePack` to say which pack is being edited. */
  key: string
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

/** Every pack, one entry per shared name/type/size/unit, ordered by name. */
export function packDefs(products: Product[]): PackDef[] {
  const byKey = new Map<string, Product[]>()
  for (const p of products) {
    const key = packKeyOf(p)
    const list = byKey.get(key)
    if (list) list.push(p)
    else byKey.set(key, [p])
  }
  return [...byKey.entries()]
    .map(([key, members]) => {
      const first = members[0]
      return {
        key,
        name: packLabel(first),
        type: first.type,
        size: first.size,
        unit: first.unit,
        bom: first.bom.map((b) => ({ ...b })),
        retired: members.every((m) => m.retired),
        members: [...members].sort((a, b) => a.name.localeCompare(b.name)),
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** The pack a product belongs to, as `packDefs` would build it. */
export const packDefOf = (products: Product[], product: Product): PackDef | undefined =>
  packDefs(products).find((d) => d.members.some((m) => m.id === product.id))
