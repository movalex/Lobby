// "Recently deleted" on the Excalidraw engine (docs/EXCALIDRAW-MIGRATION.md §2.4.6 "deleted", §2.6, §5.4),
// in the same answer shapes as the tldraw routes (http/internal.ts; @draftroom/contracts history.ts
// ListDeletedResponse / RestoreDeletedResponse), so the api proxies both engines unchanged:
//
//   GET  /internal/boards/:bid/deleted?limit=      → { entries, total, limit }, newest first
//   POST /internal/boards/:bid/deleted/restore {ids} → { restored, skipped, bindings, reparented }
//
// The capture is `lb_deleted`: the room writes one row per element whose `isDeleted` went false→true,
// with the push's clock as its `batch` (a container, its label and a frame's children go in one batch);
// a converted board's tldraw capture was copied in with `origin = 'converted'` (§5.4) and its tldraw batch
// numbers, so a batch is one origin's rows of one number (M3P3). An entry is an
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
// the ends reattached). A connector that stayed on the board gets back the end it lost to what comes back
// (DEF-W3-1: the restored element's captured list names it, and the free end is still where the engine
// left it; `reattachments` below), counted in `bindings` too, and re-snapped by the room in the same clock.
// Every written element passes the element check, and the board the invariants.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { checkElement, type WireElement } from '@draftroom/canvas-schema/elements'
import {
  bindingGap as engineBindingGap,
  indexKeyBetween,
  isBindable,
  isValidIndexKey,
  type LinearLike,
  pointAtIndexGlobal,
} from '@draftroom/canvas-schema/engine'
import { checkInvariants } from '@draftroom/canvas-schema/invariants'
import { GROUP_NAMES } from '@draftroom/canvas-schema/protocol'
import { fromShapeRef } from '@draftroom/canvas-schema/refs'
import { normalizeFixedPoint } from '@draftroom/tldraw-import'
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
  /** `live` (the room wrote it) or `converted` (copied from the tldraw capture, §5.4) */
  origin: string
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
      `SELECT seq, batch, origin, element_id, deleted_by, deleted_by_name, deleted_at, data FROM lb_deleted
        ORDER BY seq DESC`,
    )
    .all() as {
    seq: number
    batch: number
    origin: string
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
      origin: r.origin,
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

/**
 * A batch is one origin's: a converted row keeps its tldraw batch number, which says nothing about the
 * room's clocks (M3P3: the two overlap on converted boards), so a converted batch and a live push of the
 * same number are two batches.
 */
const batchKey = (r: Pick<DeletedRow, 'origin' | 'batch'>): string => `${r.origin}:${r.batch}`

/** The rows of each batch, by batchKey. */
function byBatch(rows: readonly DeletedRow[]): Map<string, Batch> {
  const out = new Map<string, Batch>()
  for (const r of rows) {
    let b = out.get(batchKey(r))
    if (!b) {
      b = { rows: new Map(), labels: new Map(), children: new Map() }
      out.set(batchKey(r), b)
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
    const batch = batches.get(batchKey(r)) as Batch
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

// ---- live connectors that lost an end to what comes back (DEF-W3-1) ---------------------------------

type End = 'startBinding' | 'endBinding'
type Pt = readonly [number, number]

/**
 * Excalidraw's binding gap: a bound end in orbit mode sits this far off its target's outline (canvas-schema
 * `bindingGap`, the engine's own `getBindingGap`; W5-53: one gap for the room, the client and the converter).
 */
const bindingGap = (t: El): number => engineBindingGap({ strokeWidth: Number(t.strokeWidth) || 0 })
/**
 * How far off a restored target's bounds a free end may be to be attached to it again: the gap plus this,
 * about Excalidraw's base binding distance at zoom 1 (15 px, `maxBindingDistance_simple`), so an end the
 * engine left at the gap, or a few pixels off it, qualifies, and an end someone dragged away does not.
 */
const REATTACH_SLACK_PX = 10
/** A second end of the same arrow goes to the same target only when it, too, sits at the gap (a self-loop). */
const SELF_LOOP_SLACK_PX = 2

/** `p` in the target's unrotated frame, its distance outside the target's bounds and its depth inside them. */
function againstBounds(p: Pt, t: El): { local: Pt; outside: number; depth: number } {
  const x = Number(t.x) || 0
  const y = Number(t.y) || 0
  const w = Number(t.width) || 0
  const h = Number(t.height) || 0
  const cx = x + w / 2
  const cy = y + h / 2
  const a = -(Number(t.angle) || 0)
  const dx = p[0] - cx
  const dy = p[1] - cy
  const lx = cx + dx * Math.cos(a) - dy * Math.sin(a)
  const ly = cy + dx * Math.sin(a) + dy * Math.cos(a)
  const ox = Math.max(x - lx, 0, lx - (x + w))
  const oy = Math.max(y - ly, 0, ly - (y + h))
  const depth = Math.min(lx - x, x + w - lx, ly - y, y + h - ly)
  return { local: [lx, ly], outside: Math.hypot(ox, oy), depth }
}

/**
 * The binding of an end that stays where it is: the fixed point is the end's own position relative to the
 * target, as Excalidraw computes it when it binds an end without a focus point
 * (`calculateFixedPointForNonElbowArrowBinding` / its elbow twin: rotated back about the centre, over
 * max(size, gap), normalized). Orbit, unless the end is deep inside the target (then `inside`, which keeps
 * it on its point instead of moving it out to the outline); an elbow arrow always orbits.
 */
function bindingAt(arrow: El, target: El, p: Pt) {
  const w = Number(target.width) || 0
  const h = Number(target.height) || 0
  const gap = bindingGap(target)
  const { local, depth } = againstBounds(p, target)
  const fixedPoint: [number, number] =
    w < 1 || h < 1
      ? [0.5001, 0.5001]
      : normalizeFixedPoint([
          (local[0] - (Number(target.x) || 0)) / Math.max(w, gap),
          (local[1] - (Number(target.y) || 0)) / Math.max(h, gap),
        ])
  const mode: 'inside' | 'orbit' = !arrow.elbowed && depth > gap ? 'inside' : 'orbit'
  return { elementId: target.id, fixedPoint, mode }
}

/** The scene position of an arrow's end, or null when the arrow has no usable points. */
function endPoint(arrow: El, end: End): Pt | null {
  const pts = arrow.points
  if (!Array.isArray(pts) || pts.length < 2) return null
  try {
    const p = pointAtIndexGlobal(arrow as unknown as LinearLike, end === 'startBinding' ? 0 : -1)
    return Number.isFinite(p[0]) && Number.isFinite(p[1]) ? p : null
  } catch {
    return null
  }
}

/**
 * The ends of live arrows to attach again to what comes back. A restored target's captured
 * `boundElements` names the arrows that were bound to it when it went (Excalidraw and the room's repair
 * null the arrow's end and leave the deleted element's list as it was; a converted row folds tldraw's
 * binding into it, tldraw-import deleted.ts). Such an arrow is on the board now with that end free: its end
 * comes back to the target when it is still where the engine left it (within the gap plus
 * REATTACH_SLACK_PX of the target's bounds). An end someone bound elsewhere since, or dragged away, is left
 * alone. Nearest first; an end is attached once; an arrow's second end goes to the same target only when
 * it also sits at the gap (a self-loop).
 */
function reattachments(
  restoring: ReadonlyMap<string, El>,
  live: ReadonlyMap<string, El>,
): { arrowId: string; end: End; target: El; at: Pt }[] {
  const candidates: { arrow: El; end: End; target: El; at: Pt; d: number }[] = []
  for (const target of restoring.values()) {
    if (!isBindable(target as never) || !Array.isArray(target.boundElements)) continue
    for (const ref of target.boundElements as { id?: unknown; type?: unknown }[]) {
      if (ref?.type !== 'arrow' || typeof ref.id !== 'string' || restoring.has(ref.id)) continue
      const arrow = live.get(ref.id)
      if (arrow?.type !== 'arrow') continue
      for (const end of ['startBinding', 'endBinding'] as const) {
        if (arrow[end]) continue // bound to something now
        const at = endPoint(arrow, end)
        if (!at) continue
        const d = againstBounds(at, target).outside
        if (d <= bindingGap(target) + REATTACH_SLACK_PX) candidates.push({ arrow, end, target, at, d })
      }
    }
  }
  candidates.sort((a, b) => a.d - b.d || (a.arrow.id < b.arrow.id ? -1 : a.arrow.id > b.arrow.id ? 1 : 0))
  const taken = new Set<string>()
  const pairs = new Set<string>()
  const out: { arrowId: string; end: End; target: El; at: Pt }[] = []
  for (const c of candidates) {
    const endKey = `${c.arrow.id}\n${c.end}`
    const pairKey = `${c.arrow.id}\n${c.target.id}`
    if (taken.has(endKey)) continue
    if (pairs.has(pairKey) && c.d > bindingGap(c.target) + SELF_LOOP_SLACK_PX) continue
    taken.add(endKey)
    pairs.add(pairKey)
    out.push({ arrowId: c.arrow.id, end: c.end, target: c.target, at: c.at })
  }
  return out
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
    const batch = batches.get(batchKey(row)) as Batch
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
  /** live elements the restore changes: targets listing a restored arrow, arrows attached again */
  const patched = new Map<string, El>()
  const present = (id: unknown): El | null =>
    typeof id === 'string' ? (restoring.get(id) ?? patched.get(id) ?? live.get(id) ?? null) : null
  const targetOf = (id: string): El => {
    const cur = patched.get(id)
    if (cur) return cur
    const t = structuredClone(live.get(id) as El)
    patched.set(id, t)
    return t
  }
  // 2a. live connectors whose end was bound to what comes back get it again (DEF-W3-1); the room's
  // rule-7 pass re-snaps them in the same clock (room/server-write.ts), and the targets list them below
  const rebound = new Set<string>()
  for (const r of reattachments(restoring, live)) {
    const a = targetOf(r.arrowId)
    a[r.end] = bindingAt(a, r.target, r.at)
    rebound.add(r.arrowId)
    result.bindings++
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
  const written = new Map<string, El>([...restoring, ...patched])
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
        : {
            ...(prev?.gclock ?? {}),
            ...(rebound.has(id) ? { bind: tx.clock } : {}),
            ...(JSON.stringify(prev?.el.boundElements ?? null) !== JSON.stringify(el.boundElements ?? null)
              ? { bound: tx.clock }
              : {}),
          },
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
