import { useEffect, useState } from 'react'
import { Modal } from '../../components/Modal'
import { Select } from '../../components/Select'
import { useApp } from '../../context/AppContext'
import { isByProduct } from '../../lib/posting'
import type { Item } from '../../types'

const blank = { name: '', uom: 'Litre', byProduct: false }

/**
 * A bulk product: what an extraction presses out.
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
  const { addBulkProduct, updateBulkProduct } = useApp()
  const [bulk, setBulk] = useState(blank)

  useEffect(() => {
    if (!open) return
    setBulk(
      editing
        ? { name: editing.name, uom: editing.uom, byProduct: isByProduct(editing) }
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
        const payload = { name: bulk.name, uom: bulk.uom, byProduct: bulk.byProduct }
        const ok = editing ? updateBulkProduct(editing.id, payload) : addBulkProduct(payload)
        if (ok) onClose()
      }}
    >
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
      </div>
      <div className="note">
        A production batch books its output against a bulk product, a melange blends them, and a
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
