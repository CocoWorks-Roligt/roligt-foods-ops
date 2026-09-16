/**
 * The kinds of test a product is judged on, and how a QC record reads and writes them.
 *
 * There used to be four, fixed in code and in every QC record's fields — microbiology,
 * pesticides, heavy metals and physicochemical. A fifth, the sensory evaluation, needed
 * a different kind of report altogether, and the plant will add more. So the list is
 * admin data now, kept in config, and the built-in one below stands until an admin
 * changes it. The four original tests keep the fields they have always been saved in;
 * every other test's result lives under its key in `QcRecord.tests`.
 */

import type { AppState, QcAttachment, QcRecord, QcTestResult, TestCategoryDef, TestParameter } from '../types'
import {
  DEFAULT_MINOR_SCORE,
  DEFAULT_PASS_SCORE,
  SENSORY_KEY,
  SENSORY_PRODUCT_GROUPS,
  defaultSensoryParameters,
} from './sensory'

export const LEGACY_TESTS = ['micro', 'pesticides', 'heavyMetals', 'physico'] as const
export type LegacyTest = (typeof LEGACY_TESTS)[number]

export const isLegacyTest = (key: string): key is LegacyTest =>
  (LEGACY_TESTS as readonly string[]).includes(key)

const LAB_SIGNATORY = 'Authorised Signatory - Biology'

export const BUILT_IN_CATEGORIES: TestCategoryDef[] = [
  {
    key: 'micro',
    title: 'Microbiology',
    format: 'results',
    requiredForRelease: true,
    status: 'Active',
    hint: 'Method, lab, report number',
    signatory: LAB_SIGNATORY,
  },
  {
    key: 'pesticides',
    title: 'Pesticide Residues',
    format: 'results',
    requiredForRelease: true,
    status: 'Active',
    hint: 'NABL report / panel details',
    signatory: LAB_SIGNATORY,
  },
  {
    key: 'heavyMetals',
    title: 'Heavy Metals',
    format: 'results',
    requiredForRelease: true,
    status: 'Active',
    hint: 'Lead, arsenic, cadmium, mercury',
    signatory: LAB_SIGNATORY,
  },
  {
    key: 'physico',
    title: 'Physicochemical',
    format: 'results',
    requiredForRelease: true,
    status: 'Active',
    hint: 'pH, Brix, appearance',
    signatory: LAB_SIGNATORY,
  },
  {
    key: SENSORY_KEY,
    title: 'Sensory Evaluation',
    format: 'scored',
    requiredForRelease: true,
    status: 'Active',
    hint: 'Evaluator, score, decision',
    passScore: DEFAULT_PASS_SCORE,
    minorScore: DEFAULT_MINOR_SCORE,
    productGroups: SENSORY_PRODUCT_GROUPS,
  },
]

/** Every report type, active or not, in the order the admin keeps them. */
export function testCategories(state: Pick<AppState, 'config'>): TestCategoryDef[] {
  const stored = state.config.testCategories
  return stored?.length ? stored : BUILT_IN_CATEGORIES
}

export const isActiveCategory = (c: TestCategoryDef) => c.status !== 'Inactive'

export const categoryDef = (state: Pick<AppState, 'config'>, key: string) =>
  testCategories(state).find((c) => c.key === key)

export function categoryTitle(state: Pick<AppState, 'config'>, key: string): string {
  return categoryDef(state, key)?.title || key
}

/** The tests a product needs a Pass on today before it can be released. */
export const requiredCategoryKeys = (state: Pick<AppState, 'config'>) =>
  testCategories(state)
    .filter((c) => isActiveCategory(c) && c.requiredForRelease)
    .map((c) => c.key)

/**
 * A report type's blueprint rows. The sensory attributes ship with the app, so until an
 * admin saves a change to them they are read from the built-in sheet — see
 * `materializeParameters` for how the first change keeps the rest.
 */
export function categoryParameters(state: Pick<AppState, 'testParameters'>, key: string): TestParameter[] {
  const stored = state.testParameters.filter((tp) => tp.category === key)
  if (stored.length || key !== SENSORY_KEY) return stored
  return defaultSensoryParameters()
}

/**
 * Saves the built-in rows of a report type before the first change to any of them.
 * Without this, editing one attribute would save that one row, and the other
 * twenty-three — which only ever existed in code — would vanish from the sheet.
 */
export function materializeParameters(draft: AppState, key: string) {
  if (draft.testParameters.some((tp) => tp.category === key)) return
  draft.testParameters.push(...categoryParameters(draft, key))
}

/** One test's result on a record. A test nobody has touched is pending. */
export function qcTest(q: QcRecord, key: string): QcTestResult {
  if (isLegacyTest(key)) {
    return {
      status: q[key] || 'Pending',
      note: q[`${key}Note` as const] || '',
      report: q[`${key}Report` as const] || null,
    }
  }
  const r = q.tests?.[key]
  return { status: r?.status || 'Pending', note: r?.note || '', report: r?.report || null }
}

/** Writes one test's result where that test has always been kept. */
export function writeQcTest(q: QcRecord, key: string, r: QcTestResult) {
  if (isLegacyTest(key)) {
    q[key] = r.status
    q[`${key}Note` as const] = r.note || ''
    q[`${key}Report` as const] = r.report || null
    return
  }
  q.tests = { ...(q.tests || {}), [key]: { status: r.status, note: r.note || '', report: r.report || null } }
}

/** Whether a test has anything recorded against it at all. */
export const hasTestData = (r: QcTestResult) => r.status !== 'Pending' || !!r.note || !!r.report

/** Every result a record carries, required or not. */
export function qcStatuses(q: QcRecord): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of LEGACY_TESTS) out[key] = q[key] || 'Pending'
  for (const [key, r] of Object.entries(q.tests || {})) out[key] = r?.status || 'Pending'
  return out
}

/**
 * What a record's results add up to.
 *
 * A fail is a fail whatever else passed, and on any test — a sensory defect found on a
 * product that did not need the evaluation is still a defect. A retest holds it. Only
 * a Pass on every required test releases it.
 */
export function qcDisposition(
  statuses: Record<string, string>,
  required: string[],
): 'Pending' | 'Retest' | 'Rejected' | 'Released' {
  const all = Object.values(statuses)
  if (all.includes('Fail')) return 'Rejected'
  if (all.includes('Retest')) return 'Retest'
  if (required.length && required.every((key) => statuses[key] === 'Pass')) return 'Released'
  return 'Pending'
}

/**
 * The tests a record needs a Pass on. A product already released or rejected was decided
 * on the tests required at the time, so a test added since does not quietly reopen it;
 * one still waiting is judged on what is required now.
 */
export function requiredTestsFor(state: Pick<AppState, 'config'>, q: QcRecord): string[] {
  const decided = q.disposition === 'Released' || q.disposition === 'Rejected'
  if (decided) return q.requiredTests?.length ? q.requiredTests : [...LEGACY_TESTS]
  return requiredCategoryKeys(state)
}

/**
 * What saving these results would decide. Pure, so the review dialog can say what a
 * save is about to do before it does it, and the save cannot decide anything else.
 */
export function qcDecision(
  state: Pick<AppState, 'config'>,
  q: QcRecord,
  tests: Record<string, QcTestResult> = {},
) {
  const record: QcRecord = { ...q, tests: { ...(q.tests || {}) } }
  for (const [key, r] of Object.entries(tests)) writeQcTest(record, key, r)
  const required = requiredTestsFor(state, q)
  return { record, required, disposition: qcDisposition(qcStatuses(record), required) }
}

/**
 * The tests a record's screens show: every active type, plus any the record was judged
 * on or has results for — a type made inactive since must not hide what was recorded.
 */
export function testsShownFor(state: Pick<AppState, 'config'>, q?: QcRecord): TestCategoryDef[] {
  const required = q ? requiredTestsFor(state, q) : requiredCategoryKeys(state)
  return testCategories(state).filter(
    (c) => isActiveCategory(c) || required.includes(c.key) || (!!q && hasTestData(qcTest(q, c.key))),
  )
}

/** Every file attached to a record, whichever test it is filed under. */
export function qcAttachments(q: QcRecord): { key: string; file: QcAttachment }[] {
  const out: { key: string; file: QcAttachment }[] = []
  for (const key of LEGACY_TESTS) {
    const file = q[`${key}Report` as const]
    if (file) out.push({ key, file })
  }
  for (const [key, r] of Object.entries(q.tests || {})) {
    if (r?.report) out.push({ key, file: r.report })
  }
  return out
}

/** A key for a new report type, from its title. Fixed from then on. */
export function mintCategoryKey(taken: string[], title: string) {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'report'
  const used = new Set([...taken, ...LEGACY_TESTS, SENSORY_KEY].map((k) => k.toLowerCase()))
  let key = slug
  for (let n = 2; used.has(key); n++) key = `${slug}-${n}`
  return key
}
