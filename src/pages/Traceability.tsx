import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { DocLink } from '../components/DocLink'
import { EmptyState } from '../components/EmptyState'
import { StatusBadge } from '../components/StatusBadge'
import { useApp } from '../context/AppContext'
import { batchKind, batchLabel, batchOutputs, fmtBulk, runBulkItem } from '../lib/batches'
import { describeIssue } from '../lib/issues'
import { itemName, locationLabel, stockRowKey } from '../lib/stock'
import {
  legacyPackStockIds,
  outputStockIds,
  packStockIds,
  resolveStockId,
  stockIdOfRow,
} from '../lib/stockIds'
import { fmtDate, fmtQty, inr } from '../lib/utils'
import type { Grn, QcRecord } from '../types'

/** Just the day, for the dates a node carries — a trace reads by day, not by minute. */
const day = (s?: string) => (s ? fmtDate(s.slice(0, 10)) : '')

/**
 * Identifies the source of a lot: the vendor id, or the lot itself when the
 * coconuts were bought straight from a farmer with no vendor master record.
 */
const sourceKey = (g: Grn) => g.farmerId || `LOT:${g.lot}`

/** Which of a document's lines a trace is about: every one, or just these. */
type Scope = 'all' | Set<string>

/** Widens a document's scope, and says whether it actually grew. */
function widen(map: Map<string, Scope>, key: string, add: Scope): boolean {
  const had = map.get(key)
  if (had === 'all') return false
  if (add === 'all') {
    map.set(key, 'all')
    return true
  }
  const next = new Set(had || [])
  let grew = !had
  for (const v of add) {
    if (!next.has(v)) {
      next.add(v)
      grew = true
    }
  }
  map.set(key, next)
  return grew
}

const allows = (map: Map<string, Scope>, key: string, value: string) => {
  const s = map.get(key)
  return s === 'all' || !!s?.has(value)
}

interface TraceResult {
  sources: string[]
  lots: string[]
  materials: string[]
  batches: string[]
  packings: string[]
  dispatches: string[]
  issues: string[]
  customers: string[]
  /** Every item of stock in the chain, by stock ID. */
  stockIds: string[]
  /** Which outputs of each batch, and which lines of each run, the chain is about. */
  outputs: Record<string, 'all' | string[]>
  lines: Record<string, 'all' | string[]>
}

const toRecord = (m: Map<string, Scope>) =>
  Object.fromEntries([...m].map(([k, v]) => [k, v === 'all' ? 'all' : [...v]])) as Record<
    string,
    'all' | string[]
  >

export function Traceability() {
  const { state, rows, getItemName } = useApp()
  const [params] = useSearchParams()
  const [term, setTerm] = useState(() => params.get('q') || '')
  const [result, setResult] = useState<TraceResult | null>(null)
  const [empty, setEmpty] = useState(false)
  /** Whether the chain is scrolled to its right-hand end, so the fade can get out of
   *  the way once there is genuinely nothing more to see. */
  const [chainAtEnd, setChainAtEnd] = useState(false)

  const inScope = (scope: 'all' | string[] | undefined, value: string) =>
    scope === 'all' || !!scope?.includes(value)

  /** A batch's outputs this trace is about, each with its stock ID. */
  const shownOutputs = (batchId: string) => {
    const b = state.batches.find((x) => x.id === batchId)
    return b ? outputStockIds(b).filter((l) => inScope(result?.outputs[batchId], l.item)) : []
  }

  /** A packing run's lines this trace is about, each with its stock ID. */
  const shownLines = (runId: string) => {
    const r = state.packingRuns.find((x) => x.id === runId)
    return r ? packStockIds(r).filter((l) => inScope(result?.lines[runId], l.sku)) : []
  }

  /** A QC record belongs to the trace when the product it tested does. */
  const qcShown = (q: QcRecord) => inScope(result?.outputs[q.batchId], q.item || '')

  /** "QC Released" for one product, "1/2 released" once there are several. */
  const qcSummary = (batchId: string) => {
    const records = state.qcs.filter((q) => q.batchId === batchId && qcShown(q))
    if (!records.length) return 'QC N/A'
    if (records.length === 1) return `QC ${records[0].disposition}`
    const released = records.filter((q) => q.disposition === 'Released').length
    return `QC ${released}/${records.length} released`
  }

  /**
   * Every dated event in the chain, oldest first.
   *
   * The chain above reads left to right and scrolls sideways, which is the right shape
   * for *what came from what* and the wrong one for *when*. A recall is a question
   * about time — when was it cut, when did it arrive, when did it go out — so the same
   * chain is also laid out as a timeline, where the dates line up under each other and
   * a gap between harvest and pressing is visible at a glance.
   */
  const timeline = () => {
    if (!result) return []
    const out: { when: string; stage: string; reference: string; detail: string }[] = []
    const add = (when: string | undefined, stage: string, reference: string, detail: string) => {
      if (when) out.push({ when, stage, reference, detail })
    }

    for (const id of result.lots) {
      const g = state.grns.find((x) => x.lot === id)
      if (!g) continue
      const unit = (g.uom || 'Piece').toLowerCase()
      add(
        g.harvestedOn,
        'Harvested',
        id,
        [g.productName, g.farmer && `by ${g.farmer}`, g.area].filter(Boolean).join(' · '),
      )
      add(
        g.date,
        'Received',
        `${g.id} · ${id}`,
        `${g.accepted} ${unit} accepted from ${g.farmerName || g.farmer || 'a direct farmer'}`,
      )
    }
    for (const id of result.batches) {
      const b = state.batches.find((x) => x.id === id)
      if (!b) continue
      add(
        b.date,
        batchKind(b) === 'Melange' ? 'Blended' : 'Produced',
        id,
        `${batchLabel(state, b)} — ${shownOutputs(id)
          .map((l) => `${l.stockId} ${fmtBulk(l.qty, l.uom)} ${itemName(state, l.item)}`)
          .join(' + ')}`,
      )
      for (const q of state.qcs.filter((x) => x.batchId === id && x.reviewedAt && qcShown(x))) {
        add(
          q.reviewedAt,
          'QC reviewed',
          `${q.id} · ${id}`,
          `${itemName(state, q.item || '')} ${q.disposition.toLowerCase()}`,
        )
      }
    }
    for (const doc of result.materials) {
      const l = state.ledger.find((x) => x.type === 'PM Receipt' && x.doc === doc)
      if (!l) continue
      const vendor = state.vendors.find((v) => v.id === l.vendorId)?.name
      add(
        l.time,
        'Material received',
        doc,
        `${fmtQty(l.qtyIn)} ${l.uom} ${itemName(state, l.item)} · supplier lot ${l.lot}${vendor ? ` from ${vendor}` : ''}`,
      )
    }
    for (const id of result.packings) {
      const p = state.packingRuns.find((x) => x.id === id)
      if (!p) continue
      const lines = shownLines(id)
      add(
        p.date,
        'Packed',
        `${id} · ${p.batchId}`,
        lines.map((l) => `${l.stockId} ${l.packs} × ${getItemName(l.sku)}`).join(', '),
      )
      // The shelf life a pack carries is a date the chain has to show: it is the one
      // that says whether stock still in the trade is fit to be there.
      for (const expiry of [...new Set(lines.map((l) => l.expiry).filter(Boolean))]) {
        add(expiry, 'Best before', id, 'Packs from this run')
      }
    }
    for (const id of result.dispatches) {
      const d = state.dispatches.find((x) => x.id === id)
      if (!d) continue
      add(
        d.dispatchTime,
        'Dispatched',
        `${id} · ${d.challan}`,
        `${d.qty} × ${getItemName(d.sku)} to ${d.customerName}`,
      )
      add(d.expected, 'Delivery expected', id, d.customerName)
      add(d.deliveredTime, 'Delivered', id, `${d.status}${d.pod ? ` — received by ${d.pod}` : ''}`)
    }
    for (const id of result.issues) {
      const i = (state.stockIssues || []).find((x) => x.id === id)
      if (!i) continue
      add(
        i.date,
        'Stock issued',
        id,
        [i.reason, i.recipient, describeIssue(state, i.lines)].filter(Boolean).join(' · '),
      )
    }
    for (const oid of orderIds()) {
      const o = state.orders.find((x) => x.id === oid)
      if (o) add(o.date, 'Ordered', oid, o.customerName)
    }

    return out.sort((a, b) => a.when.localeCompare(b.when))
  }

  const orderIds = () =>
    result
      ? [
          ...new Set(
            result.dispatches
              .map((id) => state.dispatches.find((d) => d.id === id)?.orderId)
              .filter(Boolean) as string[],
          ),
        ]
      : []

  const runTrace = (raw: string) => {
    const t = raw.trim().toLowerCase()
    if (!t) {
      setResult(null)
      setEmpty(false)
      return
    }

    const lots = new Set<string>()
    const materials = new Set<string>()
    const dispatches = new Set<string>()
    /**
     * Stock that left for something other than a sale. A recall has to reach these
     * too — packs sent to a lab or handed out at a BTL activity are units out of the
     * building, and leaving them off the chain makes a trace read complete when it
     * is not.
     */
    const issues = new Set<string>()
    const sources = new Set<string>()
    const customers = new Set<string>()

    /**
     * Batches in the chain, and which of their outputs it is about. A trace used to take
     * a batch whole, so asking after its malai dragged in every pack of the water pressed
     * alongside it. It carries the product now, all the way through.
     */
    const shown = new Map<string, Scope>()
    /**
     * The part of `shown` whose stock travels forward. Only what the term matched does:
     * a lot you asked about should show everything it went into, but a batch reached by
     * walking back from a blend must not then drag in every other batch that used it.
     */
    const forward = new Map<string, Scope>()
    /** Packing runs in the chain, and which of their lines. All of them travel forward. */
    const runs = new Map<string, Scope>()
    const seedLots = new Set<string>()

    const seedBatch = (id: string, scope: Scope) => {
      widen(shown, id, scope)
      widen(forward, id, scope)
    }

    /** A lot of packing material, and every run that drew on it. */
    const seedMaterial = (doc: string) => {
      const receipt = state.ledger.find((l) => l.type === 'PM Receipt' && l.doc === doc)
      if (!receipt) return
      materials.add(doc)
      const drewIt = new Set(
        state.ledger
          .filter(
            (l) =>
              l.type === 'Packing Consume' && l.item === receipt.item && l.lot === receipt.lot,
          )
          .map((l) => l.doc),
      )
      state.packingRuns.forEach((p) => {
        if (!drewIt.has(p.id)) return
        widen(runs, p.id, 'all')
        widen(shown, p.batchId, new Set([runBulkItem(p)]))
      })
    }

    /**
     * A stock ID names one item exactly, so it is resolved before anything is matched
     * by name — and traced as that item alone: the malai of a batch, not the batch.
     */
    const ref = resolveStockId(state, t)
    if (ref?.kind === 'raw') {
      lots.add(ref.lot)
      seedLots.add(ref.lot)
    } else if (ref?.kind === 'bulk') {
      seedBatch(ref.batchId, new Set([ref.item]))
    } else if (ref?.kind === 'batch') {
      seedBatch(ref.batchId, 'all')
    } else if (ref?.kind === 'pack') {
      widen(runs, ref.runId, new Set([ref.sku]))
      widen(shown, ref.batchId, new Set([ref.bulkItem]))
    } else if (ref?.kind === 'material') {
      seedMaterial(ref.doc)
    } else {
      state.batches.forEach((b) => {
        if ([b.id, batchLabel(state, b)].join(' ').toLowerCase().includes(t)) seedBatch(b.id, 'all')
      })

      /**
       * A product code or name — SF-0001, "Tender Coconut Malai" — is a question about
       * that product in every batch that made it, by-products included, every receipt
       * that brought it in and every run that filled it. The batch comes along narrowed
       * to that product rather than whole.
       */
      const products = new Set(
        state.items
          .filter((i) => [i.id, i.name].join(' ').toLowerCase().includes(t))
          .map((i) => i.id),
      )
      if (products.size) {
        state.batches.forEach((b) => {
          const made = batchOutputs(b).map((o) => o.item).filter((i) => products.has(i))
          if (made.length) seedBatch(b.id, new Set(made))
        })
        state.grns.forEach((g) => {
          if (!products.has(g.itemId || '')) return
          lots.add(g.lot)
          seedLots.add(g.lot)
        })
        state.packingRuns.forEach((p) => {
          const skus = p.lines.map((l) => l.sku).filter((sku) => products.has(sku))
          if (!skus.length) return
          widen(runs, p.id, new Set(skus))
          widen(shown, p.batchId, new Set([runBulkItem(p)]))
        })
        state.ledger.forEach((l) => {
          if (l.type === 'PM Receipt' && products.has(l.item)) seedMaterial(l.doc)
        })
      }

      state.grns.forEach((g) => {
        if (
          [g.id, g.lot, g.farmerName, g.farmerId, g.farmer || '', g.area || '']
            .join(' ')
            .toLowerCase()
            .includes(t)
        ) {
          lots.add(g.lot)
          seedLots.add(g.lot)
        }
      })
      state.dispatches.forEach((d) => {
        if ([d.id, d.challan, d.customerName, d.batchId, d.sku].join(' ').toLowerCase().includes(t)) {
          dispatches.add(d.id)
          customers.add(d.customerId)
          seedBatch(d.batchId, 'all')
        }
      })
      state.packingRuns.forEach((p) => {
        if ([p.id, p.batchId].join(' ').toLowerCase().includes(t)) {
          widen(runs, p.id, 'all')
          seedBatch(p.batchId, 'all')
        }
      })
      // Everything a customer *you asked about* was sent. Expanding from any customer
      // that merely turned up in the chain is what pulled in their other orders — and,
      // through those, every batch and blend behind them.
      const seedCustomers = new Set<string>()
      state.customers.forEach((c) => {
        if ([c.id, c.name].join(' ').toLowerCase().includes(t)) {
          customers.add(c.id)
          seedCustomers.add(c.id)
        }
      })
      state.dispatches.forEach((d) => {
        if (!seedCustomers.has(d.customerId)) return
        dispatches.add(d.id)
        seedBatch(d.batchId, 'all')
      })
    }

    /** Whether a run in the chain filled this pack off this batch. */
    const packedInChain = (batchId: string, sku: string, expiry?: string) =>
      state.packingRuns.some(
        (p) =>
          runs.has(p.id) &&
          p.batchId === batchId &&
          p.lines.some(
            (l) =>
              l.sku === sku &&
              allows(runs, p.id, sku) &&
              (!expiry || !l.expiry || l.expiry === expiry),
          ),
      )

    // ---- forward: where did what I asked about end up? ----------------------
    let changed = true
    while (changed) {
      changed = false
      state.batches.forEach((b) => {
        // A batch that pressed a seed lot carries everything it made forward, and so
        // does a blend drawing a component the chain is already carrying.
        const pressedSeedLot = b.sourceLines.some((l) => seedLots.has(l.lot))
        const blendedFromChain = (b.blendLines || []).some((l) => allows(forward, l.lot, l.item))
        if (!pressedSeedLot && !blendedFromChain) return
        if (widen(forward, b.id, 'all')) changed = true
        if (widen(shown, b.id, 'all')) changed = true
      })
      state.packingRuns.forEach((p) => {
        if (allows(forward, p.batchId, runBulkItem(p)) && widen(runs, p.id, 'all')) changed = true
      })
      ;(state.stockIssues || []).forEach((i) => {
        if (issues.has(i.id)) return
        const hit = i.lines.some((l) => {
          if (l.itemType === 'Raw Material') return lots.has(l.lot)
          if (l.itemType === 'Semi Finished') return allows(forward, l.lot, l.item)
          if (l.itemType === 'Finished Goods') {
            return forward.get(l.lot) === 'all' || packedInChain(l.lot, l.item, l.expiry)
          }
          return [...materials].some((doc) =>
            state.ledger.some((x) => x.doc === doc && x.item === l.item && x.lot === l.lot),
          )
        })
        if (hit) {
          issues.add(i.id)
          changed = true
        }
      })
      state.dispatches.forEach((d) => {
        if (!(forward.get(d.batchId) === 'all' || packedInChain(d.batchId, d.sku, d.expiry))) return
        if (!dispatches.has(d.id)) {
          dispatches.add(d.id)
          changed = true
        }
        if (!customers.has(d.customerId)) {
          customers.add(d.customerId)
          changed = true
        }
      })
    }

    // ---- backward: what went into everything in the chain? ------------------
    changed = true
    while (changed) {
      changed = false
      // A run needs the batch it filled from — narrowed to the bulk it drew.
      runs.forEach((_, runId) => {
        const p = state.packingRuns.find((x) => x.id === runId)
        if (p && widen(shown, p.batchId, new Set([runBulkItem(p)]))) changed = true
      })
      shown.forEach((_, batchId) => {
        const b = state.batches.find((x) => x.id === batchId)
        if (!b) return
        b.sourceLines.forEach((l) => {
          if (!lots.has(l.lot)) {
            lots.add(l.lot)
            changed = true
          }
        })
        // A melange's components are batches, so a blend reaches the juice that made it
        // and, through that, the lot and the farmer behind it — only the juice it drew.
        ;(b.blendLines || []).forEach((l) => {
          if (widen(shown, l.lot, new Set([l.item]))) changed = true
        })
      })
      state.grns.forEach((g) => {
        if (lots.has(g.lot) && !sources.has(sourceKey(g))) {
          sources.add(sourceKey(g))
          changed = true
        }
      })
    }

    const stockIds = new Set<string>([...lots, ...materials])
    shown.forEach((scope, batchId) => {
      const b = state.batches.find((x) => x.id === batchId)
      if (!b) return
      outputStockIds(b).forEach((l) => {
        if (scope === 'all' || scope.has(l.item)) stockIds.add(l.stockId)
      })
      if (scope === 'all') legacyPackStockIds(b).forEach((o) => stockIds.add(o.stockId))
    })
    runs.forEach((scope, runId) => {
      const p = state.packingRuns.find((x) => x.id === runId)
      if (!p) return
      packStockIds(p).forEach((l) => {
        if (scope === 'all' || scope.has(l.sku)) stockIds.add(l.stockId)
      })
    })

    if (
      !shown.size &&
      !lots.size &&
      !materials.size &&
      !runs.size &&
      !dispatches.size &&
      !issues.size &&
      !sources.size &&
      !customers.size
    ) {
      setResult(null)
      setEmpty(true)
      return
    }
    setEmpty(false)
    setResult({
      sources: [...sources],
      lots: [...lots],
      materials: [...materials],
      batches: [...shown.keys()],
      packings: [...runs.keys()],
      dispatches: [...dispatches],
      issues: [...issues],
      customers: [...customers],
      stockIds: [...stockIds],
      outputs: toRecord(shown),
      lines: toRecord(runs),
    })
  }

  /**
   * `?q=` runs the trace on arrival, so an item on the Inventory screen opens straight
   * onto its chain instead of leaving the operator to copy a code between screens.
   */
  const linked = params.get('q') || ''
  useEffect(() => {
    if (linked) runTrace(linked)
    // Once per linked term. runTrace reads the state it is called with; re-running it
    // on every save would reset a trace the operator is in the middle of reading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked])

  /**
   * The chain, stage by stage, with the empty stages left out.
   *
   * Every stage used to be preceded by an arrow whether it had anything in it or not,
   * so a batch not yet packed or dispatched ended in a row of arrows pointing at
   * nothing. Arrows now go only between two stages that both hold something.
   */
  const stages: ReactNode[][] = result
    ? [
        result.sources.map((key) => {
          const vendor = state.vendors.find((x) => x.id === key)
          const g = state.grns.find((x) => sourceKey(x) === key)
          return (
            <div className="node" key={key}>
              <div className="small">{vendor ? 'Vendor / Source' : 'Direct farmer'}</div>
              <b>{vendor?.name || g?.farmer || key}</b>
              <div className="small">{vendor ? key : g?.area || 'No vendor record'}</div>
              {g?.harvestedOn ? (
                <div className="trace-date">Harvested {day(g.harvestedOn)}</div>
              ) : null}
            </div>
          )
        }),
        result.lots.map((id) => {
          const g = state.grns.find((x) => x.lot === id)
          return (
            <div className="node" key={id}>
              <div className="small">Procurement Lot</div>
              <b>
                <DocLink doc={id} />
              </b>
              <div className="small">{g?.productName || 'Tender Coconut'}</div>
              <div className="small">
                {g?.accepted || 0} {(g?.uom || 'Piece').toLowerCase()} ·{' '}
                {inr(g?.usableCost || 0)}/{(g?.uom || 'Piece').toLowerCase()}
              </div>
              {g?.farmer && <div className="small">Farmer: {g.farmer}</div>}
              {g?.area && <div className="small">Area: {g.area}</div>}
              <div className="trace-date">
                {g?.harvestedOn ? `Harvested ${day(g.harvestedOn)} · ` : ''}
                Received {day(g?.date) || '—'}
              </div>
            </div>
          )
        }),
        result.batches.map((id) => {
          const b = state.batches.find((x) => x.id === id)
          return (
            <div className="node" key={id}>
              <div className="small">
                {b && batchKind(b) === 'Melange' ? 'Melange Run' : 'Production Batch'}
              </div>
              <b>
                <DocLink doc={id} />
              </b>
              <div className="small">
                {b ? batchLabel(state, b) : ''} · {qcSummary(id)}
              </div>
              {shownOutputs(id).map((l) => (
                <div className="small" key={l.stockId}>
                  <span className="cell-id">{l.stockId}</span> · {itemName(state, l.item)} ·{' '}
                  {fmtBulk(l.qty, l.uom)}
                </div>
              ))}
              {b?.blendLines?.length ? (
                <div className="small">from {b.blendLines.map((l) => l.lot).join(', ')}</div>
              ) : null}
              <div className="trace-date">Produced {day(b?.date) || '—'}</div>
            </div>
          )
        }),
        result.materials.map((doc) => {
          const receipt = state.ledger.find((l) => l.type === 'PM Receipt' && l.doc === doc)
          const vendor = state.vendors.find((v) => v.id === receipt?.vendorId)?.name
          return (
            <div className="node" key={doc}>
              <div className="small">Packing Material</div>
              <b>
                <DocLink doc={doc} />
              </b>
              <div className="small">{receipt ? itemName(state, receipt.item) : ''}</div>
              {receipt ? (
                <div className="small">
                  {fmtQty(receipt.qtyIn)} {receipt.uom} · supplier lot {receipt.lot}
                </div>
              ) : null}
              {vendor ? <div className="small">Supplier: {vendor}</div> : null}
              <div className="trace-date">Received {day(receipt?.time) || '—'}</div>
            </div>
          )
        }),
        result.packings.map((id) => {
          const p = state.packingRuns.find((x) => x.id === id)
          const lines = shownLines(id)
          return (
            <div className="node" key={id}>
              <div className="small">Packing Run</div>
              <b>
                <DocLink doc={id} />
              </b>
              {lines.map((l) => (
                <div className="small" key={l.stockId}>
                  <span className="cell-id">{l.stockId}</span> · {l.packs} × {getItemName(l.sku)}
                </div>
              ))}
              <div className="trace-date">
                Packed {day(p?.date) || '—'}
                {lines[0]?.expiry ? ` · best before ${day(lines[0].expiry)}` : ''}
              </div>
            </div>
          )
        }),
        result.dispatches.map((id) => {
          const d = state.dispatches.find((x) => x.id === id)
          return (
            <div className="node" key={id}>
              <div className="small">Dispatch</div>
              <b>
                <DocLink doc={id} />
              </b>
              <div className="small">
                {d?.challan || ''} · {d?.status || ''}
              </div>
              <div className="trace-date">
                Dispatched {day(d?.dispatchTime) || '—'}
                {d?.deliveredTime ? ` · delivered ${day(d.deliveredTime)}` : ''}
              </div>
            </div>
          )
        }),
        result.issues.map((id) => {
          const i = (state.stockIssues || []).find((x) => x.id === id)
          return (
            <div className="node" key={id}>
              <div className="small">Stock Issue</div>
              <b>
                <DocLink doc={id} />
              </b>
              <div className="small">{i?.reason}</div>
              {i?.recipient ? <div className="small">{i.recipient}</div> : null}
              <div className="trace-date">Issued {day(i?.date) || '—'}</div>
            </div>
          )
        }),
        orderIds().map((oid) => {
          const o = state.orders.find((x) => x.id === oid)
          return (
            <div className="node" key={oid}>
              <div className="small">Order</div>
              <b>
                <DocLink doc={oid} />
              </b>
              <div className="small">{o?.customerName}</div>
              <div className="small">
                {o?.lines.length || 0} line{(o?.lines.length || 0) === 1 ? '' : 's'} ·{' '}
                {o?.status}
              </div>
              <div className="trace-date">
                Ordered {day(o?.date) || '—'}
                {o?.dispatchedAt ? ` · sent ${day(o.dispatchedAt)}` : ''}
              </div>
            </div>
          )
        }),
        result.customers.map((id) => {
          const c = state.customers.find((x) => x.id === id)
          return (
            <div className="node" key={id}>
              <div className="small">Customer</div>
              <b>{c?.name || id}</b>
              <div className="small">{id}</div>
            </div>
          )
        }),
      ].filter((stage) => stage.length)
    : []

  /** What the chain's items are holding right now. */
  const chainStock = result
    ? rows.filter((r) => result.stockIds.includes(stockIdOfRow(state, r)))
    : []

  return (
    <div className="card">
      <div className="section-head">
        <div>
          <h3>Traceability Search</h3>
          <span>
            Backward and forward in one page — every link, and the date it happened on
          </span>
        </div>
      </div>
      <div className="toolbar">
        <input
          className="trace-search"
          placeholder="Enter a stock ID, product, farmer, lot, batch, dispatch, challan or customer"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') runTrace(term)
          }}
        />
        <button className="btn btn-primary" onClick={() => runTrace(term)}>
          Trace
        </button>
      </div>

      {!result && !empty && (
        <div className="empty">
          Enter a stock ID (BAT-2026-0002/1), a product, farmer, lot, batch, dispatch, challan or
          customer to see the whole chain.
        </div>
      )}
      {empty && (
        <div className="empty">
          {/* The same affordance every other searchable screen offers: say nothing
              matched, and give the way back out rather than leaving the operator to
              clear the box themselves. */}
          <EmptyState
            filtered
            empty="No linked records found."
            onClear={() => {
              setTerm('')
              setEmpty(false)
              setResult(null)
            }}
          />
        </div>
      )}

      {result && (
        <>
          <div
            className="trace-chain-wrap"
            style={{ ['--trace-fade' as string]: chainAtEnd ? 0 : 1 }}
          >
            <div
              className="trace-chain"
              onScroll={(e) => {
                const el = e.currentTarget
                setChainAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 4)
              }}
            >
              {stages.map((nodes, i) => (
                <Fragment key={i}>
                  {i > 0 ? <div className="arrow">→</div> : null}
                  {nodes}
                </Fragment>
              ))}
            </div>
          </div>

          <div className="card" style={{ marginTop: 12 }}>
            <h3>Key dates</h3>
            <span className="small">
              Everything in the chain in the order it happened — harvest, receipt, pressing, QC,
              packing, dispatch and delivery
            </span>
            <div className="table-wrap" style={{ marginTop: 10 }}>
              <table>
                <thead>
                  <tr>
                    <th className="cell-tight">Date</th>
                    <th className="cell-tight">What happened</th>
                    <th>Reference</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {!timeline().length ? (
                    <tr>
                      <td colSpan={4} className="empty">
                        Nothing in this chain carries a date.
                      </td>
                    </tr>
                  ) : (
                    timeline().map((e, i) => (
                      <tr key={`${e.stage}-${e.reference}-${e.when}-${i}`}>
                        <td data-label="Date" className="cell-tight">
                          <b>{day(e.when)}</b>
                        </td>
                        <td data-label="What happened" className="cell-tight">
                          {e.stage}
                        </td>
                        <td data-label="Reference" className="cell-id">
                          {e.reference}
                        </td>
                        <td data-label="Detail">{e.detail}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid grid-2" style={{ marginTop: 12 }}>
            <div className="card">
              <h3>Linked QC evidence</h3>
              {/* One row per product, not per batch: a pressing is tested twice and a
                  recall has to know which of the two failed. */}
              {result.batches.flatMap((id) =>
                state.qcs
                  .filter((x) => x.batchId === id && qcShown(x))
                  .map((q) => (
                    <div className="kpi-row" key={q.id}>
                      <span>
                        {itemName(state, q.item || '') || q.id} · {id}
                        <div className="small">
                          {q.id}
                          {q.reviewedAt ? ` · reviewed ${day(q.reviewedAt)}` : ''}
                        </div>
                      </span>
                      <StatusBadge value={q.disposition} />
                    </div>
                  )),
              )}
              {!result.batches.some((id) =>
                state.qcs.some((x) => x.batchId === id && qcShown(x)),
              ) ? (
                <div className="small">No QC records against this chain.</div>
              ) : null}
            </div>
            <div className="card">
              <h3>Current stock</h3>
              {chainStock.map((r) => (
                <div className="kpi-row" key={stockRowKey(r)}>
                  <span>
                    <b className="cell-id">{stockIdOfRow(state, r)}</b> · {getItemName(r.item)}{' '}
                    <StatusBadge value={r.status} />
                    <div className="small">{locationLabel(state, r.location)}</div>
                  </span>
                  <b>
                    {fmtQty(r.qty)} {r.uom}
                  </b>
                </div>
              ))}
              {!chainStock.length && <div className="small">No current balance.</div>}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
