// "Recently deleted" on the Excalidraw engine (docs/EXCALIDRAW-MIGRATION.md §2.4.6 "deleted", §2.6, §5.4),
// in the same answer shapes as the tldraw routes (http/internal.ts; @draftroom/contracts history.ts
// ListDeletedResponse / RestoreDeletedResponse), so the api proxies both engines unchanged:
//
//   GET  /internal/boards/:bid/deleted?limit=      → { entries, total, limit }, newest first
//   POST /internal/boards/:bid/deleted/restore {ids} → { restored, skipped, bindings, reparented }
//
// The capture is `lb_deleted`: the room writes one row per element whose `isDeleted` went false→true,
// with the push's clock as its `batch` (a container, its label and a frame's children go in one batch);
// a converted board's tldraw capture was copied in with `origin = 'converted'` (§5.4). An entry is an
// object of a batch that is not inside another object of the same batch (a label is its container's, a
// frame's children count as its `childCount`), whose element is not on the board now (restored, undone
// or re-created), from its newest row.
//
// A restore puts an entry back with what was deleted inside it (its label; a frame's children and their
// labels), as captured, through one server write (room-internal/board.ts): `isDeleted` false, `version` =
// max(stored, captured) + 1, a fresh `versionNonce`, and every group clock at the write's clock. It keeps
// what still holds: its index when no live element uses it (else a fresh key, labels right after their
// containers), its frame when the frame is on the board (else none: `reparented`), each arrow end bound
// to an element on the board (else unbound), and each target lists its arrows again (`bindings` counts
// the ends reattached). Every written element passes the element check, and the board the invariants.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { checkElement, type WireElement } from '@draftroom/canvas-schema/elements'
import { indexKeyBetween, isBindable, isValidIndexKey } from '@draftroom/canvas-schema/engine'
import { checkInvariants } from '@draftroom/canvas-schema/invariants'
import { GROUP_NAMES } from '@draftroom/canvas-schema/protocol'
import { fromShapeRef } from '@draftroom/canvas-schema/refs'
import type {
  InternalRoute,
  RoomExtensionContext,
  ServerWriteChange,
  ServerWriteTx,
} from '../engine-switch.ts'
import { cleanText } from '../http/board-text.ts'
import { readJson } from '../http/body.ts'
import { RESTORE_MAX_IDS } from '../http/internal.ts'
import { HttpError, sendJson } from '../http/respond.ts'
import type { Gclock } from '../room/schema.ts'
import { boardParam, readableBoard, readBoardFile, writeBoard } from './board.ts'
import { type El, isLabel, isObject, objectText, objectTypeOf, parseElement, refOf } from './elements.ts'

const MAX_LIST_LIMIT = 2_000
const LABEL_MAX_CHARS = 80
const RESTORE_LIMIT_BYTES = 256 * 1024
const SHAPE_ID_RE = /^shape:[\x21-\x7e]{1,200}$/

interface DeletedRow {
  seq: number
  batch: number
  elementId: string
  deletedBy: string
  deletedByName: string
  deletedAt: number
  el: El
}

/** The newest captured row of every element, newest first. */
function newestRows(db: DatabaseSync): DeletedRow[] {
  const rows = db
    .prepare(
      `SELECT seq, batch, element_id, deleted_by, deleted_by_name, deleted_at, data FROM lb_deleted
        ORDER BY seq DESC`,
    )
    .all() as {
    seq: number
    batch: number
    element_id: string
    deleted_by: string
    deleted_by_name: string
    deleted_at: number
    data: string
  }[]
  const seen = new Set<string>()
  const out: DeletedRow[] = []
  for (const r of rows) {
    if (seen.has(r.element_id)) continue
    seen.add(r.element_id)
    const el = parseElement(r.data)
    if (!el || el.id !== r.element_id) continue
    out.push({
      seq: Number(r.seq),
      batch: Number(r.batch),
      elementId: r.element_id,
      deletedBy: r.deleted_by,
      deletedByName: r.deleted_by_name,
      deletedAt: Number(r.deleted_at),
      el,
    })
  }
  return out
}

const liveIds = (db: DatabaseSync): Set<string> =>
  new Set(
    (db.prepare('SELECT id FROM lb_elements WHERE deleted = 0').all() as { id: string }[]).map((r) => r.id),
  )

/** One batch's rows: by element id, each container's label, each frame's children. */
interface Batch {
  readonly rows: Map<string, DeletedRow>
  readonly labels: Map<string, DeletedRow>
  readonly children: Map<string, DeletedRow[]>
}

/** Whether `row` is inside another object of its own batch (a label of its container, a frame's child). */
function insideBatch(row: DeletedRow, batch: Batch): boolean {
  const el = row.el
  if (isLabel(el) && batch.rows.has(el.containerId)) return true
  const frame = typeof el.frameId === 'string' ? batch.rows.get(el.frameId) : undefined
  return frame?.el.type === 'frame'
}

/** The rows of each batch. */
function byBatch(rows: readonly DeletedRow[]): Map<number, Batch> {
  const out = new Map<number, Batch>()
  for (const r of rows) {
    let b = out.get(r.batch)
    if (!b) {
      b = { rows: new Map(), labels: new Map(), children: new Map() }
      out.set(r.batch, b)
    }
    b.rows.set(r.elementId, r)
    if (isLabel(r.el) && !b.labels.has(r.el.containerId)) b.labels.set(r.el.containerId, r)
    if (typeof r.el.frameId === 'string' && !isLabel(r.el)) {
      const list = b.children.get(r.el.frameId) ?? []
      list.push(r)
      b.children.set(r.el.frameId, list)
    }
  }
  return out
}

export interface DeletedEntry {
  shapeId: string
  type: string
  label: string
  deletedAt: string
  deletedBy: { id: string; name: string }
  childCount: number
}

export function listDeleted(db: DatabaseSync, limit: number): { entries: DeletedEntry[]; total: number } {
  const rows = newestRows(db)
  const live = liveIds(db)
  const batches = byBatch(rows)
  const entries: DeletedEntry[] = []
  for (const r of rows) {
    if (live.has(r.elementId)) continue
    const batch = batches.get(r.batch) as Batch
    if (insideBatch(r, batch)) continue
    const type = objectTypeOf(r.el)
    const shapeId = refOf(r.elementId)
    if (!type || !shapeId || !SHAPE_ID_RE.test(shapeId)) continue
    const label = batch.labels.get(r.elementId)
    const labels = new Map(label ? [[r.elementId, label.el]] : [])
    const childCount =
      r.el.type === 'frame'
        ? (batch.children.get(r.elementId) ?? []).filter((b) => !live.has(b.elementId)).length
        : 0
    entries.push({
      shapeId,
      type,
      label: cleanText(objectText(r.el, labels), LABEL_MAX_CHARS),
      deletedAt: new Date(r.deletedAt).toISOString(),
      deletedBy: { id: r.deletedBy, name: r.deletedByName },
      childCount,
    })
  }
  return { entries: entries.slice(0, limit), total: entries.length }
}

// ---- restore -----------------------------------------------------------------------------------------

export interface RestoreResult {
  restored: string[]
  skipped: { id: string; reason: 'not-found' | 'exists' | 'invalid' }[]
  bindings: number
  reparented: number
}

const nonce = () => Math.floor(Math.random() * 2 ** 31)
const allGroupsAt = (prev: Gclock | null, clock: number): Gclock => {
  const g: Record<string, number> = { ...(prev ?? {}) }
  for (const name of GROUP_NAMES) g[name] = clock
  return g
}

/** Sorted keys with "the next key above" (the live indices, then the restored ones as they are given). */
class Keys {
  private readonly list: string[]
  constructor(keys: Iterable<string>) {
    this.list = [...new Set(keys)].sort()
  }
  has(k: string): boolean {
    return this.at(k) < this.list.length && this.list[this.at(k)] === k
  }
  private at(k: string): number {
    let lo = 0
    let hi = this.list.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((this.list[mid] as string) < k) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  add(k: string): void {
    const i = this.at(k)
    if (this.list[i] !== k) this.list.splice(i, 0, k)
  }
  /** A fresh key right above `lo` (at the top when null), below the next key above it. */
  above(lo: string | null): string {
    if (lo === null) return indexKeyBetween(this.list.at(-1) ?? null, null)
    let i = this.at(lo)
    while (i < this.list.length && (this.list[i] as string) <= lo) i++
    return indexKeyBetween(lo, this.list[i] ?? null)
  }
}

/** The restore as a server write (runs inside the write's transaction). */
export function applyRestore(tx: ServerWriteTx, refs: readonly string[]) {
  const db = tx.store.db
  const rows = newestRows(db)
  const newest = new Map(rows.map((r) => [r.elementId, r]))
  const batches = byBatch(rows)
  const result: RestoreResult = { restored: [], skipped: [], bindings: 0, reparented: 0 }
  const live = new Map<string, El>()
  for (const r of db.prepare('SELECT data FROM lb_elements WHERE deleted = 0').all() as { data: string }[]) {
    const el = parseElement(r.data)
    if (el) live.set(el.id, el)
  }

  // 1. what comes back: each requested entry with what was deleted inside it (its batch's content)
  const restoring = new Map<string, El>()
  for (const ref of refs) {
    const id = fromShapeRef(ref)
    if (!id) {
      result.skipped.push({ id: ref, reason: 'invalid' })
      continue
    }
    if (live.has(id)) {
      result.skipped.push({ id: ref, reason: 'exists' })
      continue
    }
    if (restoring.has(id)) continue // already coming back with an entry it was deleted inside
    const row = newest.get(id)
    if (!row) {
      result.skipped.push({ id: ref, reason: 'not-found' })
      continue
    }
    const batch = batches.get(row.batch) as Batch
    const group: DeletedRow[] = [row]
    const label = batch.labels.get(id)
    if (label) group.push(label)
    if (row.el.type === 'frame')
      for (const child of batch.children.get(id) ?? []) {
        group.push(child)
        const childLabel = batch.labels.get(child.elementId)
        if (childLabel) group.push(childLabel)
      }
    for (const m of group)
      if (!live.has(m.elementId) && !restoring.has(m.elementId))
        restoring.set(m.elementId, { ...structuredClone(m.el), isDeleted: false })
  }

  // 2. what still holds: frames, arrow ends, the targets' lists, labels
  const present = (id: unknown): El | null =>
    typeof id === 'string' ? (restoring.get(id) ?? live.get(id) ?? null) : null
  const patchedTargets = new Map<string, El>()
  const targetOf = (id: string): El => {
    const cur = patchedTargets.get(id)
    if (cur) return cur
    const t = structuredClone(live.get(id) as El)
    patchedTargets.set(id, t)
    return t
  }
  for (const el of restoring.values()) {
    if (typeof el.frameId === 'string' && present(el.frameId)?.type !== 'frame') {
      el.frameId = null
      if (!isLabel(el)) result.reparented++
    }
    if (isLabel(el) && !present(el.containerId)) el.containerId = null
    if (el.type === 'arrow')
      for (const end of ['startBinding', 'endBinding'] as const) {
        const b = el[end] as { elementId?: unknown } | null
        if (!b) continue
        const target = present(b.elementId)
        if (!target || !isBindable(target as never)) {
          el[end] = null
          continue
        }
        result.bindings++
        if (!restoring.has(target.id)) {
          const t = targetOf(target.id)
          const list = Array.isArray(t.boundElements) ? t.boundElements : []
          if (!list.some((x: { id: string }) => x.id === el.id))
            t.boundElements = [...list, { id: el.id, type: 'arrow' }]
        }
      }
    if (Array.isArray(el.boundElements)) {
      const kept = el.boundElements.filter((x: { id: string; type: string }) => {
        const other = present(x.id)
        if (!other) return false
        if (x.type === 'text') return isLabel(other) && other.containerId === el.id
        return other.startBinding?.elementId === el.id || other.endBinding?.elementId === el.id
      })
      el.boundElements = kept.length ? kept : null
    }
  }

  // 3. indices: kept when free (labels above their containers), else fresh keys
  const keys = new Keys([...live.values()].map((e) => e.index).filter(isValidIndexKey))
  const order = [...restoring.values()].sort((a, b) =>
    (a.index ?? '') < (b.index ?? '') ? -1 : (a.index ?? '') > (b.index ?? '') ? 1 : a.id < b.id ? -1 : 1,
  )
  const containersFirst = [...order.filter((e) => !isLabel(e)), ...order.filter(isLabel)]
  for (const el of containersFirst) {
    const container = isLabel(el) ? present(el.containerId) : null
    const floor = container?.index ?? null
    const free = isValidIndexKey(el.index) && !keys.has(el.index) && (floor === null || el.index > floor)
    if (!free) el.index = keys.above(floor)
    keys.add(el.index)
  }

  // 4. check, then write
  const written = new Map<string, El>([...restoring, ...patchedTargets])
  for (const [id, el] of written) {
    const prev = tx.store.get(id)
    el.version = Math.max(prev?.version ?? 0, Number(el.version) || 0) + 1
    el.versionNonce = nonce()
    el.updated = tx.now
    const check = checkElement(el)
    if (!check.ok)
      throw new HttpError(409, 'restore-invalid', `A restored element is not valid (${check.code}).`)
    written.set(id, check.element as El)
  }
  const after = [...live.values()].filter((e) => !written.has(e.id)).concat([...written.values()])
  const violations = checkInvariants(after as WireElement[]).filter(
    (v) => written.has(v.id) || (v.other !== undefined && written.has(v.other)),
  )
  if (violations.length)
    throw new HttpError(
      409,
      'restore-inconsistent',
      `The restored elements are not consistent (${violations
        .slice(0, 3)
        .map((v) => v.code)
        .join(', ')}).`,
    )
  const changed: ServerWriteChange[] = []
  for (const [id, el] of written) {
    const prev = tx.store.get(id)
    tx.store.upsert({
      el: el as WireElement,
      clock: tx.clock,
      gclock: restoring.has(id)
        ? allGroupsAt(prev?.gclock ?? null, tx.clock)
        : { ...(prev?.gclock ?? {}), bound: tx.clock },
      deletedClock: null,
      deletedAt: null,
    })
    changed.push({ before: prev?.el ?? null, after: el as WireElement })
  }
  for (const [id, el] of restoring) {
    const ref = refOf(id)
    if (ref && !isLabel(el)) result.restored.push(ref)
  }
  return { changed, doc: {}, result }
}

function parseRestore(body: unknown): string[] {
  const ids = isObject(body) ? body.ids : undefined
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > RESTORE_MAX_IDS)
    throw new HttpError(400, 'bad-request', `ids must be an array of 1 to ${RESTORE_MAX_IDS} shape ids.`)
  for (const id of ids)
    if (typeof id !== 'string' || !SHAPE_ID_RE.test(id))
      throw new HttpError(400, 'bad-request', 'ids must be shape ids.')
  return [...new Set(ids as string[])]
}

async function handleList(ctx: RoomExtensionContext, req: IncomingMessage, res: ServerResponse, raw: string) {
  const boardId = boardParam(raw)
  const q = new URL(req.url ?? '/', 'http://localhost').searchParams.get('limit')
  let limit = MAX_LIST_LIMIT
  if (q !== null) {
    if (!/^\d{1,5}$/.test(q) || Number(q) < 1)
      throw new HttpError(400, 'bad-request', 'limit must be a positive integer.')
    limit = Math.min(Number(q), MAX_LIST_LIMIT)
  }
  const board = await readableBoard(ctx, boardId)
  const { entries, total } =
    board.state === 'missing'
      ? { entries: [], total: 0 }
      : readBoardFile(board.path, (db) => listDeleted(db, limit))
  sendJson(res, 200, { entries, total, limit })
}

export function deletedRoutes(ctx: RoomExtensionContext): InternalRoute[] {
  return [
    {
      method: 'GET',
      path: /^\/internal\/boards\/([^/]+)\/deleted$/,
      handle: (req, res, [raw = '']) => handleList(ctx, req, res, raw),
    },
    {
      method: 'POST',
      path: /^\/internal\/boards\/([^/]+)\/deleted\/restore$/,
      handle: async (req, res, [raw = '']) => {
        const boardId = boardParam(raw)
        const refs = parseRestore(await readJson(req, RESTORE_LIMIT_BYTES))
        sendJson(res, 200, await writeBoard(ctx, boardId, (tx) => applyRestore(tx, refs)))
      },
    },
  ]
}
