// Puts captured shapes back (POST /internal/boards/:bid/deleted/restore).
//
// Server-side storage writes are NOT validated by the library (docs/research/SYNTHESIS.md §5), and a
// bad record makes the room unopenable, so every record is migrated from the schema it was captured
// in and validated with the board schema right before it is written. One storage transaction: the
// shapes, their bindings and the removal of their "Recently deleted" rows commit together; connected
// clients get the change through the room's storage listener like any other server write.

import type { SQLiteSyncStorage, TLSyncStorageTransaction } from '@tldraw/sync-core'
import type { TLBinding, TLRecord, TLSchema, TLShape } from '@tldraw/tlschema'
import type { DeletedRow, DeletedStore } from './store.ts'

export type RestoreSkipReason = 'not-found' | 'exists' | 'invalid'

export interface RestoreSummary {
  restored: string[]
  skipped: Array<{ id: string; reason: RestoreSkipReason }>
  bindings: number
  reparented: number
}

type SerializedSchema = Parameters<TLSchema['migratePersistedRecord']>[1]

interface Placement {
  pageId: string | null
  x: number
  y: number
  rotation: number
}

/**
 * The shape's position in page space, walking up its ancestors (`lookup` answers for each id).
 * pageId is null when an ancestor is unknown; x/y/rotation are then relative to the last one known.
 */
export function pagePlacement(shape: TLShape, lookup: (id: string) => TLRecord | undefined): Placement {
  let { x, y, rotation } = shape
  let parentId: string = shape.parentId
  for (let guard = 0; guard < 200; guard++) {
    if (parentId.startsWith('page:')) return { pageId: parentId, x, y, rotation }
    const parent = lookup(parentId)
    if (parent?.typeName !== 'shape') return { pageId: null, x, y, rotation }
    // point in the parent's space -> the grandparent's space: rotate by the parent's rotation, then
    // translate by its position (tldraw's parent transform)
    const cos = Math.cos(parent.rotation)
    const sin = Math.sin(parent.rotation)
    const px = parent.x + x * cos - y * sin
    const py = parent.y + x * sin + y * cos
    x = px
    y = py
    rotation += parent.rotation
    parentId = parent.parentId
  }
  return { pageId: null, x, y, rotation }
}

/**
 * A fractional index key right above `index` that no sibling uses. Appending a base62 digit keeps the
 * key valid (tldraw keys must not end in '0') and sorts it directly after `index`.
 */
export function freeIndexAbove(index: string, taken: ReadonlySet<string>): string {
  let candidate = `${index}V`
  while (taken.has(candidate)) candidate += 'V'
  return candidate
}

function sortParentsFirst(records: Map<string, TLShape>): TLShape[] {
  const depth = (rec: TLShape): number => {
    let d = 0
    let parent = records.get(rec.parentId)
    while (parent && d < 200) {
      d++
      parent = records.get(parent.parentId)
    }
    return d
  }
  return [...records.values()]
    .map((r) => ({ r, d: depth(r) }))
    .sort((a, b) => a.d - b.d)
    .map(({ r }) => r)
}

export function restoreDeleted(opts: {
  storage: SQLiteSyncStorage<TLRecord>
  store: DeletedStore
  schema: TLSchema
  ids: readonly string[]
}): RestoreSummary {
  const { storage, store, schema } = opts
  const skipped: RestoreSummary['skipped'] = []
  const requested = [...new Set(opts.ids)]

  // 1. What each requested id brings back (its content deleted with it included).
  const rows = new Map<string, DeletedRow>()
  const rootsFound: string[] = []
  for (const id of requested) {
    const found = store.shapesToRestore(id)
    if (found.length === 0) {
      skipped.push({ id, reason: 'not-found' })
      continue
    }
    rootsFound.push(id)
    for (const r of found) if (!rows.has(r.recordId)) rows.set(r.recordId, r)
  }
  if (rows.size === 0) return { restored: [], skipped, bindings: 0, reparented: 0 }

  // 2. Migrate to the current schema (outside the transaction: pure work).
  const schemas = new Map<number, SerializedSchema | null>()
  const migrated = (row: DeletedRow): TLRecord | null => {
    if (!schemas.has(row.schemaId)) {
      const json = store.schemaJson(row.schemaId)
      let parsed: SerializedSchema | null = null
      try {
        parsed = json ? (JSON.parse(json) as SerializedSchema) : null
      } catch {}
      schemas.set(row.schemaId, parsed)
    }
    const persisted = schemas.get(row.schemaId)
    if (!persisted) return null
    let raw: unknown
    try {
      raw = JSON.parse(row.state)
    } catch {
      return null
    }
    try {
      const res = schema.migratePersistedRecord(raw as TLRecord, persisted, 'up')
      return res.type === 'success' ? (res.value as TLRecord) : null
    } catch {
      return null
    }
  }
  const shapes = new Map<string, TLShape>()
  for (const [id, row] of rows) {
    const rec = migrated(row)
    if (rec?.typeName === 'shape' && rec.id === id) shapes.set(id, rec)
    else if (requested.includes(id)) skipped.push({ id, reason: 'invalid' })
  }
  const capturedCache = new Map<string, TLRecord | undefined>()
  const captured = (id: string): TLRecord | undefined => {
    if (!capturedCache.has(id)) {
      const row = store.latestShapeRow(id)
      capturedCache.set(id, row ? (migrated(row) ?? undefined) : undefined)
    }
    return capturedCache.get(id)
  }
  const bindingCandidates: TLBinding[] = []
  for (const row of store.bindingsTouching([...shapes.keys()])) {
    const rec = migrated(row)
    if (rec?.typeName === 'binding') bindingCandidates.push(rec)
  }

  // 3. One transaction: place, validate, write, forget.
  const { result } = storage.transaction((txn: TLSyncStorageTransaction<TLRecord>) => {
    const live = (id: string) => txn.get(id) as TLRecord | undefined
    for (const id of [...shapes.keys()]) {
      if (!live(id)) continue
      shapes.delete(id) // back already (undo, a peer): never overwrite what is on the board
      if (requested.includes(id)) skipped.push({ id, reason: 'exists' })
    }

    // One pass over the board: pages, sibling index keys, connector terminals already bound.
    const pages: TLRecord[] = []
    const indices = new Map<string, Set<string>>()
    const boundTerminals = new Set<string>()
    for (const rec of txn.values()) {
      if (rec.typeName === 'page') pages.push(rec)
      else if (rec.typeName === 'shape') {
        const set = indices.get(rec.parentId) ?? new Set<string>()
        set.add(rec.index)
        indices.set(rec.parentId, set)
      } else if (rec.typeName === 'binding' && rec.type === 'arrow')
        boundTerminals.add(`${rec.fromId}/${rec.props.terminal}`)
    }
    pages.sort((a, b) => (a.typeName === 'page' && b.typeName === 'page' ? (a.index < b.index ? -1 : 1) : 0))
    const firstPageId = pages[0]?.id ?? null

    let reparented = 0
    const written = new Map<string, TLShape>()
    const lookup = (id: string) => written.get(id) ?? shapes.get(id) ?? live(id) ?? captured(id)
    for (const original of sortParentsFirst(shapes)) {
      let rec: TLShape = structuredClone(original)
      const parent = rec.parentId
      const parentOk = parent.startsWith('page:')
        ? pages.some((p) => p.id === parent)
        : written.has(parent) || live(parent)?.typeName === 'shape'
      if (!parentOk) {
        const place = pagePlacement(rec, lookup)
        const pageId = place.pageId && pages.some((p) => p.id === place.pageId) ? place.pageId : firstPageId
        if (!pageId) continue // a board without pages cannot take shapes
        rec = {
          ...rec,
          parentId: pageId as TLShape['parentId'],
          x: place.x,
          y: place.y,
          rotation: place.rotation,
        }
        reparented++
      }
      const taken = indices.get(rec.parentId) ?? new Set<string>()
      if (taken.has(rec.index)) rec = { ...rec, index: freeIndexAbove(rec.index, taken) as TLShape['index'] }
      try {
        rec = schema.types.shape.validate(rec) as TLShape
      } catch {
        if (requested.includes(rec.id)) skipped.push({ id: rec.id, reason: 'invalid' })
        continue // its children see a missing parent and go to the page
      }
      taken.add(rec.index)
      indices.set(rec.parentId, taken)
      txn.set(rec.id, rec)
      written.set(rec.id, rec)
    }

    const restoredBindings: string[] = []
    for (const b of bindingCandidates) {
      if (live(b.id)) continue
      const from = written.get(b.fromId) ?? live(b.fromId)
      const to = written.get(b.toId) ?? live(b.toId)
      // reconnect only when both ends exist again (and at least one came back now)
      if (!from || !to || from.typeName !== 'shape' || to.typeName !== 'shape') continue
      if (!written.has(b.fromId) && !written.has(b.toId)) continue
      if (b.type === 'arrow') {
        if (from.type !== 'arrow' || to.type === 'arrow') continue
        const terminal = `${b.fromId}/${b.props.terminal}`
        if (boundTerminals.has(terminal)) continue // that end was connected to something else meanwhile
        boundTerminals.add(terminal)
      }
      let rec: TLBinding
      try {
        rec = schema.types.binding.validate(structuredClone(b)) as TLBinding
      } catch {
        continue
      }
      txn.set(rec.id, rec)
      restoredBindings.push(rec.id)
    }

    const restored = [...written.keys()]
    store.removeRestored(restored, restoredBindings)
    return { restored, bindings: restoredBindings.length, reparented }
  })
  return { restored: result.restored, skipped, bindings: result.bindings, reparented: result.reparented }
}
