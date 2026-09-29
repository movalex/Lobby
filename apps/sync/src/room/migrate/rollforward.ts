// The record-level roll-forward merge (docs/EXCALIDRAW-MIGRATION.md §5.9 step 3, a-i), run inside the
// capped conversion worker. O4.
//
// Inputs, all in the board file itself (no network):
//   base   = `lb_source`: the tldraw `documents` rows as of the last conversion or roll-forward; its digest
//            must equal `converted_from.sourceSha256`, else the board stays closed;
//   theirs = the current tldraw `documents` rows (the edits R0 made during a rollback);
//   ours   = the current `lb_elements` (Excalidraw edits since then).
//
// a. record diff base → theirs (created / deleted / changed, by set difference, never by tombstones);
// b. local conversion of the touched records only, within base and within theirs, with the frozen
//    `legacyPages` (a page created on R0 gets one new offset right of the board's current bounds);
// c. field-group merge per element: theirs changed a group when its base and theirs conversions differ;
//    ours changed it when `gclock[g] > converted_from.lbClock`; theirs only → theirs; both → theirs wins,
//    ours' value stays in `lb_prev_<cycle>_*` and the conflict is listed; every other group keeps ours;
// d. a frame or group moved in theirs: its untouched descendants get (theirs − base) ADDED to ours' position;
// e. records created in theirs are inserted with kept ids; records deleted in theirs delete their elements
//    (delete wins); Excalidraw-era creations and deletions are kept;
// f. z-order by relative position: ours' order is never regenerated; a created element (or a record whose
//    tldraw index or parent changed, unless ours re-ordered it) gets a key between its nearest neighbours in
//    theirs' paint order that exist in ours; labels stay after their containers;
// g. validation: text containers whose layout inputs changed are re-fitted, arrows bound to changed targets
//    re-snapped (O1's `resnapArrow` when implemented, else the converter's approximation), `boundElements`
//    made symmetric, then the §2.4.4 invariants (O1's `checkInvariants` when implemented), live index
//    uniqueness and the server's element check; anything unrepaired → nothing is written;
// h. one transaction: pre-merge lb_* copied to `lb_prev_<cycle>_*`, merged rows written (untouched rows are
//    never rewritten, so they stay byte-identical), R0's new `dr_deleted` rows appended to `lb_deleted`, a
//    new epoch and a clock above both sides, `lb_source` replaced by theirs, `converted_from` refreshed;
// i. report `<data>/migration/<board>.rollforward.json`: conflicts by element id and group (no content).

import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { checkElement, type WireElement } from '@draftroom/canvas-schema/elements'
import { indexKeyBetween, resnapArrow, type ServerTextMetrics } from '@draftroom/canvas-schema/engine'
import { fieldGroupOf, type GroupName, kindOf } from '@draftroom/canvas-schema/groups'
import { canonicalElementList } from '@draftroom/canvas-schema/hash'
import { checkInvariants } from '@draftroom/canvas-schema/invariants'
import { roundGeometry } from '@draftroom/canvas-schema/limits'
import {
  approxResnap,
  CONVERTER_VERSION,
  convertDeleted,
  convertRecords,
  elementIdOf,
  hash31,
  indexSnapshot,
  type LegacyPage,
  type LegacyPages,
  lossyCounts,
  migrateRecords,
  offsetForNewPage,
  paintOrder,
  refitLabel,
  type TlRecord,
} from '@draftroom/tldraw-import'
import {
  maxDeletedSeq,
  parseRows,
  readDeletedRows,
  readTldrawTables,
  sha256Hex,
} from '@draftroom/tldraw-import/board-file'
import {
  type ConvertedFrom,
  type Gclock,
  LB_PRAGMAS,
  LB_TABLES,
  lbPrevTable,
  parseGclock,
  serializeGclock,
} from '../schema.ts'
import { heapSampler, newEpoch, writeReport } from './convert-board.ts'
import { recordsSha256 } from './digest.ts'

export interface RollForwardJob {
  readonly kind: 'rollforward'
  readonly boardId: string
  readonly path: string
  readonly reportDir: string
  /** the merge time (`updated` of written elements); default now */
  readonly at?: number
  /** force the converter's approximate re-snap even when the room's helper exists (tests) */
  readonly resnap?: 'auto' | 'approx'
}

export interface Conflict {
  readonly elementId: string
  /** a group name (§3.2), `c:<key>`, `life` (ours deleted it) or `id-exists` (a creation hit an existing id) */
  readonly group: string
}

export interface RollForwardReport {
  readonly kind: 'rollforward'
  readonly boardId: string
  readonly ok: boolean
  readonly reason?: string
  /** the cycle this merge wrote (lb_prev_<cycle>_*), 0 when nothing was merged */
  readonly cycle: number
  readonly counts: {
    readonly created: number
    readonly deleted: number
    readonly changed: number
    readonly parentMoved: number
    readonly elementsWritten: number
    readonly elementsUntouched: number
    readonly deletedRowsAppended: number
    readonly pagesAppended: number
    readonly docKeysWritten: number
  }
  readonly conflicts: readonly Conflict[]
  readonly lossy: Readonly<Record<string, number>>
  readonly resnap: 'engine' | 'approx' | 'none'
  readonly invariants: 'ran' | 'not-implemented'
  readonly violations: readonly { code: string; id: string }[]
  readonly failures: readonly { id: string; code: string }[]
  /** hash.ts digest of the merged element list (live and tombstones) */
  readonly mergedHash: string | null
  readonly ms: number
  readonly peakHeapUsedMb: number
  readonly peakHeapTotalMb: number
}

interface OursRow {
  id: string
  clock: number
  idx: string
  deleted: number
  deleted_clock: number | null
  deleted_at: number | null
  type: string
  version: number
  gclock: string
  data: string
}

/** The fields of a group of `el` (by the §3.2 map of its kind). */
function groupFields(el: WireElement, group: GroupName, other?: WireElement): string[] {
  const keys = new Set([...Object.keys(el), ...(other ? Object.keys(other) : [])])
  return [...keys].filter((f) => fieldGroupOf(el, f) === group)
}

const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x,
  )

const lobbyOf = (e: WireElement): Record<string, unknown> =>
  (e.customData?.lobby as Record<string, unknown> | undefined) ?? {}

/**
 * Fields a conversion derives from others (a fit, §3.2 "Container fit"): a sticky note's `height` and every
 * `layout` field of a text. They are never a group theirs "changed" on their own; they follow the inputs
 * they come from (`text`, `textStyle`, the container's `shape`) and are re-fitted in step g.
 */
function isDerivedField(el: WireElement, field: string): boolean {
  if (el.type === 'stickynote') return field === 'height'
  const kind = kindOf(el)
  return (kind === 'label' || kind === 'freetext') && fieldGroupOf(el, field) === 'layout'
}

/** The groups (and `c:<key>`s) where two conversions of one element differ; `z`, `bound` and derived fields are left out. */
export function changedGroups(a: WireElement, b: WireElement): string[] {
  const out = new Set<string>()
  for (const f of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const g = fieldGroupOf(b, f) ?? fieldGroupOf(a, f)
    if (!g || g === 'z' || g === 'bound' || isDerivedField(b, f)) continue
    if (canonical((a as Record<string, unknown>)[f]) !== canonical((b as Record<string, unknown>)[f]))
      out.add(g)
  }
  const la = lobbyOf(a)
  const lb = lobbyOf(b)
  for (const k of new Set([...Object.keys(la), ...Object.keys(lb)]))
    if (canonical(la[k]) !== canonical(lb[k])) out.add(`c:${k}`)
  if (canonical(a.customData?.lobbyServer) !== canonical(b.customData?.lobbyServer)) out.add('lobbyServer')
  return [...out].sort()
}

/** Copies group `g` (or `c:<key>`, `lobbyServer`) of `from` onto `to`. */
function applyGroup(to: Record<string, unknown>, from: WireElement, g: string): void {
  if (g.startsWith('c:') || g === 'lobbyServer') {
    const cd = { ...((to.customData as Record<string, unknown> | undefined) ?? {}) }
    if (g === 'lobbyServer') {
      if (from.customData?.lobbyServer) cd.lobbyServer = structuredClone(from.customData.lobbyServer)
      else delete cd.lobbyServer
    } else {
      const key = g.slice(2)
      const lobby = { ...((cd.lobby as Record<string, unknown> | undefined) ?? {}) }
      const v = lobbyOf(from)[key]
      if (v === undefined) delete lobby[key]
      else lobby[key] = structuredClone(v)
      if (Object.keys(lobby).length) cd.lobby = lobby
      else delete cd.lobby
    }
    if (Object.keys(cd).length) to.customData = cd
    else delete to.customData
    return
  }
  const fields = groupFields(from, g as GroupName, to as WireElement)
  // a text's derived layout follows its text and text style; a note's height follows its shape
  if (from.type === 'text' && (g === 'text' || g === 'textStyle'))
    fields.push(...groupFields(from, 'layout', to as WireElement))
  if (from.type === 'stickynote' && g === 'shape') fields.push('height')
  for (const f of new Set(fields)) {
    const v = (from as Record<string, unknown>)[f]
    if (v === undefined) delete to[f]
    else to[f] = structuredClone(v)
  }
}

/** Whether ours wrote group `g` after the last conversion or roll-forward. */
function oursChanged(gclock: Gclock, g: string, lbClock: number): boolean {
  const slot = g === 'lobbyServer' ? 'text' : g
  return (gclock[slot] ?? 0) > lbClock
}

/** Whether the room's own re-snap helper exists (it throws "not implemented (O1)" while it is a stub). */
function engineResnapAvailable(
  sample: WireElement | undefined,
  map: ReadonlyMap<string, WireElement>,
): boolean {
  if (!sample) return false
  try {
    resnapArrow(sample as never, map as never)
    return true
  } catch (e) {
    return !/not implemented/.test(String((e as Error)?.message))
  }
}

function invariantsAvailable(): boolean {
  try {
    checkInvariants([])
    return true
  } catch (e) {
    return !/not implemented/.test(String((e as Error)?.message))
  }
}

export function rollForwardBoardFile(job: RollForwardJob, metrics: ServerTextMetrics): RollForwardReport {
  const t0 = performance.now()
  const heap = heapSampler()
  const at = job.at ?? Date.now()
  const counts = {
    created: 0,
    deleted: 0,
    changed: 0,
    parentMoved: 0,
    elementsWritten: 0,
    elementsUntouched: 0,
    deletedRowsAppended: 0,
    pagesAppended: 0,
    docKeysWritten: 0,
  }
  const conflicts: Conflict[] = []
  const failures: { id: string; code: string }[] = []
  let resnapMode: RollForwardReport['resnap'] = 'none'
  let invariants: RollForwardReport['invariants'] = 'not-implemented'
  let violations: { code: string; id: string }[] = []
  let lossy: Record<string, number> = {}
  let cycle = 0
  let mergedHash: string | null = null
  const done = (ok: boolean, reason?: string): RollForwardReport => {
    heap.sample('end')
    const report: RollForwardReport = {
      kind: 'rollforward',
      boardId: job.boardId,
      ok,
      ...(reason ? { reason } : {}),
      cycle,
      counts,
      conflicts: [...conflicts].sort((a, b) =>
        a.elementId < b.elementId ? -1 : a.elementId > b.elementId ? 1 : a.group < b.group ? -1 : 1,
      ),
      lossy,
      resnap: resnapMode,
      invariants,
      violations,
      failures,
      mergedHash,
      ms: Math.round(performance.now() - t0),
      peakHeapUsedMb: heap.peakUsedMb,
      peakHeapTotalMb: heap.peakTotalMb,
    }
    writeReport(job.reportDir, `${job.boardId}.rollforward.json`, report)
    return report
  }

  const db = new DatabaseSync(job.path)
  try {
    for (const p of LB_PRAGMAS) db.exec(p)
    const metaRows = new Map(
      (db.prepare('SELECT key, value FROM lb_meta').all() as Array<{ key: string; value: string }>).map(
        (r) => [r.key, r.value],
      ),
    )
    const cfText = metaRows.get('converted_from')
    if (!cfText) return done(false, 'not-converted')
    const cf = JSON.parse(cfText) as ConvertedFrom
    const lbClockNow = Number(metaRows.get('clock') ?? '0')

    // base: lb_source, checked against its recorded digest
    if (recordsSha256(db, 'lb_source') !== cf.sourceSha256) return done(false, 'base-digest')
    const theirsTl = readTldrawTables(db)
    const drNew = readDeletedRows(db, cf.deletedSeq)
    if (theirsTl.documentClock <= cf.documentClock && drNew.length === 0)
      return done(true, 'nothing-to-merge')

    // the schema base was stored under: the one whose sha256 converted_from recorded
    const candidates = [
      theirsTl.schemaText,
      ...(
        db.prepare('SELECT schema FROM dr_deleted_schemas ORDER BY id').all() as Array<{ schema: string }>
      ).map((r) => r.schema),
    ]
    const baseSchemaText = candidates.find((t) => sha256Hex(t) === cf.schemaHash)
    if (!baseSchemaText) return done(false, 'base-schema-unknown')
    const baseRows = db.prepare('SELECT id, state FROM lb_source ORDER BY id').all() as Array<{
      id: string
      state: Uint8Array | string
    }>
    const baseParsed = baseRows.map((r) =>
      JSON.parse(typeof r.state === 'string' ? r.state : Buffer.from(r.state).toString('utf8')),
    )
    const baseMig = migrateRecords(baseParsed, JSON.parse(baseSchemaText))
    const theirsMig = migrateRecords(parseRows(theirsTl.rows), theirsTl.schema)
    if (!baseMig.ok || !theirsMig.ok) return done(false, 'migration')
    heap.sample('read')
    const base = new Map(baseMig.records.map((r) => [r.id, r]))
    const theirs = new Map(theirsMig.records.map((r) => [r.id, r]))

    // a. record diff
    const created: string[] = []
    const deleted: string[] = []
    const changed: string[] = []
    for (const [id, r] of theirs) {
      const b = base.get(id)
      if (!b) created.push(id)
      else if (canonical(b) !== canonical(r)) changed.push(id)
    }
    for (const id of base.keys()) if (!theirs.has(id)) deleted.push(id)
    const baseSnap = indexSnapshot([...base.values()])
    const theirsSnap = indexSnapshot([...theirs.values()])
    const isShape = (id: string) => base.get(id)?.typeName === 'shape' || theirs.get(id)?.typeName === 'shape'
    // touched shapes: shape records themselves, the ends of touched bindings, the users of touched assets
    const touched = new Set<string>([...created, ...deleted, ...changed].filter(isShape))
    for (const id of [...created, ...deleted, ...changed]) {
      const r = theirs.get(id) ?? base.get(id)
      if (r?.typeName === 'binding') {
        for (const end of [r.fromId, r.toId])
          if (typeof end === 'string' && (base.has(end) || theirs.has(end))) touched.add(end)
        const br = base.get(id)
        if (br)
          for (const end of [br.fromId, br.toId])
            if (typeof end === 'string' && (base.has(end) || theirs.has(end))) touched.add(end)
      }
      if (r?.typeName === 'asset')
        for (const s of theirs.values())
          if (s.typeName === 'shape' && (s.props as Record<string, unknown> | undefined)?.assetId === id)
            touched.add(s.id)
    }
    const createdShapes = new Set([...touched].filter((id) => theirs.has(id) && !base.has(id)))
    const deletedShapes = new Set([...touched].filter((id) => base.has(id) && !theirs.has(id)))
    const changedShapes = new Set([...touched].filter((id) => base.has(id) && theirs.has(id)))
    counts.created = createdShapes.size
    counts.deleted = deletedShapes.size
    counts.changed = changedShapes.size

    // ours
    const oursRows = new Map(
      (db.prepare('SELECT * FROM lb_elements').all() as unknown as OursRow[]).map((r) => [r.id, r]),
    )
    const ours = new Map<string, Record<string, unknown>>()
    for (const [id, r] of oursRows) ours.set(id, JSON.parse(r.data) as Record<string, unknown>)
    const gclocks = new Map([...oursRows].map(([id, r]) => [id, parseGclock(r.gclock)]))

    // b. frozen page offsets, plus one for each page created on R0
    const importRow = db.prepare("SELECT value FROM lb_doc WHERE key = 'import'").get() as
      | { value: string | null }
      | undefined
    const importDoc = importRow?.value
      ? (JSON.parse(importRow.value) as { legacyPages: Record<string, LegacyPage> } & Record<string, unknown>)
      : null
    const legacyPages: Record<string, LegacyPage> = { ...(importDoc?.legacyPages ?? {}) }
    let boardRight = Number.NEGATIVE_INFINITY
    let boardTop = Number.POSITIVE_INFINITY
    for (const [id, e] of ours) {
      if (oursRows.get(id)?.deleted) continue
      boardRight = Math.max(boardRight, Number(e.x) + Number(e.width))
      boardTop = Math.min(boardTop, Number(e.y))
    }
    for (const pageId of theirsSnap.pageOrder) {
      if (legacyPages[pageId]) continue
      const off = offsetForNewPage(theirsSnap, pageId, boardRight, Number.isFinite(boardTop) ? boardTop : 0)
      legacyPages[pageId] = off
      counts.pagesAppended++
      const b = pageBoundsRight(theirsSnap, pageId, off)
      if (b !== null) boardRight = Math.max(boardRight, b)
    }
    const pages: LegacyPages = legacyPages
    const conv = { updatedAt: at, metrics, legacyPages: pages }
    const baseConv = convertRecords(baseSnap, [...changedShapes, ...deletedShapes], conv)
    const theirsConv = convertRecords(theirsSnap, [...changedShapes, ...createdShapes], conv)
    const convFailures = [...baseConv.failures, ...theirsConv.failures]
    if (convFailures.length) {
      failures.push(...convFailures.map((f) => ({ id: f.id, code: f.code })))
      return done(false, 'conversion')
    }
    lossy = lossyCounts(theirsConv.lossy)
    heap.sample('convert')

    const newClock = Math.max(lbClockNow, theirsTl.documentClock) + 1
    const written = new Map<string, Record<string, unknown>>()
    const writtenGroups = new Map<string, Set<string>>()
    const newDeleted = new Set<string>()
    const inserted = new Set<string>()
    const mark = (id: string, g: string) => writtenGroups.set(id, (writtenGroups.get(id) ?? new Set()).add(g))
    const work = (id: string): Record<string, unknown> | null => {
      const w = written.get(id)
      if (w) return w
      const o = ours.get(id)
      if (!o) return null
      const copy = structuredClone(o)
      written.set(id, copy)
      return copy
    }
    const isLive = (id: string) => {
      const r = oursRows.get(id)
      return (r && !r.deleted && !newDeleted.has(id)) || inserted.has(id)
    }

    // c + e (changed records): per element, per group
    for (const shapeId of [...changedShapes].sort()) {
      const bEls = new Map((baseConv.elements.get(shapeId) ?? []).map((e) => [e.id, e]))
      const tEls = new Map((theirsConv.elements.get(shapeId) ?? []).map((e) => [e.id, e]))
      for (const id of new Set([...bEls.keys(), ...tEls.keys()])) {
        const b = bEls.get(id)
        const t = tEls.get(id)
        if (b && t) {
          const groups = changedGroups(b, t)
          if (!groups.length) continue
          const row = oursRows.get(id)
          if (!row) {
            written.set(id, structuredClone(t) as unknown as Record<string, unknown>)
            inserted.add(id)
            for (const g of groups) mark(id, g)
            continue
          }
          if (row.deleted) {
            conflicts.push({ elementId: id, group: 'life' })
            continue
          }
          const w = work(id) as Record<string, unknown>
          const gc = gclocks.get(id) ?? {}
          for (const g of groups) {
            if (oursChanged(gc, g, cf.lbClock)) conflicts.push({ elementId: id, group: g })
            applyGroup(w, t, g)
            mark(id, g)
          }
        } else if (t && !b) {
          // theirs made a new element for an existing record (a label typed into an empty note)
          if (isLive(id)) conflicts.push({ elementId: id, group: 'id-exists' })
          else {
            written.set(id, structuredClone(t) as unknown as Record<string, unknown>)
            inserted.add(id)
            mark(id, 'life')
          }
        } else if (b && !t && isLive(id)) {
          newDeleted.add(id)
          mark(id, 'life')
        }
      }
    }
    // e. creations and deletions
    for (const shapeId of [...createdShapes].sort())
      for (const t of theirsConv.elements.get(shapeId) ?? []) {
        if (oursRows.has(t.id)) {
          conflicts.push({ elementId: t.id, group: 'id-exists' })
          continue
        }
        written.set(t.id, structuredClone(t) as unknown as Record<string, unknown>)
        inserted.add(t.id)
      }
    for (const shapeId of [...deletedShapes].sort())
      for (const b of baseConv.elements.get(shapeId) ?? [])
        if (isLive(b.id) && !inserted.has(b.id)) {
          newDeleted.add(b.id)
          mark(b.id, 'life')
        }

    // d. parent moves compose: untouched descendants of a frame or group whose transform changed in theirs
    const moved = [...changedShapes].filter((id) => {
      const b = base.get(id)
      const t = theirs.get(id)
      return (
        (t?.type === 'frame' || t?.type === 'group') &&
        b &&
        (b.x !== t.x || b.y !== t.y || b.rotation !== t.rotation || b.parentId !== t.parentId)
      )
    })
    const descendants = new Set<string>()
    const collect = (id: string, depth: number) => {
      if (depth > 64) return
      for (const k of theirsSnap.children.get(id) ?? []) {
        if (!touched.has(k.id) && baseSnap.shapes.has(k.id)) descendants.add(k.id)
        collect(k.id, depth + 1)
      }
    }
    for (const id of moved) collect(id, 0)
    if (descendants.size) {
      const bD = convertRecords(baseSnap, descendants, conv)
      const tD = convertRecords(theirsSnap, descendants, conv)
      for (const shapeId of [...descendants].sort()) {
        const tMap = new Map((tD.elements.get(shapeId) ?? []).map((e) => [e.id, e]))
        let any = false
        for (const b of bD.elements.get(shapeId) ?? []) {
          const t = tMap.get(b.id)
          if (!t || !isLive(b.id)) continue
          const dx = t.x - b.x
          const dy = t.y - b.y
          if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) continue
          const w = work(b.id)
          if (!w) continue
          w.x = Number(w.x) + dx
          w.y = Number(w.y) + dy
          const rounded = roundGeometry(w as unknown as WireElement) as unknown as Record<string, unknown>
          w.x = rounded.x
          w.y = rounded.y
          const g = t.type === 'arrow' || t.type === 'line' ? 'path' : (fieldGroupOf(t, 'x') ?? 'pos')
          mark(b.id, g)
          any = true
        }
        if (any) counts.parentMoved++
      }
    }

    // f. z-order by relative position (ours' order never regenerated)
    const idx = new Map<string, string>()
    for (const [id, r] of oursRows) idx.set(id, r.idx)
    // a record's elements: its id and its suffixed ids (converted ids never contain '.')
    const owners = new Map<string, string[]>()
    for (const id of [...idx.keys(), ...written.keys()]) {
      const o = id.split('.')[0] as string
      if (!owners.get(o)?.includes(id)) owners.set(o, [...(owners.get(o) ?? []), id])
    }
    const ownerElements = (shapeId: string): string[] =>
      (owners.get(elementIdOf(shapeId)) ?? []).filter((id) => idx.has(id))
    const order = paintOrder(theirsSnap)
    const positionOf = new Map(order.map((id, i) => [id, i]))
    const toPlace = new Set<string>(createdShapes)
    for (const id of changedShapes) {
      const b = base.get(id)
      const t = theirs.get(id)
      if (!b || !t || (b.index === t.index && b.parentId === t.parentId)) continue
      const main = elementIdOf(id)
      if ((gclocks.get(main)?.z ?? 0) > cf.lbClock) conflicts.push({ elementId: main, group: 'z' })
      else toPlace.add(id)
    }
    // the live keys in order; a placed element always goes right after its preceding neighbour, before
    // whatever follows that neighbour in ours, so a new key never collides with an existing one
    const liveKeys = [...idx.entries()]
      .filter(([id]) => isLive(id))
      .map(([, k]) => k)
      .sort()
    const successor = (lo: string | null): string | null => {
      let a = 0
      let b = liveKeys.length
      while (a < b) {
        const m = (a + b) >> 1
        if (lo !== null && (liveKeys[m] as string) <= lo) a = m + 1
        else b = m
      }
      return liveKeys[a] ?? null
    }
    const insertKey = (k: string) => {
      let a = 0
      let b = liveKeys.length
      while (a < b) {
        const m = (a + b) >> 1
        if ((liveKeys[m] as string) < k) a = m + 1
        else b = m
      }
      liveKeys.splice(a, 0, k)
    }
    const removeKey = (k: string) => {
      const i = liveKeys.indexOf(k)
      if (i >= 0) liveKeys.splice(i, 1)
    }
    const placed = new Set<string>()
    for (const shapeId of [...toPlace].sort((a, b) => (positionOf.get(a) ?? 0) - (positionOf.get(b) ?? 0))) {
      const els = (theirsConv.elements.get(shapeId) ?? [])
        .map((e) => e.id)
        .filter((id) => written.has(id) || idx.has(id))
      if (!els.length) continue
      // the element's old keys are free again (it is re-placed)
      for (const id of els) {
        const old = idx.get(id)
        if (old !== undefined && isLive(id)) removeKey(old)
      }
      const pos = positionOf.get(shapeId) ?? 0
      let lo: string | null = null
      for (let i = pos - 1; i >= 0 && lo === null; i--) {
        const n = order[i] as string
        // a neighbour that is itself waiting to be re-placed is not where it will be: skip it
        if (toPlace.has(n) && !placed.has(n)) continue
        const keys = ownerElements(n)
          .filter((id) => isLive(id) && !els.includes(id))
          .map((id) => idx.get(id) as string)
        if (keys.length) lo = keys.sort().at(-1) as string
      }
      for (const id of els) {
        const key = indexKeyBetween(lo, successor(lo))
        idx.set(id, key)
        insertKey(key)
        const w = work(id) ?? (written.get(id) as Record<string, unknown>)
        w.index = key
        mark(id, 'z')
        lo = key
      }
      placed.add(shapeId)
    }
    // a new label of an existing container goes right after its container
    for (const id of inserted) {
      const e = written.get(id) as Record<string, unknown>
      if (e.index !== null && e.index !== undefined && idx.has(id)) continue
      const container = typeof e.containerId === 'string' ? e.containerId : null
      const lo = container ? (idx.get(container) ?? null) : (liveKeys.at(-1) ?? null)
      const key = indexKeyBetween(lo, successor(lo))
      idx.set(id, key)
      insertKey(key)
      e.index = key
      mark(id, 'z')
    }
    heap.sample('merge')

    // g. validation: re-fit, re-snap, symmetric bound, invariants, indices, limits
    for (const id of newDeleted) {
      const w = work(id)
      if (w) w.isDeleted = true
    }
    const view = new Map<string, WireElement>()
    for (const [id, e] of ours) if (!written.has(id)) view.set(id, e as unknown as WireElement)
    for (const [id, e] of written) view.set(id, e as unknown as WireElement)
    const geometryChanged = new Set<string>()
    for (const [id, gs] of writtenGroups)
      if ([...gs].some((g) => ['pos', 'shape', 'path', 'layout', 'text', 'textStyle', 'life'].includes(g)))
        geometryChanged.add(id)
    // re-fit containers whose label or container changed
    for (const id of [...geometryChanged]) {
      const e = view.get(id)
      if (!e || e.isDeleted) continue
      const container = e.type === 'text' && e.containerId ? view.get(e.containerId) : e
      const labelRef = container?.boundElements?.find((b) => b.type === 'text')
      const label = labelRef ? view.get(labelRef.id) : undefined
      if (!container || !label || container.type === 'arrow' || label.isDeleted) continue
      const fit = refitLabel(container, label, metrics)
      for (const [el, next] of [
        [container, fit.container],
        [label, fit.label],
      ] as const) {
        if (canonical(el) === canonical(next)) continue
        const w = work(el.id) ?? written.get(el.id)
        if (!w) continue
        Object.assign(w, next)
        view.set(el.id, next)
        mark(el.id, 'fit')
        geometryChanged.add(el.id)
      }
    }
    // re-snap arrows bound to changed targets (and changed arrows)
    const arrows = [...view.values()].filter(
      (e) =>
        e.type === 'arrow' &&
        !e.isDeleted &&
        (geometryChanged.has(e.id) ||
          (e.startBinding && geometryChanged.has(e.startBinding.elementId)) ||
          (e.endBinding && geometryChanged.has(e.endBinding.elementId))),
    )
    if (arrows.length) {
      const useEngine = job.resnap !== 'approx' && engineResnapAvailable(arrows[0], view)
      resnapMode = useEngine ? 'engine' : 'approx'
      for (const a of arrows) {
        if (a.type !== 'arrow') continue
        // a binding to a deleted or missing target is nulled (§2.4.4), the end stays where it is
        let arrow = a
        for (const end of ['startBinding', 'endBinding'] as const) {
          const b = arrow[end]
          const target = b ? view.get(b.elementId) : undefined
          if (b && (!target || target.isDeleted)) arrow = { ...arrow, [end]: null }
        }
        const next = useEngine
          ? ({ ...arrow, ...resnapArrow(arrow as never, view as never).path } as WireElement)
          : approxResnap(arrow, view)
        if (canonical(next) === canonical(a)) continue
        const w = work(a.id) ?? written.get(a.id)
        if (!w) continue
        Object.assign(w, next)
        view.set(a.id, next)
        mark(a.id, 'fit')
      }
    }
    // symmetric boundElements for every element whose bound set is no longer what the merged board says
    const wantBound = new Map<string, { id: string; type: 'arrow' | 'text' }[]>()
    for (const e of view.values()) {
      if (e.isDeleted) continue
      if (e.type === 'text' && e.containerId)
        wantBound.set(e.containerId, [...(wantBound.get(e.containerId) ?? []), { id: e.id, type: 'text' }])
      if (e.type === 'arrow')
        for (const b of new Set([e.startBinding?.elementId, e.endBinding?.elementId]))
          if (b) wantBound.set(b, [...(wantBound.get(b) ?? []), { id: e.id, type: 'arrow' }])
    }
    for (const e of view.values()) {
      if (e.isDeleted) continue
      const want = wantBound.get(e.id) ?? []
      const have = e.boundElements ?? []
      const same =
        want.length === have.length && want.every((w) => have.some((h) => h.id === w.id && h.type === w.type))
      if (same) continue
      const keep = have.filter((h) => want.some((w) => w.id === h.id && w.type === h.type))
      const add = want.filter((w) => !keep.some((h) => h.id === w.id)).sort((a, b) => (a.id < b.id ? -1 : 1))
      const next = [...keep, ...add]
      const w = work(e.id) ?? written.get(e.id)
      if (!w) continue
      w.boundElements = next.length ? next : null
      view.set(e.id, { ...e, boundElements: w.boundElements } as WireElement)
      mark(e.id, 'bound')
    }
    // versions: every written element gets version + 1 and a fresh nonce
    for (const [id, w] of written) {
      const prev = oursRows.get(id)
      w.version = (prev?.version ?? Number(w.version ?? 0)) + 1
      w.versionNonce = hash31(`${id}#${newClock}`)
      w.updated = at
      if (newDeleted.has(id)) w.isDeleted = true
      view.set(id, w as unknown as WireElement)
    }
    // checks
    for (const [id, w] of written) {
      const c = checkElement(w)
      if (!c.ok) failures.push({ id, code: c.code })
    }
    const liveIdx = new Map<string, string>()
    for (const e of view.values()) {
      if (e.isDeleted) continue
      const k = idx.get(e.id) ?? (e.index as string)
      const other = liveIdx.get(k)
      if (other) failures.push({ id: e.id, code: 'INDEX_DUPLICATE' })
      liveIdx.set(k, e.id)
    }
    if (invariantsAvailable()) {
      invariants = 'ran'
      violations = checkInvariants([...view.values()]).map((v) => ({ code: v.code, id: v.id }))
    }
    if (failures.length || violations.length) return done(false, 'validation')
    mergedHash = createHash('sha256').update(canonicalElementList(view.values())).digest('hex')
    heap.sample('validate')

    // h. one transaction
    const del = convertDeleted(drNew, [...theirs.values()], conv)
    if (del.failures.length) {
      failures.push(...del.failures.map((f) => ({ id: f.id, code: f.code })))
      return done(false, 'deleted')
    }
    cycle = cf.cycle + 1
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const t of LB_TABLES) db.exec(`CREATE TABLE ${lbPrevTable(cycle, t)} AS SELECT * FROM ${t}`)
      const upd = db.prepare(
        'UPDATE lb_elements SET clock = ?, idx = ?, deleted = ?, deleted_clock = ?, deleted_at = ?, version = ?, gclock = ?, data = ? WHERE id = ?',
      )
      const ins = db.prepare(
        'INSERT INTO lb_elements (id, clock, idx, deleted, deleted_clock, deleted_at, type, version, gclock, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      for (const [id, w] of written) {
        const prev = oursRows.get(id)
        const gc: Record<string, number> = { ...(gclocks.get(id) ?? {}) }
        for (const g of writtenGroups.get(id) ?? []) gc[g === 'lobbyServer' ? 'text' : g] = newClock
        const isDel = newDeleted.has(id) || w.isDeleted === true
        const index = idx.get(id) ?? String(w.index ?? '')
        w.index = index
        const data = JSON.stringify(w)
        if (prev)
          upd.run(
            newClock,
            index,
            isDel ? 1 : 0,
            isDel ? (prev.deleted ? prev.deleted_clock : newClock) : null,
            isDel ? (prev.deleted ? prev.deleted_at : at) : null,
            Number(w.version),
            serializeGclock(gc),
            data,
            id,
          )
        else
          ins.run(
            id,
            newClock,
            index,
            isDel ? 1 : 0,
            isDel ? newClock : null,
            isDel ? at : null,
            String(w.type),
            Number(w.version),
            serializeGclock(gc),
            data,
          )
      }
      counts.elementsWritten = written.size
      counts.elementsUntouched = oursRows.size - [...written.keys()].filter((id) => oursRows.has(id)).length
      const insDel = db.prepare(
        `INSERT INTO lb_deleted (batch, element_id, type, container_id, frame_id, data, deleted_by, deleted_by_name,
           deleted_at, epoch, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'converted')`,
      )
      for (const r of del.rows)
        insDel.run(
          r.batch,
          r.elementId,
          r.type,
          r.containerId,
          r.frameId,
          r.data,
          r.deletedBy,
          r.deletedByName,
          r.deletedAt,
          r.epoch,
        )
      counts.deletedRowsAppended = del.rows.length
      // the board document: theirs' document meta per key, unless ours wrote the key since the last cycle
      counts.docKeysWritten = mergeDoc(db, base, theirs, pages, cf.lbClock, newClock, conflicts)
      if (counts.pagesAppended && importDoc) {
        const next = { ...importDoc, legacyPages: pages }
        db.prepare("UPDATE lb_doc SET value = ?, clock = ? WHERE key = 'import'").run(
          JSON.stringify(next),
          newClock,
        )
      }
      db.exec('DELETE FROM lb_source')
      db.exec('INSERT INTO lb_source (id, state) SELECT id, state FROM documents')
      const sourceSha256 = recordsSha256(db, 'lb_source')
      const next: ConvertedFrom = {
        ...cf,
        documentClock: theirsTl.documentClock,
        schemaHash: sha256Hex(theirsTl.schemaText),
        sourceSha256,
        converterVersion: CONVERTER_VERSION,
        deletedSeq: Math.max(cf.deletedSeq, del.lastSeq, maxDeletedSeq(db)),
        lbClock: newClock,
        cycle,
      }
      const setMeta = db.prepare(
        'INSERT INTO lb_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      setMeta.run('converted_from', JSON.stringify(next))
      setMeta.run('clock', String(newClock))
      setMeta.run('epoch', newEpoch())
      db.exec('COMMIT')
    } catch (e) {
      if (db.isTransaction) db.exec('ROLLBACK')
      cycle = 0
      throw e
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    heap.sample('write')
    return done(true)
  } catch (e) {
    return done(false, `error: ${(e as Error)?.name ?? 'Error'}`)
  } finally {
    db.close()
  }
}

/** The right edge of a page once offset (null when empty). */
function pageBoundsRight(
  snap: ReturnType<typeof indexSnapshot>,
  pageId: string,
  off: LegacyPage,
): number | null {
  let right: number | null = null
  for (const s of snap.children.get(pageId) ?? []) {
    const p = (s.props ?? {}) as Record<string, unknown>
    const w = typeof p.w === 'number' ? p.w : 200
    right = Math.max(right ?? Number.NEGATIVE_INFINITY, Number(s.x ?? 0) + w + off.dx)
  }
  return right
}

/** Merges the tldraw document meta into lb_doc per key (theirs changed, ours did not → theirs). */
function mergeDoc(
  db: DatabaseSync,
  base: ReadonlyMap<string, TlRecord>,
  theirs: ReadonlyMap<string, TlRecord>,
  pages: LegacyPages,
  lbClock: number,
  newClock: number,
  conflicts: Conflict[],
): number {
  const docOf = (m: ReadonlyMap<string, TlRecord>) => [...m.values()].find((r) => r.typeName === 'document')
  const b = docOf(base)
  const t = docOf(theirs)
  if (!t || canonical(b?.meta) === canonical(t.meta)) return 0
  const values = (r: TlRecord | undefined): Map<string, string | null> => {
    const out = new Map<string, string | null>()
    const meta = (r?.meta ?? {}) as Record<string, unknown>
    const sv = meta.drStartView as Record<string, unknown> | undefined
    if (sv && typeof sv === 'object') {
      const off = pages[String(sv.pageId)] ?? { dx: 0, dy: 0 }
      const v: Record<string, unknown> = {
        x: Number(sv.x) + off.dx,
        y: Number(sv.y) + off.dy,
        w: sv.w,
        h: sv.h,
      }
      if (typeof sv.frameId === 'string') v.frameId = elementIdOf(sv.frameId)
      out.set('startView', JSON.stringify(v))
    }
    const ws = meta.drWorkshop as Record<string, unknown> | undefined
    if (ws && typeof ws === 'object')
      out.set(
        'workshop',
        JSON.stringify({
          hideNoteAuthors: ws.hideNoteAuthors === true,
          hideCursors: ws.hideCursors === true,
        }),
      )
    for (const [k, v] of Object.entries(meta))
      if (k.startsWith('drTagList:') && v && typeof v === 'object')
        out.set(
          `tagDef:${k.slice('drTagList:'.length)}`,
          JSON.stringify({
            name: (v as Record<string, unknown>).name,
            color: (v as Record<string, unknown>).color,
          }),
        )
    return out
  }
  const bv = values(b)
  const tv = values(t)
  let n = 0
  const cur = db.prepare('SELECT clock FROM lb_doc WHERE key = ?')
  const put = db.prepare(
    'INSERT INTO lb_doc (key, clock, value) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET clock = excluded.clock, value = excluded.value',
  )
  for (const key of new Set([...bv.keys(), ...tv.keys()])) {
    const before = bv.get(key) ?? null
    const after = tv.get(key) ?? null
    if (before === after) continue
    const row = cur.get(key) as { clock: number } | undefined
    if (row && Number(row.clock) > lbClock) conflicts.push({ elementId: `doc:${key}`, group: 'doc' })
    put.run(key, newClock, after)
    n++
  }
  return n
}

/** hash.ts's digest of an element list, synchronously (node:crypto over the same canonical input). */
export const elementsDigest = (elements: Iterable<Readonly<Record<string, unknown>>>) =>
  createHash('sha256').update(canonicalElementList(elements)).digest('hex')
