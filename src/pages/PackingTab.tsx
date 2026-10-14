/**
 * The Packing stage form (WORKFLOW W10, behind the pipeline flag) — bulk off a
 * batch lot into packs. Glass bottles are the standard flow; BIB pouches
 * (1 L / 2.5L / 5 L) are stored LOOSE in the cold room and the pouch itself is
 * the finished-goods unit tracked by lot, size and location (§3.3 step 6). The
 * carton decision is dispatch-time (§3.3 step 9, SHIPMENT-era) — nothing here
 * counts a carton, on purpose.
 *
 * ONE write, through machinery that already exists: the run posts through the
 * SAME Classic path the Packing register uses (createPackingRun — checkPacking
 * answers first, in its own words; bulk and packing material move; each pack
 * line becomes its own stock row carrying the bulk's QC verdict). There is no
 * close step: a packing run posts complete, which is why the pipeline Packing
 * tile counts today's runs as activity rather than a queue, and why this form
 * has no queue select — only the posting form.
 *
 * The pools are the write path's own folds, re-used not re-derived (the W8
 * pressableLots lesson): the bulk pool is what checkPacking can actually draw
 * (DRAWABLE rows — rejected bulk is invisible, and its refusal names it), the
 * pack list is the product master's own, and the materials preview IS
 * packingNeeds — the same walk the save gate runs.
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { ScanInput } from '../components/shell/ScanInput'
import { SectionedForm } from '../components/shell/SectionedForm'
import { Select } from '../components/Select'
import { fmtBulk, itemUom } from '../lib/batches'
import { bulkItemOf } from '../lib/packs'
import { checkPacking, defaultPackStore, packingNeeds, pmAvailable } from '../lib/posting'
import type { PackingInput } from '../lib/posting'
import { areaChoices, itemName as lookupItemName, locationLabel } from '../lib/stock'
import { bulkByBatch, fillableBulk, isLoosePouch, packableBatches, packsForBulk } from '../lib/packingStage'
import { useDraft } from '../lib/useDraft'
import { QTY_EPSILON, toLocalInputValue } from '../lib/utils'
import type { Batch, Product } from '../types'

type NumValue = number | ''
const num = (v: NumValue) => Number(v) || 0

/** One pack line: the SKU picked and how many were filled. */
interface PackRow {
  sku: string
  packs: NumValue
}
/** One product's control samples: what they went into, how many, who took them. */
interface SampleRow {
  /** A pack SKU, `OTHER` for another container, or empty until picked. */
  sku: string
  sizeMl: NumValue
  count: NumValue
  collectedBy: string
}

/** Stands for a container that is not one of the plant's packs. */
const OTHER = '__other'
const blankPack: PackRow = { sku: '', packs: '' }
const blankSample: SampleRow = { sku: '', sizeMl: 100, count: '', collectedBy: '' }

/** What the form remembers between runs — the room the packs usually go to. */
const DRAFT = { location: '' }

export function PackingTab() {
  const { state, rows, createPackingRun } = useApp()
  const navigate = useNavigate()
  const [date, setDate] = useState(toLocalInputValue())
  const [bulkId, setBulkId] = useState('')
  const [batchId, setBatchId] = useState('')
  const [packRows, setPackRows] = useState<PackRow[]>([{ ...blankPack }])
  const [sampleRows, setSampleRows] = useState<SampleRow[]>([] as SampleRow[])
  const [formError, setFormError] = useState('')
  const [scanNote, setScanNote] = useState('')
  const [posting, setPosting] = useState(false)
  const [posted, setPosted] = useState('')
  /** Where the packs usually go — remembered between runs. */
  const remembered = useDraft('roligt_packing', DRAFT)
  const location = remembered.value.location
  const setLocation = (location: string) => remembered.set({ ...remembered.value, location })

  /** Every fillable bulk with its own packable batches — the write path's own
   *  folds, pooled once so a scan can reach a batch under any bulk. */
  const pools = useMemo(
    () =>
      fillableBulk(state).map((bulk) => {
        const held = bulkByBatch(rows, bulk.id)
        return { bulk, held, batches: packableBatches(state.batches, held) }
      }),
    [state, rows],
  )
  const active = pools.find((p) => p.bulk.id === bulkId)
  const held = active?.held ?? new Map<string, number>()
  const batches: Batch[] = active?.batches ?? []
  const packOptions = useMemo(() => packsForBulk(state.products, bulkId), [state.products, bulkId])
  const anyForBulk = useMemo(
    () => state.products.some((p) => bulkItemOf(p) === bulkId),
    [state.products, bulkId],
  )
  const bulkUom = bulkId ? itemUom(state, bulkId) : 'Litre'
  // One bulk in the plant means one less click — the form starts on it.
  useEffect(() => {
    if (!bulkId && pools.length === 1) setBulkId(pools[0].bulk.id)
  }, [bulkId, pools])

  // —— the lines the live preview and the post both read ——————————————
  const lineInputs = packRows
    .filter((r) => r.sku || num(r.packs) > 0)
    .map((r) => ({ sku: r.sku, packs: num(r.packs) }))
  const sampleInputs = sampleRows
    .filter((r) => r.sku || num(r.count) > 0)
    .map((r) => ({
      sku: r.sku && r.sku !== OTHER ? r.sku : undefined,
      count: num(r.count),
      sizeMl: r.sku === OTHER ? num(r.sizeMl) : undefined,
      collectedBy: r.collectedBy,
    }))
  /** The same walk the save gate runs — drawn bulk and packing material, in the
   *  numbers the gate will hold the run to. */
  const needs = useMemo(
    () => (bulkId ? packingNeeds(state, bulkId, lineInputs, sampleInputs) : { drawn: 0, pmNeeds: {}, problems: [] }),
    // the rows are derived fresh each render; the walk is cheap and the preview
    // must follow every keystroke
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, bulkId, packRows, sampleRows],
  )
  const available = batchId ? held.get(batchId) || 0 : 0
  const willDraw = needs.drawn

  /** The pack formats among the picked lines — decides the where-it-goes note. */
  const picked = useMemo(
    () =>
      lineInputs
        .map((l) => state.products.find((p) => p.id === l.sku))
        .filter((p): p is Product => !!p),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lineInputs, state.products],
  )
  const loosePouch = picked.some((p) => isLoosePouch(p.type))

  /** A line touched but half-filled — the gate will refuse the run for it, so
   *  the preview says so rather than showing numbers the save will not accept. */
  const halfLine = packRows.some((r) => (r.sku || num(r.packs) > 0) && !(r.sku && num(r.packs) > 0))

  const input = (): PackingInput => ({
    date,
    batchId,
    bulkItem: bulkId,
    lines: lineInputs,
    location: location || undefined,
    controlSamples: sampleInputs,
  })

  const submit = () => {
    setFormError('')
    if (!bulkId) {
      setFormError('Pick what the run is filling from.')
      return
    }
    // The Classic form's own question, verbatim — a count with no container
    // picked would otherwise draw the wrong thing or nothing at all.
    if (sampleRows.some((r) => !r.sku && num(r.count) > 0)) {
      setFormError('Pick what each control sample was filled into.')
      return
    }
    // checkPacking asks every question the write path will ask again — its own
    // words answer here first (Select a batch / half-filled lines / not enough
    // bulk / not enough packing material), so the operator sees the refusal
    // where they can still do something about it.
    const math = checkPacking(state, input())
    if (!math.ok) {
      setFormError(math.error)
      return
    }
    setPosting(true)
    const id = createPackingRun(input())
    setPosting(false)
    if (!id) return // the write path already said why, in its own words
    setPosted(id)
    setBatchId('')
    setPackRows([{ ...blankPack }])
    setSampleRows([])
    setFormError('')
  }

  // —— row editors ——————————————————————————————————————————————
  const setPack = (i: number, patch: Partial<PackRow>) =>
    setPackRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const setSample = (i: number, patch: Partial<SampleRow>) =>
    setSampleRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  /** A scanned batch lot picks the batch — and the bulk it lives under, so the
   *  operator never has to know which pool to look in first. */
  const scanBatch = (code: string) => {
    setScanNote('')
    const wanted = code.trim().toLowerCase()
    const pool = pools.find((p) => p.batches.some((b) => b.id.toLowerCase() === wanted))
    if (!pool) {
      setScanNote(
        pools.some((p) => p.batches.length)
          ? `No batch with bulk to pack reads ${code}.`
          : `Nothing is waiting to be packed — ${code} included.`,
      )
      return
    }
    setBulkId(pool.bulk.id)
    setBatchId(pool.batches.find((b) => b.id.toLowerCase() === wanted)!.id)
  }

  return (
    <div>
      <div className="section-head" style={{ marginBottom: 12 }}>
        <div>
          <h2>Run a packing</h2>
          <span className="cell-sub">
            Bulk off a batch lot into packs — bottles the standard flow, BiB pouches loose in the
            cold room; the pouch is the tracked unit, cartons are decided at dispatch
          </span>
        </div>
      </div>

      <SectionedForm
        sections={[
          {
            id: 'source',
            title: 'What is being filled',
            hint: batches.length
              ? `${batches.length} batch${batches.length === 1 ? '' : 'es'} still have drawable bulk`
              : undefined,
            children: (
              <div>
                <div className="form-grid">
                  <label>
                    Filling from
                    <Select
                      value={bulkId}
                      onChange={(e) => {
                        setBulkId(e.target.value)
                        setBatchId('')
                        setFormError('')
                      }}
                    >
                      <option value="">
                        {pools.length ? 'Select the bulk' : 'No bulk can be packed — nothing has stock'}
                      </option>
                      {pools.map((p) => (
                        <option key={p.bulk.id} value={p.bulk.id}>
                          {p.bulk.name} · {p.batches.length} batch{p.batches.length === 1 ? '' : 'es'}
                        </option>
                      ))}
                    </Select>
                  </label>
                  <label>
                    Batch lot
                    <Select value={batchId} onChange={(e) => { setBatchId(e.target.value); setFormError('') }}>
                      <option value="">
                        {bulkId ? (batches.length ? 'Select a batch' : 'No batch of it has drawable bulk') : 'Pick a bulk first'}
                      </option>
                      {batches.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.id} · {fmtBulk(held.get(b.id) || 0, itemUom(state, bulkId))} on hand
                        </option>
                      ))}
                    </Select>
                  </label>
                  <label>
                    Packed on
                    <input type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} />
                  </label>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <div style={{ maxWidth: 320 }}>
                    <ScanInput label="Batch lot" onScan={scanBatch} placeholder="Scan or type a batch lot (BAT-…)" />
                  </div>
                  {batchId ? (
                    <span className="cell-sub">
                      {fmtBulk(available, bulkUom)} of {lookupItemName(state, bulkId)} drawable · this run
                      will draw {fmtBulk(willDraw, bulkUom)}
                      {willDraw > available + QTY_EPSILON ? ' — more than it has' : ''}
                    </span>
                  ) : null}
                </div>
                {scanNote ? <p className="cell-sub">{scanNote}</p> : null}
              </div>
            ),
          },
          {
            id: 'packs',
            title: 'Packs filled',
            hint: 'One line per pack SKU — the size and what it is made of live on the pack',
            children: (
              <div>
                {bulkId && !packOptions.length ? (
                  <div className="note warning-note">
                    {anyForBulk ? (
                      <>
                        The packs filled from {lookupItemName(state, bulkId)} are retired. Restore one
                        on the <b>Products &amp; Materials</b> page, or create a new pack.
                      </>
                    ) : (
                      <>
                        No pack is filled from {lookupItemName(state, bulkId)} yet — create one on the{' '}
                        <b>Products &amp; Materials</b> page first.
                      </>
                    )}{' '}
                    <button
                      type="button"
                      className="btn btn-light"
                      onClick={() => navigate('/purchase-products')}
                    >
                      Open Products &amp; Materials
                    </button>
                  </div>
                ) : (
                  <>
                    {packRows.map((r, i) => {
                      const p = packOptions.find((x) => x.id === r.sku)
                      return (
                        <div className="form-grid" key={i}>
                          <label>
                            Pack
                            <Select value={r.sku} onChange={(e) => setPack(i, { sku: e.target.value })}>
                              <option value="">Select pack</option>
                              {packOptions.map((o) => (
                                <option key={o.id} value={o.id}>
                                  {o.label}
                                </option>
                              ))}
                            </Select>
                          </label>
                          <label>
                            Packs filled
                            <input
                              type="number"
                              min="0"
                              placeholder="Qty"
                              value={r.packs}
                              onChange={(e) =>
                                setPack(i, { packs: e.target.value === '' ? '' : Number(e.target.value) })
                              }
                            />
                          </label>
                          <span className="cell-sub" style={{ alignSelf: 'end' }}>
                            {p && num(r.packs) ? `${fmtBulk(num(r.packs) * p.packVolume, bulkUom)} of bulk` : p ? `one holds ${fmtBulk(p.packVolume, bulkUom)}` : ''}
                          </span>
                          {packRows.length > 1 ? (
                            <div className="field" style={{ alignSelf: 'end' }}>
                              <button
                                type="button"
                                className="btn btn-light"
                                onClick={() => setPackRows((rs) => rs.filter((_, j) => j !== i))}
                              >
                                Remove
                              </button>
                            </div>
                          ) : null}
                        </div>
                      )
                    })}
                    <button
                      type="button"
                      className="btn btn-light"
                      style={{ marginTop: 8 }}
                      onClick={() => setPackRows((rs) => [...rs, { ...blankPack }])}
                    >
                      Add another pack
                    </button>
                  </>
                )}
                {halfLine ? (
                  <p className="form-error">
                    Every pack line needs a pack and a count — complete or remove the half-filled lines.
                  </p>
                ) : null}
                {loosePouch ? (
                  <p className="cell-sub">
                    BiB pouches are stored loose — the pouch itself is the finished-goods unit tracked
                    by lot, size and location. Cartons are decided at dispatch, never here.
                  </p>
                ) : null}
              </div>
            ),
          },
          {
            id: 'where',
            title: 'Put away',
            hint: 'Packs go in now and stay put — QC clears or rejects them where they stand',
            children: (
              <div className="form-grid">
                <label>
                  Storage area
                  <Select value={location} onChange={(e) => setLocation(e.target.value)}>
                    <option value="">
                      {defaultPackStore(state)
                        ? `${locationLabel(state, defaultPackStore(state)!)} (default)`
                        : 'Select storage area'}
                    </option>
                    {areaChoices(state, 'Finished Goods', 'Quarantine', location).map((c) => (
                      <option key={c.area.id} value={c.value}>
                        {c.text}
                      </option>
                    ))}
                  </Select>
                </label>
              </div>
            ),
          },
          {
            id: 'samples',
            title: 'Control samples',
            hint: 'They draw bulk like a pack but are never stock — the retention register reads them',
            children: (
              <div>
                {sampleRows.map((r, i) => (
                  <div className="form-grid" key={i} style={i ? { marginTop: 8 } : undefined}>
                    <label>
                      Kept in
                      <Select value={r.sku} onChange={(e) => setSample(i, { sku: e.target.value })}>
                        <option value="">Select a pack</option>
                        <option value={OTHER}>Another container</option>
                        {packOptions.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.label}
                          </option>
                        ))}
                      </Select>
                    </label>
                    {r.sku === OTHER ? (
                      <label>
                        Each holds (ml)
                        <input
                          type="number"
                          min="0"
                          placeholder="100"
                          value={r.sizeMl}
                          onChange={(e) =>
                            setSample(i, { sizeMl: e.target.value === '' ? '' : Number(e.target.value) })
                          }
                        />
                      </label>
                    ) : null}
                    <label>
                      How many
                      <input
                        type="number"
                        min="0"
                        placeholder="Qty"
                        value={r.count}
                        onChange={(e) =>
                          setSample(i, { count: e.target.value === '' ? '' : Number(e.target.value) })
                        }
                      />
                    </label>
                    <label>
                      Collected by
                      <input
                        type="text"
                        placeholder="Who kept them"
                        value={r.collectedBy}
                        onChange={(e) => setSample(i, { collectedBy: e.target.value })}
                      />
                    </label>
                    <div className="field" style={{ alignSelf: 'end' }}>
                      <button
                        type="button"
                        className="btn btn-light"
                        onClick={() => setSampleRows((rs) => rs.filter((_, j) => j !== i))}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  className="btn btn-light"
                  style={{ marginTop: 8 }}
                  onClick={() => setSampleRows((rs) => [...rs, { ...blankSample }])}
                >
                  Keep control samples
                </button>
              </div>
            ),
          },
          {
            id: 'materials',
            title: 'Materials this run will use',
            hint: 'The same walk the save gate runs — a short shelf is a purchase away, not a surprise',
            children: (
              <div>
                {needs.problems.length ? (
                  <p className="form-error">{needs.problems[0]}</p>
                ) : !Object.keys(needs.pmNeeds).length ? (
                  <p className="cell-sub">
                    These packs have no materials linked, so the run will consume none. Link them in
                    the pack&apos;s <b>What one pack is made of</b> section and filling will draw the
                    bottles, caps and labels it uses.
                  </p>
                ) : (
                  <div className="form-grid">
                    {Object.entries(needs.pmNeeds).map(([item, need]) => {
                      const have = pmAvailable(rows, item)
                      const short = need > have + QTY_EPSILON
                      return (
                        <span key={item} className="cell-sub" style={short ? { color: 'var(--danger)' } : undefined}>
                          {lookupItemName(state, item)}: needs {Number(need.toFixed(3))}, on hand{' '}
                          {Number(have.toFixed(3))}
                          {short ? ' — short' : ' — enough'}
                        </span>
                      )
                    })}
                  </div>
                )}
              </div>
            ),
          },
        ]}
        footer={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" className="btn-primary" disabled={posting} onClick={submit}>
              {posting ? 'Posting…' : 'Post packing run'}
            </button>
            {formError ? <span className="form-error">{formError}</span> : null}
            {posted ? (
              <span className="cell-sub">
                Posted {posted} — the packs carry the bulk&apos;s own verdict: Quarantine until the
                lab releases it, Released straight away if it already is.
              </span>
            ) : null}
          </div>
        }
      />
    </div>
  )
}
