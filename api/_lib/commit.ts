/**
 * StateChanges → idempotent Zoho writes.
 *
 * Every write is an upsert keyed by the row's own business key (App ID, Series,
 * Setting), which is what makes a commit safe to retry after a partial failure: the
 * second attempt re-writes the same rows rather than duplicating ledger lines — the one
 * exception is the audit trail, which is insert-only: an upsert naming an App ID that
 * already exists is skipped, so no commit (and no retry) can rewrite history. The
 * revision row is bumped last so a reader either sees the old plant whole or the new
 * plant whole. Tables gated behind a permission the caller lacks are refused here —
 * this is the RLS of the fork, and the client maps the 403 to the same 'forbidden'
 * message it always had.
 */
import type { ZohoClient } from './zoho.ts'
import type { TableRef } from './baseSchema.ts'
import { T, TABLE_FOR } from './baseSchema.ts'
import { columnsFor, ledgerColumns, auditColumns, buildLinkMaps } from './mappers.ts'
import { COLLECTIONS } from '../../src/lib/tables.ts'
import type { StateChanges } from '../../src/lib/sync.ts'
import { TABLE_WRITE_PERMISSION, CONFIG_KEY_WRITE_PERMISSION } from '../../src/lib/permissions.ts'
import { pageScope } from '../../src/lib/pages.ts'
import type { ViewId } from '../../src/types.ts'
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
export function columnsByFieldId(
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
  // 1. permission gate — the RLS of this fork
  const held = new Set(caller.permissions)
  const holdsAny = (perm: string | readonly string[]) =>
    typeof perm === 'string' ? held.has(perm) : perm.some((p) => held.has(p))
  for (const change of changes.tables) {
    const spec = COLLECTIONS.find((c) => c.table === change.table)
    if (spec?.writePermission && !holdsAny(spec.writePermission)) throw new Forbidden(change.table)
  }
  // Page narrowing: a caller holding any page.* slug is scoped to those pages,
  // and the day's work stops being open — they may write only the tables whose
  // page they hold. The default caller (no page permissions, the operator) is
  // untouched; a full administrator is simply a caller holding every page. The
  // BFF is what makes this real: the UI's nav hiding a page would matter little
  // to a crafted POST without this loop.
  const pages = pageScope(caller.permissions)
  if (pages) {
    const holdsPage = (page: ViewId | readonly ViewId[]) =>
      typeof page === 'string' ? pages.has(page) : page.some((p) => pages.has(p))
    for (const change of changes.tables) {
      const spec = COLLECTIONS.find((c) => c.table === change.table)
      if (spec?.page && !holdsPage(spec.page)) throw new Forbidden(change.table)
    }
  }
  // config writes and audit deletions carry their own gates: the trail is
  // insert-only for callers without the Audit page (sync.ts only ever emits
  // audit removals from admin-side edits), and config is one stored row, so its
  // gate diffs the incoming object against what is stored and judges only the
  // keys that actually changed — sync sends the whole config, and a lab tester
  // may carry the numbering series unchanged in their payload without it
  // reading as an attempt to change it. A key listed in
  // CONFIG_KEY_WRITE_PERMISSION passes on any one of its permissions (the
  // report types are the lab's own); every other key needs the Settings page.
  // No stored row means every key is new, and first-time config is the Settings
  // page's business.
  if (changes.config) {
    const configTable = T['Config']
    const rows = await zoho.fetchAll(configTable.id)
    const storedRow = rows.find((r) => String(r.data[configTable.fields['Setting']]) === 'app_config')
    let stored: Record<string, unknown> = {}
    try {
      stored = storedRow ? (JSON.parse(String(storedRow.data[configTable.fields['Value']])) as Record<string, unknown>) : {}
    } catch {
      stored = {}
    }
    // The union of keys, not just the payload's: a key the payload drops is a
    // change too (a partial payload must not read as "leave the rest alone" —
    // the write replaces the whole row, so it would wipe what it omits).
    for (const key of new Set([...Object.keys(changes.config), ...Object.keys(stored)])) {
      if (JSON.stringify(stored[key]) === JSON.stringify(changes.config[key])) continue
      const gate =
        (CONFIG_KEY_WRITE_PERMISSION as Record<string, readonly string[] | undefined>)[key] ??
        [TABLE_WRITE_PERMISSION.app_config]
      if (!gate.some((p) => held.has(p))) throw new Forbidden(`app_config ${key}`)
    }
  }
  const auditRemove = changes.tables.some((t) => t.table === 'audits' && t.remove?.length)
  if (auditRemove && !held.has(TABLE_WRITE_PERMISSION.audits)) throw new Forbidden('audits')

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
