import { DEFAULT_INITIAL_SNAPSHOT, type RoomSnapshot } from '@tldraw/sync-core'
import type { TLRecord, TLSchema } from '@tldraw/tlschema'

/** Upper bound on records in one seed (a board is far smaller; this bounds work per request). */
export const MAX_SEED_RECORDS = 100_000

export type SeedPreparation = { ok: true; snapshot: RoomSnapshot } | { ok: false; message: string }

type RecordTypeLike = { scope: string; validate(record: unknown): unknown }

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const fail = (message: string): SeedPreparation => ({ ok: false, message })

/**
 * Turns an untrusted seed body into the RoomSnapshot a NEW board is initialized with.
 *
 * Accepts either a RoomSnapshot (`{ documents: [{ state }], schema }`, what GET …/snapshot returns)
 * or a store snapshot (`{ store: { [id]: record }, schema }`). Records are migrated from their own
 * schema to `schema` and then validated one by one, because storage writes are never validated by
 * the library and an invalid record would make the room unopenable. Only document-scoped records
 * are accepted (presence and session state never belong in board storage). The result starts a new
 * history: clock 0, no tombstones, the current serialized schema. A missing document record or page
 * is filled in with tldraw's defaults so the board always opens.
 */
export function prepareSeedSnapshot(input: unknown, schema: TLSchema): SeedPreparation {
  if (!isObject(input)) return fail('snapshot must be an object')
  const serialized = input.schema
  if (!isObject(serialized) || typeof serialized.schemaVersion !== 'number')
    return fail('snapshot.schema must be a serialized tldraw schema')

  const incoming: unknown[] = []
  if (Array.isArray(input.documents)) {
    for (const doc of input.documents) {
      if (!isObject(doc) || !isObject(doc.state)) return fail('snapshot.documents[] must be { state }')
      incoming.push(doc.state)
    }
  } else if (isObject(input.store)) {
    for (const [key, record] of Object.entries(input.store)) {
      if (!isObject(record) || record.id !== key) return fail('snapshot.store keys must equal record ids')
      incoming.push(record)
    }
  } else {
    return fail('snapshot must have documents[] or a store')
  }
  if (incoming.length > MAX_SEED_RECORDS) return fail(`snapshot has more than ${MAX_SEED_RECORDS} records`)

  const store: Record<string, TLRecord> = {}
  for (const record of incoming) {
    if (!isObject(record) || typeof record.id !== 'string' || typeof record.typeName !== 'string')
      return fail('every record needs a string id and typeName')
    if (Object.hasOwn(store, record.id)) return fail(`duplicate record id ${record.id}`)
    store[record.id] = record as unknown as TLRecord
  }

  const persisted = serialized as unknown as Parameters<TLSchema['getMigrationsSince']>[0]
  let migrations: ReturnType<TLSchema['getMigrationsSince']>
  try {
    migrations = schema.getMigrationsSince(persisted)
  } catch {
    return fail('snapshot.schema is malformed')
  }
  // A snapshot from a NEWER schema cannot be migrated down safely here: refuse instead of guessing.
  if (!migrations.ok) return fail('snapshot.schema is incompatible with this server (newer or unknown)')
  const migrated = schema.migrateStoreSnapshot({ store, schema: persisted })
  if (migrated.type === 'error') return fail(`snapshot migration failed (${migrated.reason})`)

  const types = schema.types as unknown as Record<string, RecordTypeLike>
  const records: TLRecord[] = []
  for (const record of Object.values(migrated.value)) {
    const type = Object.hasOwn(types, record.typeName) ? types[record.typeName] : undefined
    if (!type) return fail(`unknown record type ${record.typeName} (${record.id})`)
    if (type.scope !== 'document') return fail(`${record.typeName} records are not board data (${record.id})`)
    try {
      records.push(type.validate(record) as TLRecord)
    } catch (e) {
      return fail(`invalid ${record.typeName} record ${record.id}: ${String((e as Error)?.message ?? e)}`)
    }
  }
  for (const d of DEFAULT_INITIAL_SNAPSHOT.documents) {
    const def = d.state as TLRecord
    const present =
      def.typeName === 'page'
        ? records.some((r) => r.typeName === 'page')
        : Object.hasOwn(migrated.value, def.id)
    if (!present) records.push(def)
  }

  return {
    ok: true,
    snapshot: {
      documentClock: 0,
      tombstoneHistoryStartsAtClock: 0,
      tombstones: {},
      schema: schema.serialize(),
      documents: records.map((state) => ({ state, lastChangedClock: 0 })),
    },
  }
}

/** What a board that has never been opened looks like (served without creating its storage). */
export function emptyBoardSnapshot(schema: TLSchema): RoomSnapshot {
  return {
    documentClock: 0,
    tombstoneHistoryStartsAtClock: 0,
    tombstones: {},
    schema: schema.serialize(),
    documents: DEFAULT_INITIAL_SNAPSHOT.documents.map((d) => ({ state: d.state, lastChangedClock: 0 })),
  }
}
