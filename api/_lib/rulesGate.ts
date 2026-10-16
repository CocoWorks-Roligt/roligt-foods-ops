/**
 * The rules gate — the server-side arm of the isomorphic rules module
 * (ARCHITECTURE §5): the same pure functions the client pre-checks with,
 * called here as the AUTHORITY on the commit path. Everything in this file is
 * verdict-only, in the commitGates.ts tradition — no I/O; the engine
 * (d1Commit) supplies the stored evidence its preflight already read and
 * writes the audit row a refusal files.
 *
 * Both behaviours are flag-gated and inert while the flags are OFF
 * (ARCHITECTURE §7 — rollback is the flag switched off):
 *
 *   qc_gate_v2 — a ledger draw for a blend or a packing run ('Melange
 *     Consume' / 'Packing Consume' of Semi Finished stock) from a lot that is
 *     not Released is refused with code 'lot_not_released'. Classic keeps
 *     today's rule, where Quarantine bulk is blendable (posting.ts DRAWABLE).
 *
 *   batch_v2 — a batch moving to Closed or Released (the close-equivalent a
 *     legacy QC roll-up writes) is refused unless a spoilage record exists for
 *     that batch and the mass balance, recomputed here from the changeset's
 *     batch document plus the stored one, sits within tolerance. A conversion
 *     the documents cannot answer fails closed: no balance, no close.
 */
import type { StateChanges } from '../../src/lib/sync.js'
import {
  GUARD_EXPLANATIONS,
  type GuardKey,
  type SpoilageRecord,
} from '../../src/lib/contracts.js'
import { type FlagMap, readFlags } from '../../src/lib/rules/flags.js'
import { isAdminPermissions } from '../../src/lib/permissions.js'
import {
  MassBalanceError,
  type MassBalanceItems,
  computeMassBalance,
  massBalanceConfigOf,
  type MassBalanceConfig,
  type MassBalanceLine,
} from '../../src/lib/rules/massBalance.js'
import { closeRunGuards } from '../../src/lib/rules/spoilage.js'

/** The refusal a rules gate raises — the route answers it as an ApiError
 *  (contracts §5): prose `error`, stable `code` the UI branches on. */
export class RulesRejected extends Error {
  /** A stable refusal key ('lot_not_released', or the GuardKey that failed). */
  readonly code: string
  /** The guard that refused (audits carry this). */
  readonly guard: GuardKey
  /** What was being written — 'lot' or 'run'. */
  readonly entity: 'lot' | 'run'
  /** The document the refusal names. */
  readonly docId: string
  constructor(args: { code: string; guard: GuardKey; entity: 'lot' | 'run'; docId: string; message: string }) {
    super(args.message)
    this.code = args.code
    this.guard = args.guard
    this.entity = args.entity
    this.docId = args.docId
  }
}

/** The ledger line types that draw bulk for a blend or a packing run. */
const BULK_DRAW_TYPES = new Set(['Melange Consume', 'Packing Consume'])

/** The batch statuses whose arrival a close-guard judges (legacy 'Released'
 *  is the QC roll-up's close-equivalent; 'Closed' is the run machine's). */
const CLOSE_STATUSES = new Set(['Closed', 'Released'])

/** The stored evidence the gate judges against, as the engine's preflight
 *  already holds it. Nothing here is fetched twice. */
export interface RulesEvidence {
  /** Parsed `flags` documents — readFlags, all-OFF when the collection is empty. */
  flags: FlagMap
  /** Stored batch documents by id (the touched-rows read). */
  storedBatches: Record<string, Record<string, unknown> | undefined>
  /** Every stored spoilage record; the gate filters by batchId itself. */
  spoilage: readonly SpoilageRecord[]
  /** Material masters the conversions read, by item id. */
  items: MassBalanceItems
  /** The stored app_config object (meta row), parsed — null when unparsable. */
  appConfig: Record<string, unknown> | null
  /** The caller's held permission slugs — the release arm reads them. */
  permissions: readonly string[]
}

/** What the gate needs from the store for THIS changeset, computed from the
 *  payload alone so the engine can shape its preflight statements. */
export interface RulesWants {
  /** Flags must be read (a ledger draw or a batch close may be gated). */
  flags: boolean
  /** Batch ids whose upsert names a close-directed status. */
  closeBatchIds: string[]
  /** Item ids the close's mass balance converts through. */
  itemIds: string[]
}

const batchDocOf = (row: Record<string, unknown>): Record<string, unknown> => {
  const data = (row as { data?: unknown }).data
  return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {}
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Which stored reads this changeset's gate needs — none at all unless the
 *  payload touches a ledger draw or a batch status, so a flags-off base is
 *  byte-for-byte today's commit path. */
export function rulesWantsEvidence(changes: StateChanges): RulesWants {
  const closeBatchIds: string[] = []
  const itemIds = new Set<string>()
  let flags = false
  for (const change of changes.tables) {
    if (change.table === 'ledger' && change.upsert.length) flags = true
    if (change.table !== 'batches') continue
    for (const row of change.upsert) {
      const doc = batchDocOf(row)
      if (!CLOSE_STATUSES.has(str(doc.status))) continue
      flags = true
      closeBatchIds.push(String(row.id))
      const lines = [
        ...((doc.sourceLines as Record<string, unknown>[] | undefined) ?? []),
        ...((doc.blendLines as Record<string, unknown>[] | undefined) ?? []),
        ...((doc.outputLines as Record<string, unknown>[] | undefined) ?? []),
      ]
      for (const line of lines) {
        const item = str(line?.item)
        if (item) itemIds.add(item)
      }
    }
  }
  return { flags, closeBatchIds, itemIds: [...itemIds] }
}

/** The qc_gate_v2 arm: blend/pack draws of Semi Finished stock must name a
 *  Released lot. Draws of raw produce ('Production Consume') and packing
 *  material are not bulk draws and keep their own rules. */
function gateLotDraws(changes: StateChanges, flags: FlagMap): void {
  if (!flags.qc_gate_v2) return
  for (const change of changes.tables) {
    if (change.table !== 'ledger') continue
    for (const row of change.upsert) {
      const type = str(row.type)
      if (!BULK_DRAW_TYPES.has(type) || str(row.item_type) !== 'Semi Finished') continue
      if (!(Number(row.qty_out) > 0)) continue
      const status = str(row.status)
      if (status === 'Released') continue
      throw new RulesRejected({
        code: 'lot_not_released',
        guard: 'released_only',
        entity: 'lot',
        docId: str(row.lot) || str(row.doc),
        message: `${GUARD_EXPLANATIONS.released_only} ${str(row.item) || 'This stock'} in lot ${str(row.lot) || str(row.doc)} is ${status || 'not released'}.`,
      })
    }
  }
}

/** The batch's lines as mass balance reads them: sources + blends in, outputs
 *  out — a legacy coconut batch without outputLines answers through its
 *  waterLitres/malaiKg. A line with no unit of its own reads the item's.
 *  (B3's close endpoint folds the same lines — exported so the two cannot drift.) */
export function batchLines(doc: Record<string, unknown>, items: MassBalanceItems): {
  inputs: MassBalanceLine[]
  outputs: MassBalanceLine[]
} {
  const line = (l: Record<string, unknown>): MassBalanceLine => {
    const item = str(l.item)
    return { item, qty: Number(l.qty) || 0, uom: str(l.uom) || str(items[item]?.uom) }
  }
  const inputs = [
    ...((doc.sourceLines as Record<string, unknown>[] | undefined) ?? []),
    ...((doc.blendLines as Record<string, unknown>[] | undefined) ?? []),
  ].map(line)
  const outputLines = (doc.outputLines as Record<string, unknown>[] | undefined) ?? []
  const outputs = outputLines.length
    ? outputLines.map(line)
    : [
        ...(Number(doc.waterLitres) > 0 ? [{ item: '', qty: Number(doc.waterLitres), uom: 'Litre' }] : []),
        ...(Number(doc.malaiKg) > 0 ? [{ item: '', qty: Number(doc.malaiKg), uom: 'Kg' }] : []),
      ]
  return { inputs: inputs.filter((l) => l.qty > 0), outputs: outputs.filter((l) => l.qty > 0) }
}

/** The batch_v2 arm: a close-directed status change must carry a spoilage
 *  record and a mass balance within tolerance — recomputed HERE, from the
 *  changeset's document merged over the stored one, never trusted from the
 *  client. A status that is not changing (an idempotent re-send, an edit that
 *  leaves it alone) is not judged. */
function gateBatchCloses(changes: StateChanges, evidence: RulesEvidence): void {
  if (!evidence.flags.batch_v2) return
  const config: MassBalanceConfig = massBalanceConfigOf(evidence.appConfig)
  for (const change of changes.tables) {
    if (change.table !== 'batches') continue
    for (const row of change.upsert) {
      const doc = batchDocOf(row)
      if (!CLOSE_STATUSES.has(str(doc.status))) continue
      const id = String(row.id)
      const stored = evidence.storedBatches[id]
      if (str(stored?.status) === str(doc.status)) continue // not a change
      const records = evidence.spoilage.filter((r) => r.batchId === id)
      const { inputs, outputs } = batchLines({ ...(stored ?? {}), ...doc }, evidence.items)
      const spillage: MassBalanceLine[] = records.map((r) => ({ item: '', qty: Number(r.qty) || 0, uom: str(r.uom) }))
      let result
      let conversionProblem: string | null = null
      try {
        result = computeMassBalance(inputs, outputs, spillage, evidence.items, config)
      } catch (e) {
        if (!(e instanceof MassBalanceError)) throw e
        // no configured path to kg = no balance = no close (fail closed)
        conversionProblem = e.message
      }
      const verdicts = result ? closeRunGuards({ id }, records, result) : undefined
      if (verdicts) {
        const failed = verdicts.find((v) => !v.passed)
        if (failed) {
          const detail =
            failed.guard === 'mass_balance_ok' && result
              ? ` Variance is ${result.variancePct.toFixed(2)}% against a ${config.massBalanceTolerancePct}% tolerance.`
              : ''
          throw new RulesRejected({
            code: failed.guard,
            guard: failed.guard,
            entity: 'run',
            docId: id,
            message: `${GUARD_EXPLANATIONS[failed.guard]}${detail}`,
          })
        }
      } else if (conversionProblem) {
        throw new RulesRejected({
          code: 'mass_balance_ok',
          guard: 'mass_balance_ok',
          entity: 'run',
          docId: id,
          message: `${GUARD_EXPLANATIONS.mass_balance_ok} ${conversionProblem}`,
        })
      }
    }
  }
}

/**
 * The whole gate, in commitGates' shape: judge the changeset against the
 * evidence, throw RulesRejected on the first refusal. With both flags OFF
 * every arm returns without reading a row of the evidence.
 */
export function gateRules(changes: StateChanges, evidence: RulesEvidence): void {
  gateLotDraws(changes, evidence.flags)
  gateDispatchDraws(changes, evidence.flags)
  gateBatchCloses(changes, evidence)
  gateQcReleases(changes, evidence)
}

/** The qc_gate_v2 dispatch arm (§3.3-7's third verb): a dispatch draw — a pack
 *  leaving the gate — must be Released stock. The client's own pool
 *  (releasedPacksBySku) already refuses unreleased packs fold-side; this is
 *  the server's word for it, same flag, same refusal code as the blend/pack
 *  arm. A row with NO status passes: legacy pre-QC-era dispatches never
 *  stamped one, and the flag must roll out over years of them. */
function gateDispatchDraws(changes: StateChanges, flags: FlagMap): void {
  if (!flags.qc_gate_v2) return
  for (const change of changes.tables) {
    if (change.table !== 'ledger') continue
    for (const row of change.upsert) {
      if (str(row.type) !== 'Dispatch') continue
      if (!(Number(row.qty_out) > 0)) continue
      const status = str(row.status)
      if (!status || status === 'Released') continue
      throw new RulesRejected({
        code: 'lot_not_released',
        guard: 'released_only',
        entity: 'lot',
        docId: str(row.lot) || str(row.doc),
        message: `${GUARD_EXPLANATIONS.released_only} ${str(row.item) || 'This stock'} in lot ${str(row.lot) || str(row.doc)} is ${status}.`,
      })
    }
  }
}

/** Who may write a Released disposition (RBAC.md can.release_lot): an admin,
 *  a holder of the QC page, or an explicit can.release_lot slug once role
 *  seeding starts issuing the action slugs. page.quality is the proxy until
 *  then — so a Manager ticking the QC page carries the release write with it
 *  (a known limitation, DECISIONS.md). */
export function mayReleaseLot(held: readonly string[]): boolean {
  return isAdminPermissions(held) || held.includes('page.quality') || held.includes('can.release_lot')
}

/** The qc_gate_v2 release arm: a changeset may not set a QC disposition to
 *  Released unless the caller holds the release entitlement. Classic keeps
 *  today's behaviour, where any caller the qcs table gate admitted may write
 *  any disposition. */
function gateQcReleases(changes: StateChanges, evidence: RulesEvidence): void {
  if (!evidence.flags.qc_gate_v2) return
  for (const change of changes.tables) {
    if (change.table !== 'qcs') continue
    for (const row of change.upsert) {
      // doc tables arrive flat or wrapped ({ id, data }) — read either shape
      const doc = ((row as { data?: unknown }).data ?? row) as Record<string, unknown>
      if (str(doc.disposition) !== 'Released') continue
      if (mayReleaseLot(evidence.permissions)) continue
      throw new RulesRejected({
        code: 'release_forbidden',
        guard: 'role_allowed',
        entity: 'lot',
        docId: str(row.id),
        message: `${GUARD_EXPLANATIONS.role_allowed} Only QC may release a lot (RBAC.md can.release_lot).`,
      })
    }
  }
}

/** The audits row a refusal files — action 'rules.rejected', details naming
 *  the entity and the guard (the engine writes it; the refused commit's own
 *  rows never land). */
export function rulesAuditRow(callerEmail: string, rejection: RulesRejected, at: string): {
  id: string
  at: string
  actor: string
  action: string
  doc: string
  details: string
} {
  return {
    id: `AUD-rules-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at,
    actor: callerEmail,
    action: 'rules.rejected',
    doc: rejection.docId,
    details: JSON.stringify({ entity: rejection.entity, guard: rejection.guard }),
  }
}

/** Flags out of raw `flags` documents' JSON strings — the engine's parse step. */
export function flagsOfDocs(jsons: readonly string[]): FlagMap {
  const rows: { key: string; enabled?: boolean }[] = []
  for (const json of jsons) {
    try {
      const doc = JSON.parse(json) as { key?: unknown; enabled?: unknown }
      if (typeof doc?.key === 'string') rows.push({ key: doc.key, enabled: doc.enabled === true })
    } catch {
      // a hand-staged row is not a flag — OFF is the default everywhere
    }
  }
  return readFlags(rows)
}

/** The flags documents themselves (snapshot's read-only ride-along for the
 *  client, SHELL): parsed rows, not the typed map, so the client folds them
 *  through the same isomorphic readFlags the server enforces from. The client
 *  is taken structurally — D1Client satisfies it; nothing here needs the
 *  engine's wider surface. */
export async function readFlagRecords(
  d1: { query<T>(sql: string, params?: unknown[]): Promise<T[]> },
): Promise<{ key: string; enabled: boolean }[]> {
  const rows = await d1.query<{ json: unknown }>(
    `SELECT json FROM documents WHERE collection = 'flags'`,
  )
  const out: { key: string; enabled: boolean }[] = []
  for (const r of rows) {
    try {
      const doc = JSON.parse(String(r.json ?? '')) as { key?: unknown; enabled?: unknown }
      if (typeof doc?.key === 'string') out.push({ key: doc.key, enabled: doc.enabled === true })
    } catch {
      // a hand-staged row is not a flag
    }
  }
  return out
}
