/**
 * Melange recipes — a master, so it lives with the other masters rather than on the
 * page where blends are run.
 *
 * A recipe owns its own bulk product: saving one creates the semi-finished item the
 * blend is booked as, which is why it belongs beside Bulk on the item master and not
 * next to the runs. It used to sit on the Melanges page, which meant a bulk product
 * could be born in two different places and each had to rename the other to stay in
 * step.
 */

import { useMemo, useState } from 'react'
import { Modal } from '../components/Modal'
import { Select } from '../components/Select'
import { StatusBadge } from '../components/StatusBadge'
import { useApp } from '../context/AppContext'
import { bulkItems, fmtBulk } from '../lib/batches'
import { DRAWABLE } from '../lib/posting'
import { itemName as lookupItemName, poolByLot } from '../lib/stock'
import { QTY_EPSILON } from '../lib/utils'
import type { Melange, MelangeComponent } from '../types'
import { keyed, keyedAll, type Keyed } from '../lib/rows'

interface CompRow {
  item: string
  share: number | ''
}

const num = (v: number | '') => Number(v) || 0

const blankRecipe = {
  name: '',
  uom: 'Litre',
  description: '',
  components: [] as Keyed<CompRow>[],
}

export function MelangeRecipes() {
  const { state, rows, addMelange, updateMelange, setMelangeStatus, deleteMelange } = useApp()
  const [open, setOpen] = useState(false)
  const [editId, setEditId] = useState('')
  const [recipe, setRecipe] = useState(blankRecipe)

  const itemName = (id: string) => lookupItemName(state, id)
  const bulks = useMemo(() => bulkItems(state), [state])

  /** Same rule the posting engine enforces: a blend cannot list itself as a part. */
  const recipeBulks = useMemo(() => {
    const own = state.melanges.find((m) => m.id === editId)?.outputItem
    return own ? bulks.filter((b) => b.id !== own) : bulks
  }, [bulks, editId, state.melanges])

  const onHand = useMemo(
    () =>
      poolByLot(
        rows.filter(
          (r) =>
            r.itemType === 'Semi Finished' && DRAWABLE.includes(r.status) && r.qty > QTY_EPSILON,
        ),
      ),
    [rows],
  )
  const onHandOf = (item: string) =>
    onHand.filter((r) => r.item === item).reduce((a, b) => a + b.qty, 0)

  const openNew = () => {
    setEditId('')
    // A blend takes at least two components, so the form opens with two empty rows.
    setRecipe({
      ...blankRecipe,
      components: [keyed({ item: '', share: '' as number | '' }), keyed({ item: '', share: '' as number | '' })],
    })
    setOpen(true)
  }

  const openEdit = (m: Melange) => {
    setEditId(m.id)
    setRecipe({
      name: m.name,
      uom: m.uom,
      description: m.description,
      components: keyedAll(m.components.map((c) => ({ item: c.item, share: c.share }))),
    })
    setOpen(true)
  }

  const payload = () => ({
    name: recipe.name,
    uom: recipe.uom,
    description: recipe.description,
    components: recipe.components
      .filter((c) => c.item && num(c.share) > 0)
      .map((c) => ({ item: c.item, share: num(c.share) }) as MelangeComponent),
  })

  const shareTotal = recipe.components.reduce((a, c) => a + num(c.share), 0)

  return (
    <>
      <div className="card products-panel">
        <div className="section-head">
          <div>
            <h3>Melanges (blends)</h3>
            <span>
              A recipe for blending the bulks above into one — ABC is apple, beetroot and carrot
              in fixed shares. Each recipe is its own bulk product, so packs can be filled from it.
            </span>
          </div>
          <div className="section-head-actions">
            <button className="btn btn-primary" onClick={openNew}>
              + Add Melange
            </button>
          </div>
        </div>

        {!state.melanges.length ? (
          <div className="empty vendors-empty">
            No melanges yet. Add one — name it ABC Juice, pick the bulks it blends and the share of
            each — and it becomes its own bulk product you can blend, test and pack.
          </div>
        ) : (
          <div className="vendor-grid">
            {state.melanges.map((m) => {
              const blended = state.batches.some((b) => b.melangeId === m.id)
              return (
                <article className="vendor-card product-card" key={m.id}>
                  <div className="vendor-card-top">
                    <div className="vendor-card-title">
                      <h4>{m.name}</h4>
                      <div className="small">
                        {m.id} · measured in {m.uom}
                      </div>
                    </div>
                    <StatusBadge value={m.status} />
                  </div>
                  {m.description ? <p className="vendor-notes">{m.description}</p> : null}
                  <div className="chip-row">
                    <span className="chip-row-label">Blends</span>
                    <div className="supplier-chips">
                      {m.components.map((c) => (
                        <span className="supplier-chip" key={c.item}>
                          {c.share}% {itemName(c.item)}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="small">
                    Booked as <b>{itemName(m.outputItem)}</b> · {fmtBulk(onHandOf(m.outputItem), m.uom)}{' '}
                    on hand
                  </div>
                  <div className="row-actions">
                    <button className="btn btn-light" type="button" onClick={() => openEdit(m)}>
                      Edit
                    </button>
                    <button
                      className="btn btn-light"
                      type="button"
                      onClick={() =>
                        setMelangeStatus(m.id, m.status === 'Active' ? 'Inactive' : 'Active')
                      }
                    >
                      {m.status === 'Active' ? 'Deactivate' : 'Reactivate'}
                    </button>
                    <button
                      className="btn btn-danger"
                      type="button"
                      title={blended ? 'Already blended — has run history' : undefined}
                      onClick={() => {
                        if (confirm(`Delete ${m.name}?`)) deleteMelange(m.id)
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </div>

      <Modal
        open={open}
        title={editId ? `Edit ${editId}` : 'Add Melange'}
        saveLabel={editId ? 'Save Changes' : 'Save Melange'}
        onClose={() => {
          setOpen(false)
          setEditId('')
        }}
        onSave={() => {
          const ok = editId ? updateMelange(editId, payload()) : addMelange(payload())
          if (ok) {
            setOpen(false)
            setEditId('')
          }
        }}
      >
        <div className="form-grid">
          <div className="field span-2">
            <label>Melange name</label>
            <input
              value={recipe.name}
              placeholder="e.g. ABC Juice"
              onChange={(e) => setRecipe((f) => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div className="field">
            <label>Measured in</label>
            <Select
              value={recipe.uom}
              onChange={(e) => setRecipe((f) => ({ ...f, uom: e.target.value }))}
            >
              <option value="Litre">Litre</option>
              <option value="Kg">Kilogram</option>
            </Select>
          </div>
          <div className="field span-3">
            <label>Description</label>
            <textarea
              value={recipe.description}
              placeholder="What it is, who it is for, anything the floor should know"
              onChange={(e) => setRecipe((f) => ({ ...f, description: e.target.value }))}
            />
          </div>
        </div>

        <div className="subform">
          <div className="subform-head">
            <span>Components</span>
            <button
              className="btn btn-light"
              type="button"
              onClick={() =>
                setRecipe((f) => ({ ...f, components: [...f.components, keyed({ item: '', share: '' })] }))
              }
            >
              + Add component
            </button>
          </div>
          <div className="subform-body">
            {!bulks.length ? (
              <div className="note warning-note">
                No bulk product exists yet. Add one in the <b>Bulk</b> section above and it appears
                here.
              </div>
            ) : null}
            {recipe.components.map((c, idx) => (
              <div className="subform-row" key={c.rowId}>
                <Select
                  value={c.item}
                  onChange={(e) =>
                    setRecipe((f) => ({
                      ...f,
                      components: f.components.map((x, i) =>
                        i === idx ? { ...x, item: e.target.value } : x,
                      ),
                    }))
                  }
                >
                  <option value="">Select bulk product</option>
                  {recipeBulks
                    // A bulk already on another line cannot be a second component —
                    // one blend, one share per bulk.
                    .filter(
                      (b) =>
                        b.id === c.item ||
                        !recipe.components.some((x, i) => i !== idx && x.item === b.id),
                    )
                    .map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name} ({b.uom})
                      </option>
                    ))}
                </Select>
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  placeholder="Share %"
                  value={c.share}
                  onChange={(e) =>
                    setRecipe((f) => ({
                      ...f,
                      components: f.components.map((x, i) =>
                        i === idx
                          ? { ...x, share: e.target.value === '' ? '' : Number(e.target.value) }
                          : x,
                      ),
                    }))
                  }
                />
                <span className="subform-unit">% of blend</span>
                <button
                  className="btn btn-danger"
                  type="button"
                  onClick={() =>
                    setRecipe((f) => ({
                      ...f,
                      components: f.components.filter((_, i) => i !== idx),
                    }))
                  }
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className={`note${Math.abs(shareTotal - 100) > 0.01 ? ' warning-note' : ''}`}>
          Shares total <b>{Number(shareTotal.toFixed(2))}%</b>
          {Math.abs(shareTotal - 100) > 0.01 ? ' — they must add up to 100%.' : '.'}
        </div>
        <div className="note">
          {editId
            ? 'Runs already posted keep the shares they were blended at — a recipe change only guides the next run.'
            : `Saving creates "${recipe.name.trim() || 'the melange'} (bulk)" as its own bulk product, so blended stock is never mixed up with the bulks it was made from. Blend it on the Production page, then add a pack filled from it.`}
        </div>
      </Modal>
    </>
  )
}
