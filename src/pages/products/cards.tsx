import { StatusBadge } from '../../components/StatusBadge'
import { useApp } from '../../context/AppContext'
import { isByProduct } from '../../lib/posting'
import { bulkItemOf, bulkUomForUnit, formatSize, packLabel, toBase, type PackDef } from '../../lib/packs'
import type { Item, PurchaseProduct } from '../../types'

/** The cards each master section lays out. One file, so they stay a family. */

export function PurchaseCard({
  product,
  supplierNames,
  onEditSuppliers,
  onEdit,
  onDelete,
}: {
  product: PurchaseProduct
  supplierNames: string[]
  onEditSuppliers: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <article className="vendor-card product-card">
      <div className="vendor-card-top">
        <div className="vendor-card-title">
          <h4>{product.name}</h4>
          <div className="small">
            {/* The ledger code, not the master's own id — this is what stock, GRNs,
                dropdowns and stickers all call it, and showing PP-0001 here while
                every other page said RM-TCW-COCO read as two different items. */}
            {product.itemId || product.id} · {product.uom}
          </div>
        </div>
        <StatusBadge value={product.category} />
      </div>
      {product.description ? <p className="vendor-notes">{product.description}</p> : null}
      <div className="chip-row">
        <span className="chip-row-label">Bought from</span>
        <div className="supplier-chips">
          {!supplierNames.length ? (
            <span className="small">No supplier linked</span>
          ) : (
            supplierNames.map((n) => (
              <span className="supplier-chip" key={n}>
                {n}
              </span>
            ))
          )}
        </div>
      </div>
      <div className="row-actions">
        <button className="btn btn-light" type="button" onClick={onEditSuppliers}>
          Suppliers
        </button>
        <button className="btn btn-light" type="button" onClick={onEdit}>
          Edit
        </button>
        <button className="btn btn-danger" type="button" onClick={onDelete}>
          Delete
        </button>
      </div>
    </article>
  )
}

export function BulkCard({
  item,
  onEdit,
  onDelete,
}: {
  item: Item
  onEdit: () => void
  onDelete: () => void
}) {
  const { state } = useApp()
  const melange = state.melanges.find((m) => m.outputItem === item.id)
  // Pack labels, not SKU names: several recipes fill the same 5 L BiB, and the bulk's
  // question is which physical packs draw it.
  const packs = [...new Set(
    state.products.filter((p) => bulkItemOf(p) === item.id).map(packLabel),
  )]
  const used = state.ledger.some((l) => l.item === item.id)
  return (
    <article className="vendor-card product-card">
      <div className="vendor-card-top">
        <div className="vendor-card-title">
          <h4>{item.name}</h4>
          <div className="small">
            {item.id} · measured in {item.uom}
          </div>
        </div>
        <StatusBadge value={isByProduct(item) ? 'By-product' : melange ? 'Blend' : 'Extraction'} />
      </div>
      <div className="small">
        {isByProduct(item)
          ? 'Thrown off alongside a batch’s main output. Carries none of the batch cost.'
          : melange
            ? `Blended to the ${melange.name} melange.`
            : 'Booked by a production batch as its output.'}
      </div>
      <div className="chip-row">
        <span className="chip-row-label">Filled into</span>
        <div className="supplier-chips">
          {!packs.length ? (
            <span className="small">No pack yet</span>
          ) : (
            packs.map((label) => (
              <span className="supplier-chip" key={label}>
                {label}
              </span>
            ))
          )}
        </div>
      </div>
      <div className="row-actions">
        <button className="btn btn-light" type="button" onClick={onEdit}>
          Edit
        </button>
        <button
          className="btn btn-danger"
          type="button"
          title={used ? 'Already produced — has stock history' : undefined}
          onClick={onDelete}
        >
          Delete
        </button>
      </div>
    </article>
  )
}

/** One pack as the catalog holds it: the physical format, with a chip per recipe
 *  (each chip is that recipe's finished SKU). Retire is the off-ramp that keeps
 *  history — a pack with stock behind it refuses Delete and says so. */
export function PackDefCard({
  def,
  onEdit,
  onRetire,
  onDelete,
}: {
  def: PackDef
  onEdit: () => void
  onRetire: () => void
  onDelete: () => void
}) {
  const { state } = useApp()
  const packed = def.members.some((m) => state.ledger.some((l) => l.item === m.id))
  return (
    <article className="vendor-card product-card">
      <div className="vendor-card-top">
        <div className="vendor-card-title">
          <h4>{def.name}</h4>
          <div className="small">
            {def.type} · {formatSize(def.size, def.unit)} · {def.members.length} recipe
            {def.members.length === 1 ? '' : 's'}
          </div>
        </div>
        {def.retired ? <StatusBadge value="Retired" /> : null}
      </div>
      <div className="small">
        Holds {toBase(def.size, def.unit)} {bulkUomForUnit(def.unit) === 'Kg' ? 'kg' : 'L'} per
        pack · {def.members[0]?.shelfLifeDays ?? '—'} day shelf life
      </div>
      <div className="chip-row">
        <span className="chip-row-label">Recipes</span>
        <div className="supplier-chips">
          {def.members.map((m) => (
            <span className="supplier-chip" key={m.id}>
              {m.name}
            </span>
          ))}
        </div>
      </div>
      <div className="chip-row">
        <span className="chip-row-label">Consumes</span>
        <div className="supplier-chips">
          {!def.bom.length ? (
            <span className="small">Nothing</span>
          ) : (
            def.bom.map((b) => (
              <span className="supplier-chip" key={b.item}>
                {b.qty} × {state.items.find((i) => i.id === b.item)?.name || b.item}
              </span>
            ))
          )}
        </div>
      </div>
      <div className="row-actions">
        <button className="btn btn-light" type="button" onClick={onEdit}>
          Edit
        </button>
        <button className="btn btn-light" type="button" onClick={onRetire}>
          {def.retired ? 'Restore' : 'Retire'}
        </button>
        <button
          className="btn btn-danger"
          type="button"
          title={packed ? 'Already packed — has stock history; retire it instead' : undefined}
          onClick={onDelete}
        >
          Delete
        </button>
      </div>
    </article>
  )
}
