/**
 * The Receipt stage form (WORKFLOW W6, behind the pipeline flag) — the plant's
 * one form for everything that arrives, whose questions change with what is
 * being received: the item's own procurement form decides whether the load
 * grades at the gate, is held for grading later (staged — the Grading stage's
 * queue), or skips grading altogether into inventory or blending stock.
 *
 * It posts through the same Classic write path as ever (AppContext.createGrn)
 * — pre-validated with the same priceGrn — and only then, when the receipt
 * answers a purchase order, links the two through W5's receive endpoint. The
 * order matters: the GRN is minted first (the link needs its id), and a link
 * that fails surfaces without losing the receipt — the linkage is append-once
 * and idempotent, so the retry that follows a refresh can never double-book.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../context/AppContext'
import { useToast } from '../context/ToastContext'
import { SectionedForm } from '../components/shell/SectionedForm'
import { ScanInput } from '../components/shell/ScanInput'
import { Select } from '../components/Select'
import { defaultRawStore } from '../lib/posting'
import { areaChoices, itemName as lookupItemName } from '../lib/stock'
import { gradedUnit, priceGrn } from '../lib/grn'
import type { GrnInput } from '../lib/grn'
import {
  canStage,
  matchProduct,
  receiptFormOf,
  receivedAgainst,
  ROUTE_NOTES,
} from '../lib/receiptStage'
import { useDraft } from '../lib/useDraft'
import {
  fetchPurchaseOrders,
  receivePurchaseOrderCall,
  PoApiError,
  type PurchaseOrderRow,
} from '../lib/poApi'
import { fmtDate, fmtQty, inr, toLocalInputValue } from '../lib/utils'

type NumValue = number | ''
const num = (v: NumValue) => Number(v) || 0

/** What survives a posted receipt: most deliveries share a supplier and a store. */
const blankRemembered = { farmerId: '', location: '' }

/** The numbers are per-delivery — they start empty every time. */
const blankNumbers = {
  date: toLocalInputValue(),
  total: '' as NumValue,
  free: '' as NumValue,
  rate: '' as NumValue,
  a: '' as NumValue,
  b: '' as NumValue,
  c: '' as NumValue,
  reject: '' as NumValue,
  transport: '' as NumValue,
  notes: '',
}

/** Orders a receipt can be booked against: the linkage needs an acknowledgement. */
const LINKABLE: PurchaseOrderRow['status'][] = ['acknowledged', 'received']

export function ReceiptTab() {
  const { state, createGrn } = useApp()
  const toast = useToast()
  const remembered = useDraft('roligt_receipt', blankRemembered)
  const [nums, setNums] = useState(blankNumbers)
  const [purchaseProductId, setPurchaseProductId] = useState('')
  const [farmer, setFarmer] = useState({ farmer: '', area: '', harvestedOn: '' })
  const [gradeLater, setGradeLater] = useState(false)
  const [pos, setPos] = useState<PurchaseOrderRow[] | null>(null)
  const [poError, setPoError] = useState('')
  const [poId, setPoId] = useState('')
  const [scanNote, setScanNote] = useState('')
  const [formError, setFormError] = useState('')
  const [busy, setBusy] = useState(false)
  const [linkNote, setLinkNote] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(async () => {
    setPoError('')
    try {
      setPos(await fetchPurchaseOrders())
    } catch (e) {
      setPoError(e instanceof Error ? e.message : 'The purchase orders could not be read.')
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const produce = useMemo(
    () =>
      state.purchaseProducts.filter(
        (p) => p.status === 'Active' && p.category !== 'Packing Material',
      ),
    [state.purchaseProducts],
  )
  const buying = produce.find((p) => p.id === purchaseProductId)
  const item = buying ? state.items.find((it) => it.id === buying.itemId) : undefined
  const form = receiptFormOf(item)
  const graded = gradedUnit(buying?.uom)
  /** The graded intake can land unsorted — nothing else has grades to stage. */
  const gradeLaterOffered = canStage(item)
  const staged = gradeLaterOffered && gradeLater
  const unit = (buying?.uom || 'Piece').toLowerCase()

  const chosen = pos?.find((p) => p.id === poId)
  const linkable = useMemo(() => pos?.filter((p) => LINKABLE.includes(p.status)) ?? [], [pos])

  const vendorOptions = state.vendors.filter((v) => v.status === 'Active')
  const sourceOptions = buying?.vendorIds.length
    ? vendorOptions.filter((v) => buying.vendorIds.includes(v.id) || v.id === remembered.value.farmerId)
    : vendorOptions

  /** The order's lines, with what each has already had booked against it. The
   *  name lookup closes over `state` — already a dependency — rather than a
   *  helper re-created every render. */
  const lineStatus = useMemo(() => {
    if (!chosen) return []
    const itemName = (id: string) => lookupItemName(state, id)
    const booked = receivedAgainst(
      chosen.lines,
      chosen.id,
      chosen.receivedGrnIds,
      state.grns,
      itemName,
    )
    return chosen.lines.map((line, i) => ({
      line,
      received: booked[i] ?? 0,
      product: matchProduct(line, produce, itemName),
    }))
  }, [chosen, produce, state])

  const setNum = (key: keyof typeof blankNumbers, value: string | number) =>
    setNums((n) => ({ ...n, [key]: value }))

  /** Seeds the form from one of the order's lines — the previous stage's answer. */
  const receiveLine = (i: number) => {
    const row = lineStatus[i]
    if (!row || !chosen) return
    setFormError('')
    if (row.product) {
      setPurchaseProductId(row.product.id)
      // The order's own supplier, unless this product cannot come from them —
      // then the vendor is left for the operator to pick, as the Classic form
      // would.
      const supplies = !row.product.vendorIds.length || row.product.vendorIds.includes(chosen.vendorId)
      remembered.set({ ...remembered.value, farmerId: supplies ? chosen.vendorId : '' })
    } else {
      setFormError(
        `"${row.line.item}" is not in the products master — pick what this load actually is.`,
      )
    }
    const still = row.line.qty - row.received
    setNums((n) => ({
      ...n,
      total: still > 0 ? still : '',
      rate: row.line.rate || '',
    }))
  }

  const scanOrder = useCallback(
    (code: string) => {
      setScanNote('')
      const found = pos?.find(
        (p) => p.number.toLowerCase() === code.toLowerCase() || p.id === code,
      )
      if (!found) {
        setScanNote(`No purchase order reads ${code}.`)
        return
      }
      if (!LINKABLE.includes(found.status)) {
        setScanNote(
          `${found.number} is ${found.status} — a receipt links only to an acknowledged order. Book the load without a link, or acknowledge the order first.`,
        )
        return
      }
      setPoId(found.id)
    },
    [pos],
  )

  // ── the GRN↔PO link: fires for any receipt this order called in that the
  // order's own list does not carry yet (a fresh post, or one whose link never
  // landed). One at a time, each against the version the list last handed
  // back; a stale version reloads and retries, and every failure leaves the
  // receipt booked — the note says what to do, nothing is lost. ──
  const attempted = useRef(new Set<string>())
  useEffect(() => {
    if (!chosen) return
    const grn = state.grns.find(
      (g) =>
        g.poId === chosen.id &&
        !attempted.current.has(g.id) &&
        !chosen.receivedGrnIds.includes(g.id),
    )
    if (!grn) return
    attempted.current.add(grn.id)
    let cancelled = false
    void (async () => {
      try {
        const next = await receivePurchaseOrderCall(chosen.id, {
          grnId: grn.id,
          expectedVersion: chosen.version,
        })
        if (cancelled) return
        setLinkNote({ ok: true, text: `${grn.id} linked to ${next.number} (${next.status}).` })
        await load()
      } catch (e) {
        if (cancelled) return
        const msg = e instanceof Error ? e.message : 'the order link failed'
        if (e instanceof PoApiError && e.code === 'cas_version') {
          // The order moved under us: re-read it and let the effect try again
          // with the fresh version. The linkage is idempotent, so the retry
          // can only land once.
          attempted.current.delete(grn.id)
          await load()
          setLinkNote({ ok: false, text: `${grn.id}: the order changed — retrying the link.` })
        } else {
          setLinkNote({
            ok: false,
            text: `${grn.id} is booked, but ${msg} The receipt is safe; retry once the order is acknowledged.`,
          })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [chosen, state.grns, load])

  const payload = (): GrnInput => ({
    date: nums.date,
    purchaseProductId,
    itemId: buying?.itemId,
    uom: buying?.uom || 'Piece',
    location: remembered.value.location,
    farmerId: remembered.value.farmerId,
    farmer: farmer.farmer,
    area: farmer.area,
    harvestedOn: farmer.harvestedOn,
    total: num(nums.total),
    free: graded ? num(nums.free) : 0,
    rate: num(nums.rate),
    a: graded && !staged ? num(nums.a) : 0,
    b: graded && !staged ? num(nums.b) : 0,
    c: graded && !staged ? num(nums.c) : 0,
    reject: graded && !staged ? num(nums.reject) : 0,
    transport: num(nums.transport),
    notes: nums.notes,
    ...(staged ? { gradingMode: 'staged' as const } : {}),
    ...(poId ? { poId } : {}),
  })

  const submit = () => {
    setFormError('')
    // The same questions the write path asks, answered before it asks them —
    // so the operator hears about a mismatched grade here, not after a refused
    // post (createGrn runs them again anyway; that check is the one that
    // counts).
    const math = priceGrn(payload())
    if (!math.ok) {
      setFormError(math.error)
      return
    }
    setBusy(true)
    const ok = createGrn(payload())
    setBusy(false)
    if (!ok) return // refused — its own message is already up
    toast(
      staged
        ? 'Receipt posted — the lot is held for grading.'
        : `Receipt posted into ${remembered.value.location || defaultRawStore(state) || 'the raw store'}.`,
    )
    setNums({ ...blankNumbers, date: toLocalInputValue() })
    setGradeLater(false)
  }

  const numberFields: [keyof typeof blankNumbers, string][] = graded
    ? staged
      ? [
          ['total', `Total received (incl. free), in ${unit}`],
          ['free', `Free ${unit} (not charged)`],
          ['rate', `Common rate / ${unit.replace(/s$/, '')}`],
          ['transport', 'Transport cost'],
        ]
      : [
          ['total', `Total received (incl. free), in ${unit}`],
          ['free', `Free ${unit} (not charged)`],
          ['rate', `Common rate / ${unit.replace(/s$/, '')}`],
          ['a', 'Grade A'],
          ['b', 'Grade B'],
          ['c', 'Grade C'],
          ['reject', 'Rejected'],
          ['transport', 'Transport cost'],
        ]
    : [
        ['total', `Total received, in ${unit}`],
        ['rate', `Rate / ${unit}`],
        ['transport', 'Transport cost'],
      ]

  const preview = (() => {
    const total = num(nums.total)
    if (!total) return null
    const free = graded ? num(nums.free) : 0
    const chargeable = Math.max(0, total - free)
    const landed = chargeable * num(nums.rate) + num(nums.transport)
    const accepted = staged ? total : graded ? num(nums.a) + num(nums.b) + num(nums.c) : total
    if (staged) {
      return `Booking the whole load of ${fmtQty(total)} ${unit} — landed ${inr(landed)}, held in quarantine until it is graded.`
    }
    const gradedTotal = graded ? num(nums.a) + num(nums.b) + num(nums.c) + num(nums.reject) : total
    const ungraded = total - gradedTotal
    return (
      `Charging ${fmtQty(chargeable)} of ${fmtQty(total)} ${unit}` +
      (graded && free > 0 ? ` — ${fmtQty(free)} free` : '') +
      ` · landed ${inr(landed)} · ${fmtQty(accepted)} accepted` +
      (graded && ungraded > 0 ? ` · ${fmtQty(ungraded)} still to grade` : '') +
      '.'
    )
  })()

  return (
    <div>
      <div className="section-head" style={{ marginBottom: 12 }}>
        <div>
          <h2>Receive goods</h2>
          <span className="cell-sub">
            One form for everything that arrives — what it asks follows what is being received
          </span>
        </div>
      </div>

      <SectionedForm
        sections={[
          {
            id: 'order',
            title: 'Against a purchase order',
            hint: 'Optional — the order’s lines seed the form',
            children: (
              <div>
                <div className="form-grid">
                  <label>
                    Order
                    <Select
                      value={poId}
                      onChange={(e) => {
                        setPoId(e.target.value)
                        setScanNote('')
                        setLinkNote(null)
                      }}
                    >
                      <option value="">No order — a direct delivery</option>
                      {linkable.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.number} · {state.vendors.find((v) => v.id === p.vendorId)?.name ?? p.vendorId}
                          {p.expectedOn ? ` · expected ${fmtDate(p.expectedOn)}` : ''}
                        </option>
                      ))}
                    </Select>
                  </label>
                </div>
                {poError ? <p className="form-error">{poError}</p> : null}
                {pos && !linkable.length ? (
                  <p className="cell-sub">
                    No acknowledged orders — an order links its receipts once the supplier has
                    acknowledged it.
                  </p>
                ) : null}
                <div style={{ marginTop: 8, maxWidth: 360 }}>
                  <ScanInput label="Purchase order number" onScan={scanOrder} placeholder="Scan or type an order number" />
                </div>
                {scanNote ? <p className="cell-sub">{scanNote}</p> : null}

                {chosen ? (
                  <table className="table" style={{ marginTop: 12 }}>
                    <thead>
                      <tr>
                        <th>Material</th>
                        <th className="num">Ordered</th>
                        <th className="num">Received</th>
                        <th className="num">Still to receive</th>
                        <th className="cell-actions">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lineStatus.map((row, i) => (
                        <tr key={i}>
                          <td>
                            {row.line.item}
                            {row.product ? (
                              <div className="cell-sub cell-id">{row.product.name}</div>
                            ) : (
                              <div className="cell-sub form-error">not in the products master</div>
                            )}
                          </td>
                          <td className="num">
                            {fmtQty(row.line.qty)} {row.line.uom}
                          </td>
                          <td className="num">{fmtQty(row.received)}</td>
                          <td className="num">
                            {fmtQty(Math.max(0, row.line.qty - row.received))}
                          </td>
                          <td className="cell-actions">
                            <button type="button" className="btn-light" onClick={() => receiveLine(i)}>
                              Receive this
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : null}
                {linkNote ? (
                  <p className={linkNote.ok ? 'cell-sub' : 'form-error'} style={{ marginTop: 8 }}>
                    {linkNote.text}
                  </p>
                ) : null}
              </div>
            ),
          },
          {
            id: 'load',
            title: 'What arrived',
            hint: 'The item says what happens to this load',
            children: (
              <div className="form-grid">
                <label className="span-2">
                  Product received
                  <Select
                    value={purchaseProductId}
                    onChange={(e) => setPurchaseProductId(e.target.value)}
                  >
                    <option value="">
                      {produce.length ? 'Select produce' : 'No produce yet — add one on the Products & Materials page'}
                    </option>
                    {produce.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} · {p.uom}
                      </option>
                    ))}
                  </Select>
                  {form ? <small className="cell-sub">{ROUTE_NOTES[form]}</small> : null}
                </label>
                <label>
                  Storage area
                  <Select
                    value={remembered.value.location}
                    onChange={(e) => remembered.set({ ...remembered.value, location: e.target.value })}
                  >
                    <option value="">Select storage area</option>
                    {areaChoices(state, 'Raw Material', 'Available', remembered.value.location).map((c) => (
                      <option key={c.area.id} value={c.value}>
                        {c.text}
                      </option>
                    ))}
                  </Select>
                </label>
                <label>
                  Approved supplier
                  <Select
                    value={remembered.value.farmerId}
                    onChange={(e) => remembered.set({ ...remembered.value, farmerId: e.target.value })}
                  >
                    <option value="">Direct farmer purchase — no vendor</option>
                    {sourceOptions.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.id} · {v.name}
                      </option>
                    ))}
                  </Select>
                </label>
                <label>
                  Farmer name{remembered.value.farmerId ? '' : ' (required without a vendor)'}
                  <input
                    value={farmer.farmer}
                    onChange={(e) => setFarmer((f) => ({ ...f, farmer: e.target.value }))}
                    placeholder="Who grew / harvested this lot"
                  />
                </label>
                <label>
                  Area
                  <input
                    value={farmer.area}
                    onChange={(e) => setFarmer((f) => ({ ...f, area: e.target.value }))}
                    placeholder="Village / farm / block"
                  />
                </label>
                <label>
                  Harvested on
                  <input
                    type="date"
                    value={farmer.harvestedOn}
                    onChange={(e) => setFarmer((f) => ({ ...f, harvestedOn: e.target.value }))}
                  />
                </label>
                <label>
                  Receipt date/time
                  <input
                    type="datetime-local"
                    value={nums.date}
                    onChange={(e) => setNum('date', e.target.value)}
                  />
                </label>
              </div>
            ),
          },
          {
            id: 'count',
            title: graded ? 'Count and grades' : 'Count and cost',
            hint: staged ? 'The load is held unsorted' : undefined,
            children: (
              <div>
                {gradeLaterOffered ? (
                  <div className="form-grid" style={{ marginBottom: 8 }}>
                    <label className="check">
                      <input
                        type="radio"
                        name="grading-mode"
                        checked={!gradeLater}
                        onChange={() => setGradeLater(false)}
                      />{' '}
                      Grade at the gate
                    </label>
                    <label className="check">
                      <input
                        type="radio"
                        name="grading-mode"
                        checked={gradeLater}
                        onChange={() => setGradeLater(true)}
                      />{' '}
                      Grade later — the lot is held until the Grading stage sorts it
                    </label>
                  </div>
                ) : null}
                {staged ? (
                  <p className="cell-sub">
                    The whole load books into quarantine as received. Pipeline → Grading sorts it
                    later; the accepted count moves into stock then, and the costs re-derive from
                    the grades.
                  </p>
                ) : null}
                <div className="form-grid">
                  {numberFields.map(([key, label]) => (
                    <label key={key}>
                      {label}
                      <input
                        type="number"
                        min="0"
                        step={key === 'rate' || key === 'transport' || !graded ? '0.01' : '1'}
                        placeholder="0"
                        value={nums[key]}
                        onChange={(e) => setNum(key, e.target.value === '' ? '' : Number(e.target.value))}
                      />
                    </label>
                  ))}
                </div>
                {preview ? <div className="note">{preview}</div> : null}
                <div className="form-grid" style={{ marginTop: 12 }}>
                  <label className="span-3">
                    Notes / receiving inspection
                    <textarea
                      value={nums.notes}
                      onChange={(e) => setNum('notes', e.target.value)}
                      placeholder="Photos, challan details, inspection findings"
                    />
                  </label>
                </div>
              </div>
            ),
          },
        ]}
        footer={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button type="button" className="btn-primary" disabled={busy} onClick={submit}>
              {busy ? 'Posting…' : staged ? 'Post receipt, held for grading' : 'Post receipt'}
            </button>
            {formError ? <span className="form-error">{formError}</span> : null}
          </div>
        }
      />
    </div>
  )
}
