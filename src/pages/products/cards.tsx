import { StatusBadge } from '../../components/StatusBadge'
import { useApp } from '../../context/AppContext'
import { isByProduct } from '../../lib/posting'
import { bulkItemOf, bulkUomForUnit, formatSize } from '../../lib/packs'
import type { Item, Product, PurchaseProduct } from '../../types'

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
  const packs = state.products.filter((p) => bulkItemOf(p) === item.id)
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
        <StatusBadge value={isByProduct(item) ? 'By-product' : melange ? 'Melange' : 'Extraction'} />
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
            packs.map((p) => (
              <span className="supplier-chip" key={p.id}>
                {p.name}
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

export function PackCard({
  product,
  onEdit,
  onDelete,
}: {
  product: Product
  onEdit: () => void
  onDelete: () => void
}) {
  const { state } = useApp()
  const filledFrom = state.items.find((i) => i.id === bulkItemOf(product))
  const packed = state.ledger.some((l) => l.item === product.id)
  return (
    <article className="vendor-card product-card">
      <div className="vendor-card-top">
        <div className="vendor-card-title">
          <h4>{product.name}</h4>
          <div className="small">
            {product.id} · {product.type} · {formatSize(product.size, product.unit)}
          </div>
        </div>
        <StatusBadge value={filledFrom?.name || 'Unlinked'} />
      </div>
      <div className="small">
        Holds {product.packVolume} {bulkUomForUnit(product.unit) === 'Kg' ? 'kg' : 'L'} of{' '}
        {filledFrom?.name || 'bulk'} per pack · {product.shelfLifeDays} day shelf life
      </div>
      <div className="chip-row">
        <span className="chip-row-label">Consumes</span>
        <div className="supplier-chips">
          {!product.bom.length ? (
            <span className="small">Nothing</span>
          ) : (
            product.bom.map((b) => (
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
        <button
          className="btn btn-danger"
          type="button"
          title={packed ? 'Already packed — has stock history' : undefined}
          onClick={onDelete}
        >
          Delete
        </button>
      </div>
    </article>
  )
}
