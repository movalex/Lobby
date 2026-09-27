# Per-property undo on native sync (spike WRK-05)

Date: 2026-09-26/27. Engine: **tldraw 5.4.2**, `@tldraw/sync` / `@tldraw/sync-core` 5.4.2, React 19.3.0, Vite 8.3.1, TypeScript 7.0.2, Node 24.19.0. Browsers: branded Chrome driven by `playwright-core` 1.63.0 (`channel: 'chrome'`, headless).

**Problem.** The repo's e2e test `DOCUMENTED LIMITATION (SYNTHESIS §8): undo after a remote edit also reverts the other user's prop on that shape` (`e2e/tests/conflicts.spec.ts`) pins native behavior:
- A's undo of a move also reverts B's later recolor.
- A's undo can bring back a shape that B deleted.

**Goal (Miro behavior).** Undo reverses only your own changes. It never brings back something another user deleted; instead it skips that part and shows a small notice.

Tags:
- **[src]**: read in the 5.4.2 package `src/`. Paths are relative to `node_modules/<pkg>/src/`.
- **[run]**: observed in this spike's two-browser runs against a real `TLSocketRoom`.
- **UNVERIFIED**: not demonstrated here.

---

## TL;DR

- **Recommendation: adopt it.** Add one client-only module, `installPerPropUndo(editor)`, and call it from `<Tldraw onMount>`. There are no server, schema or protocol changes. **Adopted (2026-09-27):** `apps/web/src/sync-quality/perPropUndo.ts`, wired in `BoardPage.tsx`; browser proof in e2e/tests/conflicts.spec.ts (the seven "WRK-05" tests; the old "documented limitation" test is inverted). One engine issue found afterwards is in §8.
- **How it works.** It wraps `editor.store.applyDiff` and acts only while the `HistoryManager` is replaying (undo, redo, bail, bailToMark). During a replay it rewrites the record-level diff into a **per-field 3-way patch** against the current store:
  - A field is reverted only if this entry changed it, **and** its current value is still what the entry left, **and** its last write was not a remote one.
  - A record that someone else deleted is never re-created.
  - Parents and binding endpoints must exist after the replay.

  The `HistoryManager` itself (stacks, marks, squashing, redo) is untouched.
- **Is there a supported hook in 5.4.2? No** (§2). The least fragile interception is the public `Store.applyDiff`, patched on the store instance. It is gated by `editor.isReplayingHistory()`, which is `@internal` but used by tldraw's own `ArrowBindingUtil`. If that method ever disappears, the module falls back to wrapping the public `undo/redo/bail/bailToMark`; the fallback was verified too.
- **Verified [run]:**
  - All five requested scenarios, plus bail (Escape mid-drag), offline undo, arrows/bindings, group/ungroup and frames.
  - Two real Chrome clients plus the server's stored records, compared record for record.
  - Totals: **285 of 287 browser checks pass and 14/14 unit checks pass.** The 2 failures are baseline-mode checks that deliberately reproduce **native** defects (§7), which this module fixes.
  - With no concurrent edits, every undo and redo step lands on exactly the same state as native tldraw, over a 10-step history (§5, S3).
- **Two things a naive 3-way patch gets wrong. Both were found and fixed here:**
  1. **A remote edit inside one of your history entries.** For example, B recolors while A is still dragging. The entry then squashes B's value into its `to`, and a plain 3-way check reverts B's color. The fix is a per-field "last write was remote" tracker (S6).
  2. **Redo of your own create after B deleted the shape.** The undo was a no-op, but the redo re-created the shape. The fix is a "deleted remotely" set (S2).
- **Cost.** A 1000-shape undo took a median of **10.7 to 11.9 ms, against 7.6 to 8.4 ms native** (3 runs, this workstation).

---

## 1. Why native undo reverts other people's edits [src]

| Fact | Where |
|---|---|
| History records only `source === 'user'` changes, squashed per entry into `[first from, last to]` per record. | `@tldraw/editor editor/managers/HistoryManager/HistoryManager.ts:45-65` (interceptor), `:366-367` (`squashRecordDiffsMutable`); `@tldraw/store lib/RecordsDiff.ts:312` (`existing[1] = to`) |
| Undo builds `reverseRecordsDiff` (updated pairs become `[to, from]`) and applies it with `this.store.applyDiff(diffToUndo, { ignoreEphemeralKeys: true })`. | `HistoryManager.ts:128-202`, **`:193`**; `RecordsDiff.ts:80-92` |
| Redo applies the forward diff the same way. | `HistoryManager.ts:210-252`, **`:243`** |
| `bail()` and `bailToMark()` (tool cancel, e.g. Escape mid-drag) go through the same `_undo`. | `HistoryManager.ts:254-266`; `Editor.ts:1678, 1695` |
| `Store.applyDiff` **puts the whole target record** for every updated pair (only ephemeral keys, which shapes do not have, are merged). A `put` of a missing id **creates** it. | `@tldraw/store lib/Store.ts:1055-1102`, `put` `:605` |
| The sync client pushes local `'user'` changes as a field diff of old versus new. So the whole-record write goes out as "every field that differs from now", which includes other users' newer values. | `@tldraw/sync-core lib/TLSyncClient.ts:572-579` |

So the diff that `applyDiff` receives during a replay is exactly the information needed. `updated[id] = [expectedCurrent, target]` holds for undo and redo alike. Rewriting that diff is the smallest possible change.

---

## 2. Extension points in 5.4.2, evaluated [src]

| Candidate | Verdict |
|---|---|
| Custom `HistoryManager` or history option | **None.** `Editor` constructs it directly (`Editor.ts:381`) and holds it as `protected readonly history` (`:1538`). Replacing it would also require disposing its store interceptor. That is invasive, so it was rejected. |
| An `onBeforeUndo` or undo event | **None.** The UI actions `undo`/`redo` just call `editor.undo()`/`editor.redo()` (`tldraw lib/ui/context/actions.tsx:210, 220`). `editor.undo()` calls `history.undo()` (`Editor.ts:1550-1558`). |
| `history: 'ignore'` / `'record-preserveRedoStack'` (`editor.run`, `Editor.ts:1728`) | These control **recording**, not replay. Irrelevant. |
| `markHistoryStoppingPoint` / `squashToMark` (`Editor.ts:1627, 1663`) | These shape the entries only. The squash is actually what causes the conflation case (S6). |
| `store.sideEffects` before-handlers (public; `StoreSideEffects.ts:477`, …) | Only partial. `beforeChange` can rewrite `next`, but it does not know the entry's `to`. `beforeCreate` **cannot veto** a create (it must return a record), so it cannot stop a resurrection. |
| `store.sideEffects` **after**-handlers with `source` (public; `:509, 576, 643`) | **Used** for the two trackers (§3). They are synchronous, and `source` is `'remote'` for the sync client's `mergeRemoteChanges` (`Store.ts:1025`, `flushAtomicCallbacks :1187-1219`). |
| `store.listen(fn, { source })` | This is flushed on the next frame by the history reactor, so it is asynchronous and could miss a remote write that lands just before Ctrl+Z. Not used. |
| `store.addHistoryInterceptor` | `@internal` (excluded from `@tldraw/store dist-esm/index.d.mts:1834`). Not needed. |
| **`Store.applyDiff`**, wrapped on the store instance | **Chosen.** It is a public method (`@tldraw/store dist-esm/index.d.mts:1802`), and it is the single call through which every replay writes. |
| Gate: `editor.isReplayingHistory()` | Runtime `Editor.ts:1645`; `@internal` (`@tldraw/editor dist-esm/index.d.mts:1606`, "Excluded from this release type"). It is true exactly inside `_undo`/`redo`, and tldraw's own `ArrowBindingUtil` depends on it (`tldraw lib/bindings/arrow/ArrowBindingUtil.ts:95, 116`). Fallback: count calls through instance wrappers of the public `undo/redo/bail/bailToMark`. Verified in S1/S2 with `gate=public`. |

The gate matters. `TLSyncClient` also calls `store.applyDiff` (for rebase and remote patches: `TLSyncClient.ts:953, 970`, inside `mergeRemoteChanges`). Those calls must pass through untouched, and they do because they never happen during a replay. Replays are synchronous, and the sync client only reacts to socket messages.

---

## 3. The algorithm

For each replay, `mergeReplayDiff(diff, ctx)` works at the **same granularity as the sync wire**: top-level fields plus first-level `props.*` and `meta.*` keys (`sync-core lib/diff.ts:185-236`; see [conflict-semantics.md](conflict-semantics.md) §1). The steps are:

1. **Removed** (undo of your own create, redo of your own delete): remove the record if it still exists.
2. **Updated** (only document-scoped types; session records like selection or camera keep native behavior):
   - The record is missing: **skip** it with `deleted`. It is never resurrected.
   - For each field the entry changed (`expected[p] ≠ target[p]`), revert it only if `current[p] = expected[p]` **and** the field's last write was not remote. Otherwise skip it with `changed`.
   - **Spatial unit.** `x`, `y`, `rotation` and `index` are relative to `parentId`. If the entry changed `parentId`, the unit is reverted together or not at all. If the parent is still the entry's parent, `parentId` is reverted with every spatial field the entry changed, even ones someone moved since. Otherwise all of them are skipped.
3. **Added** (undo of your own delete, redo of your own create):
   - Skip if the id exists again (`exists`).
   - Skip if a **remote change deleted it** (`deleted`). Without this check, "redo create" re-creates a shape that B deleted (S2).
4. **Referential integrity, iterated to a fixpoint:**
   - A re-added shape needs its parent, and a re-added or updated binding needs both endpoints. Otherwise the record is skipped as `orphan`, and a dropped group cascades to its children and their bindings.
   - A shape whose reverted `parentId` would point at a missing record keeps its current spatial fields.
   - A removed container that another user has since put shapes into is kept (`has-foreign-children`).
5. The local `instance_page_state` never selects, edits or hovers shapes that will not exist.
6. **Foreign arrows.** An arrow **not** in this history whose bound shape the replay removes gets its terminal set to the point where it is currently drawn (via the public `getArrowInfo`). tldraw skips this on replay (`ArrowBindingUtil.ts:111-124`), which causes the divergence in §7.
7. **Optional `isFieldLocked(record, path)`.** The web app returns true for `props.richText` of a shape that a collaborator's presence says they are editing (§6).

Two trackers are fed by public `sideEffects` after-handlers, which receive `source` synchronously:
- **Remote-written fields.** Per record, the set of fields whose latest write was `'remote'`. A local write clears the field again.
- **Remotely deleted records.** Set by an `afterDelete` with source `'remote'` and cleared on any create.

`onReplay(report)` receives `{ applied, skipped[{id, typeName, reason, paths?}], noop }`. It is called in a **microtask**: `HistoryManager` updates its stacks after `applyDiff` returns (`HistoryManager.ts:195`), so no UI code may run inside the replay.

---

## 4. Code the web app should adopt

### 4.1 `apps/web/src/board/per-prop-undo.ts`

This is the verified module, reproduced exactly as tested. It imports only from `tldraw`, so no new dependency is needed. It typechecks under TS 7.0.2 with `strict`, `verbatimModuleSyntax` and `skipLibCheck`.

`gate` and `trackRemoteWrites` are test hooks used by the spike. Their defaults are the recommended behavior, and they can be removed.

```ts
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
        if (!isEqual(av[sk], bv[sk]) || Object.hasOwn(av, sk) !== Object.hasOwn(bv, sk)) out.push(`${k}.${sk}`)
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
          if (!set) remote.set(next.id, (set = new Set()))
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
      if (!arrow || editor.getBindingsFromShape(arrow, 'arrow').some((b) => b.props.terminal === terminal)) continue
      editor.updateShape<TLArrowShape>({ id: arrowId, type: 'arrow', props: { [terminal]: { x: point.x, y: point.y } } })
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
  const target = editor as unknown as Record<string, (...args: unknown[]) => unknown>
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
```

### 4.2 Wiring in `apps/web/src/board/BoardPage.tsx`

The wiring goes into the existing `onMount`. `notify` from `useNotices()` is a stable `useCallback`. The presence meta `editingShapeId` already exists (`board/presence.ts` `getDraftroomPresence`).

```tsx
import { installPerPropUndo, type UndoReplayReport } from './per-prop-undo.ts'

function undoNotice(r: UndoReplayReport): string | null {
  const gone = r.skipped.filter((s) => s.reason === 'deleted' || s.reason === 'orphan').length
  if (gone) return gone === 1 ? 'Someone deleted that object, so it was not restored.' : `Someone deleted ${gone} of those objects, so they were not restored.`
  if (r.skipped.some((s) => s.reason === 'locked')) return 'Someone is editing that text, so it was left as is.'
  if (r.noop) return 'Someone changed this since, so there was nothing left to undo.'
  return null // partial skips of fields someone else changed are silent
}

const onMount = useCallback<TLOnMountHandler>((ed) => {
  editorRef.current = ed
  setEditor(ed)
  if (DEV_AUTH_ENABLED) window.editor = ed
  const uninstallUndo = installPerPropUndo(ed, {
    onReplay: (report) => {
      const text = undoNotice(report)
      if (text) notify({ key: 'undo-skip', text, testId: 'undo-notice' })
    },
    // The server lease vetoes the WHOLE record op (lease.ts), so an undo that reverts text a
    // collaborator is typing in would also lose its move/resize. Leave that text alone instead.
    isFieldLocked: (rec, path) =>
      path === 'props.richText' && ed.getCollaborators().some((c) => c.meta?.editingShapeId === rec.id),
  })
  return () => {
    uninstallUndo()
    editorRef.current = null
    setEditor(null)
    if (window.editor === ed) window.editor = undefined
  }
}, [notify])
```

Install exactly once per editor. A second install wraps the first. That is harmless but does the work twice.

### 4.3 Tests to add or flip

- **Unit (vitest, web project).** Port `test/unit.mjs` from the scratch harness (Appendix). It contains 14 cases of the pure `mergeReplayDiff`: per-field revert, changed-by-other, deleted, the conflation guard, both spatial-unit rules, the orphan cascade, binding re-add and update guards, has-foreign-children, undo-group, deleted-remotely re-add, the lock hook, and selection cleanup. Importing `tldraw` under Node works; the harness needed a `process.exit`.
- **e2e `conflicts.spec.ts`.** Turn the `DOCUMENTED LIMITATION … undo after a remote edit` test into a pass. After Ctrl+Z, assert `{ x: 100, color: 'red' }` for A, B and a fresh context.
- **New e2e tests:**
  - "A moves X, B deletes X, A undoes: X stays deleted, `undo-notice` shown."
  - The conflation case: B recolors while A's pointer is still down (S6). This is the best upgrade canary, because it fails if either tracker or gate silently stops working.

---

## 5. Verified outcomes [run]

**Setup.**
- A standalone Vite app plus a local `TLSocketRoom` in scratch. The server wiring was copied from `apps/sync/src/{rooms.ts,app.ts,lease.ts}`: SQLite storage, the socket wrapper without `addEventListener`, and the implicit text lease with a 4 s lease.
- Two Chrome contexts ("alice" and "bob") on one room.
- "Server" means `room.getCurrentSnapshot()` read over HTTP.
- Convergence means the shapes, bindings and pages of A, B and the server are JSON-identical.

**Modes.**
- **per-prop**: the module installed.
- **native**: the same app with `?perprop=0`.

Keyboard undo and redo (Ctrl+Z, Ctrl+Shift+Z through tldraw's `undo`/`redo` actions) were used in most steps. Final full run: `unit` 14/14, `s12` 53/53, `s3` 57/57, `s4` 38/38 (run 3×), `s56` 45/45, `s78` 72/74, `s9` 20/20.

| # | Scenario | per-prop (A, B and server agree unless noted) | native |
|---|---|---|---|
| **S1** | A moves X (x 100→400), B recolors it red, A presses Ctrl+Z | **x=100, red.** A's push was `{"shape:x":["patch",{"x":["put",100]}]}`. Redo gives x=400, red. | x=100, **black**; the push also carried `props.color: black` |
| S1′ | The same, with the public-method fallback gate | Identical to S1 | n/a |
| **S2** | A moves X, B deletes X, A undoes | **X stays deleted.** Report `{applied:0, skipped:[{reason:'deleted'}], noop:true}`, and the notice is shown. A further undo, redo and redo keep X deleted (this path needed the remote-delete set, see TL;DR). A still edits normally, with no page errors. | **X resurrected** on A, B and the server |
| **S3** | A alone, with B watching: create 3 geos, **UI drag-move**, resize, **arrow tool drag** G1→G2 (2 bindings), **drag the arrow end handle** to G3, note, **type in the note**, group, ungroup, delete G1 (the arrow start is bound). Then undo 10 steps and redo 10 steps. | **Every undo and redo lands exactly on the recorded state**, including restoring A's own deleted G1 and its binding. Step counts are **identical to native**, no skips are reported, A, B and the server converge, and integrity is OK. | Same states and counts |
| **S4a** | A types "hello" in a note (real TipTap typing, Escape), B moves it to x=600, A presses Ctrl+Z | **Text reverts to empty, x stays 600.** The push was only `props.richText` and `props.textLastEditedBy`, and it committed because A holds or retakes the text lease. Redo gives "hello" at x=600. | Text empty **and x=100** |
| **S4b** | Lease race (§6): A's entry changed the text and x. B is editing and typing, and B's keystroke has reached the server (B holds the lease) but not A. A undoes. | **With the lock hook:** x reverted to 100, B's text kept, no denial, report `locked: props.richText`, notice shown. **Without the hook:** A's whole op is **vetoed** (x stays 400), and A gets `text-lease-denied`. | Vetoed, as without the hook |
| **S5a** | A moves X, A undoes, B recolors, A redoes | x=400, **red** | x=400, black |
| **S5b** | A moves X, A undoes, B moves X to 700, A redoes | **x stays 700** (report: `changed: x`, noop) | x=400 (B's move overwritten) |
| **S5c** | A moves X, A undoes, B deletes X, A redoes | **Stays deleted**, notice shown | **Resurrected** |
| **S5d** | A deletes X (own), then undo, redo, undo | Restored, deleted, restored, everywhere | Same |
| **S6** | **Conflation:** A drags X with the mouse; B recolors X while A's pointer is still down; A keeps dragging, releases, and presses Ctrl+Z. A's pending entry recorded color `black→red` (this was checked). | **x=100, red** | x=100, black. **Per-prop with the tracker off gives the same black**, which proves the tracker is required. |
| **S7a** | A drew arrow G1→G2 (UI), A deletes G2, B deletes the arrow, A undoes | G2 restored. The arrow is **not** resurrected (`deleted`), and its binding is skipped (`orphan`). Integrity OK. | The arrow B deleted is **resurrected** |
| **S7b** | A rebinds the arrow end G2→G3 by dragging the handle (tldraw records this as remove plus add of a binding, with a new id), B deletes G2, A undoes | End left unbound, start still on G1, no dangling binding | Same final state. This is consistent with tldraw's `arrowDidUpdate`, which unbinds an end whose target is missing (`ArrowBindingUtil.ts:280-292`; inferred from source). |
| **S7c** | B's arrow is bound to A's new shape S, A undoes creating S | S removed. B's arrow is unbound and **converged**, because of the foreign-arrow step. | **Diverged:** A and B show the arrow end at (277.2, −95.1), but the server stores (262.5, −90). See §7. |
| **S8a** | A groups G1 and G2, B moves G1 inside the group, A undoes the group | Group removed, G1 and G2 back on the page at their pre-group positions. **B's move inside the group is overwritten** (spatial unit, §8). | Same |
| **S8b** | A groups, B deletes G2 (tldraw dissolves the 1-child group on B), A undoes | G2 stays deleted, G1 on the page | **G2 resurrected** |
| **S8c** | A creates frame F, B moves G3 into F, A undoes | **F kept** (`has-foreign-children`), no orphan | F removed and **G3 orphaned** on the server (`parentId shape:f missing`) |
| **S8d** | A groups, then ungroups, B deletes G1, A undoes the ungroup | Group re-created with G2, G1 stays deleted, integrity OK | Group re-created and **G1 resurrected** |
| **S9a** | Escape mid-drag (`bailToMark`) after B recolored | X back, **red kept** | Red reverted |
| **S9b** | Escape mid-drag after B deleted X | Not resurrected | **Resurrected** |
| **S9c** | A undoes while offline, and B recolored meanwhile | x=100, red | **The same.** A never saw the recolor, so even the whole-record write changes only `x` in A's store, and reconnect re-sends changed fields only. |
| **S9d** | One undo moving 1000 shapes (median of 5, 3 runs) | 10.7 / 11.3 / 11.9 ms | 8.0 / 7.6 / 8.4 ms |

Page errors: none in any scenario. The offline run logs the expected `ERR_INTERNET_DISCONNECTED`, which was filtered.

---

## 6. Interaction with the server text lease (`authorizeRecord`)

- **Normal case (S4a).** A undoes their own typing. A either still holds the lease or takes it again, because the lease is implicit and renewed on any accepted text change by the same user. The push commits.
- **B changed the text after A.** Per-prop never pushes a text revert, because `current ≠ expected` (reason `changed`). So in steady state the lease is never involved.
- **The remaining window is a race (S4b).** B's keystroke has reached the server and B holds the lease, but A has not yet received it. A's undo then pushes a text revert, and `lease.ts` vetoes the **whole record op**. That drops the non-text part of the undo too, which is the documented limitation in `text-lease.test.ts`. A gets `discard` plus `text-lease-denied`, and the history entry is still consumed.
- **The lock hook closes most of that window.** B's presence (`meta.editingShapeId`) arrives when B *enters* edit mode, before the first keystroke. So A skips `props.richText` and reverts the rest. The hook is a client hint; the server lease remains the enforcement.
- Server changes: **none needed.**

---

## 7. Arrows, bindings, groups, frames

- **No dangling references.** The server integrity check (every binding's `fromId`/`toId` exists, and every shape's `parentId` exists) passed in every per-prop scenario.
- **Two native defects found, both independent of this change (reproduced in native mode):**
  1. **Undo that removes a shape bound by another user's arrow diverges the arrow** (S7c).
     - `ArrowBindingUtil.onBeforeIsolateFromShape` returns early while replaying (`ArrowBindingUtil.ts:113-116`: "the history diff already contains the arrow's correct state"). For an arrow outside the undoing user's history that is false.
     - So the undoing client never writes the new terminal. The other clients do compute it locally, but inside `mergeRemoteChanges` (a `before*` handler with `source: 'remote'`), so it is never pushed.
     - Result: both clients agree with each other and disagree with the server. A reload would show the arrow end jump.
     - A plain delete (no undo) converges, because the deleting client computes and pushes the terminal [run].
     - The module's step 6 fixes this. **The mechanism is inferred from source plus these observations.** The server kept the pre-undo value, so no client pushed the new terminal; the undo-case push log itself was not inspected.
  2. **Undo of creating a frame after someone moved a shape into it orphans that shape on the server** (S8c).
     - `Store.applyDiff` → `remove` does not cascade, and nothing reparents the child.
     - Step 4's `has-foreign-children` fixes it.
- **Probed, not observed.** The worry was that remote changes make the local editor write records (Editor side effects are not source-gated, `Editor.ts:645-900`; later side-effect rounds are attributed `'user'`, `Store.ts:1215-1216`), so those writes would land in the local undo entry.
  - Probe: B deletes one child of a two-child group.
  - Result: B's own client dissolved the group and pushed the result in the same diff, so A had nothing left to write. A's pending entry stayed empty.
  - This is possible in principle for other side effects. **UNVERIFIED** in general.

---

## 8. Risks and what can still go wrong

**Upgrade fragility.** Each assumption, and what happens if it breaks:

| Assumption | Where | If it breaks |
|---|---|---|
| Replays write through `store.applyDiff` with `updated = [expected, target]` | `HistoryManager.ts:193, 243` | The patch silently stops applying, and behavior reverts to native. The S1/S6 e2e canaries catch it. |
| `editor.isReplayingHistory()` exists (`@internal`) | `Editor.ts:1645` | Automatic fallback to the public-method gate (verified). |
| `store.applyDiff` is an overridable prototype method; the sync client calls it only outside replays | `Store.ts:1055`; `TLSyncClient.ts:953, 970` | A synchronous rebase during a replay would be rewritten. Not possible in 5.4.2. |
| After-handlers receive `source: 'remote'` for sync-applied changes | `Store.ts:1187-1219` | The trackers go blind. Conflation (S6) and redo-resurrection (S2) regress; the canaries catch it. |
| The arrow replay skip | `ArrowBindingUtil.ts:116` | If tldraw fixes it upstream, step 6 becomes a redundant but harmless second write of the same value. |

Pin the tldraw version and re-run the e2e canaries on every bump.

**Found after adoption (validation phase, 2026-09-27) [run]: a sync rebase can wipe the redo stack.** Undo a creation, redo it quickly, and let the server's commit of the delete arrive after the redo: `TLSyncClient.rebase` removes and re-adds the shape inside one `mergeRemoteChanges`. The Editor's before-delete handler has noted the removal, so its operation-complete `cleanupInstancePageState` drops the (still existing) shape from the selection. That cleanup runs after the remote merge, is recorded as a `user` change, and recording a new change clears the redo stack: the next Ctrl+Shift+Z does nothing. The mechanism is in the engine (sync client + Editor), not in this module; a control run with native undo was not done. Workaround in `apps/web/src/sync-quality/rebaseGuard.ts` (installed in `onMount`): keep page-state references to shapes that were deleted during the current remote merge and exist again when the cleanup runs. It relies on `store.mergeRemoteChanges` being overridable per instance and on 5.4.2's cleanup order; the canary is e2e/tests/conflicts.spec.ts "WRK-05: redo keeps working when the server confirms an undone creation only after the redo" (deterministic: incoming frames are held with `page.routeWebSocket`). Worth reporting upstream.

**Semantic choices to confirm with product:**
- **Spatial unit.** If your undo moves a shape back to its old parent, it also restores x/y/rotation/index, even if someone moved the shape since (S8a: undoing a group overwrote B's move inside it). The alternative is to preserve the current page transform. That is possible via `editor.getShapePageTransform`, but it would not undo *your own* drag into a frame. **UNVERIFIED.**
- **Undo of your own create still removes the object** when others edited it since (for example, B typed into your note). It is kept only if others put **children** into it. An alternative policy would skip it when any field's last write was remote; that is a one-line change and **UNVERIFIED**.
- **A skipped step still consumes its history entry.** This is native bookkeeping. The next Ctrl+Z moves on, and there is no auto-advance past no-op steps.
- **Silent partial skips.** When another user changed the *same* field, it is left alone and no notice is shown. Only deletions, orphans, locks and complete no-ops notify.

**Remaining conflicts (not solved here):**
- **Same field, crossing in flight.** If A's undo and B's edit of the *same* field cross before either sees the other, the server's arrival order wins, as for any edit (conflict-semantics §1.3).
- **Coupled props inside one record** can mix. Examples: arrow `start/end/bend` against its bindings; text `w/autoSize/richText`; note `growY`; the `segments/points` of draw and line shapes; file-card `status/posterDerivativeId`. Each prop is a whole value, so every mix is schema-valid, but it may look odd. Only geo, note, arrow, group and frame were exercised; **the others are UNVERIFIED.**
- **Echo writes.** Peers' side effects can write fields the undoing user wrote (for example arrow reparenting). Those fields then count as "remote", so undo skips them. That is conservative, not destructive.

**Other:**
- **In-edit Ctrl+Z is TipTap's own history**, not tldraw's. TipTap's StarterKit keeps undo/redo, and tldraw shortcuts are off while a text input has focus. This module does not change it, and it was not tested concurrently. **UNVERIFIED.**
- **Memory.** The remote-field map grows with the records others change and is freed when they are deleted. It is per tab and lost on reload, as is the undo stack itself.
- **Custom binding types** are covered only by the generic endpoint guard. The terminal fix-up is arrow-specific, and it sets the terminal but not the arc `bend`. Only straight arrows were tested.

---

## 9. UNVERIFIED

- Real network latency and jitter; everything here ran on localhost.
- Multi-page boards (undo across a page another user deleted). The editor's own `instance.afterChange` guard exists for `currentPageId` (`Editor.ts:820-840`); it was not tested.
- Paste, duplicate, align/distribute, rotate, crop, image/file-card and draw-shape undo under concurrency. They take the same code path, but each was not tested individually.
- `wipe_all` reconnect or a schema migration landing between an edit and its undo.
- Firefox and Safari; mobile or coarse pointers.
- The policy alternatives in §8: transform-preserving reparent, and keeping a created object that others edited.
- Whether remote-triggered local side-effect writes can end up in a user's undo entry in cases other than the one probed (§7).

---

## Appendix — scratch harness (reproducible)

Location: `C:/Users/Chase/AppData/Local/Temp/claude/C--Users-Chase-Documents-GitHub-Draftroom/3dc84691-7141-4bcc-93bd-450e201c602f/scratchpad/spikes/per-prop-undo/`

- `package.json`: exact pins `tldraw`, `@tldraw/{sync,sync-core,tlschema,store,editor}` 5.4.2, `react`/`react-dom` 19.3.0, `vite` 8.3.1, `@vitejs/plugin-react` 6.1.1, `typescript` 7.0.2, `ws` 8.21.3, `playwright-core` 1.63.0. There is one copy of each `@tldraw/*`.
- `server.mjs`: `TLSocketRoom` on port 5961, with `/records/:room`, `/log/:room` (pushes and `push_result`) and `/leases/:room`. Lease length comes from `TEXT_LEASE_MS`.
- `src/perPropUndo.ts`: the module from §4.1. `src/App.tsx`: `useSync` wiring like `BoardPage.tsx`, with the toggles `?perprop=0`, `?gate=public`, `?tracker=0` and `?lockhook=0`.
- `test/lib.mjs`: two-context helpers, a WebSocket relay that can hold server→client frames (`page.routeWebSocket`), and convergence and integrity checks.
- Scenario scripts:
  - `test/unit.mjs`: the pure merge.
  - `test/s12.mjs`: S1, S2.
  - `test/s3.mjs`: A's own multi-step history.
  - `test/s4.mjs`: text and the lease.
  - `test/s56.mjs`: redo and conflation.
  - `test/s78.mjs`: arrows, groups, frames.
  - `test/s9.mjs`: bail, offline, cost.
- `results-*.txt`: the final run's output.

Run it:

```bash
export PATH="/c/Program Files/nodejs:/c/Users/Chase/AppData/Roaming/npm:$PATH"
npm install && npx tsc -p .
TEXT_LEASE_MS=4000 node server.mjs &   # port 5961
npx vite --port 5960 --strictPort --host 127.0.0.1 &
for s in unit s12 s3 s4 s56 s78 s9; do node test/$s.mjs; done
```

In `s78`, the two baseline-mode failures are the native defects of §7, reproduced on purpose.

**Follow-ups for the owners of other docs** (this spike did not edit them): SYNTHESIS §8 ("Undo after a remote edit"), SYNTHESIS §10 risk 3, and FEASIBILITY condition 3 should point here once the module is adopted and the e2e limitation test is flipped.
