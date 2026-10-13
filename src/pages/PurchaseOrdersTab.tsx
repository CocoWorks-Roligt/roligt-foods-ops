/**
 * The Purchase orders tab on Procurement (WORKFLOW W4, behind the pipeline
 * flag) — the plant's first upstream document as a register and a form.
 *
 * The register reads GET /api/purchase-orders; a click opens the order with
 * only the moves the purchaseOrder machine allows as buttons (the same table
 * the server enforces), each labelled with its guard's plain-language note,
 * and each move carries the version the list handed back so a race loses to a
 * 409 instead of silently overwriting. The form drafts through useDraft — the
 * last supplier and expected-on day come back, because most orders share them.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useApp } from '../context/AppContext'
import { useToast } from '../context/ToastContext'
import { DataTable, type Column } from '../components/shell/DataTable'
import { SectionedForm } from '../components/shell/SectionedForm'
import { StatusBadge } from '../components/StatusBadge'
import { useDraft } from '../lib/useDraft'
import {
  createPurchaseOrderCall,
  fetchPurchaseOrders,
  patchPurchaseOrderCall,
  PoApiError,
  type PurchaseOrderRow,
} from '../lib/poApi'
import { explainGuard, guardsRequired, legalTargets } from '../lib/rules'
import type { PurchaseOrderLine, PurchaseOrderStatus } from '../lib/contracts'
import { fmtDate } from '../lib/utils'

type Po = PurchaseOrderRow

/** The one word the register shows a PO status as — the machine's own names, capitalised. */
const PO_WORDS: Record<PurchaseOrderStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  acknowledged: 'Acknowledged',
  received: 'Received',
  closed: 'Closed',
  cancelled: 'Cancelled',
}

type LineDraft = { item: string; qty: string; uom: string; rate: string }

const blankLine = (): LineDraft => ({ item: '', qty: '', uom: '', rate: '' })

const blankForm = {
  vendorId: '',
  expectedOn: '',
  alreadySent: false,
  lines: [blankLine()] as LineDraft[],
}

const num = (v: string) => Number(v) || 0

export function PurchaseOrdersTab() {
  const { state } = useApp()
  const toast = useToast()
  const [pos, setPos] = useState<Po[] | null>(null)
  const [error, setError] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [selectedId, setSelectedId] = useState('')
  const [moveError, setMoveError] = useState('')
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const draft = useDraft('roligt_po_new', blankForm)
  const form = draft.value

  const load = useCallback(async () => {
    setError('')
    try {
      setPos(await fetchPurchaseOrders())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The purchase orders could not be read.')
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const vendors = useMemo(() => state.vendors.filter((v) => v.status !== 'Inactive'), [state.vendors])
  const vendorName = (id: string) => state.vendors.find((v) => v.id === id)?.name ?? id
  const selected = pos?.find((p) => p.id === selectedId)

  const setForm = (patch: Partial<typeof blankForm>) => draft.set({ ...form, ...patch })
  const setLine = (i: number, patch: Partial<LineDraft>) => {
    const lines = form.lines.map((l, j) => (j === i ? { ...l, ...patch } : l))
    setForm({ lines })
  }

  /** Client-side pass mirrors the server's own questions, field by field. */
  const submit = async () => {
    setFormError('')
    setFieldErrors({})
    const details: Record<string, string> = {}
    if (!form.vendorId) details.vendorId = 'Which supplier is this order for?'
    form.lines.forEach((l, i) => {
      if (!l.item.trim()) details[`lines.${i}.item`] = 'Name the material.'
      if (num(l.qty) <= 0) details[`lines.${i}.qty`] = 'Quantity must be greater than zero.'
      if (!l.uom.trim()) details[`lines.${i}.uom`] = 'Name the unit.'
      if (num(l.rate) < 0) details[`lines.${i}.rate`] = 'Rate must be zero or more.'
    })
    if (Object.keys(details).length) {
      setFieldErrors(details)
      return
    }
    setBusy(true)
    try {
      const lines: PurchaseOrderLine[] = form.lines.map((l) => ({
        item: l.item.trim(),
        qty: num(l.qty),
        uom: l.uom.trim(),
        rate: num(l.rate),
      }))
      const po = await createPurchaseOrderCall({
        vendorId: form.vendorId,
        lines,
        ...(form.expectedOn ? { expectedOn: form.expectedOn } : {}),
        ...(form.alreadySent ? { status: 'sent' } : {}),
      })
      toast(`${po.number} raised${po.status === 'sent' ? ' and sent' : ' as a draft'}.`)
      setFormOpen(false)
      // Keep the supplier and the day — most orders share them; clear the lines.
      draft.set({ ...blankForm, vendorId: form.vendorId, expectedOn: form.expectedOn })
      setSelectedId(po.id)
      await load()
    } catch (e) {
      if (e instanceof PoApiError) {
        setFormError(e.message)
        setFieldErrors(e.details ?? {})
      } else setFormError(e instanceof Error ? e.message : 'The order could not be raised.')
    } finally {
      setBusy(false)
    }
  }

  const move = async (po: Po, to: PurchaseOrderStatus) => {
    setMoveError('')
    setBusy(true)
    try {
      const next = await patchPurchaseOrderCall(po.id, { status: to, expectedVersion: po.version })
      toast(`${next.number} moved to ${PO_WORDS[next.status]}.`)
      await load()
    } catch (e) {
      setMoveError(e instanceof Error ? e.message : 'The move did not land.')
    } finally {
      setBusy(false)
    }
  }

  const columns: Column<Po>[] = [
    { key: 'number', label: 'Order', sort: (p) => p.number, render: (p) => <strong>{p.number}</strong> },
    { key: 'vendor', label: 'Supplier', sort: (p) => vendorName(p.vendorId), render: (p) => vendorName(p.vendorId) },
    {
      key: 'lines',
      label: 'What',
      render: (p) =>
        p.lines.length === 1
          ? `${p.lines[0]!.qty} ${p.lines[0]!.uom} ${p.lines[0]!.item}`
          : `${p.lines.length} lines`,
    },
    { key: 'expectedOn', label: 'Expected on', sort: (p) => p.expectedOn ?? '', render: (p) => (p.expectedOn ? fmtDate(p.expectedOn) : '—') },
    { key: 'status', label: 'Status', sort: (p) => p.status, render: (p) => <StatusBadge value={PO_WORDS[p.status] ?? p.status} /> },
  ]

  return (
    <div>
      <div className="section-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h2>Purchase orders</h2>
        <button type="button" className="btn" onClick={() => setFormOpen((v) => !v)}>
          {formOpen ? 'Close the form' : '+ Raise a purchase order'}
        </button>
      </div>

      {formOpen ? (
        <div className="card" style={{ marginBottom: 16 }}>
          <SectionedForm
            sections={[
              {
                id: 'who',
                title: 'Supplier',
                hint: 'Who this order goes to',
                children: (
                  <div className="form-grid">
                    <label>
                      Supplier
                      <select value={form.vendorId} onChange={(e) => setForm({ vendorId: e.target.value })}>
                        <option value="">— choose —</option>
                        {vendors.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.name}
                          </option>
                        ))}
                      </select>
                      {fieldErrors.vendorId ? <small className="form-error">{fieldErrors.vendorId}</small> : null}
                    </label>
                    <label>
                      Expected on
                      <input
                        type="date"
                        value={form.expectedOn}
                        onChange={(e) => setForm({ expectedOn: e.target.value })}
                      />
                    </label>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={form.alreadySent}
                        onChange={(e) => setForm({ alreadySent: e.target.checked })}
                      />{' '}
                      Already sent to the supplier
                    </label>
                  </div>
                ),
              },
              {
                id: 'what',
                title: 'Lines',
                hint: 'What is ordered, and at what rate',
                children: (
                  <div className="form-lines">
                    {form.lines.map((l, i) => (
                      <div key={i} className="form-line">
                        <label style={{ flex: 2 }}>
                          Material
                          <input
                            value={l.item}
                            list="po-item-names"
                            onChange={(e) => setLine(i, { item: e.target.value })}
                          />
                          {fieldErrors[`lines.${i}.item`] ? (
                            <small className="form-error">{fieldErrors[`lines.${i}.item`]}</small>
                          ) : null}
                        </label>
                        <label>
                          Qty
                          <input
                            type="number"
                            min="0"
                            step="any"
                            value={l.qty}
                            onChange={(e) => setLine(i, { qty: e.target.value })}
                          />
                          {fieldErrors[`lines.${i}.qty`] ? (
                            <small className="form-error">{fieldErrors[`lines.${i}.qty`]}</small>
                          ) : null}
                        </label>
                        <label>
                          Unit
                          <input value={l.uom} onChange={(e) => setLine(i, { uom: e.target.value })} />
                          {fieldErrors[`lines.${i}.uom`] ? (
                            <small className="form-error">{fieldErrors[`lines.${i}.uom`]}</small>
                          ) : null}
                        </label>
                        <label>
                          Rate
                          <input
                            type="number"
                            min="0"
                            step="any"
                            value={l.rate}
                            onChange={(e) => setLine(i, { rate: e.target.value })}
                          />
                          {fieldErrors[`lines.${i}.rate`] ? (
                            <small className="form-error">{fieldErrors[`lines.${i}.rate`]}</small>
                          ) : null}
                        </label>
                        <button
                          type="button"
                          className="btn-light"
                          aria-label={`Remove line ${i + 1}`}
                          disabled={form.lines.length === 1}
                          onClick={() => setForm({ lines: form.lines.filter((_, j) => j !== i) })}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                    <datalist id="po-item-names">
                      {state.items.map((it) => (
                        <option key={it.id} value={it.name} />
                      ))}
                    </datalist>
                    <button type="button" className="btn-light" onClick={() => setForm({ lines: [...form.lines, blankLine()] })}>
                      + Another line
                    </button>
                  </div>
                ),
              },
            ]}
            footer={
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button type="button" className="btn-primary" disabled={busy} onClick={() => void submit()}>
                  {busy ? 'Raising…' : form.alreadySent ? 'Raise and mark sent' : 'Raise draft'}
                </button>
                {formError ? <span className="form-error">{formError}</span> : null}
              </div>
            }
          />
        </div>
      ) : null}

      <DataTable
        id="purchase-orders"
        columns={columns}
        rows={pos ?? []}
        rowKey={(p) => p.id}
        loading={pos === null && !error}
        error={error ? <span className="form-error">{error}</span> : undefined}
        empty="No purchase orders yet — raise the first one."
        onRowClick={(p) => setSelectedId(p.id === selectedId ? '' : p.id)}
      />

      {selected ? (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="section-head" style={{ display: 'flex', justifyContent: 'space-between' }}>
            <h3>
              {selected.number} · {vendorName(selected.vendorId)}
            </h3>
            <StatusBadge value={PO_WORDS[selected.status] ?? selected.status} />
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Material</th>
                <th className="num">Qty</th>
                <th>Unit</th>
                <th className="num">Rate</th>
              </tr>
            </thead>
            <tbody>
              {selected.lines.map((l, i) => (
                <tr key={i}>
                  <td>{l.item}</td>
                  <td className="num">{l.qty}</td>
                  <td>{l.uom}</td>
                  <td className="num">{l.rate}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {selected.receivedGrnIds.length ? (
            <p className="cell-sub">
              Receipts booked: {selected.receivedGrnIds.join(', ')}
            </p>
          ) : null}
          <div className="form-grid" style={{ marginTop: 8 }}>
            {legalTargets('purchaseOrder', selected.status).map((to) => {
              const guardNote = guardsRequired('purchaseOrder', selected.status, to)
                .map((g) => explainGuard(g))
                .filter(Boolean)
                .join(' ')
              return (
                <button
                  key={to}
                  type="button"
                  className="btn"
                  disabled={busy}
                  title={guardNote || undefined}
                  onClick={() => void move(selected, to as PurchaseOrderStatus)}
                >
                  Mark {PO_WORDS[to as PurchaseOrderStatus] ?? to}
                  {guardNote ? <small className="cell-sub"> — {guardNote}</small> : null}
                </button>
              )
            })}
          </div>
          {moveError ? <p className="form-error">{moveError}</p> : null}
        </div>
      ) : null}
    </div>
  )
}
