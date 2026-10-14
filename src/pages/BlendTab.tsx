/**
 * The Blend stage form (WORKFLOW W9, behind the pipeline flag) — the
 * intermediate run: a recipe's components drawn from bulk lots into one blend
 * lot, then closed with the mandatory blend-stage spoilage. A coconut-milk run
 * is one of these — the recipe whose output is the milk bulk — and every run
 * posts as kind 'Melange', so it lands in the pipeline Blending queue where it
 * belongs (STATE W9: the milk form is a blend form offering the milk recipe,
 * not a new stage).
 *
 * Two writes, both through machinery that already exists: the run posts
 * through the SAME Classic path the old form used (createBatch — checkBatch's
 * own questions answer first, stock moves, one QC record), then the close
 * files the spoilage and stamps the server-computed mass balance
 * (POST /api/transformations/close via runCloseApi). The close needs the
 * batch's documents version, which the snapshot rides (contracts v1.7): the
 * form waits for the copy that carries it — one revision bump is the commit
 * itself, so the wait is a tick, not a poll — and never guesses a version.
 *
 * A run that is already open (the pipeline Blending tile links here with
 * ?run=) closes the same way: its draws read back read-only, only the
 * spoilage is asked for.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { useToast } from '../context/ToastContext'
import { MassBalanceBar, type TransformationLine } from '../components/shell/TransformationForm'
import { ScanInput } from '../components/shell/ScanInput'
import { SectionedForm } from '../components/shell/SectionedForm'
import { Select } from '../components/Select'
import { batchLabel, blendComponentItems, itemUom, mainOutput } from '../lib/batches'
import { checkBatch, defaultBulkStore, describeOutputs } from '../lib/posting'
import type { BatchInput } from '../lib/posting'
import { areaChoices, locationLabel, stockRows, sumByUom } from '../lib/stock'
import { itemName as lookupItemName } from '../lib/stock'
import { PoApiError, postRunClose } from '../lib/runCloseApi'
import {
  massBalanceItemsOf, // generic run folds W8 introduced — one implementation, shared
  runMassLines,
} from '../lib/extractionStage'
import { activeRecipes, blendReasonCodes, blendableLots, openBlendRuns } from '../lib/blendStage'
import type { SpoilageInput } from '../lib/contracts'
import { useDraft } from '../lib/useDraft'
import { fmtDate, fmtQty, toLocalInputValue } from '../lib/utils'
import type { Batch } from '../types'

type NumValue = number | ''
const num = (v: NumValue) => Number(v) || 0
const lower = (uom: string) => uom.toLowerCase()

/** One component drawn: the bulk, out of which lot, and how much. */
interface DrawRow {
  item: string
  lot: string
  qty: NumValue
}
/** A loss beyond the blend's own gap — a burst pouch, a spill on the floor. */
interface LossRow {
  qty: NumValue
  uom: string
  reasonCode: string
}

const blankDraw: DrawRow = { item: '', lot: '', qty: '' }
const blankLoss: LossRow = { qty: '', uom: 'Kg', reasonCode: '' }

/** What the form remembers between runs — the plant's answers rarely change. */
const DRAFT = { location: '', reasonCode: '' }

export function BlendTab() {
  const { state, createBatch } = useApp()
  const toast = useToast()
  const [params] = useSearchParams()
  const [date, setDate] = useState(toLocalInputValue())
  const [melangeId, setMelangeId] = useState('')
  const [draws, setDraws] = useState<DrawRow[]>([{ ...blankDraw }])
  const [outQty, setOutQty] = useState<NumValue>('')
  const [spoiled, setSpoiled] = useState<NumValue>('')
  const [lossRows, setLossRows] = useState<LossRow[]>([])
  const [formError, setFormError] = useState('')
  const [scanNote, setScanNote] = useState('')
  const [posting, setPosting] = useState(false)
  const [closing, setClosing] = useState(false)
  /** A run this form posted, waiting on the snapshot copy that carries its
   *  version — the close fires the moment it lands. */
  const [pending, setPending] = useState<{ batchId: string } | null>(null)
  /** A run to close straight from the queue (?run= or the select) — '' = new run. */
  const [runId, setRunId] = useState(params.get('run') || '')
  /** The cold room and the usual reason — remembered between runs. */
  const remembered = useDraft('roligt_blend', DRAFT)
  const reasonCode = remembered.value.reasonCode
  const setReasonCode = (reasonCode: string) => remembered.set({ ...remembered.value, reasonCode })
  const outLocation = remembered.value.location
  const setOutLocation = (location: string) => remembered.set({ ...remembered.value, location })
  /** Each (batch, version) close is attempted once — a re-render must not re-fire it. */
  const attempted = useRef('')

  const lots = useMemo(() => blendableLots(state, stockRows(state)), [state])
  const reasons = useMemo(() => blendReasonCodes(), [])
  const queue = useMemo(() => openBlendRuns(state.batches), [state.batches])
  const items = useMemo(() => massBalanceItemsOf(state.items), [state.items])
  const recipes = useMemo(() => activeRecipes(state.melanges), [state.melanges])
  const selected = state.melanges.find((m) => m.id === melangeId)
  // A pipeline tile click lands here with ?run= while the form may already be
  // open on another run — the select follows the address as well as the click.
  const linkedRun = params.get('run')
  useEffect(() => {
    if (linkedRun) setRunId(linkedRun)
  }, [linkedRun])
  const run = runId ? state.batches.find((b) => b.id === runId) : undefined
  const pendingBatch = pending ? state.batches.find((b) => b.id === pending.batchId) : undefined
  const runRecipe = run ? state.melanges.find((m) => m.id === run.melangeId) : undefined
  /** The unit the blend itself is measured in — the recipe's own. */
  const blendUom = (run ? runRecipe?.uom : selected?.uom) || 'Litre'

  /** Components a run can draw beyond the recipe's rows: any blend component
   *  that is not the blend it makes (checkBatch refuses a run drinking itself). */
  const components = useMemo(() => {
    const out = selected?.outputItem
    return blendComponentItems(state).filter((i) => i.id !== out)
  }, [selected, state])

  const drawnTotal = draws.reduce((a, d) => a + num(d.qty), 0)
  const outTotal = run ? mainOutput(run)?.qty ?? 0 : num(outQty)
  // Components may be counted in more than one unit (water by the litre, malai
  // by the kilo), so the drawn total is held apart by unit and the gap is
  // figured only against the blend's own: a kilo line is an input, not a litre
  // lost. Same fold the Classic form runs.
  const drawnInBlendUom = sumByUom(
    (run ? runMassLines(run, items).inputs : draws.filter((d) => d.item && num(d.qty) > 0).map((d) => ({ qty: num(d.qty), uom: itemUom(state, d.item) }))),
  ).get(blendUom) || 0
  const loss = drawnInBlendUom - outTotal

  /** Components more than two points off the share the recipe names — the
   *  Classic form's own fold, kept so the stage form says what it would say. */
  const offRecipe = !selected || drawnTotal <= 0
    ? []
    : selected.components
        .map((c) => {
          const drawn = draws.filter((d) => d.item === c.item).reduce((a, d) => a + num(d.qty), 0)
          return { item: c.item, target: c.share, actual: (drawn / drawnTotal) * 100 }
        })
        .filter((o) => Math.abs(o.actual - o.target) > 2)

  // —— the lines the live verdict and the close both read ——————————————
  const inputLines: TransformationLine[] = run
    ? runMassLines(run, items).inputs
    : draws
        .filter((d) => d.item && num(d.qty) > 0)
        .map((d) => ({ item: d.item, qty: num(d.qty), uom: itemUom(state, d.item) }))
  const outputLines: TransformationLine[] = run
    ? runMassLines(run, items).outputs
    : selected && outTotal > 0
      ? [{ item: selected.outputItem, qty: outTotal, uom: blendUom }]
      : []
  // A blend's close spoilage is asked fresh in both modes — the batch itself
  // books zero (the Classic contract); the close's records are the durable word.
  const spoiledQty = num(spoiled)
  const spoilageLines: TransformationLine[] = [
    { item: '', qty: spoiledQty, uom: blendUom },
    ...lossRows
      .filter((r) => num(r.qty) > 0)
      .map((r) => ({ item: '', qty: num(r.qty), uom: r.uom })),
  ]

  /** The whole client-side check on the new-run path: the Classic form's own
   *  questions first, then the write path's own words (checkBatch runs again
   *  server-side). */
  const batchInput = (): BatchInput => ({
    date,
    kind: 'Melange' as const,
    melangeId: selected!.id,
    // The Classic form posts zero here: a blend's loss is implied in the
    // balance and said out loud in the close's spoilage records, which are
    // mandatory there — this form asks for them below.
    spoiled: 0,
    sourceLines: [],
    blendLines: draws
      .filter((d) => d.item && d.lot && num(d.qty) > 0)
      .map((d) => ({ item: d.item, lot: d.lot, qty: num(d.qty) })),
    location: outLocation || defaultBulkStore(state) || undefined,
    outputs: [{ item: selected!.outputItem, qty: outTotal, main: true }],
  })

  const spoilageInput = (): SpoilageInput[] => [
    { stage: 'blend', qty: spoiledQty, uom: blendUom, reasonCode },
    ...lossRows
      .filter((r) => num(r.qty) > 0 && r.reasonCode)
      .map((r) => ({ stage: 'blend' as const, qty: num(r.qty), uom: r.uom, reasonCode: r.reasonCode })),
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
          // this form's own posting just finished its lifecycle — the next run
          // starts from a blank form (the date and the remembered cold room
          // and reason stay)
          setMelangeId('')
          setDraws([{ ...blankDraw }])
          setOutQty('')
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

  /** Picking a recipe lays out one draw row per component, in the recipe's
   *  order — the Classic form's own behavior. */
  const pickRecipe = (id: string) => {
    setMelangeId(id)
    const m = state.melanges.find((x) => x.id === id)
    setDraws(m ? m.components.map((c) => ({ item: c.item, lot: '', qty: '' as NumValue })) : [])
    setOutQty('')
  }

  const submit = () => {
    setFormError('')
    setScanNote('')
    if (!selected) {
      setFormError('Pick the recipe this run follows.')
      return
    }
    if (!(outTotal > 0)) {
      setFormError('Enter how much blend came out of the run.')
      return
    }
    if (!reasonCode) {
      setFormError('Say why the run lost what it lost — pick a reason, even for zero.')
      return
    }
    // A draw missing its lot or its quantity used to be filtered out of
    // blendLines silently — the run then consumed less stock than the screen
    // showed. Refuse with the reason instead; a bulk with nothing left to
    // draw gets its own words. (The Classic form's own checks, verbatim.)
    const noStock = draws.find(
      (d) => d.item && num(d.qty) > 0 && !d.lot && !lots.some((l) => l.item === d.item),
    )
    if (noStock) {
      setFormError(`No lot of ${lookupItemName(state, noStock.item)} is available to draw — its stock may already be fully used.`)
      return
    }
    const incomplete = draws.filter(
      (d) => (d.item || d.lot || num(d.qty) > 0) && !(d.item && d.lot && num(d.qty) > 0),
    )
    if (incomplete.length) {
      setFormError(
        incomplete.length === 1
          ? 'One component drawn is incomplete — give it a bulk, a batch lot and a quantity, or remove it.'
          : `${incomplete.length} components drawn are incomplete — each needs a bulk, a batch lot and a quantity.`,
      )
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
  const setDraw = (i: number, patch: Partial<DrawRow>) =>
    setDraws((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const setLoss = (i: number, patch: Partial<LossRow>) =>
    setLossRows((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  /** The lots one row can draw: the component's own lots, on hand and drawable. */
  const lotsFor = (item: string) => lots.filter((l) => l.item === item)

  const scanLot = (code: string) => {
    setScanNote('')
    const wanted = code.trim().toLowerCase()
    const found = lots.find((l) => l.lot.toLowerCase() === wanted)
    if (!found) {
      setScanNote(lots.length ? `No drawable lot reads ${code}.` : `Nothing drawable is on hand — ${code} included.`)
      return
    }
    // a recipe row of the same component with no lot yet takes it first
    const openRow = draws.findIndex((d) => d.item === found.item && !d.lot)
    if (openRow >= 0) setDraw(openRow, { lot: found.lot })
    else {
      const blank = draws.findIndex((d) => !d.item && !d.lot)
      if (blank >= 0) setDraw(blank, { item: found.item, lot: found.lot })
      else setDraws((rows) => [...rows, { item: found.item, lot: found.lot, qty: '' }])
    }
  }

  const busy = posting || closing || !!pending

  return (
    <div>
      <div className="section-head" style={{ marginBottom: 12 }}>
        <div>
          <h2>Run a blend</h2>
          <span className="cell-sub">
            Recipe components in — malai, water, milk, what the recipe names — one blend lot out,
            the spoilage said out loud, the close filed server-side
          </span>
        </div>
      </div>

      <SectionedForm
        sections={[
          {
            id: 'mode',
            title: run ? `Close ${run.id}` : 'A new run',
            hint: run
              ? `Posted ${fmtDate(run.date)} · ${run.status}`
              : queue.length
                ? `${queue.length} open run${queue.length === 1 ? '' : 's'} can also be closed here`
                : undefined,
            children: (
              <div className="form-grid">
                <label className="span-2">
                  Or close a run that is already open
                  <Select value={runId} onChange={(e) => { setRunId(e.target.value); setFormError('') }}>
                    <option value="">Post a new run now</option>
                    {queue.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.id} · {batchLabel(state, b)} · {describeOutputs(state, b.outputLines ?? []) || 'posted'} · {fmtDate(b.date)} · {b.status}
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
                  id: 'recipe',
                  title: 'The recipe this run follows',
                  hint: recipes.length ? 'Its components are laid out below, in its order' : undefined,
                  children: (
                    <div className="form-grid">
                      <label className="span-2">
                        Blend recipe
                        <Select value={melangeId} onChange={(e) => pickRecipe(e.target.value)}>
                          <option value="">{recipes.length ? 'Select a recipe' : 'No active recipe — create one on the Blend tab first'}</option>
                          {recipes.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name} · {m.components.map((c) => `${c.share}%`).join(' / ')}
                            </option>
                          ))}
                        </Select>
                      </label>
                      {selected ? (
                        <span className="cell-sub" style={{ alignSelf: 'end' }}>
                          Makes <b>{lookupItemName(state, selected.outputItem)}</b> — downstream runs
                          consume the blend, never its components
                        </span>
                      ) : null}
                    </div>
                  ),
                },
                {
                  id: 'draws',
                  title: 'Components drawn',
                  hint: 'Bulk and bought-ready stock, pooled by lot — the same pool the post accepts',
                  children: (
                    <div>
                      {draws.map((r, i) => {
                        const rowLots = lotsFor(r.item)
                        return (
                          <div className="form-grid" key={i}>
                            <label>
                              Component
                              <Select
                                value={r.item}
                                onChange={(e) => setDraw(i, { item: e.target.value, lot: '' })}
                              >
                                <option value="">Select a component</option>
                                {components.map((c) => (
                                  <option key={c.id} value={c.id}>
                                    {c.name} · {lower(c.uom)}
                                  </option>
                                ))}
                              </Select>
                            </label>
                            <label>
                              Lot
                              <Select value={r.lot} onChange={(e) => setDraw(i, { lot: e.target.value })}>
                                <option value="">{r.item ? (rowLots.length ? 'Select a lot' : 'No drawable lot on hand') : 'Pick a component first'}</option>
                                {rowLots.map((l) => (
                                  <option key={l.lot} value={l.lot}>
                                    {l.lot} · {fmtQty(l.qty)} {lower(l.uom)} on hand
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
                                onChange={(e) => setDraw(i, { qty: e.target.value === '' ? '' : Number(e.target.value) })}
                              />
                            </label>
                            {draws.length > 1 ? (
                              <div className="field" style={{ alignSelf: 'end' }}>
                                <button type="button" className="btn btn-light" onClick={() => setDraws((rows) => rows.filter((_, j) => j !== i))}>
                                  Remove
                                </button>
                              </div>
                            ) : null}
                          </div>
                        )
                      })}
                      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                        <button type="button" className="btn btn-light" onClick={() => setDraws((rows) => [...rows, { ...blankDraw }])}>
                          Add another draw
                        </button>
                        <div style={{ maxWidth: 320 }}>
                          <ScanInput label="Lot number" onScan={scanLot} placeholder="Scan or type a lot number" />
                        </div>
                      </div>
                      {scanNote ? <p className="cell-sub">{scanNote}</p> : null}
                      {offRecipe.length ? (
                        <p className="cell-sub">
                          This run does not follow {selected!.name}:{' '}
                          {offRecipe
                            .map((o) => `${lookupItemName(state, o.item)} ${o.actual.toFixed(0)}% (recipe says ${o.target}%)`)
                            .join(', ')}
                          .
                        </p>
                      ) : null}
                    </div>
                  ),
                },
                {
                  id: 'output',
                  title: 'What the run made',
                  hint: selected ? `One lot of ${lookupItemName(state, selected.outputItem)}, its own QC and shelf life` : undefined,
                  children: (
                    <div className="form-grid">
                      <label>
                        Blend produced ({blendUom === 'Kg' ? 'kg' : 'litres'})
                        <input
                          type="number"
                          min="0"
                          step="any"
                          placeholder="0"
                          value={outQty}
                          onChange={(e) => setOutQty(e.target.value === '' ? '' : Number(e.target.value))}
                        />
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
                        Blended on
                        <input type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} />
                      </label>
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
                    Lost to blending ({lower(blendUom)})
                    <input
                      type="number"
                      min="0"
                      step="any"
                      placeholder={loss > 0 ? String(Math.round(loss * 100) / 100) : '0'}
                      value={spoiled}
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
                    Add a loss line (a burst pouch, a spill…)
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
                {posting ? 'Posting…' : pending ? 'Waiting for the server’s copy…' : 'Post run & close'}
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
