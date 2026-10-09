import { useEffect, useMemo, useState } from 'react'
import { Modal } from '../../components/Modal'
import { Select } from '../../components/Select'
import { useApp } from '../../context/AppContext'
import { bulkItems } from '../../lib/batches'
import {
  PACK_UNITS,
  bulkUomForUnit,
  drinkName,
  packDefs,
  packKeyOfDef,
  toBase,
  type PackDef,
} from '../../lib/packs'
import { NEW_MATERIAL, PACK_TYPES } from './constants'
import { suggestBom } from './packTemplates'
import { ChoiceOrOther } from './shared'
import type { BomLine, PackUnit } from '../../types'
import { bareAll, keyed, keyedAll, type Keyed } from '../../lib/rows'

/**
 * One recipe row: either an existing member SKU (`skuId` set) or a bulk being newly
 * assigned. Everything else on the row is that SKU's own commercial detail — the
 * physical pack is shared by every row and lives above them.
 */
interface RecipeDraft {
  skuId?: string
  bulkItem: string
  name: string
  shelfLifeDays: number | ''
  chilledShelfLifeDays: number | ''
  mrp: number | ''
}

const blankRecipe = (bulkItem = ''): RecipeDraft => ({
  bulkItem,
  name: '',
  shelfLifeDays: 90,
  chilledShelfLifeDays: 7,
  mrp: '',
})

const blank = {
  name: '',
  type: 'BiB',
  size: '' as number | '',
  unit: 'L' as PackUnit,
  bom: [] as Keyed<BomLine>[],
  recipes: [] as Keyed<RecipeDraft>[],
}

/** A material created from inside this form, and the BOM row it was created for. */
export interface FilledMaterial {
  idx: number
  itemId: string
}

/**
 * A pack: one physical format — 5 L BiB, 4 × 250 ml bottle — with the recipes
 * (bulks) filled into it. The pack is created once here and the recipes are
 * assigned inside it; the physical format is never re-entered per recipe.
 *
 * The one form on this page that is not self-contained. Its bill of materials can
 * only pick a packing material that already exists, so adding a carton used to mean
 * abandoning a half-filled pack — the row can now open the material form over this
 * one, and `fillMaterial` is that material coming back. That coupling is real, and
 * it is a named prop rather than shared mutable state so it can be seen.
 */
export function PackDefForm({
  open,
  editing,
  onClose,
  seedBulk,
  onNewMaterial,
  fillMaterial,
  onMaterialFilled,
}: {
  open: boolean
  editing?: PackDef
  onClose: () => void
  /** Bulk to pre-assign as a new pack's first recipe — the run form's quick-create
   *  names the bulk it was filling from, so the pack comes out already holding it. */
  seedBulk?: string
  /** Asks the page to open the packing-material form for BOM row `idx`. */
  onNewMaterial: (idx: number) => void
  fillMaterial: FilledMaterial | null
  onMaterialFilled: () => void
}) {
  const { state, savePack } = useApp()
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
            bom: keyedAll(editing.bom),
            recipes: keyedAll(
              editing.members.map((m) => ({
                skuId: m.id,
                bulkItem: m.bulkItem || '',
                name: m.name,
                shelfLifeDays: m.shelfLifeDays,
                chilledShelfLifeDays: m.chilledShelfLifeDays ?? 7,
                mrp: m.mrp ?? '',
              })),
            ),
          }
        : { ...blank, recipes: [keyed(blankRecipe(seedBulk || ''))] },
    )
    // Only when the dialog opens: re-seeding while somebody is typing would throw
    // away what they had entered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing?.key, seedBulk])

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
  /** The typical set for this format, from materials that already exist. */
  const suggested = useMemo(() => suggestBom(pmItems, pack.type), [pmItems, pack.type])
  const allBulks = useMemo(() => bulkItems(state), [state])
  // A pack sized in litres can only be filled from a bulk counted in litres, so the
  // unit narrows the list rather than the admin having to keep the two in agreement.
  const packBulkUom = bulkUomForUnit(pack.unit)
  const packBulks = allBulks.filter((b) => b.uom === packBulkUom)
  // Each recipe is one bulk, so the assign list offers only bulks the pack does not
  // already hold — a bulk cannot be filled into the same pack twice.
  const heldBulks = new Set(pack.recipes.map((r) => r.bulkItem).filter(Boolean))
  const freeBulks = packBulks.filter((b) => !heldBulks.has(b.id))
  const packHolds = toBase(Number(pack.size) || 0, pack.unit)

  /** Saving with the same name/type/size/unit as an existing pack does not create a
   *  second pack — the recipes join that one. Said here, so it reads as the feature
   *  it is rather than a surprise after the save. */
  const mergesInto = useMemo(() => {
    if (!pack.name.trim() || !(Number(pack.size) > 0)) return undefined
    const key = packKeyOfDef(pack.name.trim(), pack.type.trim(), Number(pack.size), pack.unit)
    return packDefs(state.products).find((d) => d.key === key && d.key !== editing?.key)
  }, [pack.name, pack.type, pack.size, pack.unit, state.products, editing?.key])

  /** "10 pouches, 10 caps" — what `ofThese` packs of the linked materials add up to,
   *  in the same words the run's preview will say, so the two screens rhyme. */
  const bomSummary = (ofThese: number) => {
    const rows = pack.bom.filter((b) => b.item && b.qty > 0)
    if (!rows.length) return ''
    return rows
      .map((b) => {
        const name = pmItems.find((i) => i.id === b.item)?.name || b.item
        const qty = b.qty * ofThese
        return `${Number(qty.toFixed(3))} ${name}`
      })
      .join(', ')
  }

  /** A member that has already been packed carries stock history — removing it would
   *  delete that history, so the row is kept and the × says why it will not move. */
  const packedMember = (skuId?: string) =>
    !!(skuId && state.ledger.some((l) => l.item === skuId))

  const payload = () => ({
    name: pack.name,
    type: pack.type,
    size: Number(pack.size) || 0,
    unit: pack.unit,
    bom: bareAll(pack.bom.filter((b) => b.item && b.qty > 0)),
    recipes: pack.recipes
      .filter((r) => r.bulkItem)
      .map((r) => ({
        ...(r.skuId ? { skuId: r.skuId } : {}),
        bulkItem: r.bulkItem,
        name: r.name,
        shelfLifeDays: Number(r.shelfLifeDays) || 0,
        chilledShelfLifeDays: Number(r.chilledShelfLifeDays) || 0,
        mrp: Number(r.mrp) || 0,
      })),
  })

  return (
    <Modal
      open={open}
      title={editing ? `Edit pack · ${editing.name}` : 'Add Pack'}
      saveLabel={editing ? 'Save Changes' : 'Save Pack'}
      onClose={onClose}
      onSave={() => {
        const ok = savePack(editing?.key ?? null, payload())
        if (ok) onClose()
      }}
    >
      <div className="form-grid">
        <div className="field span-2">
          <label>Pack name</label>
          <input
            value={pack.name}
            placeholder="e.g. 5 L BiB, 4 × 250 ml bottle, 3 kg cover"
            onChange={(e) => setPack((f) => ({ ...f, name: e.target.value }))}
          />
          <div className="small">
            One pack, created once — recipes are assigned inside it below. Two packs with
            the same name, type, size and unit are the same pack.
          </div>
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
          <div className="small">Total the pack holds — 480 for a 4 × 120 ml bottle.</div>
        </div>
        <div className="field">
          <label>Unit</label>
          <Select
            value={pack.unit}
            onChange={(e) => {
              const unit = e.target.value as PackUnit
              // Switching between a volume and a weight changes which bulks can fill
              // the pack at all, so recipe rows that no longer fit leave the list —
              // the bulk they name cannot be poured into a pack sized in the new unit.
              setPack((f) => ({
                ...f,
                unit,
                recipes: f.recipes.filter((r) =>
                  allBulks.some(
                    (b) => b.id === r.bulkItem && b.uom === bulkUomForUnit(unit),
                  ),
                ),
              }))
            }}
          >
            {PACK_UNITS.map((u) => (
              <option key={u.value} value={u.value}>
                {u.label}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="subform">
        <div className="subform-head">
          <span>What one pack is made of</span>
          {/* The usual set for the format, filled in from materials that exist — an
              empty grid asked the admin to know a BiB takes a pouch and a cap. */}
          {!pack.bom.length && suggested.length ? (
            <button
              className="btn btn-light"
              type="button"
              onClick={() => setPack((f) => ({ ...f, bom: keyedAll(suggested) }))}
            >
              Prefill {pack.type} set
            </button>
          ) : null}
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
              Nothing linked yet — this pack would consume no material when it is filled. Add a
              row and pick or create each material, so filling it draws the right stock.
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

      <div className="subform">
        <div className="subform-head">
          <span>Recipes filled into this pack</span>
          <button
            className="btn btn-light"
            type="button"
            disabled={!freeBulks.length}
            onClick={() =>
              setPack((f) => ({ ...f, recipes: [...f.recipes, keyed(blankRecipe())] }))
            }
          >
            + Assign a recipe
          </button>
        </div>
        <div className="subform-body">
          <div className="subform-row recipe-row pack-row-head">
            <span>Recipe (bulk)</span>
            <span>Finished SKU</span>
            <span>Frozen (days)</span>
            <span>Chilled (days)</span>
            <span>MRP (₹)</span>
            <span />
          </div>
          {pack.recipes.map((row, idx) => {
            const update = (patch: Partial<RecipeDraft>) =>
              setPack((f) => ({
                ...f,
                recipes: f.recipes.map((r, i) => (i === idx ? { ...r, ...patch } : r)),
              }))
            const removable = !packedMember(row.skuId)
            return (
              <div className="subform-row recipe-row" key={row.rowId}>
                {row.skuId ? (
                  // A member's bulk is fixed: its stock history was costed in it, and
                  // moving a recipe between bulks is unassign + assign, not an edit.
                  <input
                    disabled
                    value={allBulks.find((b) => b.id === row.bulkItem)?.name || row.bulkItem}
                  />
                ) : (
                  <Select
                    value={row.bulkItem}
                    onChange={(e) => {
                      const bulk = allBulks.find((b) => b.id === e.target.value)
                      update({
                        bulkItem: e.target.value,
                        // "Coconut Water (bulk)" reads as Coconut Water — the natural
                        // SKU name, offered once and still theirs to retype.
                        name: row.name || (bulk ? drinkName(bulk.name) : ''),
                      })
                    }}
                  >
                    <option value="">Select bulk</option>
                    {freeBulks.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </Select>
                )}
                <input
                  placeholder="SKU name"
                  value={row.name}
                  onChange={(e) => update({ name: e.target.value })}
                />
                {/* Two clocks, because the pack has two lives: months in the freezer,
                    days once it leaves. The frozen one is what stock expires on. */}
                <input
                  type="number"
                  min="1"
                  value={row.shelfLifeDays}
                  onChange={(e) =>
                    update({
                      shelfLifeDays: e.target.value === '' ? '' : Number(e.target.value),
                    })
                  }
                />
                <input
                  type="number"
                  min="1"
                  value={row.chilledShelfLifeDays}
                  onChange={(e) =>
                    update({
                      chilledShelfLifeDays: e.target.value === '' ? '' : Number(e.target.value),
                    })
                  }
                />
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  value={row.mrp}
                  onChange={(e) =>
                    update({ mrp: e.target.value === '' ? '' : Number(e.target.value) })
                  }
                />
                <button
                  className="btn btn-danger"
                  type="button"
                  disabled={!removable}
                  title={
                    removable
                      ? undefined
                      : 'Already packed — it has stock history and cannot be removed. Retire the pack instead.'
                  }
                  onClick={() =>
                    setPack((f) => ({
                      ...f,
                      recipes: f.recipes.filter((_, i) => i !== idx),
                    }))
                  }
                >
                  ×
                </button>
              </div>
            )
          })}
          {!freeBulks.length ? (
            <div className="small" style={{ marginTop: 8 }}>
              {packBulks.length
                ? `Every bulk measured in ${packBulkUom.toLowerCase()} is already a recipe of this pack.`
                : `Nothing is measured in ${packBulkUom.toLowerCase()} yet, so a pack sized in ${pack.unit} has nothing to draw from. Add a bulk product first.`}
            </div>
          ) : null}
        </div>
      </div>

      {mergesInto ? (
        <div className="note">
          This matches <b>{mergesInto.name}</b> as it already stands — saving adds these recipes
          to that pack instead of creating a second one.
        </div>
      ) : !packBulks.length ? (
        <div className="note warning-note">
          Nothing is measured in {packBulkUom.toLowerCase()} yet, so a pack sized in {pack.unit} has
          nothing to draw from. Add a bulk product above first.
        </div>
      ) : (
        <div className="note">
          Sized in {pack.unit}, so one pack holds{' '}
          <b>
            {packHolds} {packBulkUom === 'Kg' ? 'kg' : 'L'}
          </b>{' '}
          of whichever recipe is filled into it. Filling 10 of them draws{' '}
          {Number((packHolds * 10).toFixed(3))} {packBulkUom === 'Kg' ? 'kg' : 'L'} from the batch
          {bomSummary(10) ? ` and uses ${bomSummary(10)}.` : '.'}
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
