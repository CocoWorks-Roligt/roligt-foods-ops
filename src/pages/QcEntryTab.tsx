/**
 * The QC test-entry stage form (WORKFLOW W11, behind the pipeline flag) — the
 * bench half of the §3.3-7 hard gate. One queue of records still without a
 * verdict, one card per test the record is judged on, and a live preview of
 * what the save will decide — computed by the same qcDecision the save runs,
 * so the form cannot promise a disposition the write path would not stamp.
 *
 * The write is saveQc — the SAME Classic path the register's Review dialog
 * posts through. It decides the disposition from the results themselves,
 * moves the stock (released and rejected in place, anything else back to
 * awaiting QC) and rolls the batch up; its hold-area refusal is its own toast,
 * and a null return leaves this form open with its words already on screen.
 * Lab reports and evaluations are attached from the register's Review — this
 * form is results entry.
 */
import { useMemo, useState } from 'react'
import { useApp } from '../context/AppContext'
import { SectionedForm } from '../components/shell/SectionedForm'
import { ScanInput } from '../components/shell/ScanInput'
import { Select } from '../components/Select'
import { StatusBadge } from '../components/StatusBadge'
import { runBulkItem } from '../lib/batches'
import { categoryTitle, qcDecision, qcTest, testsShownFor } from '../lib/qcCategories'
import { pendingQc } from '../lib/qcStage'
import { itemName } from '../lib/stock'
import { productionDates, productionDateRows } from '../lib/productionDates'
import { fmtDate, statusLabel, toDateKey } from '../lib/utils'
import type { QcTestResult } from '../types'

const OPTS = ['Pending', 'Pass', 'Fail', 'Retest'] as const

/** Days a verdict has waited — the same day-diff the pipeline tile ages by. */
const waitingDays = (date: string | undefined) =>
  date ? Math.max(0, Math.round((Date.parse(toDateKey()) - Date.parse(date)) / 86400000)) : 0

export function QcEntryTab() {
  const { state, saveQc } = useApp()
  const [picked, setPicked] = useState('')
  const [scanNote, setScanNote] = useState('')
  const [tests, setTests] = useState<Record<string, QcTestResult> | null>(null)

  const queue = useMemo(() => pendingQc(state), [state])
  // Still only a waiting record: the save itself stamps the disposition, so a
  // record decided a moment ago folds out of the queue on the spot.
  const active = queue.find((e) => e.q.id === picked)?.q
  const product = active ? itemName(state, active.item || '') : ''

  const pick = (id: string) => {
    const q = state.qcs.find((x) => x.id === id)
    setPicked(id)
    setScanNote('')
    // Seeded exactly as the register's Review dialog seeds itself — the
    // record's own results, on the tests it is judged on today.
    setTests(q ? Object.fromEntries(testsShownFor(state, q).map((c) => [c.key, qcTest(q, c.key)])) : null)
  }

  const setTest = (key: string, patch: Partial<QcTestResult>) =>
    setTests((f) => (f ? { ...f, [key]: { ...(f[key] || { status: 'Pending' }), ...patch } } : f))

  const scanRecord = (code: string) => {
    setScanNote('')
    const wanted = code.trim().toLowerCase()
    const found = queue.find(
      (e) => e.q.id.toLowerCase() === wanted || e.q.batchId.toLowerCase() === wanted,
    )
    if (!found) {
      setScanNote(
        queue.length
          ? `No waiting record reads ${code}.`
          : `Nothing is waiting a verdict — ${code} included.`,
      )
      return
    }
    // A batch with two products waiting has two records; the scan takes the
    // first and says so, so the sibling is not quietly forgotten.
    const siblings = queue.filter((e) => e.q.batchId === found.q.batchId).length
    if (siblings > 1) setScanNote(`This batch has ${siblings} records waiting — the other stays in the queue.`)
    pick(found.q.id)
  }

  /** What this save will decide — the same pure fold the save itself runs. */
  const decision = active && tests ? qcDecision(state, active, tests) : null
  const outstanding = decision
    ? decision.required.filter((k) => qcTest(decision.record, k).status !== 'Pass')
    : []
  const hasPacks = active
    ? state.packingRuns.some((r) => r.batchId === active.batchId && runBulkItem(r) === active.item)
    : false

  const submit = () => {
    if (!active || !tests) return
    // saveQc decides the disposition from these results, moves the stock and
    // toasts; on its hold-area refusal it returns null and the form stays put.
    const saved = saveQc(active.id, { tests })
    if (!saved) return
    // The queue re-folds without the decided record — offer the next oldest.
    const next = queue.find((e) => e.q.id !== active.id)
    pick(next ? next.q.id : '')
  }

  const entry = queue.find((e) => e.q.id === picked)
  const batchDate = entry?.batch?.date
  const waited = waitingDays(batchDate)

  return (
    <div>
      <div className="section-head" style={{ marginBottom: 12 }}>
        <div>
          <h2>Enter test results</h2>
          <span className="cell-sub">
            The bench queue — products still waiting a verdict, oldest first. Results in, the
            disposition comes out: nothing is released by hand.
          </span>
        </div>
      </div>

      <SectionedForm
        sections={[
          {
            id: 'queue',
            title: 'Waiting for a verdict',
            hint: queue.length ? `${queue.length} record${queue.length === 1 ? '' : 's'} pending` : undefined,
            children: (
              <div>
                {queue.length ? (
                  <>
                    <div className="form-grid">
                      <label className="span-2">
                        Record
                        <Select value={picked} onChange={(e) => pick(e.target.value)}>
                          <option value="">Select a record to test</option>
                          {queue.map((e) => (
                            <option key={e.q.id} value={e.q.id}>
                              {itemName(state, e.q.item || '') || e.q.batchId} · {e.q.batchId} ·{' '}
                              made {e.batch ? fmtDate(e.batch.date) : '—'} · {e.q.id}
                            </option>
                          ))}
                        </Select>
                      </label>
                    </div>
                    <div style={{ marginTop: 8, maxWidth: 360 }}>
                      <ScanInput
                        label="Batch or QC record"
                        onScan={scanRecord}
                        placeholder="Scan or type a batch id"
                      />
                    </div>
                  </>
                ) : (
                  <p className="cell-sub">
                    Nothing is waiting. A record appears here the moment its batch is posted — one
                    per product the batch made. A batch too old to have per-product records gets
                    them raised from the register.
                  </p>
                )}
                {scanNote ? <p className="cell-sub">{scanNote}</p> : null}
              </div>
            ),
          },
          ...(active && tests && decision
            ? [
                {
                  id: 'results',
                  title: `${product} · ${active.batchId}`,
                  hint: `${
                    entry?.batch ? `made ${fmtDate(entry.batch.date)}` : 'batch date unknown'
                  }${waited ? ` · waiting ${waited} day${waited === 1 ? '' : 's'}` : ''}`,
                  children: (
                    <div>
                      <p className="cell-sub" style={{ marginTop: 0 }}>
                        {productionDateRows(productionDates(state, active.batchId, active.item))
                          .map(([label, value]) => `${label}: ${value}`)
                          .join(' · ')}
                      </p>
                      <div className="qc-review-grid">
                        {testsShownFor(state, active).map((cat) => {
                          const result = tests[cat.key] || qcTest(active, cat.key)
                          const needed = decision.required.includes(cat.key)
                          return (
                            <article className="qc-review-card" key={cat.key}>
                              <div className="qc-review-head">
                                <h4>{cat.title}</h4>
                                <StatusBadge value={result.status} />
                              </div>
                              <div className="small">
                                {needed ? 'Needed to release this product' : 'Not needed to release this record'}
                              </div>
                              <label>Status</label>
                              <Select
                                value={result.status}
                                onChange={(e) => setTest(cat.key, { status: e.target.value })}
                              >
                                {OPTS.map((o) => (
                                  <option key={o} value={o}>
                                    {statusLabel(o)}
                                  </option>
                                ))}
                              </Select>
                              <label style={{ marginTop: 10 }}>Report note</label>
                              <textarea
                                placeholder={cat.hint}
                                value={result.note || ''}
                                onChange={(e) => setTest(cat.key, { note: e.target.value })}
                              />
                            </article>
                          )
                        })}
                      </div>
                    </div>
                  ),
                },
              ]
            : []),
        ]}
        footer={
          active && decision ? (
            <div>
              <div className="note">
                <b>Apply</b> marks <b>{product}</b> <b>{statusLabel(decision.disposition)}</b>.{' '}
                {decision.disposition === 'Released'
                  ? 'Every test needed to release it reads Pass.'
                  : outstanding.length
                    ? `Still not a Pass: ${outstanding.map((k) => categoryTitle(state, k)).join(', ')}.`
                    : decision.disposition === 'Rejected'
                      ? 'A Fail on any test rejects it.'
                      : 'A Retest puts it on hold.'}{' '}
                {hasPacks
                  ? 'Packs filled from this bulk are already in the cold room — releasing them clears them for dispatch where they stand, and rejecting them leaves them there flagged.'
                  : 'None of this bulk has been packed yet, so releasing it clears it for blending and packing.'}{' '}
                It decides nothing about anything else the batch made. Attach the lab reports on the
                register&rsquo;s Review.
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
                <button type="button" className="btn-primary" onClick={submit}>
                  {decision.disposition === 'Released'
                    ? `Release ${product}`
                    : decision.disposition === 'Rejected'
                      ? `Reject ${product}`
                      : `Save results for ${product}`}
                </button>
              </div>
            </div>
          ) : undefined
        }
      />
    </div>
  )
}
