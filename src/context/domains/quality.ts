/**
 * The QC verdict a batch is released on, the report types and blueprints it is tested
 * against, and its lab reports.
 *
 * Split out of AppContext, which had grown to nearly three thousand lines and every
 * write the application can make.
 */

import { useCallback, useMemo } from 'react'
import { batchDisposition } from '../../lib/posting'
import type { QcUpdate } from '../../lib/posting'
import { batchOutputs, mainOutput, runBulkItem } from '../../lib/batches'
import {
  categoryDef,
  categoryParameters,
  hasTestData,
  isActiveCategory,
  isLegacyTest,
  materializeParameters,
  mintCategoryKey,
  qcAttachments,
  qcDecision,
  qcTest,
  requiredCategoryKeys,
  testCategories,
  testsShownFor,
  writeQcTest,
} from '../../lib/qcCategories'
import { SENSORY_KEY, scoreSensory } from '../../lib/sensory'
import { itemName, stockRows, inHoldArea, locationLabel } from '../../lib/stock'
import { deepClone, nowISO, statusLabel, uid, QTY_EPSILON } from '../../lib/utils'
import type { AppState, LabReport, TestCategoryDef, TestParameter } from '../../types'
import { POSTED } from './deps'
import type { CoreDeps } from './deps'

export type TestCategoryInput = Omit<TestCategoryDef, 'key' | 'status'>
export type LabReportInput = Omit<LabReport, 'id' | 'createdAt'>
export type TestParameterPatch = Omit<TestParameter, 'id' | 'category'>

/** One line for the audit trail naming the report and, for an evaluation, what it found. */
function describeReport(state: AppState, r: LabReportInput) {
  const def = categoryDef(state, r.category)
  const title = def?.title || r.category
  if (def?.format !== 'scored') return `${title} · ${r.sampleName}`
  const summary = scoreSensory(r.scores || [], r)
  const score = summary.score == null ? 'not scored' : `${summary.score}/100`
  return `${title} · ${r.sampleName} · ${r.batchLotDetails} · ${score} · ${summary.decision}`
}

/** What a report form got wrong, or null when it can be saved. Shared by generate and edit. */
function reportProblem(state: AppState, input: LabReportInput): string | null {
  const def = categoryDef(state, input.category)
  if (!def) return 'Pick a report type.'
  if (def.format === 'scored') {
    if (!input.scores?.length) return `Add attributes to ${def.title} on the Test Parameters page first.`
    if (!input.sampleName.trim()) return 'Enter the product / variant that was evaluated.'
    if (!input.batchLotDetails.trim()) return 'Enter the batch or trial number this evaluation is for.'
    if (input.scores.some((s) => s.score != null && !(Number.isInteger(s.score) && s.score >= 1 && s.score <= 5))) {
      return 'Scores run from 1 to 5.'
    }
    return null
  }
  if (!input.customerName.trim()) return 'Customer name is required.'
  if (!input.results.length) return 'Add at least one test parameter for this category first.'
  return null
}

/**
 * The thresholds and product checks an evaluation was decided against, copied onto it.
 * A report is a record of what was found on the day; changing the pass score next month
 * must not turn a report that passed into one that failed.
 */
function withSnapshot(def: TestCategoryDef, input: LabReportInput, existing?: LabReport): LabReportInput {
  if (def.format !== 'scored') return input
  const sameProduct = !!existing && existing.productGroup === input.productGroup
  return {
    ...input,
    passScore: existing?.passScore ?? def.passScore,
    minorScore: existing?.minorScore ?? def.minorScore,
    productChecks: sameProduct
      ? existing?.productChecks
      : def.productGroups?.find((g) => g.name === input.productGroup),
  }
}

/** The row a parameter id names — a saved one, or a built-in sensory attribute not yet saved. */
const findParameter = (state: AppState, id: string) =>
  state.testParameters.find((x) => x.id === id) ||
  categoryParameters(state, SENSORY_KEY).find((x) => x.id === id)

/** What a parameter form got wrong, or null. */
function parameterProblem(
  state: AppState,
  category: string,
  input: TestParameterPatch,
  id?: string,
): string | null {
  const def = categoryDef(state, category)
  if (!def) return 'Pick a report type.'
  const name = input.name.trim()
  if (!name) return def.format === 'scored' ? 'Give the attribute a name.' : 'Test parameter name is required.'
  // A report lists its results by name, so two alike would be one row printed twice.
  const clash = categoryParameters(state, category).some(
    (p) => p.id !== id && p.name.trim().toLowerCase() === name.toLowerCase(),
  )
  if (clash) return `${def.title} already has ${name}.`
  if (def.format === 'scored') {
    if (!(input.section || '').trim()) return 'Say which section the attribute sits under — Appearance, Aroma …'
    const weight = Number(input.weight)
    if (!Number.isFinite(weight) || weight <= 0) return 'Give the attribute a weight above zero.'
  }
  return null
}

/** The fields a parameter keeps, for its report type's format. */
function cleanParameter(format: string, input: TestParameterPatch): TestParameterPatch {
  const base = {
    name: input.name.trim(),
    method: (input.method || '').trim(),
    unit: (input.unit || '').trim(),
  }
  if (format !== 'scored') return base
  return {
    ...base,
    section: (input.section || '').trim(),
    weight: Number(input.weight) || 0,
    critical: !!input.critical,
  }
}

/** Whether a list still has something a product can be released on. */
const releasable = (list: TestCategoryDef[]) =>
  list.some((c) => isActiveCategory(c) && c.requiredForRelease)

const NOTHING_RELEASABLE =
  'At least one active report type has to be needed for release — without one, nothing could ever be released.'

export function useQuality({ state, setState, nextId, log, showToast, actor, announcement, forbidden }: CoreDeps) {
  const saveQc = useCallback(
    (id: string, updates: QcUpdate): string | null => {
      const existing = state.qcs.find((x) => x.id === id)
      if (!existing) return null
      // Worked out from the results themselves, by the same rule the review dialog
      // previews with, so the toast cannot announce a disposition other than the one saved.
      const { disposition, required } = qcDecision(state, existing, updates.tests)
      /**
       * A hold area takes only stock QC has rejected. Any other verdict would leave stock
       * standing somewhere the rule says it cannot be — released goods among the rejects,
       * or goods awaiting a retest mistaken for them — so it is moved out first.
       */
      const batch = state.batches.find((x) => x.id === existing.batchId)
      if (batch && disposition !== 'Rejected') {
        const covered = existing.item || mainOutput(batch)?.item || ''
        const packs = new Set(
          state.packingRuns
            .filter((r) => r.batchId === batch.id && runBulkItem(r) === covered)
            .flatMap((r) => r.lines.map((l) => l.sku)),
        )
        const setAside = stockRows(state).find(
          (r) =>
            r.lot === batch.id &&
            r.qty > QTY_EPSILON &&
            (r.itemType === 'Semi Finished' ? r.item === covered : r.itemType === 'Finished Goods' && packs.has(r.item)) &&
            inHoldArea(state, r.location),
        )
        if (setAside) {
          showToast(
            `${itemName(state, setAside.item)} from ${batch.id} is set aside in ${locationLabel(state, setAside.location)} — move it back out before ${
              disposition === 'Released' ? 'releasing it' : 'changing its verdict'
            }.`,
          )
          return null
        }
      }
      setState((prev) => {
        const draft = deepClone(prev)
        const q = draft.qcs.find((x) => x.id === id)
        if (!q) return prev
        for (const [key, result] of Object.entries(updates.tests)) writeQcTest(q, key, result)
        q.requiredTests = required
        q.disposition = disposition
        q.reviewedBy = actor
        q.reviewedAt = nowISO()
        const b = draft.batches.find((x) => x.id === q.batchId)
        if (!b) return draft

        /**
         * What this verdict actually covers: one bulk output of the batch, and the
         * packs filled from that bulk. A batch gives water and malai, and rejecting
         * the malai must not quarantine the bottles of water standing beside it.
         */
        const product = q.item || mainOutput(b)?.item || ''
        const packedFrom = new Set(
          draft.packingRuns
            .filter((r) => r.batchId === b.id && runBulkItem(r) === product)
            .flatMap((r) => r.lines.map((l) => l.sku)),
        )
        const covers = (r: { itemType: string; item: string }) =>
          r.itemType === 'Semi Finished'
            ? r.item === product
            : r.itemType === 'Finished Goods' && packedFrom.has(r.item)

        /**
         * Packs are already in the cold room — they went there off the packing line and
         * the lab worked while they sat. So a verdict changes their *status* and nothing
         * else: released stock becomes sellable where it stands, rejected stock stays put
         * flagged. A product put back on retest, or reopened while results are redone, is
         * no longer cleared, so whatever a verdict had released or rejected goes back to
         * awaiting QC — a retest used to leave released packs free to dispatch.
         */
        const target = disposition === 'Released' || disposition === 'Rejected' ? disposition : 'Quarantine'
        const moving = stockRows(draft).filter(
          (r) =>
            r.lot === b.id &&
            r.qty > 0 &&
            covers(r) &&
            (target === 'Quarantine' ? r.status === 'Released' || r.status === 'Rejected' : r.status !== target),
        )
        for (const r of moving) {
          draft.ledger.push({
            id: uid('LED'),
            type: 'QC Status Transfer',
            doc: q.id,
            item: r.item,
            itemType: r.itemType,
            lot: r.lot,
            location: r.location,
            status: r.status,
            qtyIn: 0,
            qtyOut: r.qty,
            uom: r.uom,
            unitCost: r.unitCost,
            time: nowISO(),
            expiry: r.expiry,
          })
          draft.ledger.push({
            id: uid('LED'),
            type: 'QC Status Transfer',
            doc: q.id,
            item: r.item,
            itemType: r.itemType,
            lot: r.lot,
            location: r.location,
            status: target,
            qtyIn: r.qty,
            qtyOut: 0,
            uom: r.uom,
            unitCost: r.unitCost,
            time: nowISO(),
            expiry: r.expiry,
          })
        }
        const reopened = target === 'Quarantine' && moving.length ? ' Its stock is back to awaiting QC.' : ''

        // Filed under the QC record — the transaction the verdict belongs to — and not
        // the batch, which had two products and said nothing about which was meant.
        if (disposition === 'Released' || disposition === 'Rejected') {
          log(
            draft,
            disposition === 'Released' ? 'Released product' : 'Rejected product',
            q.id,
            disposition === 'Released'
              ? `${itemName(draft, product)} from ${b.id} released — its packs are cleared for dispatch where they stand and its bulk is cleared for packing.`
              : `${itemName(draft, product)} from ${b.id} rejected — its stock stays where it is, flagged so it cannot be dispatched.`,
          )
        } else if (disposition === 'Retest') {
          log(draft, 'Held product for retest', q.id, `${itemName(draft, product)} from ${b.id} needs a retest.${reopened}`)
        } else {
          // Results saved before there is a verdict are still work somebody did on the record.
          const results = testsShownFor(draft, q)
            .map((c) => `${c.title} ${statusLabel(qcTest(q, c.key).status)}`)
            .join(', ')
          log(draft, 'Recorded QC results', q.id, `${itemName(draft, product)} from ${b.id}: ${results}.${reopened}`)
        }
        // The batch is the roll-up of every verdict on what it made — released only
        // when all of them are, and `Partly Released` when only some are.
        b.status = batchDisposition(draft.qcs.filter((x) => x.batchId === b.id))
        return draft
      })
      showToast(`QC updated: ${statusLabel(disposition)}.`)
      return disposition
    },
    [actor, log, setState, showToast, state],
  )

  /**
   * Raises the QC record for a bulk output that has none.
   *
   * Only ever needed by a batch posted before QC was per product: it carries one
   * record covering its main output, and its by-product has nothing to be tested
   * against. Every batch posted since gets a record for each output as it is booked.
   */
  const startQc = useCallback(
    (batchId: string, item: string): string | null => {
      const b = state.batches.find((x) => x.id === batchId)
      if (!b) return null
      if (!batchOutputs(b).some((o) => o.item === item)) {
        showToast('That batch did not produce this product.')
        return null
      }
      if (state.qcs.some((q) => q.batchId === batchId && q.item === item)) {
        showToast('That product already has a QC record.')
        return null
      }
      let createdId = ''
      setState((prev) => {
        const draft = deepClone(prev)
        const id = nextId(draft, 'qc')
        draft.qcs.push({
          id,
          batchId,
          item,
          micro: 'Pending',
          pesticides: 'Pending',
          heavyMetals: 'Pending',
          physico: 'Pending',
          requiredTests: requiredCategoryKeys(draft),
          disposition: 'Pending',
          reviewedBy: '',
          reviewedAt: '',
        })
        const target = draft.batches.find((x) => x.id === batchId)
        if (target) {
          target.qcIds = draft.qcs.filter((q) => q.batchId === batchId).map((q) => q.id)
          target.status = batchDisposition(draft.qcs.filter((q) => q.batchId === batchId))
        }
        log(draft, 'Raised QC record', id, `${itemName(draft, item)} from ${batchId}.`)
        createdId = id
        return draft
      })
      showToast('QC record raised.')
      return createdId || POSTED
    },
    [log, nextId, setState, showToast, state.batches, state.qcs],
  )

  /**
   * Adds a report type, or changes one. The list lives in config; the first change an
   * admin makes saves the built-in list with it.
   */
  const saveTestCategory = useCallback(
    (input: TestCategoryInput, key?: string): string | null => {
      if (forbidden('Changing report types')) return null
      const title = input.title.trim()
      if (!title) {
        showToast('Give the report type a name.')
        return null
      }
      const list = testCategories(state)
      const existing = key ? list.find((c) => c.key === key) : undefined
      if (key && !existing) return null
      if (list.some((c) => c.key !== key && c.title.trim().toLowerCase() === title.toLowerCase())) {
        showToast(`There is already a report type called ${title}.`)
        return null
      }
      // Parameters and reports are written in their type's format, so a type that has
      // any cannot change format underneath them.
      if (existing && existing.format !== input.format) {
        const used =
          isLegacyTest(existing.key) ||
          existing.key === SENSORY_KEY ||
          state.testParameters.some((tp) => tp.category === existing.key) ||
          state.labReports.some((r) => r.category === existing.key)
        if (used) {
          showToast(`${existing.title} already has parameters or reports in its format — add a new report type instead.`)
          return null
        }
      }
      const groups = (input.productGroups || [])
        .map((g) => ({
          name: g.name.trim(),
          checkpoints: g.checkpoints.trim(),
          defects: g.defects.trim(),
          focus: g.focus.trim(),
        }))
        .filter((g) => g.name)
      if (input.format === 'scored') {
        const pass = Number(input.passScore)
        const minor = Number(input.minorScore)
        if (!(pass > 0 && pass <= 100) || !(minor >= 0 && minor <= pass)) {
          showToast('The pass score has to be between 1 and 100, and the minor-modification score no higher than it.')
          return null
        }
        const names = groups.map((g) => g.name.toLowerCase())
        const repeated = groups.find((g, i) => names.indexOf(g.name.toLowerCase()) !== i)
        if (repeated) {
          showToast(`Two product checks are both called ${repeated.name}.`)
          return null
        }
      }
      const clean: TestCategoryDef = {
        key: existing?.key || mintCategoryKey(list.map((c) => c.key), title),
        title,
        format: input.format,
        requiredForRelease: !!input.requiredForRelease,
        status: existing?.status || 'Active',
        ...(input.hint?.trim() ? { hint: input.hint.trim() } : {}),
        ...(input.format === 'scored'
          ? { passScore: Number(input.passScore), minorScore: Number(input.minorScore), productGroups: groups }
          : input.signatory?.trim()
            ? { signatory: input.signatory.trim() }
            : {}),
      }
      const next = existing ? list.map((c) => (c.key === existing.key ? clean : c)) : [...list, clean]
      if (!releasable(next)) {
        showToast(NOTHING_RELEASABLE)
        return null
      }
      setState((prev) => {
        const draft = deepClone(prev)
        draft.config.testCategories = next
        log(
          draft,
          existing ? 'Edited report type' : 'Added report type',
          clean.title,
          `${clean.format === 'scored' ? 'Scored evaluation' : 'Results table'} · ${
            clean.requiredForRelease ? 'needed to release a product' : 'not needed to release a product'
          }`,
        )
        return draft
      })
      showToast(existing ? `${clean.title} saved.` : `${clean.title} added.`)
      return clean.key
    },
    [forbidden, log, setState, showToast, state],
  )

  const setTestCategoryStatus = useCallback(
    (key: string, status: string) => {
      if (forbidden('Changing report types')) return
      const list = testCategories(state)
      const def = list.find((c) => c.key === key)
      if (!def) return
      const next = list.map((c) => (c.key === key ? { ...c, status } : c))
      if (!releasable(next)) {
        showToast(NOTHING_RELEASABLE)
        return
      }
      setState((prev) => {
        const draft = deepClone(prev)
        draft.config.testCategories = next
        log(
          draft,
          status === 'Inactive' ? 'Deactivated report type' : 'Reactivated report type',
          def.title,
          status === 'Inactive'
            ? 'Takes no new reports and no longer holds back a product waiting on QC.'
            : 'Takes reports again.',
        )
        return draft
      })
      showToast(status === 'Inactive' ? `${def.title} deactivated.` : `${def.title} reactivated.`)
    },
    [forbidden, log, setState, showToast, state],
  )

  const deleteTestCategory = useCallback(
    (key: string) => {
      if (forbidden('Changing report types')) return
      const list = testCategories(state)
      const def = list.find((c) => c.key === key)
      if (!def) return
      if (isLegacyTest(key)) {
        showToast(`${def.title} is one of the tests every QC record carries — deactivate it instead.`)
        return
      }
      const reports = state.labReports.filter((r) => r.category === key).length
      const recorded = state.qcs.filter((q) => hasTestData(qcTest(q, key))).length
      if (reports || recorded) {
        showToast(
          `Cannot delete ${def.title}: ${reports} report(s) and ${recorded} QC record(s) use it. Deactivate it instead.`,
        )
        return
      }
      const next = list.filter((c) => c.key !== key)
      if (!releasable(next)) {
        showToast(NOTHING_RELEASABLE)
        return
      }
      setState((prev) => {
        const draft = deepClone(prev)
        const dropped = draft.testParameters.filter((tp) => tp.category === key).length
        draft.config.testCategories = next
        draft.testParameters = draft.testParameters.filter((tp) => tp.category !== key)
        log(draft, 'Deleted report type', def.title, `${dropped} parameter(s) removed with it.`)
        return draft
      })
      showToast(`${def.title} deleted.`)
    },
    [forbidden, log, setState, showToast, state],
  )

  const addTestParameter = useCallback(
    (input: Omit<TestParameter, 'id'>): string | null => {
      const problem = parameterProblem(state, input.category, input)
      if (problem) {
        showToast(problem)
        return null
      }
      const format = categoryDef(state, input.category)?.format || 'results'
      let createdId = ''
      setState((prev) => {
        const draft = deepClone(prev)
        materializeParameters(draft, input.category)
        const tp: TestParameter = { ...cleanParameter(format, input), category: input.category, id: uid('TP') }
        draft.testParameters.push(tp)
        log(draft, 'Added test parameter', tp.id, `${categoryDef(draft, tp.category)?.title || tp.category}: ${tp.name}`)
        createdId = tp.id
        return draft
      })
      showToast('Test parameter added.')
      return createdId || POSTED
    },
    [log, setState, showToast, state],
  )

  const updateTestParameter = useCallback(
    (id: string, patch: TestParameterPatch): string | null => {
      const row = findParameter(state, id)
      if (!row) return null
      const problem = parameterProblem(state, row.category, patch, id)
      if (problem) {
        showToast(problem)
        return null
      }
      const format = categoryDef(state, row.category)?.format || 'results'
      setState((prev) => {
        const draft = deepClone(prev)
        materializeParameters(draft, row.category)
        const tp = draft.testParameters.find((x) => x.id === id)
        if (!tp) return prev
        Object.assign(tp, cleanParameter(format, patch))
        log(draft, 'Edited test parameter', tp.id, tp.name)
        return draft
      })
      showToast('Test parameter updated.')
      return id
    },
    [log, setState, showToast, state],
  )

  const deleteTestParameter = useCallback(
    (id: string) => {
      const row = findParameter(state, id)
      if (!row) return
      if (categoryDef(state, row.category)?.format === 'scored' && categoryParameters(state, row.category).length <= 1) {
        showToast('An evaluation needs at least one attribute to score.')
        return
      }
      setState((prev) => {
        const draft = deepClone(prev)
        materializeParameters(draft, row.category)
        draft.testParameters = draft.testParameters.filter((x) => x.id !== id)
        log(draft, 'Deleted test parameter', id, row.name)
        return draft
      })
      showToast('Test parameter deleted.')
    },
    [log, setState, showToast, state],
  )

  const generateReport = useCallback(
    (input: LabReportInput): string | null => {
      const problem = reportProblem(state, input)
      if (problem) {
        showToast(problem)
        return null
      }
      const def = categoryDef(state, input.category) as TestCategoryDef
      if (!isActiveCategory(def)) {
        showToast(`${def.title} is inactive — reactivate it on the Test Parameters page to issue new reports.`)
        return null
      }
      let createdId = ''
      setState((prev) => {
        const draft = deepClone(prev)
        const id = nextId(draft, 'testReport')
        const report: LabReport = { ...withSnapshot(def, input), id, createdAt: nowISO() }
        draft.labReports.push(report)
        log(draft, 'Generated lab report', id, describeReport(draft, report))
        createdId = id
        // Announced after React commits, like every other posting: read straight back
        // out of the updater the code is only there while React takes its eager-state
        // shortcut, and the toast quietly degraded to the word "Report" when it did not.
        announcement.current = `${id} generated.`
        return draft
      })
      return createdId || POSTED
    },
    [announcement, log, nextId, setState, showToast, state],
  )

  const updateReport = useCallback(
    (id: string, input: LabReportInput): string | null => {
      const existing = state.labReports.find((r) => r.id === id)
      if (!existing) return null
      const problem = reportProblem(state, input)
      if (problem) {
        showToast(problem)
        return null
      }
      const def = categoryDef(state, input.category) as TestCategoryDef
      setState((prev) => {
        const draft = deepClone(prev)
        const idx = draft.labReports.findIndex((r) => r.id === id)
        if (idx < 0) return prev
        // Report number and the date it was generated identify the document, so they
        // survive an edit — anything a QC record has attached still points at it.
        const before = draft.labReports[idx]
        draft.labReports[idx] = { ...withSnapshot(def, input, before), id, createdAt: before.createdAt }
        log(draft, 'Edited lab report', id, describeReport(draft, draft.labReports[idx]))
        return draft
      })
      showToast(`${id} updated.`)
      return id
    },
    [log, setState, showToast, state],
  )

  const deleteReport = useCallback(
    (id: string) => {
      const attachedTo = state.qcs.find((q) =>
        qcAttachments(q).some((a) => a.file.url === `/reports/${id}`),
      )
      if (attachedTo) {
        showToast(`Cannot delete: attached to ${attachedTo.id}. Detach it from the QC record first.`)
        return
      }
      setState((prev) => {
        const draft = deepClone(prev)
        const r = draft.labReports.find((x) => x.id === id)
        if (!r) return prev
        draft.labReports = draft.labReports.filter((x) => x.id !== id)
        log(draft, 'Deleted lab report', id, describeReport(draft, r))
        return draft
      })
      showToast('Report deleted.')
    },
    [log, setState, showToast, state.qcs],
  )

  return useMemo(
    () => ({
      saveQc,
      startQc,
      saveTestCategory,
      setTestCategoryStatus,
      deleteTestCategory,
      addTestParameter,
      updateTestParameter,
      deleteTestParameter,
      generateReport,
      updateReport,
      deleteReport,
    }),
    [
      saveQc,
      startQc,
      saveTestCategory,
      setTestCategoryStatus,
      deleteTestCategory,
      addTestParameter,
      updateTestParameter,
      deleteTestParameter,
      generateReport,
      updateReport,
      deleteReport,
    ],
  )
}
