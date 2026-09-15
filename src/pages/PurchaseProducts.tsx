import { useCallback, useMemo, useState } from 'react'
import { EmptyState } from '../components/EmptyState'
import { MelangeRecipes } from '../components/MelangeRecipes'
import { useApp } from '../context/AppContext'
import { bulkItems } from '../lib/batches'
import { BulkProductForm } from './products/BulkProductForm'
import { BulkCard, PackCard, PurchaseCard } from './products/cards'
import { blankMaterial, materialFrom, type MaterialDraft } from './products/constants'
import { MaterialForm, SupplierForm } from './products/MaterialForm'
import { PackProductForm } from './products/PackProductForm'
import type { Item, Product, PurchaseProduct } from '../types'

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
  const { state, deletePurchaseProduct, deleteProduct, deleteBulkProduct } = useApp()
  const [search, setSearch] = useState('')
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' })
  /**
   * Set while the packing-material form was opened from a pack's BOM row. The BOM
   * could only ever pick a material that already existed, so adding a carton meant
   * abandoning a half-filled pack form. `knownIds` is the snapshot the new material
   * is spotted against, because the create call cannot hand its id back — it is
   * assigned inside a setState updater that has not run yet when the call returns.
   */
  const [pendingBom, setPendingBom] = useState<{ idx: number; knownIds: string[] } | null>(null)
  const [packOpen, setPackOpen] = useState(false)
  const [packEditing, setPackEditing] = useState<Product | undefined>(undefined)

  const close = () => setDialog({ kind: 'none' })
  // Stable, so the pack form's fill effect does not re-run on every render of this page.
  const clearPendingBom = useCallback(() => setPendingBom(null), [])

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

  const pmItems = state.items.filter((i) => i.type === 'Packing Material')
  /**
   * Bulk a melange owns is edited with its recipe, not here — listing it in both
   * places is what made one bulk product look like two and forced each edit to
   * rename the other to stay in step.
   */
  const bulks = useMemo(
    () => bulkItems(state).filter((b) => !state.melanges.some((m) => m.outputItem === b.id)),
    [state],
  )

  // The material lands in state a render after it is saved; this is it coming back to
  // the BOM row it was created for.
  const filledMaterial = useMemo(() => {
    if (!pendingBom) return null
    const created = pmItems.find((i) => !pendingBom.knownIds.includes(i.id))
    return created ? { idx: pendingBom.idx, itemId: created.id } : null
  }, [pendingBom, pmItems])

  /** Opens the packing-material form over the pack form, to fill BOM row `idx`. */
  const startNewMaterial = (idx: number) => {
    setPendingBom({ idx, knownIds: pmItems.map((i) => i.id) })
    // The pack form stays open underneath, so a half-filled pack is not thrown away
    // to add a carton to it.
    setDialog({ kind: 'material', initial: blankMaterial('Packing Material', 'Piece') })
  }

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
              The finished goods a packing run fills. Type, size and unit are set here and the run
              only asks how many. The outer box a pack ships in is not a type — it is a packing
              material above, listed under &ldquo;consumes&rdquo;.
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

        {!state.products.length ? (
          <div className="empty vendors-empty">
            No packs yet. Add one — a 5 L BiB, a 250 ml glass bottle, a 3 kg malai cover — and it
            appears in the packing run dropdown.
          </div>
        ) : (
          <div className="vendor-grid">
            {state.products.map((p) => (
              <PackCard
                key={p.id}
                product={p}
                onEdit={() => {
                  setPackEditing(p)
                  setPackOpen(true)
                }}
                onDelete={() => {
                  if (confirm(`Delete ${p.name}?`)) deleteProduct(p.id)
                }}
              />
            ))}
          </div>
        )}
      </div>

      <PackProductForm
        open={packOpen}
        editing={packEditing}
        onClose={() => setPackOpen(false)}
        onNewMaterial={startNewMaterial}
        fillMaterial={filledMaterial}
        onMaterialFilled={clearPendingBom}
      />

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
        onClose={() => {
          // Dismissed without saving: the BOM row it was opened for gets nothing.
          setPendingBom(null)
          close()
        }}
        // Saved: `pendingBom` is left alone so the new material can find its way back
        // to the row that asked for it, on the render after it reaches state.
        onSaved={close}
      />

      <SupplierForm
        product={dialog.kind === 'suppliers' ? dialog.product : null}
        onClose={close}
      />
    </div>
  )
}
