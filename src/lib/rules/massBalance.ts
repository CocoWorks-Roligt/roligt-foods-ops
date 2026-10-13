/**
 * The mass-balance rules — base units only, raw mixed units never compared
 * (§3.2, contracts §6). Count-measured materials (coconuts) convert through a
 * configured average unit weight, litre-measured ones through density; kg is
 * the base unit everything lands in before anything is summed or compared.
 *
 * An unknown conversion is an ERROR, not a guess: a line whose unit has no
 * configured path to kg throws MassBalanceError, and the caller (the client's
 * live indicator, the server's close gate) turns that into a refusal. Summing
 * mixed units raw is the failure mode this module exists to prevent.
 */
import type { BaseUnitConversion, MassBalanceResult } from '../contracts.ts'
import { QTY_EPSILON } from '../utils.ts'

/** One quantity that entered, left or was lost — the item names its conversion. */
export interface MassBalanceLine {
  /** Item id; '' when the line has none (a spoilage record carries only a uom). */
  item: string
  qty: number
  uom: string
}

/** The conversion-relevant fields off a material master (ItemExtension subset). */
export interface MassBalanceItem {
  /** The item's base unit — the fallback for a line that carries none. */
  uom?: string
  /** kg per counting unit (contracts ItemExtension.avgUnitWeight — kilograms). */
  avgUnitWeight?: number
  /** kg per litre. */
  densityKgPerL?: number
}

export type MassBalanceItems = Record<string, MassBalanceItem | undefined>

/** The plant-wide conversions and the tolerance, from meta.app_config. */
export interface MassBalanceConfig {
  /** Default grams per counting unit (app_config avgNutWeightG, DECISIONS #2). */
  avgUnitWeightG: number
  /** Default kg per litre (app_config defaultDensityKgPerL). */
  defaultDensityKgPerL: number
  /** Allowed |variance| percent (app_config massBalanceTolerancePct). */
  massBalanceTolerancePct: number
}

/** DECISIONS #2 defaults: 2% tolerance, ~500 g per nut, water-like density. */
export const DEFAULT_MASS_BALANCE_CONFIG: MassBalanceConfig = {
  avgUnitWeightG: 500,
  defaultDensityKgPerL: 1.0,
  massBalanceTolerancePct: 2,
}

/** The config off a stored app_config object — unknown/invalid keys default. */
export function massBalanceConfigOf(appConfig: Record<string, unknown> | null | undefined): MassBalanceConfig {
  const num = (v: unknown, fallback: number) => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : fallback
  }
  const tolerance = Number(appConfig?.massBalanceTolerancePct)
  return {
    avgUnitWeightG: num(appConfig?.avgNutWeightG, DEFAULT_MASS_BALANCE_CONFIG.avgUnitWeightG),
    defaultDensityKgPerL: num(appConfig?.defaultDensityKgPerL, DEFAULT_MASS_BALANCE_CONFIG.defaultDensityKgPerL),
    massBalanceTolerancePct:
      Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : DEFAULT_MASS_BALANCE_CONFIG.massBalanceTolerancePct,
  }
}

/** A line whose unit has no configured path to kg — never summed, never guessed. */
export class MassBalanceError extends Error {
  readonly item: string
  readonly uom: string
  readonly need: 'avgUnitWeight' | 'densityKgPerL' | 'known_unit'
  constructor(item: string, uom: string, need: MassBalanceError['need']) {
    super(
      need === 'known_unit'
        ? `${uom || 'a unitless quantity'} has no conversion to kg — set the unit on the item first.`
        : need === 'avgUnitWeight'
          ? `No average unit weight is configured for ${item || 'this material'} — ${uom} cannot be converted to kg.`
          : `No density is configured for ${item || 'this material'} — ${uom} cannot be converted to kg.`,
    )
    this.item = item
    this.uom = uom
    this.need = need
  }
}

/** The unit families, lower-cased and trimmed — the plant's spellings plus the
 *  honest near-misses ('L', 'ltr', 'grams'); anything else is unknown. */
const KG = new Set(['kg', 'kgs', 'kilogram', 'kilograms'])
const GRAMS = new Set(['g', 'gm', 'gram', 'grams'])
const LITRE = new Set(['l', 'ltr', 'litre', 'litres', 'liter', 'liters'])
const MILLILITRE = new Set(['ml', 'millilitre', 'millilitres', 'milliliter', 'milliliters'])
const COUNT = new Set(['piece', 'pieces', 'pcs', 'count', 'nos'])

const positive = (n: number | undefined): number | undefined =>
  n !== undefined && Number.isFinite(n) && n > 0 ? n : undefined

/** kg per litre for this line — the material's own density, else the plant's. */
function densityOf(line: MassBalanceLine, items: MassBalanceItems, config: MassBalanceConfig): number {
  const density = positive(items[line.item]?.densityKgPerL) ?? positive(config.defaultDensityKgPerL)
  if (density === undefined) throw new MassBalanceError(line.item, line.uom, 'densityKgPerL')
  return density
}

/** kg per counting unit for this line — the material's own average, else the
 *  plant's. item.avgUnitWeight is kg per unit; the config's is grams per unit. */
function unitWeightOf(line: MassBalanceLine, items: MassBalanceItems, config: MassBalanceConfig): number {
  const perUnit = positive(items[line.item]?.avgUnitWeight) ?? positive(config.avgUnitWeightG / 1000)
  if (perUnit === undefined) throw new MassBalanceError(line.item, line.uom, 'avgUnitWeight')
  return perUnit
}

/** The conversion a line converts through, judged per material with the
 *  plant-wide config as the fallback (DECISIONS #2). Kilograms and grams are
 *  already weight — they carry the identity conversion. */
export function conversionOf(
  line: MassBalanceLine,
  items: MassBalanceItems,
  config: MassBalanceConfig,
): BaseUnitConversion {
  const uom = (line.uom ?? '').trim().toLowerCase()
  if (KG.has(uom) || GRAMS.has(uom)) return { kind: 'count_weight', avgUnitWeight: 1 }
  if (LITRE.has(uom) || MILLILITRE.has(uom)) {
    return { kind: 'density', densityKgPerL: densityOf(line, items, config) }
  }
  if (COUNT.has(uom)) return { kind: 'count_weight', avgUnitWeight: unitWeightOf(line, items, config) }
  throw new MassBalanceError(line.item, line.uom, 'known_unit')
}

/** One line in kg — the only unit anything is ever summed in. */
export function toBaseKg(line: MassBalanceLine, items: MassBalanceItems, config: MassBalanceConfig): number {
  const qty = Number(line.qty) || 0
  const uom = (line.uom ?? '').trim().toLowerCase()
  if (KG.has(uom)) return qty
  if (GRAMS.has(uom)) return qty / 1000
  if (LITRE.has(uom) || MILLILITRE.has(uom)) {
    return (MILLILITRE.has(uom) ? qty / 1000 : qty) * densityOf(line, items, config)
  }
  if (COUNT.has(uom)) return qty * unitWeightOf(line, items, config)
  throw new MassBalanceError(line.item, line.uom, 'known_unit')
}

/**
 * The verdict a close computes and stores (contracts MassBalanceResult):
 * inputs, outputs and spoilage each converted to kg, then compared.
 * `variancePct` is (inputs − outputs − spoilage) as a percent of inputs; a
 * batch with no inputs answers 0 (nothing to balance — upstream rules already
 * refuse an empty batch). Within tolerance is |variance| ≤ the configured
 * percent, with float slack so "exactly at" passes.
 */
export function computeMassBalance(
  inputs: readonly MassBalanceLine[],
  outputs: readonly MassBalanceLine[],
  spoilage: readonly MassBalanceLine[],
  items: MassBalanceItems,
  config: MassBalanceConfig,
): MassBalanceResult {
  const sumKg = (lines: readonly MassBalanceLine[]) =>
    lines.reduce((total, line) => total + toBaseKg(line, items, config), 0)
  const inputBaseUnits = sumKg(inputs)
  const outputBaseUnits = sumKg(outputs)
  const spoilageKg = sumKg(spoilage)
  const variancePct = inputBaseUnits > QTY_EPSILON
    ? ((inputBaseUnits - outputBaseUnits - spoilageKg) / inputBaseUnits) * 100
    : 0
  return {
    inputBaseUnits,
    outputBaseUnits,
    variancePct,
    withinTolerance: Math.abs(variancePct) <= config.massBalanceTolerancePct + 1e-9,
  }
}
