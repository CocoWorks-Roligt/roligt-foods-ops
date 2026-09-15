/**
 * Traceability search: from whatever was typed, the chain of records it belongs to.
 *
 * What was typed decides which way the chain runs. A lot, a farmer, a batch or a product
 * is a question about everything that came out of it, so the chain runs forward from
 * there. One particular document — a dispatch, a challan, a packing run, an order, a
 * stock issue — is a question about that document alone: the chain runs forward only
 * from what the document itself holds. It used to seed the document's batch whole, so
 * asking after one dispatch listed every other dispatch and every run of the same batch.
 *
 * Either way the chain then climbs back, but only from what was asked about. A blend
 * that took this lot's water also took somebody else's beetroot, and that beetroot is
 * neither where the lot came from nor where it went.
 */

import { batchKind, batchOutputs, mainOutput, runBulkItem } from './batches'
import { bulkItemOf } from './packs'
import { product } from './stock'
import {
  dispatchRuns,
  happenedAt,
  legacyPackStockIds,
  outputStockIds,
  packStockIds,
  receiptsFor,
  resolveStockId,
  runsFilling,
  type StockPlace,
} from './stockIds'
import { sourceKey } from './traceGraph'
import type { AppState, Batch, Dispatch, PackingRun, StockIssue } from '../types'

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

export interface TraceResult {
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

export function traceChain(state: AppState, raw: string): TraceResult | null {
  const t = raw.trim().toLowerCase()
  if (!t) return null
  /**
   * A code or document number names one record, so it has to match whole: DSP-2026-0001
   * is not a question about DSP-2026-00010, and a batch number is not a question about
   * every dispatch that happens to mention it.
   */
  const is = (v?: string) => !!v && v.trim().toLowerCase() === t
  /** A name is searched by whatever part of it the operator remembers. */
  const mentions = (v?: string) => !!v && v.toLowerCase().includes(t)

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
   * walking back from a blend or a dispatch must not then drag in everything else that
   * used it.
   */
  const forward = new Map<string, Scope>()
  /** Packing runs in the chain, and which of their lines. */
  const runs = new Map<string, Scope>()
  /**
   * The part of `runs` whose packs travel forward. A run reached by walking back from a
   * dispatch is where that dispatch's packs came from — not a question about every other
   * dispatch filled from the same run.
   */
  const runsForward = new Map<string, Scope>()
  /**
   * Runs whose own making belongs to the answer — the ones asked about, or walked back to
   * from a dispatch or an issue — so the chain climbs from them to the batch and lots
   * behind them. A run reached by following a lot forward, or one that merely drew a
   * packing material asked about, is downstream: the juice and farmers behind it are not.
   */
  const upstreamRuns = new Set<string>()
  /** Lots and packing-material receipts whose stock travels forward: the ones asked about. */
  const seedLots = new Set<string>()
  const seedMaterials = new Set<string>()
  /**
   * Packs booked straight onto a batch before packing runs existed, as `batch·pack`. There
   * is no run to carry them, so the chain carries them by name.
   */
  const legacyShown = new Set<string>()
  const legacyForward = new Set<string>()
  const legacyKey = (batchId: string, sku: string) => `${batchId}·${sku}`
  /** The bulk a legacy pack was filled from: its product's, or failing that the batch's main output. */
  const legacyBulk = (b: Batch, sku: string) => {
    const p = product(state, sku)
    return p ? bulkItemOf(p) : mainOutput(b)?.item || ''
  }

  const seedLot = (lot: string) => {
    lots.add(lot)
    seedLots.add(lot)
  }
  const seedBatch = (id: string, scope: Scope) => {
    widen(shown, id, scope)
    widen(forward, id, scope)
  }
  const seedRun = (id: string, scope: Scope, upstream = true) => {
    widen(runs, id, scope)
    widen(runsForward, id, scope)
    if (upstream) upstreamRuns.add(id)
  }

  /**
   * Where finished packs of a batch came from, walking back only: the runs that filled
   * them, narrowed to that pack. Packs booked on the batch before packing runs existed
   * have no run, so they come back to the bulk they were filled from instead.
   */
  const packsFrom = (batchId: string, sku: string, filled: PackingRun[]) => {
    filled.forEach((p) => {
      widen(runs, p.id, new Set([sku]))
      upstreamRuns.add(p.id)
    })
    if (filled.length) return
    const b = state.batches.find((x) => x.id === batchId)
    if (!b) return
    legacyShown.add(legacyKey(batchId, sku))
    const bulk = legacyBulk(b, sku)
    if (bulk) widen(shown, batchId, new Set([bulk]))
  }

  /** One dispatch: its customer, and back to the packs it drew. */
  const seedDispatch = (d: Dispatch) => {
    dispatches.add(d.id)
    customers.add(d.customerId)
    packsFrom(d.batchId, d.sku, dispatchRuns(state, d))
  }

  /** Everything a customer was sent — each dispatch on its own terms. */
  const seedCustomer = (id: string) => {
    customers.add(id)
    state.dispatches.forEach((d) => {
      if (d.customerId === id) seedDispatch(d)
    })
  }

  /** A stock issue, and back to the stock each of its lines took. */
  const seedIssue = (i: StockIssue) => {
    issues.add(i.id)
    for (const l of i.lines) {
      const at: StockPlace = { expiry: l.expiry, location: l.location, time: i.date }
      if (l.itemType === 'Raw Material') lots.add(l.lot)
      else if (l.itemType === 'Semi Finished') widen(shown, l.lot, new Set([l.item]))
      else if (l.itemType === 'Finished Goods') {
        packsFrom(l.lot, l.item, runsFilling(state, l.lot, l.item, at))
      } else receiptsFor(state, l.item, l.lot, at).forEach((doc) => materials.add(doc))
    }
  }

  /** A receipt of packing material, and the packs that were filled into it. */
  const seedMaterial = (doc: string) => {
    const receipt = state.ledger.find((l) => l.type === 'PM Receipt' && l.doc === doc)
    if (!receipt) return
    materials.add(doc)
    seedMaterials.add(doc)
    // The runs that drew this receipt — not another delivery sharing its supplier lot.
    const drewIt = new Set(
      state.ledger
        .filter(
          (l) =>
            l.type === 'Packing Consume' &&
            l.item === receipt.item &&
            l.lot === receipt.lot &&
            receiptsFor(state, l.item, l.lot, { location: l.location, time: happenedAt(state, l) }).includes(doc),
        )
        .map((l) => l.doc),
    )
    state.packingRuns.forEach((p) => {
      if (!drewIt.has(p.id)) return
      // A run fills several packs, and only those whose bill of materials takes this
      // material were filled into it.
      const used = p.lines
        .filter((l) => product(state, l.sku)?.bom.some((c) => c.item === receipt.item))
        .map((l) => l.sku)
      seedRun(p.id, used.length ? new Set(used) : 'all', false)
    })
  }

  /** A supplier: every lot of produce it sold and every delivery of packing material. */
  const seedVendor = (id: string) => {
    state.grns.forEach((g) => {
      if (g.farmerId === id) seedLot(g.lot)
    })
    state.ledger.forEach((l) => {
      if (l.type === 'PM Receipt' && l.vendorId === id) seedMaterial(l.doc)
    })
  }

  /**
   * A product code or name — SF-0001, "Tender Coconut Malai" — is a question about
   * that product in every batch that made it, by-products included, every receipt
   * that brought it in and every run that filled it. The batch comes along narrowed
   * to that product rather than whole.
   */
  const seedProducts = (products: Set<string>) => {
    state.batches.forEach((b) => {
      const made = batchOutputs(b)
        .map((o) => o.item)
        .filter((i) => products.has(i))
      if (made.length) seedBatch(b.id, new Set(made))
    })
    state.grns.forEach((g) => {
      if (products.has(g.itemId || '')) seedLot(g.lot)
    })
    state.packingRuns.forEach((p) => {
      const skus = p.lines.map((l) => l.sku).filter((sku) => products.has(sku))
      if (skus.length) seedRun(p.id, new Set(skus))
    })
    state.batches.forEach((b) => {
      ;(b.outputs || []).forEach((o) => {
        if (!products.has(o.sku)) return
        legacyShown.add(legacyKey(b.id, o.sku))
        legacyForward.add(legacyKey(b.id, o.sku))
      })
    })
    state.ledger.forEach((l) => {
      if (l.type === 'PM Receipt' && products.has(l.item)) seedMaterial(l.doc)
    })
  }

  const products = new Set<string>()
  const found = () =>
    products.size +
    lots.size +
    materials.size +
    shown.size +
    runs.size +
    dispatches.size +
    issues.size +
    customers.size +
    legacyShown.size

  /**
   * A stock ID names one item exactly, so it is resolved before anything is matched
   * by name — and traced as that item alone: the malai of a batch, not the batch.
   */
  const ref = resolveStockId(state, t)
  if (ref?.kind === 'raw') {
    seedLot(ref.lot)
  } else if (ref?.kind === 'bulk') {
    seedBatch(ref.batchId, new Set([ref.item]))
  } else if (ref?.kind === 'batch') {
    // A pack booked on the batch before packing runs existed: that pack, not the batch.
    legacyShown.add(legacyKey(ref.batchId, ref.sku))
    legacyForward.add(legacyKey(ref.batchId, ref.sku))
    const b = state.batches.find((x) => x.id === ref.batchId)
    const bulk = b && legacyBulk(b, ref.sku)
    if (bulk) widen(shown, ref.batchId, new Set([bulk]))
  } else if (ref?.kind === 'pack') {
    seedRun(ref.runId, new Set([ref.sku]))
  } else if (ref?.kind === 'material') {
    seedMaterial(ref.doc)
  } else {
    // Record numbers and codes first, matched whole.
    state.items.forEach((i) => {
      if (is(i.id)) products.add(i.id)
    })
    ;(state.products || []).forEach((p) => {
      if (is(p.id)) products.add(p.id)
    })
    state.grns.forEach((g) => {
      if (is(g.id) || is(g.lot) || is(g.farmerId)) seedLot(g.lot)
    })
    state.vendors.forEach((v) => {
      if (is(v.id)) seedVendor(v.id)
    })
    // The supplier's lot number is what a packing-material sticker carries.
    state.ledger.forEach((l) => {
      if (l.type === 'PM Receipt' && is(l.lot)) seedMaterial(l.doc)
    })
    state.batches.forEach((b) => {
      if (is(b.id)) seedBatch(b.id, 'all')
    })
    // A QC verdict is about one product of one batch, and a recall off it follows that product.
    state.qcs.forEach((q) => {
      if (is(q.id)) seedBatch(q.batchId, q.item ? new Set([q.item]) : 'all')
    })
    state.packingRuns.forEach((p) => {
      if (is(p.id)) seedRun(p.id, 'all')
    })
    // A challan can carry several dispatch lines; each comes back on its own terms.
    state.dispatches.forEach((d) => {
      if (is(d.id) || is(d.challan)) seedDispatch(d)
    })
    state.orders.forEach((o) => {
      if (!is(o.id)) return
      state.dispatches.forEach((d) => {
        if (d.orderId === o.id) seedDispatch(d)
      })
    })
    ;(state.stockIssues || []).forEach((i) => {
      if (is(i.id)) seedIssue(i)
    })
    state.customers.forEach((c) => {
      if (is(c.id)) seedCustomer(c.id)
    })

    /**
     * Names only when no record number matched, so a number is never read as part of a
     * name — and a whole name before part of one, so "5 L BiB" is not also "2.5 L BiB".
     */
    const byName = (matches: (v?: string) => boolean) => {
      state.items.forEach((i) => {
        if (matches(i.name)) products.add(i.id)
      })
      ;(state.products || []).forEach((p) => {
        if (matches(p.name)) products.add(p.id)
      })
      state.vendors.forEach((v) => {
        if (matches(v.name)) seedVendor(v.id)
      })
      state.grns.forEach((g) => {
        if (matches(g.farmerName) || matches(g.farmer) || matches(g.area)) seedLot(g.lot)
      })
      // An extraction is named after the product it made, which the product match already
      // carries — narrowed. Only a melange is named after something else: its recipe.
      state.batches.forEach((b) => {
        if (batchKind(b) !== 'Melange') return
        if (matches(state.melanges.find((m) => m.id === b.melangeId)?.name)) seedBatch(b.id, 'all')
      })
      state.customers.forEach((c) => {
        if (matches(c.name)) seedCustomer(c.id)
      })
      // A dispatch keeps the customer name it went out under, even if the master changed since.
      state.dispatches.forEach((d) => {
        if (matches(d.customerName)) seedDispatch(d)
      })
      ;(state.stockIssues || []).forEach((i) => {
        if (matches(i.recipient)) seedIssue(i)
      })
    }
    if (!found()) byName(is)
    if (!found()) byName(mentions)
    if (products.size) seedProducts(products)
  }

  /** Batches the answer climbs back from: everything seeded, before the forward walk adds more. */
  const upstream = [...shown.keys()]

  /** Whether a run the chain carries forward filled this batch's packs. */
  const hasForwardRun = (batchId: string) =>
    state.packingRuns.some((p) => p.batchId === batchId && runsForward.has(p.id))
  const carried = (filled: PackingRun[], sku: string) =>
    filled.some((p) => allows(runsForward, p.id, sku))

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
      if (!allows(forward, p.batchId, runBulkItem(p))) return
      if (widen(runsForward, p.id, 'all')) changed = true
      if (widen(runs, p.id, 'all')) changed = true
    })
    // Packs booked on a batch before runs existed travel with the bulk they were filled from.
    state.batches.forEach((b) => {
      ;(b.outputs || []).forEach((o) => {
        const key = legacyKey(b.id, o.sku)
        if (legacyForward.has(key) || !allows(forward, b.id, legacyBulk(b, o.sku))) return
        legacyForward.add(key)
        legacyShown.add(key)
        changed = true
      })
    })
    ;(state.stockIssues || []).forEach((i) => {
      if (issues.has(i.id)) return
      const hit = i.lines.some((l) => {
        const at: StockPlace = { expiry: l.expiry, location: l.location, time: i.date }
        if (l.itemType === 'Raw Material') return seedLots.has(l.lot)
        if (l.itemType === 'Semi Finished') return allows(forward, l.lot, l.item)
        if (l.itemType === 'Finished Goods') {
          return (
            forward.get(l.lot) === 'all' ||
            legacyForward.has(legacyKey(l.lot, l.item)) ||
            (hasForwardRun(l.lot) && carried(runsFilling(state, l.lot, l.item, at), l.item))
          )
        }
        return (
          seedMaterials.size > 0 &&
          receiptsFor(state, l.item, l.lot, at).some((doc) => seedMaterials.has(doc))
        )
      })
      if (hit) {
        issues.add(i.id)
        changed = true
      }
    })
    state.dispatches.forEach((d) => {
      const hit =
        forward.get(d.batchId) === 'all' ||
        legacyForward.has(legacyKey(d.batchId, d.sku)) ||
        (hasForwardRun(d.batchId) && carried(dispatchRuns(state, d), d.sku))
      if (!hit) return
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

  // ---- backward: what went into what was asked about? ---------------------
  // Every run in the chain shows the batch it filled from, narrowed to the bulk it drew.
  runs.forEach((_, runId) => {
    const p = state.packingRuns.find((x) => x.id === runId)
    if (!p) return
    widen(shown, p.batchId, new Set([runBulkItem(p)]))
    if (upstreamRuns.has(runId)) upstream.push(p.batchId)
  })
  // The chain climbs from what was asked about to the lots, blends and farmers behind it.
  const climbed = new Set<string>()
  while (upstream.length) {
    const batchId = upstream.pop() as string
    if (climbed.has(batchId)) continue
    climbed.add(batchId)
    const b = state.batches.find((x) => x.id === batchId)
    if (!b) continue
    b.sourceLines.forEach((l) => lots.add(l.lot))
    // A melange's components are batches, so a blend reaches the juice that made it and,
    // through that, the lot and the farmer behind it — only the juice it drew.
    ;(b.blendLines || []).forEach((l) => {
      widen(shown, l.lot, new Set([l.item]))
      upstream.push(l.lot)
    })
  }
  state.grns.forEach((g) => {
    if (lots.has(g.lot)) sources.add(sourceKey(g))
  })
  // The packing material every run in the chain filled its packs into. A pack is the juice
  // and the bottle it went out in, so a recall of either has to reach the other — but
  // only what the packs in the chain take, by their bills of materials.
  runs.forEach((scope, runId) => {
    const p = state.packingRuns.find((x) => x.id === runId)
    if (!p) return
    const skus = scope === 'all' ? p.lines.map((l) => l.sku) : [...scope]
    const bom = new Set(skus.flatMap((sku) => (product(state, sku)?.bom || []).map((c) => c.item)))
    state.ledger.forEach((l) => {
      if (l.doc !== runId || l.type !== 'Packing Consume' || l.itemType !== 'Packing Material') return
      if (bom.size && !bom.has(l.item)) return
      receiptsFor(state, l.item, l.lot, { location: l.location, time: happenedAt(state, l) }).forEach((doc) =>
        materials.add(doc),
      )
    })
  })

  const stockIds = new Set<string>([...lots, ...materials])
  shown.forEach((scope, batchId) => {
    const b = state.batches.find((x) => x.id === batchId)
    if (!b) return
    outputStockIds(b).forEach((l) => {
      if (scope === 'all' || scope.has(l.item)) stockIds.add(l.stockId)
    })
    legacyPackStockIds(b).forEach((o) => {
      if (scope === 'all' || legacyShown.has(legacyKey(b.id, o.sku))) stockIds.add(o.stockId)
    })
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
    return null
  }
  return {
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
  }
}
