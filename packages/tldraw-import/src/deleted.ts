/**
 * "Recently deleted" at conversion (docs/EXCALIDRAW-MIGRATION.md §5.4): every batch of `dr_deleted_*` is
 * converted with the same converter in local mode and becomes `lb_deleted` rows with origin
 * `converted` and the original batch, author and time. The source rows are never written. Partial sets are
 * fine: each batch is converted within the live board (so a deleted child of a live frame keeps its
 * place), with the batch's own records on top; a shape whose page is gone goes to the root (offset 0).
 *
 * Mapping (the B8 lossless row "every dr_deleted_records row → an lb_deleted row or a lossy code"): a
 * shape row maps to its elements; a group row to the group id its batch's elements carry; a binding row
 * is folded into its arrow's or its target's element in the same batch, else `arrow-binding-dropped`.
 */
import type { WireElement } from '@draftroom/canvas-schema/elements'
import type { DrDeletedRow } from './board-file.ts'
import { convertRecords, elementIdOf } from './convert.ts'
import { migrateRecords } from './migrate.ts'
import type { ConvertFailure, ConvertOptions, LegacyPages, Lossy, TlRecord } from './types.ts'

/** One `lb_deleted` row to write (seq is assigned by the table). */
export interface LbDeletedRow {
  readonly batch: number
  readonly elementId: string
  readonly type: string
  readonly containerId: string | null
  readonly frameId: string | null
  /** the element's JSON */
  readonly data: string
  readonly deletedBy: string
  readonly deletedByName: string
  readonly deletedAt: number
  readonly epoch: string
  readonly origin: 'converted'
}

export interface DeletedConversion {
  readonly rows: LbDeletedRow[]
  /** dr_deleted seq → the element ids it maps to, or the lossy code that covers it */
  readonly mapping: ReadonlyMap<number, readonly string[] | { readonly lossy: string }>
  readonly lossy: Lossy[]
  readonly failures: ConvertFailure[]
  /** the highest seq converted (0 when none) */
  readonly lastSeq: number
}

/** Page offsets with every unknown page read as offset 0 (a deleted shape whose page is gone). */
function lenientPages(pages: LegacyPages, records: readonly TlRecord[]): LegacyPages {
  const out: Record<string, LegacyPages[string]> = { ...pages }
  for (const r of records) {
    const parent = typeof r.parentId === 'string' ? r.parentId : ''
    if (parent.startsWith('page:') && !out[parent]) out[parent] = { dx: 0, dy: 0, index: 0, name: '' }
  }
  return out
}

export function convertDeleted(
  drRows: readonly DrDeletedRow[],
  live: readonly TlRecord[],
  opts: ConvertOptions & { readonly legacyPages: LegacyPages },
): DeletedConversion {
  const rows: LbDeletedRow[] = []
  const mapping = new Map<number, readonly string[] | { readonly lossy: string }>()
  const lossy: Lossy[] = []
  const failures: ConvertFailure[] = []
  let lastSeq = 0
  const batches = new Map<number, DrDeletedRow[]>()
  for (const r of drRows) {
    lastSeq = Math.max(lastSeq, r.seq)
    batches.set(r.batch, [...(batches.get(r.batch) ?? []), r])
  }
  const liveById = new Map(live.map((r) => [r.id, r]))
  for (const [batch, list] of [...batches.entries()].sort(([a], [b]) => a - b)) {
    // migrate each schema's records up to the current schema
    const bySchema = new Map<string, DrDeletedRow[]>()
    for (const r of list) bySchema.set(r.schema, [...(bySchema.get(r.schema) ?? []), r])
    const migrated = new Map<number, TlRecord>()
    for (const [schemaText, group] of bySchema) {
      let parsed: unknown[]
      let schema: unknown
      try {
        schema = JSON.parse(schemaText)
        parsed = group.map((r) => JSON.parse(r.state) as unknown)
      } catch {
        for (const r of group)
          failures.push({ id: r.recordId, code: 'INVALID', detail: 'unreadable deleted row' })
        continue
      }
      const res = migrateRecords(parsed, schema)
      if (!res.ok) {
        for (const r of group)
          failures.push({ id: r.recordId, code: 'INVALID', detail: 'deleted row migration failed' })
        continue
      }
      const byId = new Map(res.records.map((rec) => [rec.id, rec]))
      for (const r of group) {
        const rec = byId.get(r.recordId)
        if (rec) migrated.set(r.seq, rec)
      }
    }
    const snapshot = new Map(liveById)
    for (const rec of migrated.values()) snapshot.set(rec.id, rec)
    const records = [...snapshot.values()]
    const shapeRows = list.filter((r) => r.kind === 'shape' && migrated.has(r.seq))
    const local = convertRecords(
      records,
      shapeRows.map((r) => r.recordId),
      { ...opts, legacyPages: lenientPages(opts.legacyPages, records) },
    )
    failures.push(...local.failures)
    for (const l of local.lossy) lossy.push(l)
    const elementsOf = (recordId: string): WireElement[] => local.elements.get(recordId) ?? []
    const batchElements = shapeRows.flatMap((r) => elementsOf(r.recordId))
    for (const r of list) {
      if (!migrated.has(r.seq)) continue
      if (r.kind === 'shape') {
        const els = elementsOf(r.recordId)
        if (els.length) {
          mapping.set(
            r.seq,
            els.map((e) => e.id),
          )
          for (const e of els)
            rows.push({
              batch,
              elementId: e.id,
              type: e.type,
              containerId: e.type === 'text' ? e.containerId : null,
              frameId: e.frameId,
              data: JSON.stringify(e),
              deletedBy: r.deletedBy,
              deletedByName: r.deletedByName,
              deletedAt: r.deletedAt,
              epoch: r.epoch,
              origin: 'converted',
            })
        } else {
          const gid = elementIdOf(r.recordId)
          const carried = batchElements.some((e) => e.groupIds.includes(gid))
          mapping.set(r.seq, carried ? [gid] : { lossy: 'empty-group' })
          if (!carried) lossy.push({ code: 'empty-group', id: r.recordId })
        }
      } else {
        const arrowId = r.fromId ? elementIdOf(r.fromId) : null
        const targetId = r.toId ? elementIdOf(r.toId) : null
        const folded = batchElements.find(
          (e) =>
            (e.id === arrowId &&
              e.type === 'arrow' &&
              (e.startBinding?.elementId === targetId || e.endBinding?.elementId === targetId)) ||
            (e.id === targetId && (e.boundElements ?? []).some((b) => b.id === arrowId)),
        )
        mapping.set(r.seq, folded ? [folded.id] : { lossy: 'arrow-binding-dropped' })
        if (!folded) lossy.push({ code: 'arrow-binding-dropped', id: r.recordId })
      }
    }
  }
  return { rows, mapping, lossy, failures, lastSeq }
}
