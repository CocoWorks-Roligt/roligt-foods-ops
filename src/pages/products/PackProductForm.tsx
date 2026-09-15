import { useEffect, useMemo, useState } from 'react'
import { Modal } from '../../components/Modal'
import { Select } from '../../components/Select'
import { useApp } from '../../context/AppContext'
import { bulkItems } from '../../lib/batches'
import { PACK_UNITS, bulkItemOf, bulkUomForUnit, toBase } from '../../lib/packs'
import { NEW_MATERIAL, PACK_TYPES } from './constants'
import { ChoiceOrOther } from './shared'
import type { BomLine, PackUnit, Product } from '../../types'
import { bareAll, keyed, keyedAll, type Keyed } from '../../lib/rows'

const blank = {
  name: '',
  type: 'BiB',
  size: '' as number | '',
  unit: 'L' as PackUnit,
  bulkItem: '',
  shelfLifeDays: 90 as number | '',
  chilledShelfLifeDays: 7 as number | '',
  mrp: '' as number | '',
  bom: [] as Keyed<BomLine>[],
}

/** A material created from inside this form, and the BOM row it was created for. */
export interface FilledMaterial {
  idx: number
  itemId: string
}

/**
 * A pack product: the finished-goods SKU a packing run fills.
 *
 * The one form on this page that is not self-contained. Its bill of materials can
 * only pick a packing material that already exists, so adding a carton used to mean
 * abandoning a half-filled pack form — the row can now open the material form over
 * this one, and `fillMaterial` is that material coming back. That coupling is real,
 * and it is a named prop rather than shared mutable state so it can be seen.
 */
export function PackProductForm({
  open,
  editing,
  onClose,
  onNewMaterial,
  fillMaterial,
  onMaterialFilled,
}: {
  open: boolean
  editing?: Product
  onClose: () => void
  /** Asks the page to open the packing-material form for BOM row `idx`. */
  onNewMaterial: (idx: number) => void
  fillMaterial: FilledMaterial | null
  onMaterialFilled: () => void
}) {
  const { state, addProduct, updateProduct } = useApp()
  const [pack, setPack] = useState(blank)

  useEffect(() => {
    if (!open) return
    setPack(
      editing
        ? {
            name: editing.name,
            type: editing.type,
            size: editing.size,
            unit: editing.unit,
            bulkItem: bulkItemOf(editing),
            shelfLifeDays: editing.shelfLifeDays,
            chilledShelfLifeDays: editing.chilledShelfLifeDays ?? 7,
            mrp: editing.mrp ?? '',
            bom: keyedAll(editing.bom),
          }
        : { ...blank, bom: [] },
    )
    // Only when the dialog opens: re-seeding while somebody is typing would throw
    // away what they had entered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing?.id])

  // The material lands in state a render after it is saved, so the row it was created
  // for is filled in here rather than at the call site.
  useEffect(() => {
    if (!fillMaterial) return
    setPack((f) => ({
      ...f,
      bom: f.bom.map((b, i) => (i === fillMaterial.idx ? { ...b, item: fillMaterial.itemId } : b)),
    }))
    onMaterialFilled()
  }, [fillMaterial, onMaterialFilled])

  const pmItems = state.items.filter((i) => i.type === 'Packing Material')
  const allBulks = useMemo(() => bulkItems(state), [state])
  // A pack sized in litres can only be filled from a bulk counted in litres, so the
  // unit narrows the list rather than the admin having to keep the two in agreement.
  const packBulkUom = bulkUomForUnit(pack.unit)
  const packBulks = allBulks.filter((b) => b.uom === packBulkUom)
  const packBulk = allBulks.find((b) => b.id === pack.bulkItem)
  const packHolds = toBase(Number(pack.size) || 0, pack.unit)

  const payload = () => ({
    name: pack.name,
    type: pack.type,
    size: Number(pack.size) || 0,
    unit: pack.unit,
    bulkItem: pack.bulkItem,
    shelfLifeDays: Number(pack.shelfLifeDays) || 0,
    chilledShelfLifeDays: Number(pack.chilledShelfLifeDays) || 0,
    mrp: Number(pack.mrp) || 0,
    bom: bareAll(pack.bom.filter((b) => b.item && b.qty > 0)),
  })

  return (
    <Modal
      open={open}
      title={editing ? `Edit ${editing.id} · ${editing.name}` : 'Add Pack Product'}
      saveLabel={editing ? 'Save Changes' : 'Save Pack Product'}
      onClose={onClose}
      onSave={() => {
        const ok = editing ? updateProduct(editing.id, payload()) : addProduct(payload())
        if (ok) onClose()
      }}
    >
      <div className="form-grid">
        <div className="field span-2">
          <label>Pack name</label>
          <input
            value={pack.name}
            placeholder="e.g. OG TCW 5 L, Malai Cover 3 kg"
            onChange={(e) => setPack((f) => ({ ...f, name: e.target.value }))}
          />
        </div>
        <div className="field">
          <label>Pack type</label>
          <ChoiceOrOther
            value={pack.type}
            options={PACK_TYPES}
            placeholder="What the pack is — e.g. Jar"
            onChange={(next) => setPack((f) => ({ ...f, type: next }))}
          />
        </div>
        <div className="field">
          <label>Size of one pack</label>
          <input
            type="number"
            min="0"
            step="0.01"
            placeholder="5"
            value={pack.size}
            onChange={(e) =>
              setPack((f) => ({ ...f, size: e.target.value === '' ? '' : Number(e.target.value) }))
            }
          />
        </div>
        <div className="field">
          <label>Unit</label>
          <Select
            value={pack.unit}
            onChange={(e) => {
              const unit = e.target.value as PackUnit
              // Switching between a volume and a weight changes which bulks are even
              // possible, so a selection that no longer fits is dropped rather than
              // left behind to fail validation on save.
              setPack((f) => {
                const stillValid = allBulks.some(
                  (b) => b.id === f.bulkItem && b.uom === bulkUomForUnit(unit),
                )
                return { ...f, unit, bulkItem: stillValid ? f.bulkItem : '' }
              })
            }}
          >
            {PACK_UNITS.map((u) => (
              <option key={u.value} value={u.value}>
                {u.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="field span-2">
          <label>Filled from</label>
          <Select
            value={pack.bulkItem}
            onChange={(e) => setPack((f) => ({ ...f, bulkItem: e.target.value }))}
          >
            <option value="">Select bulk product</option>
            {packBulks.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </div>
        {/* Two clocks, because the pack has two lives: months in the freezer, days
            once it leaves. The frozen one is what stock actually expires on. */}
        <div className="field">
          <label>Frozen shelf life (days)</label>
          <input
            type="number"
            min="1"
            value={pack.shelfLifeDays}
            onChange={(e) =>
              setPack((f) => ({
                ...f,
                shelfLifeDays: e.target.value === '' ? '' : Number(e.target.value),
              }))
            }
          />
          <div className="small">From packing. This is what the stock expires on.</div>
        </div>
        <div className="field">
          <label>Chilled shelf life (days)</label>
          <input
            type="number"
            min="1"
            value={pack.chilledShelfLifeDays}
            onChange={(e) =>
              setPack((f) => ({
                ...f,
                chilledShelfLifeDays: e.target.value === '' ? '' : Number(e.target.value),
              }))
            }
          />
          <div className="small">From the dispatch label. Printed there, never on stock.</div>
        </div>
        <div className="field">
          <label>MRP (₹)</label>
          <input
            type="number"
            min="0"
            step="0.01"
            placeholder="0.00"
            value={pack.mrp}
            onChange={(e) =>
              setPack((f) => ({ ...f, mrp: e.target.value === '' ? '' : Number(e.target.value) }))
            }
          />
          <div className="small">Printed on the dispatch label.</div>
        </div>
      </div>

      <div className="subform">
        <div className="subform-head">
          <span>Packing material per pack</span>
          <button
            className="btn btn-light"
            type="button"
            onClick={() => setPack((f) => ({ ...f, bom: [...f.bom, keyed({ item: '', qty: 1 })] }))}
          >
            + Add material
          </button>
        </div>
        <div className="subform-body">
          {!pack.bom.length ? (
            <div className="small">
              Nothing linked yet — a pack with no material consumes none when it is filled.
            </div>
          ) : (
            pack.bom.map((line, idx) => (
              <div className="subform-row" key={line.rowId}>
                <Select
                  value={line.item}
                  onChange={(e) => {
                    if (e.target.value === NEW_MATERIAL) {
                      onNewMaterial(idx)
                      return
                    }
                    setPack((f) => ({
                      ...f,
                      bom: f.bom.map((b, i) => (i === idx ? { ...b, item: e.target.value } : b)),
                    }))
                  }}
                >
                  <option value="">Select packing material</option>
                  {pmItems.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.id} · {i.name}
                    </option>
                  ))}
                  <option value={NEW_MATERIAL}>+ Create a new packing material…</option>
                </Select>
                <input
                  type="number"
                  min="0"
                  step="1"
                  placeholder="Qty"
                  value={line.qty || ''}
                  onChange={(e) =>
                    setPack((f) => ({
                      ...f,
                      bom: f.bom.map((b, i) =>
                        i === idx ? { ...b, qty: Number(e.target.value) } : b,
                      ),
                    }))
                  }
                />
                <span className="subform-unit">per pack</span>
                <button
                  className="btn btn-danger"
                  type="button"
                  onClick={() => setPack((f) => ({ ...f, bom: f.bom.filter((_, i) => i !== idx) }))}
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {!packBulks.length ? (
        <div className="note warning-note">
          Nothing is measured in {packBulkUom.toLowerCase()} yet, so a pack sized in {pack.unit} has
          nothing to draw from. Add a bulk product above first.
        </div>
      ) : (
        <div className="note">
          Sized in {pack.unit}, so this pack holds{' '}
          <b>
            {packHolds} {packBulkUom === 'Kg' ? 'kg' : 'L'}
          </b>{' '}
          of <b>{packBulk?.name || 'the bulk you pick'}</b> each. Filling 10 of them would draw{' '}
          {Number((packHolds * 10).toFixed(3))} {packBulkUom === 'Kg' ? 'kg' : 'L'} from the batch.
        </div>
      )}
      {editing ? (
        <div className="note warning-note">
          Packing runs already posted keep the size they were filled at — changing it here only
          affects runs from now on.
        </div>
      ) : null}
    </Modal>
  )
}
