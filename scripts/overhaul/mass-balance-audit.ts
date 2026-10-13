#!/usr/bin/env npx tsx
/**
 * Throwaway LEAD check (2026-10-13): run the real computeMassBalance over the
 * historical batches in the 2026-10-12 prod export — the pass rate at the 2%
 * default tolerance decides whether batch_v2 needs per-material tolerance,
 * a recorded unaccounted-loss, or warn-first before flags go on.
 */
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { batchLines } from '../../api/_lib/rulesGate.js'
import {
  MassBalanceError,
  computeMassBalance,
  massBalanceConfigOf,
} from '../../src/lib/rules/massBalance.js'

const db = new Database(':memory:')
db.exec(readFileSync(new URL('../d1/dump-prod-export-2026-10-12.sql', import.meta.url), 'utf8'))

const items: Record<string, { uom?: string; avgUnitWeight?: number; densityKgPerL?: number }> = {}
for (const r of db.prepare(`SELECT id, json FROM documents WHERE collection='items'`).all() as { id: string; json: string }[]) {
  try {
    const d = JSON.parse(r.json) as Record<string, unknown>
    items[r.id] = {
      ...(typeof d.uom === 'string' ? { uom: d.uom } : {}),
      ...(Number(d.avgUnitWeight) > 0 ? { avgUnitWeight: Number(d.avgUnitWeight) } : {}),
      ...(Number(d.densityKgPerL) > 0 ? { densityKgPerL: Number(d.densityKgPerL) } : {}),
    }
  } catch { /* skip */ }
}

const meta = db.prepare(`SELECT value FROM meta WHERE setting='app_config'`).get() as { value: string } | undefined
const config = massBalanceConfigOf(meta ? JSON.parse(meta.value) : null)
console.log(`config: tolerance=${config.massBalanceTolerancePct}% avgNut=${config.avgUnitWeightG}g density=${config.defaultDensityKgPerL}`)

const rows = db.prepare(`SELECT id, json FROM documents WHERE collection='batches' ORDER BY id`).all() as { id: string; json: string }[]
console.log(`batches: ${rows.length}`)

let pass = 0
let errored = 0
for (const r of rows) {
  const doc = JSON.parse(r.json) as Record<string, unknown>
  try {
    const { inputs, outputs } = batchLines(doc, items)
    const res = computeMassBalance(inputs, outputs, [], items, config)
    const ok = Math.abs(res.variancePct) <= config.massBalanceTolerancePct
    if (ok) pass++
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${String(doc.id).padEnd(14)} ${String(doc.kind ?? '?').padEnd(11)} status=${String(doc.status ?? '?').padEnd(14)} in=${res.inputBaseUnits.toFixed(1)}kg out=${res.outputBaseUnits.toFixed(1)}kg variance=${res.variancePct.toFixed(2)}%`,
    )
  } catch (e) {
    errored++
    const msg = e instanceof MassBalanceError ? `${e.item || '?'} ${e.need}` : e instanceof Error ? e.message.slice(0, 80) : '?'
    console.log(`ERR   ${String(doc.id).padEnd(14)} ${String(doc.kind ?? '?').padEnd(11)} ${msg}`)
  }
}
console.log(`\npass ${pass}/${rows.length} at ${config.massBalanceTolerancePct}% (errors: ${errored})`)
