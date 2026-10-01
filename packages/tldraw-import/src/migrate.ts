/**
 * Stored tldraw records → tldraw 5.4.2 records (docs/EXCALIDRAW-MIGRATION.md §5.3 "migrates records to
 * 5.4.2 with @tldraw/tlschema plus the old file-card migration"): the board's persisted schema
 * (`metadata.schema`, or a `dr_deleted_schemas` row) is migrated up to Lobby's one server schema
 * (`draftroomSchema`, which carries the file-card shape's migrations). A record the schema cannot migrate
 * fails the whole set; nothing is guessed.
 */

import type { TLRecord, TLSchema } from '@tldraw/tlschema'
import { draftroomSchema } from './schema.ts'
import type { TlRecord } from './types.ts'

type SerializedSchema = Parameters<TLSchema['migrateStoreSnapshot']>[0]['schema']

export type MigrateResult = { ok: true; records: TlRecord[] } | { ok: false; reason: string }

/** Migrates a set of records stored under `schema` (a serialized tldraw schema) to the current schema. */
export function migrateRecords(records: readonly unknown[], schema: unknown): MigrateResult {
  const store: Record<string, TLRecord> = {}
  for (const r of records) {
    if (!r || typeof r !== 'object' || typeof (r as { id?: unknown }).id !== 'string')
      return { ok: false, reason: 'a record has no id' }
    store[(r as { id: string }).id] = r as TLRecord
  }
  let migrations: ReturnType<TLSchema['getMigrationsSince']>
  try {
    migrations = draftroomSchema.getMigrationsSince(schema as SerializedSchema)
  } catch {
    return { ok: false, reason: 'the stored schema is malformed' }
  }
  if (!migrations.ok) return { ok: false, reason: 'the stored schema is newer than this converter' }
  const res = draftroomSchema.migrateStoreSnapshot({ store, schema: schema as SerializedSchema })
  if (res.type === 'error') return { ok: false, reason: `migration failed (${res.reason})` }
  return { ok: true, records: Object.values(res.value) as unknown as TlRecord[] }
}

/** The schema this converter reads (serialized), and its short hash for `converted_from.schemaHash`. */
export const currentSchema = () => draftroomSchema.serialize()
