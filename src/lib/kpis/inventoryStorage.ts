/**
 * The inventory/storage module's fold (KPI.md §Inventory / Storage). The stock
 * POSITION is stockRows — the same fold the Inventory page's table is — and the
 * ageing and expiry cuts ride the classic reports' own folds (lotAgeing,
 * fgOnHand), so the dashboard and the reports count the same rows. Value (₹) is
 * the only unit that sums across categories: quantities never are, and a uom
 * rides the label wherever a chart must split them.
 *
 * Honest gaps, logged in DECISIONS (P5 D4a): COLD-ROOM CAPACITY is not recorded
 * (no field exists), so the occupancy heatmap is value by room, not fill %.
 * SLOW-MOVING's threshold has no config field — SLOW_MOVING_DAYS (30) is the
 * logged ASSUMED constant. Near-expiry follows the classic rule (Released
 * finished goods inside config.expiryAlertDays, fgOnHand's own default);
 * near-expiry BULK is the blending module's card (ib-near-expiry), so the two
 * never double-count.
 *
 * Isomorphic: `.ts` extensions, no browser globals.
 */

import type { AppState } from '../../types.ts'
import type { ReportWindow } from '../reports/params.ts'
import { stockRows, stockRowKey, itemTypeLabel, locationLabel } from '../stock.ts'
import { lotAgeing, fgOnHand, daysBetween } from '../reports/inventoryReports.ts'
import { packLabel } from '../packs.ts'
import { localDay } from '../utils.ts'
import { packFormatOf } from './packing.ts'
import type { KpiCard, KpiChart } from '../contracts.ts'
import type { KpiPayload } from './qc.ts'

/** Days without a single ledger line before an on-hand row counts as
 * slow-moving. No config field exists for it (KPI.md's "> N days") — this is
 * the ASSUMED constant, logged in DECISIONS. */
export const SLOW_MOVING_DAYS = 30

// Every cut is a position or a today-based ageing — nothing windows (the
// control-samples precedent), so the window parameter goes unread.
export function inventoryStorageKpis(state: Partial<AppState>, _w: ReportWindow, today: string): KpiPayload {
  // stockRows/lotAgeing/fgOnHand read exactly the module's declared collections
  // (ledger, items, grns, storageLocations, products) — the cast only satisfies
  // their AppState signatures.
  const s = state as AppState
  const rows = stockRows(s).filter((r) => r.qty > 0)
  const round2 = (n: number) => Number(n.toFixed(2))

  // ── Stock value by category (₹ — the one cross-category unit) ──────────────
  const valueBy = new Map<string, number>()
  for (const r of rows) valueBy.set(r.itemType, (valueBy.get(r.itemType) ?? 0) + r.value)
  const byCategory: KpiChart = {
    key: 'inv-value-by-category',
    label: 'Stock value by category',
    kind: 'treemap',
    rows: [...valueBy.entries()].map(([t, v]) => ({ label: itemTypeLabel(t), value: round2(v) })),
  }

  // ── Cold-room occupancy: value by room × category. Capacity is not recorded
  //    (logged gap) — this is where the value stands, not how full the room is.
  const coldRooms = (s.storageLocations ?? []).filter((l) => l.type === 'Cold Room')
  const heat = new Map<string, number>() // `${room}\u0000${category}` → value
  for (const room of coldRooms) {
    for (const r of rows.filter((x) => x.location === room.name)) {
      const k = `${room.name}\u0000${r.itemType}`
      heat.set(k, (heat.get(k) ?? 0) + r.value)
    }
  }
  const occupancy: KpiChart = {
    key: 'inv-coldroom-occupancy',
    label: 'Cold-room value by area',
    kind: 'heatmap',
    rows: coldRooms.flatMap((room) =>
      [...new Set(rows.filter((x) => x.location === room.name).map((x) => x.itemType))].map((t) => ({
        series: itemTypeLabel(t),
        label: locationLabel(s, room.name),
        value: round2(heat.get(`${room.name}\u0000${t}`) ?? 0),
      })),
    ),
  }

  // ── Ageing of raw + bulk, off the classic report's own buckets ─────────────
  const byAge = lotAgeing(s, ['Raw Material', 'Semi Finished'], today).byAge
  const ageing: KpiChart = {
    key: 'inv-ageing',
    label: 'Raw & bulk ageing',
    kind: 'stacked',
    rows: byAge.map((b) => ({ series: b.uom, label: b.bucket, value: b.qty })),
  }
  const slowBuckets = byAge.filter((b) => b.bucket === '15+ days').reduce((a, b) => a + b.lots, 0)

  // ── Near-expiry finished goods: the classic rule (Released FG, the report's
  //    own buckets off config.expiryAlertDays) — bulk is ib-near-expiry's count.
  const fg = fgOnHand(s, today).filter((r) => r.status === 'Released' && r.expiry)
  const nearBuckets = new Map<string, number>()
  for (const r of fg) nearBuckets.set(r.bucket, (nearBuckets.get(r.bucket) ?? 0) + 1)
  const alertDays = s.config?.expiryAlertDays ?? 2
  // Chronological bucket order — fgOnHand's own vocabulary, soonest first.
  const bucketOrder = ['Expired', `≤ ${alertDays} d`, '≤ 30 d', '> 30 d']
  const expiryChart: KpiChart = {
    key: 'inv-fg-expiry',
    label: 'Released FG by expiry bucket',
    kind: 'bar',
    rows: bucketOrder
      .filter((b) => nearBuckets.has(b))
      .map((b) => ({ label: b, value: nearBuckets.get(b) ?? 0 })),
  }
  const nearExpiry = fg.filter((r) => r.bucket === 'Expired' || r.bucket === `≤ ${alertDays} d`).length

  // ── Loose BIB stock by size: every BIB is stored loose (§3.3-6), so the BIB
  //    finished-goods position IS the loose position. Glass never answers.
  const bibBySize = new Map<string, number>()
  for (const r of rows.filter((x) => x.itemType === 'Finished Goods')) {
    const p = s.products?.find((x) => x.id === r.item)
    if (!p || packFormatOf(p) !== 'bib') continue
    const label = packLabel(p)
    bibBySize.set(label, (bibBySize.get(label) ?? 0) + r.qty)
  }
  const bibChart: KpiChart = {
    key: 'inv-bib-by-size',
    label: 'Loose BIB stock by size (packs)',
    kind: 'bar',
    rows: [...bibBySize.entries()].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value: Number(value.toFixed(1)) })),
  }

  // ── Slow-moving: no ledger line on the exact row for SLOW_MOVING_DAYS ──────
  const lastMovement = new Map<string, string>()
  for (const l of s.ledger) {
    const day = localDay(l.time)
    if (!day) continue
    const k = stockRowKey(l)
    const prev = lastMovement.get(k)
    if (!prev || day > prev) lastMovement.set(k, day)
  }
  const slow = rows.filter((r) => {
    const last = lastMovement.get(stockRowKey(r))
    return !!last && daysBetween(last, today) > SLOW_MOVING_DAYS
  }).length

  const cards: KpiCard[] = [
    { key: 'inv-stock-value', label: 'Stock value', value: round2(rows.reduce((a, r) => a + r.value, 0)), unit: '₹' },
    { key: 'inv-lines', label: 'Stock lines on hand', value: rows.length, href: '/inventory' },
    { key: 'inv-near-expiry', label: 'FG near expiry', value: nearExpiry, href: '/inventory' },
    { key: 'inv-slow-moving', label: `Slow-moving lines (> ${SLOW_MOVING_DAYS} d)`, value: slow },
    { key: 'inv-aged-lots', label: 'Raw & bulk lots 15+ days', value: slowBuckets },
  ]

  return { cards, charts: [byCategory, occupancy, ageing, expiryChart, bibChart] }
}
