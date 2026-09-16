/**
 * The CocoWorks sensory evaluation, scored the way the plant's spreadsheet scores it.
 *
 * Twenty-four attributes across appearance, aroma, flavour, sweetness, mouthfeel and
 * aftertaste, each carrying a weight and scored 1–5. The weighted score is out of 100,
 * and the decision reads it together with the critical attributes: one critical
 * attribute scored below 3 holds the product whatever the total says.
 */

import type { SensoryProductGroup, SensoryScore, TestParameter } from '../types'

/** The built-in sensory report type's key. */
export const SENSORY_KEY = 'sensory'

export const DEFAULT_PASS_SCORE = 80
export const DEFAULT_MINOR_SCORE = 70

/** A critical attribute scored below this holds the product. */
export const CRITICAL_BELOW = 3

export const SCORING_GUIDE = [
  { score: 5, meaning: 'Excellent', reading: 'Characteristic, well balanced, no defect' },
  { score: 4, meaning: 'Good', reading: 'Acceptable; minor deviation' },
  { score: 3, meaning: 'Average', reading: 'Noticeable deviation; R&D review recommended' },
  { score: 2, meaning: 'Poor', reading: 'Significant defect; corrective action required' },
  { score: 1, meaning: 'Unacceptable', reading: 'Major sensory failure; reject/hold' },
] as const

export const STORAGE_CONDITIONS = ['Ambient', 'Chilled', 'Other'] as const

/** Section, attribute, weight, critical — the sheet's weights, which total 100. */
const ATTRIBUTES: [string, string, number, boolean][] = [
  ['Appearance', 'Colour / shade appropriate', 5, false],
  ['Appearance', 'Colour uniformity', 3, false],
  ['Appearance', 'Clarity / opacity appropriate', 4, false],
  ['Appearance', 'Homogeneity', 4, true],
  ['Appearance', 'Sedimentation / separation', 5, true],
  ['Aroma', 'Coconut aroma', 5, true],
  ['Aroma', 'Product-specific aroma', 5, true],
  ['Aroma', 'Freshness', 4, true],
  ['Aroma', 'Aroma balance', 3, false],
  ['Flavour', 'Coconut flavour', 6, true],
  ['Flavour', 'Characteristic product flavour', 7, true],
  ['Flavour', 'Flavour intensity', 4, false],
  ['Flavour', 'Flavour balance', 5, true],
  ['Flavour', 'Freshness / naturalness', 4, true],
  ['Sweetness', 'Sweetness intensity', 4, true],
  ['Sweetness', 'Sweetness quality – monk fruit', 4, true],
  ['Sweetness', 'Sweetness aftertaste', 4, true],
  ['Mouthfeel', 'Body', 3, false],
  ['Mouthfeel', 'Smoothness', 4, true],
  ['Mouthfeel', 'Creaminess (if applicable)', 3, false],
  ['Mouthfeel', 'Acidity balance', 4, true],
  ['Mouthfeel', 'Refreshing quality', 3, false],
  ['Aftertaste', 'Aftertaste acceptability', 4, true],
  ['Aftertaste', 'Clean finish', 3, true],
]

/**
 * The attributes as test parameters. The ids are fixed rather than minted, because
 * these stand in for rows nobody has saved yet: every device has to name them alike,
 * and the first edit an admin makes saves them under exactly these ids.
 */
export function defaultSensoryParameters(): TestParameter[] {
  return ATTRIBUTES.map(([section, name, weight, critical], i) => ({
    id: `TP-SENSORY-${String(i + 1).padStart(2, '0')}`,
    category: SENSORY_KEY,
    name,
    method: '',
    unit: '',
    section,
    weight,
    critical,
  }))
}

export const SENSORY_PRODUCT_GROUPS: SensoryProductGroup[] = [
  {
    name: 'Coconut Water',
    checkpoints: 'Fresh coconut aroma; clean taste; natural sweetness; clarity; refreshing finish',
    defects: 'Fermented/sour note; rancidity; excessive haze; sediment; flat flavour',
    focus: 'Coconut freshness; sweetness; clarity; clean finish',
  },
  {
    name: 'Coconut Melange',
    checkpoints: 'Fruit identity; fruit:coconut balance; acidity; sweetness; natural fruit character',
    defects: 'Fruit oxidation; excessive acidity; muddled fruit flavour; separation; monk-fruit linger',
    focus: 'Fruit ratio; acid balance; sweetness; refreshing finish',
  },
  {
    name: 'Coconut Smoothie',
    checkpoints: 'Coconut milk character; chocolate/cocoa; creaminess; body; smoothness',
    defects: 'Gritty/chalky; gluey; excessive thickness; phase separation; bitter monk fruit',
    focus: 'Protein/stabilizer system; cocoa balance; texture',
  },
  {
    name: 'Coconut Cold Brew Coffee',
    checkpoints: 'Coffee intensity; roast character; coffee:coconut balance; bitterness; acidity',
    defects: 'Over-extraction; burnt/harsh coffee; excessive bitterness; sediment; monk-fruit aftertaste',
    focus: 'Extraction strength; coffee dose; bitterness; clean finish',
  },
]

export type SensoryDecision =
  | 'PENDING'
  | 'PENDING – COMPLETE SCORES'
  | 'REJECT / HOLD – CRITICAL DEFECT'
  | 'PASS'
  | 'PASS WITH MINOR MODIFICATION'
  | 'HOLD – R&D REVIEW'

export interface SensorySummary {
  /** Weighted score out of 100, or null before anything is scored. */
  score: number | null
  /** Average raw score out of 5, or null before anything is scored. */
  average: number | null
  criticalBelow: number
  criticalAt: number
  missing: number
  decision: SensoryDecision
}

const isScore = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 5

/** What one attribute adds to the total: its weight, scaled by its score out of 5. */
export const weightedScore = (s: SensoryScore) =>
  isScore(s.score) ? ((Number(s.weight) || 0) * s.score) / 5 : null

/**
 * The sheet's automatic summary. The total is taken against the weights actually on the
 * sheet, so it is out of 100 even if an admin's weights no longer add up to exactly
 * that — the spreadsheet itself only asked for them to be kept at 100.
 */
export function scoreSensory(
  scores: SensoryScore[],
  thresholds: { passScore?: number; minorScore?: number } = {},
): SensorySummary {
  const scored = scores.filter((s) => isScore(s.score))
  const totalWeight = scores.reduce((a, s) => a + (Number(s.weight) || 0), 0)
  const earned = scored.reduce((a, s) => a + (weightedScore(s) || 0), 0)
  // Rounded before it is compared: weights times fifths are not exact in binary, and
  // 79.99999 must not fail a product the sheet would pass at 80.
  const score = scored.length
    ? totalWeight > 0
      ? Math.round((earned / totalWeight) * 100 * 100) / 100
      : 0
    : null
  const average = scored.length
    ? Math.round((scored.reduce((a, s) => a + (s.score as number), 0) / scored.length) * 100) / 100
    : null
  const criticalBelow = scored.filter((s) => s.critical && (s.score as number) < CRITICAL_BELOW).length
  const criticalAt = scored.filter((s) => s.critical && s.score === CRITICAL_BELOW).length
  const missing = scores.length - scored.length
  const pass = thresholds.passScore ?? DEFAULT_PASS_SCORE
  const minor = thresholds.minorScore ?? DEFAULT_MINOR_SCORE

  let decision: SensoryDecision
  if (!scored.length) decision = 'PENDING'
  else if (missing > 0) decision = 'PENDING – COMPLETE SCORES'
  else if (criticalBelow > 0) decision = 'REJECT / HOLD – CRITICAL DEFECT'
  else if ((score as number) >= pass) decision = 'PASS'
  else if ((score as number) >= minor) decision = 'PASS WITH MINOR MODIFICATION'
  else decision = 'HOLD – R&D REVIEW'

  return { score, average, criticalBelow, criticalAt, missing, decision }
}

/**
 * The QC result a decision stands for. A pass with minor modification is still a
 * pass; an R&D review holds the product for a retest; a critical defect fails it.
 */
export function decisionStatus(decision: SensoryDecision): 'Pass' | 'Retest' | 'Fail' | 'Pending' {
  switch (decision) {
    case 'PASS':
    case 'PASS WITH MINOR MODIFICATION':
      return 'Pass'
    case 'HOLD – R&D REVIEW':
      return 'Retest'
    case 'REJECT / HOLD – CRITICAL DEFECT':
      return 'Fail'
    default:
      return 'Pending'
  }
}

/** A blank score sheet off the report type's attributes, in the order they were set. */
export function blankScores(params: TestParameter[]): SensoryScore[] {
  return params.map((p) => ({
    section: p.section || '',
    name: p.name,
    weight: Number(p.weight) || 0,
    critical: !!p.critical,
    score: null,
    observation: '',
    action: '',
  }))
}
