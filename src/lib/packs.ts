import type { PackMedium, PackUnit, Product } from '../types'

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
