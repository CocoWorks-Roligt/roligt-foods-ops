/**
 * The flag reader — one definition client and server share (ARCHITECTURE §5:
 * the client pre-checks against the same map the server enforces from).
 *
 * Flags are documents in the `flags` collection (FlagRecord rows, seeded OFF by
 * the Phase-2 backfill). Every phase rides a flag and rolls back by switching
 * it off, so the reader's whole job is: parse whatever rows exist into a typed
 * map where every missing row reads as OFF. A base with no flags collection at
 * all (pre-backfill) is all-OFF, which is byte-for-byte today's behaviour.
 *
 * The `.ts` extensions are deliberate: this module is compiled by the api
 * project's nodenext tsconfig too, where extensionless relative imports do not
 * resolve (see src/lib/stock.ts for the convention).
 */
import type { FlagKey, FlagRecord } from '../contracts.ts'

/** The closed set of named flags — the template `dashboards_${string}` member
 *  of FlagKey is carried separately so this stays a finite, typed record. */
export type NamedFlag = Exclude<FlagKey, `dashboards_${string}`>

/** Every flag the plant knows, each with its verdict. */
export interface FlagMap {
  shell_nav: boolean
  pipeline: boolean
  batch_v2: boolean
  qc_gate_v2: boolean
  dispatch_v2: boolean
  shipments: boolean
  /** `dashboards_<module>` — one per KPI module, arbitrary suffixes tolerated. */
  dashboards: Record<string, boolean>
}

/** The rollback position: nothing the overhaul adds is on (ARCHITECTURE §7). */
export const ALL_FLAGS_OFF: FlagMap = {
  shell_nav: false,
  pipeline: false,
  batch_v2: false,
  qc_gate_v2: false,
  dispatch_v2: false,
  shipments: false,
  dashboards: {},
}

/** Anything shaped like a flag row — a stored FlagRecord or its raw document. */
export type FlagLike = Pick<FlagRecord, 'key'> & Partial<Pick<FlagRecord, 'enabled'>>

/**
 * Fold flag rows into the typed map. Unknown keys are ignored (a flag this
 * build does not know is OFF to it); `dashboards_<module>` keys land in the
 * sub-map; a row without a boolean `enabled` reads as OFF, never as on.
 */
export function readFlags(rows: readonly FlagLike[] | null | undefined): FlagMap {
  const flags: FlagMap = { ...ALL_FLAGS_OFF, dashboards: {} }
  for (const row of rows ?? []) {
    if (!row || typeof row.key !== 'string') continue
    if (row.key.startsWith('dashboards_')) {
      flags.dashboards[row.key.slice('dashboards_'.length)] = row.enabled === true
      continue
    }
    if (row.key in flags) (flags as unknown as Record<string, boolean>)[row.key] = row.enabled === true
  }
  return flags
}

/** One flag's verdict, named or dashboard — unknown flags are OFF. */
export function flagEnabled(flags: FlagMap, key: FlagKey): boolean {
  if (key.startsWith('dashboards_')) return flags.dashboards[key.slice('dashboards_'.length)] === true
  return (flags as unknown as Record<string, boolean>)[key] === true
}
