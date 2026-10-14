/**
 * The Extraction stage form (WORKFLOW W8, behind the pipeline flag) — the
 * pressing itself: graded coconut lots in (the Grading form's output, offered
 * as the same Available pool the Classic write path will accept), water /
 * malai / by-products out, and the spoilage the run lost — spoilage is
 * MANDATORY, zero allowed but it must be said.
 *
 * Two writes, both through machinery that already exists: the run posts
 * through the SAME Classic path the old form used (createBatch — checkBatch's
 * own questions answer first, stock moves, one QC record per output), then the
 * close files the spoilage and stamps the server-computed mass balance
 * (POST /api/transformations/close). The close needs the batch's documents
 * version, which the snapshot rides (contracts v1.7): the form waits for the
 * copy that carries it — one revision bump is the commit itself, so the wait
 * is a tick, not a poll — and never guesses a version.
 *
 * A run that is already open (the pipeline Extraction tile links here with
 * ?run=) closes the same way: its inputs and outputs read back read-only,
 * only the spoilage is asked for.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { useToast } from '../context/ToastContext'
import { MassBalanceBar, type TransformationLine } from '../components/shell/TransformationForm'
import { ScanInput } from '../components/shell/ScanInput'
import { SectionedForm } from '../components/shell/SectionedForm'
import { Select } from '../components/Select'
import { WATER_ITEM, bulksFrom, itemUom } from '../lib/batches'
import { checkBatch, describeOutputs, isByProduct, defaultBulkStore } from '../lib/posting'
import type { BatchInput, OutputInput } from '../lib/posting'
import { areaChoices, locationLabel, stockRows } from '../lib/stock'
import { itemName as lookupItemName } from '../lib/stock'
import { PoApiError, postRunClose } from '../lib/extractionApi'
import {
  extractionReasonCodes,
  massBalanceItemsOf,
  openExtractionRuns,
  pressableLots,
  runMassLines,
} from '../lib/extractionStage'
import type { SpoilageInput } from '../lib/contracts'
import { useDraft } from '../lib/useDraft'
import { fmtDate, fmtQty, toLocalInputValue } from '../lib/utils'
import type { Batch } from '../types'

type NumValue = number | ''
const num = (v: NumValue) => Number(v) || 0
const lower = (uom: string) => uom.toLowerCase()

/** One graded lot drawn into the press — the pooled lot picked and how much of it. */
interface LotRow {
  item: string
  lot: string
  qty: NumValue
}
/** One thing the press gave back, before the cost seat is decided. */
interface OutRow {
  item: string
  qty: NumValue
}
/** A loss beyond the spoiled-at-the-press count — malai spilled, line loss. */
interface LossRow {
  qty: NumValue
  uom: string
  reasonCode: string
}

const blankLot: LotRow = { item: '', lot: '', qty: '' }
const blankOut: OutRow = { item: '', qty: '' }
const blankLoss: LossRow = { qty: '', uom: 'Kg', reasonCode: '' }

/** What the form remembers between pressings — the plant's answers rarely change. */
const DRAFT = { location: '', reasonCode: '' }

export function ExtractionTab() {
  const { state, createBatch } = useApp()
  const toast = useToast()
  const [params] = useSearchParams()
  const [date, setDate] = useState(toLocalInputValue())
  const [lotRows, setLotRows] = useState<LotRow[]>([{ ...blankLot }])
  const [outRows, setOutRows] = useState<OutRow[]>([{ ...blankOut }])
  const [mainItem, setMainItem] = useState('')
  const [spoiled, setSpoiled] = useState<NumValue>('')
  const [lossRows, setLossRows] = useState<LossRow[]>([])
  const [formError, setFormError] = useState('')
  const [scanNote, setScanNote] = useState('')
  const [posting, setPosting] = useState(false)
  const [closing, setClosing] = useState(false)
  /** A run this form posted, waiting on the snapshot copy that carries its
   *  version — the close fires the moment it lands. */
  const [pending, setPending] = useState<{ batchId: string } | null>(null)
  /** A run to close straight from the queue (?run= or the select) — '' = new pressing. */
  const [runId, setRunId] = useState(params.get('run') || '')
  /** The cold room and the usual reason — remembered between pressings. */
  const remembered = useDraft('roligt_extraction', DRAFT)
  const reasonCode = remembered.value.reasonCode
  const setReasonCode = (reasonCode: string) => remembered.set({ ...remembered.value, reasonCode })
  const outLocation = remembered.value.location
  const setOutLocation = (location: string) => remembered.set({ ...remembered.value, location })
  /** Each (batch, version) close is attempted once — a re-render must not re-fire it. */
  const attempted = useRef('')

  const lots = useMemo(() => pressableLots(state, stockRows(state)), [state])
  const reasons = useMemo(() => extractionReasonCodes(), [])
  const queue = useMemo(() => openExtractionRuns(state.batches), [state.batches])
  const items = useMemo(() => massBalanceItemsOf(state.items), [state.items])
  // A pipeline tile click lands here with ?run= while the form may already be
  // open on another run — the select follows the address as well as the click.
  const linkedRun = params.get('run')
  useEffect(() => {
    if (linkedRun) setRunId(linkedRun)
  }, [linkedRun])
  const run = runId ? state.batches.find((b) => b.id === runId) : undefined
  const pendingBatch = pending ? state.batches.find((b) => b.id === pending.batchId) : undefined

  /** The bulks a press can book: anything a blend's own recipe does not own. */
  const pressable = useMemo(() => {
    const blended = new Set(state.melanges.map((m) => m.outputItem))
    return state.items.filter((i) => i.type === 'Semi Finished' && !blended.has(i.id))
  }, [state])

  const sourceUom = lotRows.find((r) => r.item)?.item
    ? itemUom(state, lotRows.find((r) => r.item)!.item)
    : 'Piece'

  // —— the lines the live verdict and the close both read ——————————————
  const inputLines: TransformationLine[] = run
    ? runMassLines(run, items).inputs
    : lotRows
        .filter((r) => r.item && r.lot && num(r.qty) > 0)
        .map((r) => ({ item: r.item, qty: num(r.qty), uom: itemUom(state, r.item) }))
  const outputLines: TransformationLine[] = run
    ? runMassLines(run, items).outputs
    : outRows
        .filter((r) => r.item && num(r.qty) > 0)
        .map((r) => ({ item: r.item, qty: num(r.qty), uom: itemUom(state, r.item) }))
  const spoiledQty = run ? run.spoiled || 0 : num(spoiled)
  const spoilageLines: TransformationLine[] = [
    { item: '', qty: spoiledQty, uom: run?.inputUom || sourceUom },
    ...lossRows
      .filter((r) => num(r.qty) > 0)
      .map((r) => ({ item: '', qty: num(r.qty), uom: r.uom })),
  ]

  /** The whole client-side check on the new-pressing path: the write path's
   *  own questions, in its own words (checkBatch runs again server-side). */
  const batchInput = (): BatchInput => ({
    date,
    kind: 'Extraction',
    spoiled: num(spoiled),
    sourceLines: lotRows
      .filter((r) => r.item && r.lot && num(r.qty) > 0)
      .map((r) => ({ item: r.item, lot: r.lot, qty: num(r.qty) })),
    blendLines: [],
    outputs: outRows
      .filter((r) => r.item && num(r.qty) > 0)
      .map((r) => ({ item: r.item, qty: num(r.qty), main: r.item === mainItem }) as OutputInput),
    location: outLocation || defaultBulkStore(state) || undefined,
  })

  const spoilageInput = (): SpoilageInput[] => [
    { stage: 'extraction', qty: spoiledQty, uom: run?.inputUom || sourceUom, reasonCode },
    ...lossRows
      .filter((r) => num(r.qty) > 0 && r.reasonCode)
      .map((r) => ({ stage: 'extraction' as const, qty: num(r.qty), uom: r.uom, reasonCode: r.reasonCode })),
  ]

  // —— the close itself, shared by both paths —————————————————————————
  const close = (batch: Batch) => {
    if (batch.version === undefined) {
      setFormError('This device’s copy of the run is still loading its version — try again in a moment.')
      return false
    }
    const version = batch.version
    const signature = `${batch.id}@${version}`
    if (attempted.current === signature) return true
    attempted.current = signature
    setClosing(true)
    setFormError('')
    void (async () => {
      try {
        const out = await postRunClose({
          batchId: batch.id,
          expectedVersion: version,
          spoilage: spoilageInput(),
        })
        toast(
          `${batch.id} closed — variance ${out.massBalance.variancePct.toFixed(2)}%, ${out.spoilage.length} spoilage record${out.spoilage.length === 1 ? '' : 's'} filed.`,
        )
        if (pending) {
          // this form's own posting just finished its lifecycle — the next
          // pressing starts from a blank form (the date and the remembered
          // cold room and reason stay)
          setLotRows([{ ...blankLot }])
          setOutRows([{ ...blankOut }])
          setMainItem('')
          setSpoiled('')
          setLossRows([])
        }
      } catch (e) {
        if (e instanceof PoApiError && e.code === 'cas_version') {
          setFormError(`${batch.id} changed after this form read it — the fresh copy is arriving; close it again in a moment.`)
          attempted.current = '' // the re-read version may try once more
        } else {
          setFormError(e instanceof Error ? e.message : 'The close could not be posted.')
        }
      } finally {
        setClosing(false)
        setPending(null)
        setRunId('')
      }
    })()
    return true
  }

  // The posted run's version rides the NEXT snapshot (v1.7) — the commit's own
  // revision bump is what wakes the feed, so this is a tick, not a poll. Until
  // then the button says it is waiting; the form never guesses version 1.
  useEffect(() => {
    if (pending && pendingBatch && pendingBatch.version !== undefined && !closing) close(pendingBatch)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, pendingBatch, closing])

  const submit = () => {
    setFormError('')
    setScanNote('')
    if (!reasonCode) {
      setFormError('Say why the press lost what it lost — pick a reason, even for zero.')
      return
    }
    const problem = checkBatch(state, batchInput())
    if (problem) {
      setFormError(problem)
      return
    }
    setPosting(true)
    const id = createBatch(batchInput())
    setPosting(false)
    if (!id) return // createBatch already said why, in its own words
    setPending({ batchId: id })
  }

  // —— row editors ——————————————————————————————————————————————
  const setLot = (i: number, patch: Partial<LotRow>) =>
    setLotRows((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const setOut = (i: number, patch: Partial<OutRow>) =>
    setOutRows((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const setLoss = (i: number, patch: Partial<LossRow>) =>
    setLossRows((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  /** Picking a lot prefills what this press makes (once, on a blank form):
   *  the bulks mastered as coming off that raw material — water main, malai
   *  beside it — so the operator confirms numbers instead of naming items. */
  const pickLot = (i: number, item: string, lot: string) => {
    setLot(i, { item, lot })
    const untouched = outRows.length === 1 && !outRows[0].item
    if (untouched && item) {
      const made = bulksFrom(state, item)
      if (made.length) {
        setOutRows(made.map((m) => ({ item: m.id, qty: '' as NumValue })))
        setMainItem(made.find((m) => m.id === WATER_ITEM)?.id || made[0].id)
      }
    }
  }

  const scanLot = (code: string) => {
    setScanNote('')
    const wanted = code.trim().toLowerCase()
    const found = lots.find((l) => l.lot.toLowerCase() === wanted)
    if (!found) {
      setScanNote(lots.length ? `No graded lot reads ${code}.` : `Nothing graded is waiting — ${code} included.`)
      return
    }
    const open = lotRows.findIndex((r) => !r.item)
    if (open >= 0) pickLot(open, found.item, found.lot)
    else setLotRows((rows) => [...rows, { item: found.item, lot: found.lot, qty: '' }])
  }

  const lotValue = (r: LotRow) => (r.item && r.lot ? `${r.item}|${r.lot}` : '')
  const onLotValue = (i: number, value: string) => {
    const found = lots.find((l) => `${l.item}|${l.lot}` === value)
    if (found) pickLot(i, found.item, found.lot)
    else setLot(i, { item: '', lot: '', qty: '' })
  }

  const busy = posting || closing || !!pending

  return (
    <div>
      <div className="section-head" style={{ marginBottom: 12 }}>
        <div>
          <h2>Run a pressing</h2>
          <span className="cell-sub">
            Graded lots in, water and malai out — the spoilage said out loud, the balance judged
            live, the close filed server-side
          </span>
        </div>
      </div>

      <SectionedForm
        sections={[
          {
            id: 'mode',
            title: run ? `Close ${run.id}` : 'A new pressing',
            hint: run ? `Posted ${fmtDate(run.date)} · ${run.status}` : queue.length ? `${queue.length} open run${queue.length === 1 ? '' : 's'} can also be closed here` : undefined,
            children: (
              <div className="form-grid">
                <label className="span-2">
                  Or close a run that is already open
                  <Select value={runId} onChange={(e) => { setRunId(e.target.value); setFormError('') }}>
                    <option value="">Post a new pressing now</option>
                    {queue.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.id} · {describeOutputs(state, b.outputLines ?? []) || 'posted'} · {fmtDate(b.date)} · {b.status}
                      </option>
                    ))}
                  </Select>
                </label>
              </div>
            ),
          },
          ...(run
            ? [
                {
                  id: 'run-readback',
                  title: `What ${run.id} took and made`,
                  hint: 'Read back from the run — only the spoilage below is asked for',
                  children: (
                    <MassBalanceBar inputs={inputLines} outputs={outputLines} spoilage={spoilageLines} items={items} />
                  ),
                },
              ]
            : [
                {
                  id: 'inputs',
                  title: 'Graded lots pressed',
                  hint: 'Available raw material, pooled by lot — the same pool the post accepts',
                  children: (
                    <div>
                      {lotRows.map((r, i) => (
                        <div className="form-grid" key={i}>
                          <label className="span-2">
                            Lot
                            <Select value={lotValue(r)} onChange={(e) => onLotValue(i, e.target.value)}>
                              <option value="">Select a graded lot</option>
                              {lots.map((l) => (
                                <option key={`${l.item}|${l.lot}`} value={`${l.item}|${l.lot}`}>
                                  {l.lot} · {lookupItemName(state, l.item)} · {fmtQty(l.qty)} {lower(l.uom)} on hand
                                </option>
                              ))}
                            </Select>
                          </label>
                          <label>
                            Quantity ({lower(itemUom(state, r.item))})
                            <input
                              type="number"
                              min="0"
                              step="any"
                              placeholder="0"
                              value={r.qty}
                              onChange={(e) => setLot(i, { qty: e.target.value === '' ? '' : Number(e.target.value) })}
                            />
                          </label>
                          {lotRows.length > 1 ? (
                            <div className="field" style={{ alignSelf: 'end' }}>
                              <button type="button" className="btn btn-light" onClick={() => setLotRows((rows) => rows.filter((_, j) => j !== i))}>
                                Remove
                              </button>
                            </div>
                          ) : null}
                        </div>
                      ))}
                      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                        <button type="button" className="btn btn-light" onClick={() => setLotRows((rows) => [...rows, { ...blankLot }])}>
                          Add another lot
                        </button>
                        <div style={{ maxWidth: 320 }}>
                          <ScanInput label="Lot number" onScan={scanLot} placeholder="Scan or type a lot number" />
                        </div>
                      </div>
                      {scanNote ? <p className="cell-sub">{scanNote}</p> : null}
                    </div>
                  ),
                },
                {
                  id: 'outputs',
                  title: 'What the press gave',
                  hint: 'Prefilled off the lot — confirm the numbers',
                  children: (
                    <div>
                      {outRows.map((r, i) => (
                        <div className="form-grid" key={i}>
                          <label className="span-2">
                            Bulk
                            <Select value={r.item} onChange={(e) => setOut(i, { item: e.target.value })}>
                              <option value="">Select a bulk</option>
                              {pressable.map((b) => (
                                <option key={b.id} value={b.id}>
                                  {b.name} · {lower(b.uom)}
                                  {isByProduct(b) ? ' · by-product' : ''}
                                </option>
                              ))}
                            </Select>
                          </label>
                          <label>
                            Quantity ({lower(itemUom(state, r.item))})
                            <input
                              type="number"
                              min="0"
                              step="any"
                              placeholder="0"
                              value={r.qty}
                              onChange={(e) => setOut(i, { qty: e.target.value === '' ? '' : Number(e.target.value) })}
                            />
                          </label>
                          {outRows.length > 1 ? (
                            <div className="field" style={{ alignSelf: 'end' }}>
                              <button type="button" className="btn btn-light" onClick={() => setOutRows((rows) => rows.filter((_, j) => j !== i))}>
                                Remove
                              </button>
                            </div>
                          ) : null}
                        </div>
                      ))}
                      <div className="form-grid" style={{ marginTop: 8 }}>
                        <button type="button" className="btn btn-light" onClick={() => setOutRows((rows) => [...rows, { ...blankOut }])}>
                          Add another output
                        </button>
                        <label>
                          The cost sits on
                          <Select value={mainItem} onChange={(e) => setMainItem(e.target.value)}>
                            <option value="">Which output carries the cost</option>
                            {outRows.filter((r) => r.item).map((r) => (
                              <option key={r.item} value={r.item}>
                                {lookupItemName(state, r.item)}
                              </option>
                            ))}
                          </Select>
                        </label>
                        <label>
                          Put away in
                          <Select value={outLocation} onChange={(e) => setOutLocation(e.target.value)}>
                            <option value="">{defaultBulkStore(state) ? `${locationLabel(state, defaultBulkStore(state)!)} (default)` : 'Select a cold room'}</option>
                            {areaChoices(state, 'Semi Finished', 'Quarantine', outLocation).map((c) => (
                              <option key={c.area.id} value={c.value}>
                                {c.text}
                              </option>
                            ))}
                          </Select>
                        </label>
                        <label>
                          Pressed on
                          <input type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} />
                        </label>
                      </div>
                    </div>
                  ),
                },
              ]),
          {
            id: 'spoilage',
            title: 'Spoilage — said out loud',
            hint: 'Mandatory: zero is fine, silence is not',
            children: (
              <div>
                <div className="form-grid">
                  <label>
                    Spoiled at the press ({lower(run?.inputUom || sourceUom)})
                    <input
                      type="number"
                      min="0"
                      step="any"
                      placeholder={run ? String(run.spoiled || 0) : '0'}
                      disabled={!!run}
                      value={run ? run.spoiled || 0 : spoiled}
                      onChange={(e) => setSpoiled(e.target.value === '' ? '' : Number(e.target.value))}
                    />
                  </label>
                  <label>
                    Reason
                    <Select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
                      <option value="">Pick the reason</option>
                      {reasons.map((r) => (
                        <option key={r.code} value={r.code}>
                          {r.label}
                        </option>
                      ))}
                    </Select>
                  </label>
                </div>
                {lossRows.map((r, i) => (
                  <div className="form-grid" key={i} style={{ marginTop: 8 }}>
                    <label>
                      Other loss — quantity
                      <input
                        type="number"
                        min="0"
                        step="any"
                        placeholder="0"
                        value={r.qty}
                        onChange={(e) => setLoss(i, { qty: e.target.value === '' ? '' : Number(e.target.value) })}
                      />
                    </label>
                    <label>
                      Unit
                      <Select value={r.uom} onChange={(e) => setLoss(i, { uom: e.target.value })}>
                        <option>Kg</option>
                        <option>Litre</option>
                      </Select>
                    </label>
                    <label>
                      Reason
                      <Select value={r.reasonCode} onChange={(e) => setLoss(i, { reasonCode: e.target.value })}>
                        <option value="">Pick the reason</option>
                        {reasons.map((x) => (
                          <option key={x.code} value={x.code}>
                            {x.label}
                          </option>
                        ))}
                      </Select>
                    </label>
                    <div className="field" style={{ alignSelf: 'end' }}>
                      <button type="button" className="btn btn-light" onClick={() => setLossRows((rows) => rows.filter((_, j) => j !== i))}>
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
                {!lossRows.length ? (
                  <button type="button" className="btn btn-light" style={{ marginTop: 8 }} onClick={() => setLossRows((rows) => [...rows, { ...blankLoss }])}>
                    Add a loss line (spillage, line loss…)
                  </button>
                ) : null}
              </div>
            ),
          },
          {
            id: 'balance',
            title: 'The balance, live',
            hint: 'The same fold the close gate enforces — the server recomputes it',
            children: (
              <MassBalanceBar inputs={inputLines} outputs={outputLines} spoilage={spoilageLines} items={items} />
            ),
          },
        ]}
        footer={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {run ? (
              <button type="button" className="btn-primary" disabled={busy} onClick={() => close(run)}>
                {closing ? 'Closing…' : `Close ${run.id}`}
              </button>
            ) : (
              <button type="button" className="btn-primary" disabled={busy} onClick={submit}>
                {posting ? 'Posting…' : pending ? 'Waiting for the server’s copy…' : 'Post pressing & close'}
              </button>
            )}
            {pending && !closing ? (
              <button type="button" className="btn btn-light" onClick={() => setPending(null)}>
                Leave it open
              </button>
            ) : null}
            {formError ? <span className="form-error">{formError}</span> : null}
          </div>
        }
      />
    </div>
  )
}

