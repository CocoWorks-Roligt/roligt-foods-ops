/**
 * StateChanges → idempotent Zoho writes.
 *
 * Every write is an upsert keyed by the row's own business key (App ID, Series,
 * Setting), which is what makes a commit safe to retry after a partial failure: the
 * second attempt re-writes the same rows rather than duplicating ledger lines — the one
 * exception is the audit trail, which is insert-only: an upsert naming an App ID that
 * already exists is skipped, so no commit (and no retry) can rewrite history. The
 * revision row is bumped last so a reader either sees the old plant whole or the new
 * plant whole. Admin-only tables are refused for operators here — this is the RLS of
 * the fork, and the client maps the 403 to the same 'forbidden' message it always had.
 */
import type { ZohoClient } from './zoho.ts'
import type { TableRef } from './baseSchema.ts'
import { T, TABLE_FOR } from './baseSchema.ts'
import { columnsFor, ledgerColumns, auditColumns, buildLinkMaps } from './mappers.ts'
import { COLLECTIONS } from '../../src/lib/tables.ts'
import type { StateChanges } from '../../src/lib/sync.ts'
import type { Caller } from './auth.ts'

export class Forbidden extends Error {
  readonly table: string
  constructor(table: string) {
    super(`You do not have permission to change ${table.replace(/_/g, ' ')}.`)
    this.table = table
  }
}

/**
 * Mapper columns arrive keyed by field NAME (readable, checked against the base by
 * eye); the wire speaks field IDs — `upsertByKey` sends `is_ids_used_in_data: true`,
 * so a name in that map is read as a bogus ID and the live API answers
 * 500 INTERNAL SERVER ERROR (pinned against the scratch base, 2026-09-22: every
 * name-keyed enrichment 500s while the same row with ID keys succeeds). Names the
 * generated schema does not know are dropped silently — the enrichment is
 * best-effort by contract; only App ID and Data JSON are load-bearing.
 */
function columnsByFieldId(
  table: TableRef,
  columns: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(columns)) {
    if (value === undefined) continue
    const fieldId = table.fields[name]
    if (fieldId) out[fieldId] = value
  }
  return out
}

async function linkMaps(zoho: ZohoClient) {
  const grab = async (base: string) => zoho.fetchAll(T[base].id)
  return buildLinkMaps(await grab('Vendors'), await grab('Purchase Products'), await grab('Storage Locations'), await grab('Items'), {
    vendors: T['Vendors'], purchaseProducts: T['Purchase Products'], storageLocations: T['Storage Locations'], items: T['Items'],
  })
}

export async function commitChanges(zoho: ZohoClient, caller: Caller, changes: StateChanges): Promise<number> {
  // 1. role gate — the RLS of this fork
  for (const change of changes.tables) {
    const spec = COLLECTIONS.find((c) => c.table === change.table)
    if (spec?.adminOnly && caller.role !== 'Admin') throw new Forbidden(change.table)
  }
  // config writes and audit deletions were admin-only under Supabase RLS too: tolerances,
  // numbering and label copy are admin business, and the trail is insert-only for operators
  // (sync.ts only ever emits audit removals from admin-side edits)
  if (changes.config && caller.role !== 'Admin') throw new Forbidden('app_config')
  const auditRemove = changes.tables.some((t) => t.table === 'audits' && t.remove?.length)
  if (auditRemove && caller.role !== 'Admin') throw new Forbidden('audits')

  // 2. link maps for column enrichment (masters are small; four reads)
  const links = await linkMaps(zoho)

  // 3. collection rows — { id, data } upserts; ledger and audits arrive flat. Audits are
  // the one insert-only table: before writing, existing App IDs are fetched (the same
  // fetch the removes path does) and any upsert naming an existing id is SKIPPED — a
  // crafted commit cannot rewrite history, and a retried commit re-posting its own
  // audit rows is a no-op for them (new ids still write normally).
  for (const change of changes.tables) {
    const base = TABLE_FOR[change.table]
    if (!base) throw new Error(`unknown table ${change.table}`)
    const table = T[base]
    // look the spec up by TABLE name (change.table is 'sticker_templates', the key is
    // 'stickerTemplates' — find-by-table is the one that is correct for both)
    const spec = COLLECTIONS.find((c) => c.table === change.table) ?? null

    const existingAuditIds =
      change.table === 'audits' && change.upsert.length
        ? new Set((await zoho.fetchAll(table.id)).map((r) => String(r.data[table.appId] ?? '')))
        : null

    for (const row of change.upsert) {
      const appId = String(row.id)
      if (existingAuditIds?.has(appId)) continue // insert-only: never rewrite an audit row
      let values: Record<string, unknown>
      if (change.table === 'ledger') {
        values = { [table.appId]: appId, ...(table.dataJson ? { [table.dataJson]: JSON.stringify(row) } : {}), ...columnsByFieldId(table, ledgerColumns(row, links)) }
      } else if (change.table === 'audits') {
        values = { [table.appId]: appId, ...(table.dataJson ? { [table.dataJson]: JSON.stringify(row) } : {}), ...columnsByFieldId(table, auditColumns(row)) }
      } else {
        const doc = (row as { data: Record<string, unknown> }).data
        values = {
          [table.appId]: appId,
          ...(table.dataJson ? { [table.dataJson]: JSON.stringify(doc) } : {}),
          ...(spec ? columnsByFieldId(table, columnsFor(spec.key, doc, links)) : {}),
        }
      }
      await zoho.upsertByKey(table.id, table.appId, appId, values)
    }

    if (change.remove.length) {
      const rows = await zoho.fetchAll(table.id)
      const byApp = new Map(rows.map((r) => [String(r.data[table.appId] ?? ''), r.recordID]))
      for (const id of change.remove) {
        const rid = byApp.get(String(id))
        if (rid) await zoho.deleteRecord(table.id, rid)
      }
    }
  }

  // 4. counters — upsert by Series (Next is a plain column). A `period:*` value is a
  // STRING ('YYYY:2026') and Next is a NUMBER field that silently drops strings, so
  // periods travel in the Config table instead, whose Value is text — which is where
  // the snapshot reader has always looked for them.
  const counters = T['Counters']
  const configTable = T['Config']
  for (const [series, value] of Object.entries(changes.counters)) {
    if (series.startsWith('period:')) {
      await zoho.upsertByKey(configTable.id, configTable.fields['Setting'], series, {
        [configTable.fields['Setting']]: series,
        [configTable.fields['Value']]: String(value),
      })
      continue
    }
    await zoho.upsertByKey(counters.id, counters.fields['Series'], series, {
      [counters.fields['Series']]: series,
      [counters.fields['Next']]: String(value),
    })
  }

  // 5. config
  const config = T['Config']
  if (changes.config) {
    await zoho.upsertByKey(config.id, config.fields['Setting'], 'app_config', {
      [config.fields['Setting']]: 'app_config',
      [config.fields['Value']]: JSON.stringify(changes.config),
    })
  }

  // 6. revision, last — a reader sees the old plant whole or the new plant whole
  const rows = await zoho.fetchAll(config.id)
  let current = 0
  for (const r of rows) {
    if (String(r.data[config.fields['Setting']]) === 'app_revision') current = Number(r.data[config.fields['Value']]) || 0
  }
  const next = current + 1
  await zoho.upsertByKey(config.id, config.fields['Setting'], 'app_revision', {
    [config.fields['Setting']]: 'app_revision',
    [config.fields['Value']]: String(next),
  })
  return next
}
