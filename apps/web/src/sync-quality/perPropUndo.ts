/**
 * Per-property ("Miro-style") undo/redo for a tldraw 5.4.2 editor on native sync.
 *
 * Problem: HistoryManager records record-level [from, to] pairs and replays them with
 * `store.applyDiff(diff, { ignoreEphemeralKeys: true })` (HistoryManager.ts:193 undo, :243 redo), and
 * Store.applyDiff puts the WHOLE target record (Store.ts:1055-1102). So undo reverts other users' later
 * edits to that record and re-creates records they deleted.
 *
 * Fix: while (and only while) the HistoryManager is replaying, rewrite the diff it hands to
 * `store.applyDiff` into a 3-way patch against the CURRENT store:
 *   - updated record, per field (top-level keys, first-level props.* and meta.* keys, i.e. the same
 *     granularity the sync wire uses): only fields the entry changed are touched, and only if the
 *     current value still equals what the entry left there AND the last write to that field was not a
 *     remote one. Anything else is someone else's later edit and is left alone.
 *   - updated record that no longer exists: skipped (never resurrected).
 *   - re-added record (undo of your own delete / redo of your own create): restored, unless an id
 *     already exists or it would reference a missing parent / binding endpoint.
 *   - removed record (undo of your own create / redo of your own delete): removed if still present,
 *     unless another user has since put children into it.
 * The HistoryManager itself is untouched: its stacks, marks, squashing and redo bookkeeping stay
 * native; only what gets written changes.
 */
import {
  type Editor,
  getArrowInfo,
  isEqual,
  isShapeId,
  type RecordsDiff,
  type TLArrowBinding,
  type TLArrowShape,
  type TLRecord,
  type TLShapeId,
} from 'tldraw'

export type UndoSkipReason =
  /** the record was deleted by someone else since: not resurrected */
  | 'deleted'
  /** the field(s) were changed by someone else since: left as they are */
  | 'changed'
  /** restoring it would point at a parent/endpoint that no longer exists */
  | 'orphan'
  /** a record with this id exists again: not overwritten */
  | 'exists'
  /** isFieldLocked() vetoed the field (e.g. another user is editing that text) */
  | 'locked'
  /** not removed: other users' shapes are now inside it */
  | 'has-foreign-children'

export interface UndoSkip {
  id: string
  typeName: string
  reason: UndoSkipReason
  paths?: string[]
}

export interface UndoReplayReport {
  /** document records actually written (added + updated + removed) */
  applied: number
  skipped: UndoSkip[]
  /** true when the step changed no document record at all, but something was skipped */
  noop: boolean
}

export interface PerPropUndoOptions {
  /** Called (in a microtask, after the replay) whenever something was skipped. */
  onReplay?(report: UndoReplayReport): void
  /**
   * Return true to leave `path` of `current` alone, e.g. `props.richText` of a shape another
   * collaborator is editing (the server text lease would veto the whole record op otherwise).
   */
  isFieldLocked?(current: TLRecord, path: string): boolean
  /** Spike-only: force the public-method replay gate instead of editor.isReplayingHistory(). */
  gate?: 'auto' | 'public-methods'
  /** Spike-only: false disables the remote-write tracker (to demonstrate why it is needed). */
  trackRemoteWrites?: boolean
}

type AnyRecord = Record<string, unknown> & { id: string; typeName: string }
const SPATIAL = ['parentId', 'x', 'y', 'rotation', 'index'] as const
const SPATIAL_SET: ReadonlySet<string> = new Set(SPATIAL)

// ---------------------------------------------------------------- field paths
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function split(path: string): [string, string | undefined] {
  if (path.startsWith('props.')) return ['props', path.slice(6)]
  if (path.startsWith('meta.')) return ['meta', path.slice(5)]
  return [path, undefined]
}
function read(rec: AnyRecord, path: string): unknown {
  const [a, b] = split(path)
  const v = rec[a]
  return b === undefined ? v : isObj(v) ? v[b] : undefined
}
/** Changed field paths between two versions of one record, at sync-wire granularity (diff.ts:185-236). */
export function changedPaths(a: AnyRecord, b: AnyRecord): string[] {
  const out: string[] = []
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) {
    if (k === 'id' || k === 'typeName') continue
    const av = a[k]
    const bv = b[k]
    if ((k === 'props' || k === 'meta') && isObj(av) && isObj(bv)) {
      for (const sk of new Set([...Object.keys(av), ...Object.keys(bv)]))
        if (!isEqual(av[sk], bv[sk]) || Object.hasOwn(av, sk) !== Object.hasOwn(bv, sk))
          out.push(`${k}.${sk}`)
    } else if (!isEqual(av, bv) || Object.hasOwn(a, k) !== Object.hasOwn(b, k)) {
      out.push(k)
    }
  }
  return out
}
/** `current` with `paths` copied from `target` (a key absent in target is deleted). */
function writePaths(current: AnyRecord, target: AnyRecord, paths: Iterable<string>): AnyRecord {
  const next: AnyRecord = { ...current }
  for (const path of paths) {
    const [a, b] = split(path)
    if (b === undefined) {
      if (Object.hasOwn(target, a)) next[a] = target[a]
      else delete next[a]
      continue
    }
    if (next[a] === current[a]) next[a] = { ...(current[a] as object) } // copy props/meta once
    const dst = next[a] as Record<string, unknown>
    const src = target[a]
    if (isObj(src) && Object.hasOwn(src, b)) dst[b] = src[b]
    else delete dst[b]
  }
  return next
}

// ---------------------------------------------------------------- the merge (pure)
export interface MergeContext {
  get(id: string): AnyRecord | undefined
  isDocumentType(typeName: string): boolean
  /** field paths of `id` whose most recent write came from a remote change */
  remoteFields(id: string): ReadonlySet<string> | undefined
  /** true if `id` was deleted by a remote change (and not re-created since) */
  deletedRemotely(id: string): boolean
  /** ids of shapes whose parentId is `id` right now */
  childIds(id: string): readonly string[]
  isFieldLocked?(current: AnyRecord, path: string): boolean
}

/**
 * Rewrites a history replay diff (`updated` = [expected current, target]) into the 3-way patch
 * described in the header. Works for undo (reversed entry) and redo (forward entry) alike.
 */
export function mergeReplayDiff(
  diff: RecordsDiff<TLRecord>,
  ctx: MergeContext,
): { diff: RecordsDiff<TLRecord>; report: UndoReplayReport } {
  const added: Record<string, AnyRecord> = {}
  const updated: Record<string, [AnyRecord, AnyRecord]> = {}
  const removed: Record<string, AnyRecord> = {}
  const skipped: UndoSkip[] = []
  const skip = (rec: AnyRecord, reason: UndoSkipReason, paths?: string[]) =>
    skipped.push({ id: rec.id, typeName: rec.typeName, reason, ...(paths?.length ? { paths } : {}) })

  // 1. removals: only what still exists (removing something already gone is a no-op anyway)
  for (const rec of Object.values(diff.removed) as unknown as AnyRecord[]) {
    const current = ctx.get(rec.id)
    if (current) removed[rec.id] = current
  }

  // 2. updates: the 3-way per-field patch
  for (const [expected, target] of Object.values(diff.updated) as unknown as [AnyRecord, AnyRecord][]) {
    if (!ctx.isDocumentType(target.typeName)) {
      updated[target.id] = [expected, target] // session state (selection, camera...): native behavior
      continue
    }
    const current = ctx.get(target.id)
    if (!current) {
      skip(target, 'deleted')
      continue
    }
    const paths = changedPaths(expected, target)
    const remote = ctx.remoteFields(target.id)
    const apply = new Set<string>()
    const conflicts: string[] = []
    const locked: string[] = []
    const fieldOk = (p: string) => {
      if (ctx.isFieldLocked?.(current, p)) return void locked.push(p)
      if (!isEqual(read(current, p), read(expected, p)) || remote?.has(p)) return void conflicts.push(p)
      apply.add(p)
    }
    if (isShapeId(target.id) && paths.includes('parentId')) {
      // x/y/rotation/index are relative to the parent: revert them together with parentId or not at all.
      const spatial = paths.filter((p) => SPATIAL_SET.has(p))
      const parentOk =
        !ctx.isFieldLocked?.(current, 'parentId') &&
        isEqual(current.parentId, expected.parentId) &&
        !remote?.has('parentId')
      if (parentOk) for (const p of spatial) apply.add(p)
      else conflicts.push(...spatial)
      for (const p of paths) if (!SPATIAL_SET.has(p)) fieldOk(p)
    } else {
      for (const p of paths) fieldOk(p)
    }
    if (locked.length) skip(current, 'locked', locked)
    if (conflicts.length) skip(current, 'changed', conflicts)
    if (apply.size) updated[target.id] = [current, writePaths(current, target, apply)]
  }

  // 3. re-additions (undo of your delete, redo of your create): never overwrite a record that exists
  //    again, and never re-create one that someone else deleted. The second case is real: undo of
  //    "create X" after B deleted X is a no-op, and the following redo would otherwise re-add X.
  for (const rec of Object.values(diff.added) as unknown as AnyRecord[]) {
    const isDoc = ctx.isDocumentType(rec.typeName)
    if (isDoc && ctx.get(rec.id)) skip(rec, 'exists')
    else if (isDoc && ctx.deletedRemotely(rec.id)) skip(rec, 'deleted')
    else added[rec.id] = rec
  }

  // 4. referential integrity of the post-replay state, to a fixpoint (dropping one record can
  //    orphan another: a restored group's children, a restored shape's bindings).
  const exists = (id: unknown): boolean => {
    if (typeof id !== 'string') return false
    if (added[id]) return true
    if (removed[id]) return false
    return !!ctx.get(id)
  }
  const parentOf = (id: string): unknown => (updated[id]?.[1] ?? added[id] ?? ctx.get(id))?.parentId
  for (let guard = 0, changed = true; changed && guard < 50; guard++) {
    changed = false
    for (const rec of Object.values(added)) {
      const bad =
        (rec.typeName === 'shape' && !exists(rec.parentId)) ||
        (rec.typeName === 'binding' && (!exists(rec.fromId) || !exists(rec.toId)))
      if (bad) {
        delete added[rec.id]
        skip(rec, 'orphan')
        changed = true
      }
    }
    for (const [id, [current, next]] of Object.entries(updated)) {
      if (next.typeName === 'shape' && next.parentId !== current.parentId && !exists(next.parentId)) {
        const reverted = writePaths(next, current, SPATIAL) // keep it where it is now
        if (changedPaths(current, reverted).length) updated[id] = [current, reverted]
        else delete updated[id]
        skip(current, 'orphan', ['parentId'])
        changed = true
      } else if (next.typeName === 'binding' && (!exists(next.fromId) || !exists(next.toId))) {
        delete updated[id]
        skip(current, 'orphan')
        changed = true
      }
    }
    for (const [id, rec] of Object.entries(removed)) {
      if (rec.typeName !== 'shape') continue
      const stranded = ctx.childIds(id).filter((c) => exists(c) && parentOf(c) === id)
      if (stranded.length) {
        delete removed[id]
        skip(rec, 'has-foreign-children')
        changed = true
      }
    }
  }

  // 5. local page state must not point at shapes that will not exist
  const idFields = ['editingShapeId', 'croppingShapeId', 'focusedGroupId', 'hoveredShapeId'] as const
  const listFields = ['selectedShapeIds', 'hintingShapeIds', 'erasingShapeIds'] as const
  const clean = (ps: AnyRecord): AnyRecord => {
    let out = ps
    for (const f of listFields) {
      const list = ps[f]
      if (Array.isArray(list) && list.some((id) => !exists(id))) out = { ...out, [f]: list.filter(exists) }
    }
    for (const f of idFields) if (ps[f] != null && !exists(ps[f])) out = { ...out, [f]: null }
    return out
  }
  for (const [id, pair] of Object.entries(updated))
    if (pair[1].typeName === 'instance_page_state') updated[id] = [pair[0], clean(pair[1])]
  for (const [id, rec] of Object.entries(added))
    if (rec.typeName === 'instance_page_state') added[id] = clean(rec)

  const isDoc = (r: AnyRecord) => ctx.isDocumentType(r.typeName)
  const applied =
    Object.values(added).filter(isDoc).length +
    Object.values(removed).filter(isDoc).length +
    Object.values(updated).filter(([, n]) => isDoc(n)).length
  return {
    diff: { added, updated, removed } as unknown as RecordsDiff<TLRecord>,
    report: { applied, skipped, noop: applied === 0 && skipped.length > 0 },
  }
}

// ---------------------------------------------------------------- installation
/**
 * Installs per-property undo/redo on `editor`. Call once from <Tldraw onMount>; returns a disposer
 * (return it from onMount). Safe with native sync: only applyDiff calls made while the
 * HistoryManager is replaying are rewritten; the sync client's own applyDiff calls pass through.
 */
export function installPerPropUndo(editor: Editor, opts: PerPropUndoOptions = {}): () => void {
  const store = editor.store
  const docTypes = new Set(
    Object.values(store.schema.types)
      .filter((t) => t.scope === 'document')
      .map((t) => t.typeName as string),
  )

  // Which fields were last written by a remote change. Needed because a history entry squashes
  // [first from, last to] per record (HistoryManager PendingDiff -> squashRecordDiffsMutable): if a
  // remote edit lands between two of this user's writes to the same record inside ONE entry, the
  // entry's `to` contains the remote value and a plain 3-way check would revert it.
  const remote = new Map<string, Set<string>>()
  // Records deleted by a remote change. A replay must not re-create them (mergeReplayDiff step 3).
  const remoteDeleted = new Set<string>()
  const disposers: Array<() => void> = []
  for (const typeName of docTypes) {
    disposers.push(
      store.sideEffects.registerAfterDeleteHandler(typeName as TLRecord['typeName'], (rec, source) => {
        if (source === 'remote') remoteDeleted.add(rec.id)
        else remoteDeleted.delete(rec.id)
      }),
      store.sideEffects.registerAfterCreateHandler(typeName as TLRecord['typeName'], (rec) => {
        remoteDeleted.delete(rec.id)
      }),
    )
  }
  for (const typeName of opts.trackRemoteWrites === false ? [] : docTypes) {
    disposers.push(
      store.sideEffects.registerAfterChangeHandler(typeName as TLRecord['typeName'], (prev, next, source) => {
        if (source === 'user' && !remote.has(next.id)) return // hot path: local drag frames
        const paths = changedPaths(prev as unknown as AnyRecord, next as unknown as AnyRecord)
        if (source === 'remote') {
          let set = remote.get(next.id)
          if (!set) {
            set = new Set()
            remote.set(next.id, set)
          }
          for (const p of paths) set.add(p)
        } else {
          const set = remote.get(next.id)
          if (!set) return
          for (const p of paths) set.delete(p)
          if (!set.size) remote.delete(next.id)
        }
      }),
      store.sideEffects.registerAfterDeleteHandler(typeName as TLRecord['typeName'], (rec) => {
        remote.delete(rec.id)
      }),
    )
  }

  const gate = createReplayGate(editor, opts.gate ?? 'auto')
  const ctx: MergeContext = {
    get: (id) => store.get(id as TLRecord['id']) as AnyRecord | undefined,
    isDocumentType: (t) => docTypes.has(t),
    remoteFields: (id) => remote.get(id),
    deletedRemotely: (id) => remoteDeleted.has(id),
    childIds: (id) => (isShapeId(id) ? editor.getSortedChildIdsForParent(id) : []),
    isFieldLocked: opts.isFieldLocked as MergeContext['isFieldLocked'],
  }

  const original = store.applyDiff
  const patched: typeof store.applyDiff = function (this: unknown, diff, applyOpts) {
    if (!gate.isReplaying()) return original.call(store, diff, applyOpts)
    let merged: ReturnType<typeof mergeReplayDiff>
    try {
      merged = mergeReplayDiff(diff, ctx)
    } catch (e) {
      console.error('[per-prop-undo] merge failed; falling back to native replay', e)
      return original.call(store, diff, applyOpts)
    }
    const isolations = foreignArrowIsolations(editor, merged.diff)
    original.call(store, merged.diff, applyOpts)
    // ArrowBindingUtil.onBeforeIsolateFromShape skips its terminal update while replaying ("the history
    // diff already contains the arrow's correct state"), which is false for an arrow that is NOT in
    // this user's history (another user's arrow bound to a shape this replay removes). Do it here:
    // still inside the replay, so it is not recorded, but it syncs like any local write.
    for (const { arrowId, terminal, point } of isolations) {
      const arrow = editor.getShape<TLArrowShape>(arrowId)
      if (!arrow || editor.getBindingsFromShape(arrow, 'arrow').some((b) => b.props.terminal === terminal))
        continue
      editor.updateShape<TLArrowShape>({
        id: arrowId,
        type: 'arrow',
        props: { [terminal]: { x: point.x, y: point.y } },
      })
    }
    // Never run UI code inside HistoryManager._undo: it updates its stacks after applyDiff returns.
    if (merged.report.skipped.length && opts.onReplay) {
      const report = merged.report
      queueMicrotask(() => opts.onReplay?.(report))
    }
  }
  store.applyDiff = patched

  return () => {
    if (store.applyDiff === patched) store.applyDiff = original
    gate.dispose()
    for (const d of disposers) d()
    remote.clear()
    remoteDeleted.clear()
  }
}

/** Arrow bindings NOT in the replay diff whose target shape the replay removes, with the rendered terminal point. */
function foreignArrowIsolations(editor: Editor, diff: RecordsDiff<TLRecord>) {
  const out: Array<{ arrowId: TLShapeId; terminal: 'start' | 'end'; point: { x: number; y: number } }> = []
  for (const id of Object.keys(diff.removed)) {
    if (!isShapeId(id)) continue
    for (const b of editor.getBindingsToShape<TLArrowBinding>(id, 'arrow')) {
      if (Object.hasOwn(diff.removed, b.id) || Object.hasOwn(diff.removed, b.fromId)) continue
      const info = getArrowInfo(editor, b.fromId)
      const p = info?.[b.props.terminal]?.point
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y))
        out.push({ arrowId: b.fromId, terminal: b.props.terminal, point: { x: p.x, y: p.y } })
    }
  }
  return out
}

/**
 * True exactly while HistoryManager is inside _undo()/redo() (which covers undo, redo, bail and
 * bailToMark). Prefers the editor's own flag, `Editor.isReplayingHistory()` (Editor.ts:1645;
 * @internal, but tldraw's ArrowBindingUtil relies on it too); falls back to wrapping the public
 * undo/redo/bail/bailToMark methods if a future version drops it.
 */
function createReplayGate(editor: Editor, mode: 'auto' | 'public-methods') {
  const internal = (editor as unknown as { isReplayingHistory?: () => boolean }).isReplayingHistory
  if (mode === 'auto' && typeof internal === 'function') {
    return { isReplaying: () => internal.call(editor), dispose() {} }
  }
  let depth = 0
  const names = ['undo', 'redo', 'bail', 'bailToMark'] as const
  type Method = (...args: unknown[]) => unknown
  const target = editor as unknown as Record<(typeof names)[number], Method>
  const originals = names.map((n) => [n, target[n]] as const)
  for (const [n, fn] of originals) {
    target[n] = function (this: unknown, ...args: unknown[]) {
      depth++
      try {
        return fn.apply(editor, args)
      } finally {
        depth--
      }
    }
  }
  return {
    isReplaying: () => depth > 0,
    dispose() {
      for (const [n, fn] of originals) target[n] = fn
    },
  }
}
