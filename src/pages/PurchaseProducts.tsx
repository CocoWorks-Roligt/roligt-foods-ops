import { useMemo, useState } from 'react'
import { EmptyState } from '../components/EmptyState'
import { MelangeRecipes } from '../components/MelangeRecipes'
import { useApp } from '../context/AppContext'
import { bulkItems } from '../lib/batches'
import { packDefs, type PackDef } from '../lib/packs'
import { BulkProductForm } from './products/BulkProductForm'
import { BulkCard, PackDefCard, PurchaseCard } from './products/cards'
import { blankMaterial, materialFrom, type MaterialDraft } from './products/constants'
import { MaterialForm, SupplierForm } from './products/MaterialForm'
import { PackDefDialog } from './products/PackDefDialog'
import type { Item, PurchaseProduct } from '../types'

/**
 * Products & Materials — the single home for every master, in the order the plant
 * handles them: what it buys, what it presses that into, the blends made from that,
 * the materials a pack consumes, and the packs themselves.
 *
 * This page owns the lists, the search across them and which dialog is open. Each
 * dialog owns its own draft, in `./products`. It was all one component of eleven
 * hundred lines with a dozen pieces of state, where changing one label meant reading
 * five masters to be sure you had not disturbed another.
 */

/**
 * Which dialog is open, and what it is working on.
 *
 * The pack form is deliberately not in here. It is the one that can have another
 * dialog open on top of it — creating a packing material from a BOM row — so its own
 * openness is tracked separately; folding it in would close the half-filled pack the
 * moment the material form appeared.
 */
type Dialog =
  | { kind: 'none' }
  | { kind: 'material'; editId?: string; initial: MaterialDraft }
  | { kind: 'bulk'; editing?: Item }
  | { kind: 'suppliers'; product: PurchaseProduct }

export function PurchaseProducts() {
  const { state, deletePurchaseProduct, deletePack, retirePack, deleteBulkProduct } = useApp()
  const [search, setSearch] = useState('')
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' })
  const [packOpen, setPackOpen] = useState(false)
  const [packEditing, setPackEditing] = useState<PackDef | undefined>(undefined)

  const close = () => setDialog({ kind: 'none' })

  const vendorNames = (ids: string[]) =>
    ids.map((id) => state.vendors.find((v) => v.id === id)?.name || id).filter(Boolean)

  const rows = useMemo(() => {
    const q = search.toLowerCase()
    return state.purchaseProducts.filter((p) =>
      [
        p.id,
        // The code shown on the card is the ledger one, so it has to be searchable.
        p.itemId || '',
        p.name,
        p.category,
        p.description,
        ...p.vendorIds.map((id) => state.vendors.find((v) => v.id === id)?.name || id),
      ]
        .join(' ')
        .toLowerCase()
        .includes(q),
    )
  }, [search, state.purchaseProducts, state.vendors])

  /**
   * Bulk a melange owns is edited with its recipe, not here — listing it in both
   * places is what made one bulk product look like two and forced each edit to
   * rename the other to stay in step.
   */
  const bulks = useMemo(
    () => bulkItems(state).filter((b) => !state.melanges.some((m) => m.outputItem === b.id)),
    [state],
  )

  /** The packs, as the catalog holds them: one card per physical format, with its
   *  member SKUs inside — not one card per recipe. */
  const packs = useMemo(() => packDefs(state.products, state.packs), [state.products, state.packs])

  const openMaterial = (p: PurchaseProduct) =>
    setDialog({ kind: 'material', editId: p.id, initial: materialFrom(p) })

  const rawRows = rows.filter((p) => p.category !== 'Packing Material')
  const packingRows = rows.filter((p) => p.category === 'Packing Material')

  const purchaseCards = (list: PurchaseProduct[]) => (
    <div className="vendor-grid">
      {list.map((p) => (
        <PurchaseCard
          key={p.id}
          product={p}
          supplierNames={vendorNames(p.vendorIds)}
          onEditSuppliers={() => setDialog({ kind: 'suppliers', product: p })}
          onEdit={() => openMaterial(p)}
          onDelete={() => {
            if (confirm(`Delete ${p.name}?`)) deletePurchaseProduct(p.id)
          }}
        />
      ))}
    </div>
  )

  return (
    <div className="products-page">
      <div className="card products-panel master-toolbar-panel">
        <div className="vendors-toolbar">
          <input
            className="vendors-search"
            placeholder="Search any item, code or supplier"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="card products-panel">
        <div className="section-head">
          <div>
            <h3>Raw materials</h3>
            <span>
              The produce the plant buys and presses. Each one is linked to the farmers or vendors
              it comes from.
            </span>
          </div>
          <div className="section-head-actions">
            <button
              className="btn btn-primary"
              onClick={() =>
                setDialog({ kind: 'material', initial: blankMaterial('Farm Produce', 'Kg') })
              }
            >
              + Add Raw Material
            </button>
          </div>
        </div>

        {!rawRows.length ? (
          <div className="empty vendors-empty">
            <EmptyState
              filtered={!!search}
              empty="No raw materials yet. Add one and link the suppliers it comes from."
              onClear={() => setSearch('')}
            />
          </div>
        ) : (
          purchaseCards(rawRows)
        )}
      </div>

      <div className="card products-panel">
        <div className="section-head">
          <div>
            <h3>Bulk</h3>
            <span>
              What extraction presses out — coconut water, malai, beetroot juice. Packs are filled
              from these, and melanges below blend them. A blend&rsquo;s own bulk is created and
              edited with its melange, so it is not repeated here.
            </span>
          </div>
          <div className="section-head-actions">
            <button className="btn btn-primary" onClick={() => setDialog({ kind: 'bulk' })}>
              + Add Bulk
            </button>
          </div>
        </div>

        {!bulks.length ? (
          <div className="empty vendors-empty">
            No bulk products yet. Add one — a name and whether it is measured in litres or
            kilograms — and production can book its output against it.
          </div>
        ) : (
          <div className="vendor-grid">
            {bulks.map((i) => (
              <BulkCard
                key={i.id}
                item={i}
                onEdit={() => setDialog({ kind: 'bulk', editing: i })}
                onDelete={() => {
                  if (confirm(`Delete ${i.name}?`)) deleteBulkProduct(i.id)
                }}
              />
            ))}
          </div>
        )}
      </div>

      <MelangeRecipes />

      <div className="card products-panel">
        <div className="section-head">
          <div>
            <h3>Packing materials</h3>
            <span>
              Everything a pack is made of and shipped in — bottles, caps, labels, BiBs and the
              outer boxes. Add them here first; each pack below then lists the ones it consumes. A
              supplier is optional.
            </span>
          </div>
          <div className="section-head-actions">
            <button
              className="btn btn-primary"
              onClick={() =>
                setDialog({ kind: 'material', initial: blankMaterial('Packing Material', 'Piece') })
              }
            >
              + Add Packing Material
            </button>
          </div>
        </div>

        {!packingRows.length ? (
          <div className="empty vendors-empty">
            <EmptyState
              filtered={!!search}
              empty="No packing materials yet. Add the bottles, caps and cartons you buy."
              onClear={() => setSearch('')}
            />
          </div>
        ) : (
          purchaseCards(packingRows)
        )}
      </div>

      <div className="card products-panel">
        <div className="section-head">
          <div>
            <h3>Packs</h3>
            <span>
              The physical formats a packing run fills — a 5 L BiB, a 4 × 250 ml bottle. Each pack
              is created once, and the recipes (bulks) it is filled with are assigned inside it;
              the same pack is never re-entered per recipe. Retire a pack the line no longer fills
              — it disappears from new runs but keeps its stock, stickers and dispatch history.
            </span>
          </div>
          <div className="section-head-actions">
            <button
              className="btn btn-primary"
              onClick={() => {
                setPackEditing(undefined)
                setPackOpen(true)
              }}
            >
              + Add Pack
            </button>
          </div>
        </div>

        {!packs.length ? (
          <div className="empty vendors-empty">
            No packs yet. Add one — a 5 L BiB, a 4 × 250 ml bottle, a 3 kg malai cover — then
            assign the recipes it is filled from; it appears in the packing run dropdown.
          </div>
        ) : (
          <div className="vendor-grid">
            {packs.map((d) => (
              <PackDefCard
                key={d.key}
                def={d}
                onEdit={() => {
                  setPackEditing(d)
                  setPackOpen(true)
                }}
                onRetire={() => retirePack(d.key, !d.retired)}
                onDelete={() => {
                  const n = d.members.length
                  if (
                    confirm(
                      `Delete ${d.name} and its ${n} recipe SKU${n === 1 ? '' : 's'} (${d.members
                        .map((m) => m.name)
                        .join(', ')})?`,
                    )
                  ) {
                    deletePack(d.key)
                  }
                }}
              />
            ))}
          </div>
        )}
      </div>

      <PackDefDialog open={packOpen} editing={packEditing} onClose={() => setPackOpen(false)} />

      <BulkProductForm
        open={dialog.kind === 'bulk'}
        editing={dialog.kind === 'bulk' ? dialog.editing : undefined}
        onClose={close}
      />

      <MaterialForm
        open={dialog.kind === 'material'}
        editId={dialog.kind === 'material' ? dialog.editId : undefined}
        initial={
          dialog.kind === 'material' ? dialog.initial : blankMaterial('Farm Produce', 'Piece')
        }
        onClose={close}
        onSaved={close}
      />

      <SupplierForm
        product={dialog.kind === 'suppliers' ? dialog.product : null}
        onClose={close}
      />
    </div>
  )
}
