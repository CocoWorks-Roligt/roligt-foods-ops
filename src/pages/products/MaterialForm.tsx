import { useEffect, useState } from 'react'
import { Modal } from '../../components/Modal'
import { Select } from '../../components/Select'
import { useApp } from '../../context/AppContext'
import { UNITS, toggleVendor, type MaterialDraft } from './constants'
import { ChoiceOrOther, SupplierPicker } from './shared'
import type { PurchaseCategory, PurchaseProduct } from '../../types'

/**
 * Anything the plant buys in — produce, or the bottles and boxes a pack is made of.
 *
 * One form for both, because they are the same record with a different category, and
 * because it is opened from four places: the two "Add" buttons, the Edit button on a
 * card, and from inside the pack form when somebody needs a carton that does not
 * exist yet. The `initial` draft is what the caller decides; the form owns it from
 * the moment it opens.
 */
export function MaterialForm({
  open,
  editId,
  initial,
  onClose,
  onSaved,
}: {
  open: boolean
  /** Set while the form is correcting a product that already exists. */
  editId?: string
  initial: MaterialDraft
  /** Dismissed without saving. */
  onClose: () => void
  /** Saved. Kept apart from `onClose` because a material created from a pack's BOM
   *  row has to be handed back to that row, and a cancelled one must not be. */
  onSaved?: () => void
}) {
  const { state, addPurchaseProduct, updatePurchaseProduct } = useApp()
  const [form, setForm] = useState<MaterialDraft>(initial)

  useEffect(() => {
    if (open) setForm(initial)
  }, [initial, open])

  const packing = form.category === 'Packing Material'

  return (
    <Modal
      open={open}
      title={
        editId
          ? `Edit ${editId} · ${form.name}`
          : packing
            ? 'Add packing material'
            : 'Add raw material'
      }
      saveLabel={editId ? 'Save Changes' : 'Save'}
      onClose={onClose}
      onSave={() => {
        const ok = editId
          ? updatePurchaseProduct(editId, {
              name: form.name,
              uom: form.uom,
              description: form.description,
            })
          : addPurchaseProduct(form)
        if (ok) (onSaved || onClose)()
      }}
    >
      <div className="form-grid">
        <div className="field span-2">
          <label>Product name</label>
          <input
            value={form.name}
            placeholder="e.g. Tender Coconut, Dark Chocolate, 5 L BiB"
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
        </div>
        <div className="field">
          <label>Category</label>
          <Select
            value={form.category}
            onChange={(e) =>
              setForm((f) => ({ ...f, category: e.target.value as PurchaseCategory }))
            }
          >
            <option>Farm Produce</option>
            <option>Packing Material</option>
            <option>Other</option>
          </Select>
        </div>
        <div className="field">
          <label>Unit of measure</label>
          <ChoiceOrOther
            value={form.uom}
            options={UNITS}
            placeholder="What it is counted in — e.g. Bundle"
            onChange={(next) => setForm((f) => ({ ...f, uom: next }))}
          />
        </div>
        <div className="field span-3">
          <label>Description</label>
          <textarea
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          />
        </div>
        <div className="field span-3">
          <label>
            {packing ? 'Suppliers (optional)' : 'Suppliers (select one or more)'}
          </label>
          {!state.vendors.length ? (
            <div className={`note${packing ? '' : ' warning-note'}`}>
              {packing
                ? 'No suppliers yet — that is fine, a packing material can be linked to one later from the Suppliers button on its card.'
                : 'Add farmers/vendors first from the Suppliers page, then link them here.'}
            </div>
          ) : (
            <SupplierPicker
              showType
              selected={form.vendorIds}
              onToggle={(id) =>
                setForm((f) => ({ ...f, vendorIds: toggleVendor(f.vendorIds, id) }))
              }
            />
          )}
        </div>
      </div>
    </Modal>
  )
}

/** Changes only which suppliers a product is bought from. */
export function SupplierForm({
  product,
  onClose,
}: {
  product: PurchaseProduct | null
  onClose: () => void
}) {
  const { updatePurchaseProductVendors } = useApp()
  const [vendorIds, setVendorIds] = useState<string[]>([])

  useEffect(() => {
    if (product) setVendorIds([...(product.vendorIds || [])])
  }, [product])

  return (
    <Modal
      open={!!product}
      title={`Suppliers · ${product?.name || ''}`}
      saveLabel="Save Suppliers"
      onClose={onClose}
      onSave={() => {
        if (!product) return
        updatePurchaseProductVendors(product.id, vendorIds)
        onClose()
      }}
    >
      <SupplierPicker
        selected={vendorIds}
        onToggle={(id) => setVendorIds((ids) => toggleVendor(ids, id))}
      />
    </Modal>
  )
}
