import { useEffect, useState } from 'react'
import { Modal } from '../../components/Modal'
import { Select } from '../../components/Select'
import { useApp } from '../../context/AppContext'
import { extractableItems, sourceItemOf } from '../../lib/batches'
import { isByProduct } from '../../lib/posting'
import type { Item } from '../../types'

const blank = { name: '', uom: 'Litre', byProduct: false, sourceItem: '', qc: true }

/**
 * A bulk product: what an extraction presses out of one raw material. A raw material
 * can give several — tender coconut gives water and, as a by-product, malai — but each
 * bulk comes off exactly one, and only off one the plant extracts.
 *
 * Self-contained — nothing else on the page reaches into this form — so it owns its
 * own draft rather than having it held for it by a parent that does not care.
 */
export function BulkProductForm({
  open,
  editing,
  onClose,
}: {
  open: boolean
  editing?: Item
  onClose: () => void
}) {
  const { state, addBulkProduct, updateBulkProduct } = useApp()
  const [bulk, setBulk] = useState(blank)

  /** Raw materials a bulk can come off. A bulk's own source is always among them: a raw
   *  material cannot be switched to "used as bought" while a bulk is extracted from it. */
  const sources = extractableItems(state)

  useEffect(() => {
    if (!open) return
    setBulk(
      editing
        ? {
            name: editing.name,
            uom: editing.uom,
            byProduct: isByProduct(editing),
            sourceItem: sourceItemOf(editing) || '',
            qc: !editing.qcExempt,
          }
        : { ...blank },
    )
  }, [editing, open])

  return (
    <Modal
      open={open}
      title={editing ? `Edit ${editing.id} · ${editing.name}` : 'Add Bulk Product'}
      saveLabel={editing ? 'Save Changes' : 'Save Bulk Product'}
      onClose={onClose}
      onSave={() => {
        const payload = {
          name: bulk.name,
          uom: bulk.uom,
          byProduct: bulk.byProduct,
          sourceItem: bulk.sourceItem,
          qcExempt: !bulk.qc,
        }
        const ok = editing ? updateBulkProduct(editing.id, payload) : addBulkProduct(payload)
        if (ok) onClose()
      }}
    >
      {sources.length ? null : (
        <div className="note warning-note">
          No raw material needs extraction yet. Add one under Raw materials with “Needs
          extraction” ticked — a bulk is always pressed out of one.
        </div>
      )}
      <div className="form-grid">
        <div className="field span-2">
          <label>Bulk name</label>
          <input
            value={bulk.name}
            placeholder="e.g. Beetroot Juice (bulk), Apple Pulp (bulk)"
            onChange={(e) => setBulk((f) => ({ ...f, name: e.target.value }))}
          />
        </div>
        <div className="field">
          <label>Measured in</label>
          <Select value={bulk.uom} onChange={(e) => setBulk((f) => ({ ...f, uom: e.target.value }))}>
            <option value="Litre">Litre</option>
            <option value="Kg">Kilogram</option>
          </Select>
        </div>
        <div className="field span-2">
          <label>What a batch makes this as</label>
          <Select
            value={bulk.byProduct ? 'by' : 'main'}
            onChange={(e) => setBulk((f) => ({ ...f, byProduct: e.target.value === 'by' }))}
          >
            <option value="main">Main output — carries the batch cost</option>
            <option value="by">By-product — carries no cost</option>
          </Select>
        </div>
        <div className="field">
          <label>Extracted from</label>
          <Select
            value={bulk.sourceItem}
            onChange={(e) => setBulk((f) => ({ ...f, sourceItem: e.target.value }))}
          >
            <option value="">Select raw material</option>
            {sources.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="field span-3">
          <label className="check-row">
            <input
              type="checkbox"
              checked={bulk.qc}
              onChange={(e) => setBulk((f) => ({ ...f, qc: e.target.checked }))}
            />
            Goes through QC
          </label>
          <div className="small">
            {bulk.qc
              ? 'Each lot a batch makes waits in quarantine for a QC record to release it.'
              : 'Lots are released the moment the batch is booked — no QC record is raised.'}
            {editing && !!editing.qcExempt !== !bulk.qc
              ? ' The change applies from the next batch; lots already made keep the decision they were booked under.'
              : ''}
          </div>
        </div>
      </div>
      <div className="note">
        A production batch books its output against a bulk product, a blend mixes them, and a
        pack product is filled from one. Juice and water are measured in litres, malai and pulp by
        weight. A <b>by-product</b> is what a pressing throws off alongside the thing it was for —
        malai beside coconut water, pomace beside beetroot juice. It carries none of the batch
        cost, so the main output&rsquo;s cost per litre does not move with how much of it a batch
        happens to yield.
      </div>
      {editing ? (
        <div className="note warning-note">
          Once this bulk has stock history its unit is fixed — the ledger already counted it that
          way and is never rewritten. The name can always be corrected.
        </div>
      ) : null}
    </Modal>
  )
}
