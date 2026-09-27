/**
 * Guards undo/redo against a tldraw 5.4.2 + native sync interaction that wipes the redo stack.
 *
 * TLSyncClient.rebase runs inside `store.mergeRemoteChanges`: it undoes this tab's speculative
 * changes, applies what the server confirmed, then re-applies the pushes still in flight
 * (@tldraw/sync-core TLSyncClient.ts `rebase`). If the server confirms a DELETE of ours while a later
 * push of ours RE-CREATES the same shape (undo a creation, then redo it, before the first ack has been
 * applied), the shape is removed and put back inside one operation. The Editor's before-delete
 * handler has already noted it as deleted, so its operation-complete cleanup drops it from the
 * selection although it exists (@tldraw/editor Editor.ts `cleanupInstancePageState`). That cleanup
 * runs after the remote merge, so the store attributes it to 'user' (Store.ts flushAtomicCallbacks:
 * "later rounds are attributed to 'user'"), the HistoryManager records it, and recording a new change
 * clears the redo stack: the next Ctrl+Shift+Z does nothing. Seen in e2e (conflicts.spec.ts, own
 * history undo/redo), in 1 of 3 to 4 of 4 runs depending on timing.
 *
 * The guard keeps a page state's references to shapes that were deleted during the current remote
 * merge and exist again when the cleanup runs. Nothing else is touched: a shape that is really gone
 * is still dropped, and selection changes outside remote merges pass through unchanged.
 */
import type { Editor, TLInstancePageState, TLRecord, TLShapeId, TLStore } from 'tldraw'

type PageState = TLInstancePageState
const LIST_FIELDS = ['selectedShapeIds', 'hintingShapeIds', 'erasingShapeIds'] as const
const ID_FIELDS = ['hoveredShapeId', 'editingShapeId', 'croppingShapeId', 'focusedGroupId'] as const

/** `next` with every reference `prev` had to a wrongly-dropped shape put back (or `prev` if equal). */
export function restoreDroppedRefs(
  prev: PageState,
  next: PageState,
  wronglyDropped: (id: TLShapeId) => boolean,
): PageState {
  let out: PageState | null = null
  for (const f of LIST_FIELDS) {
    const before = prev[f]
    const after = next[f]
    if (before === after) continue
    const lost = before.filter((id) => !after.includes(id) && wronglyDropped(id))
    if (!lost.length) continue
    // Previous order for what was kept or restored, then anything the change added.
    const kept = before.filter((id) => after.includes(id) || lost.includes(id))
    const added = after.filter((id) => !before.includes(id))
    out ??= { ...next }
    out[f] = [...kept, ...added]
  }
  for (const f of ID_FIELDS) {
    const before = prev[f]
    if (before && next[f] === null && wronglyDropped(before)) {
      out ??= { ...next }
      out = { ...out, [f]: before }
    }
  }
  if (!out) return next
  const same = (Object.keys(prev) as (keyof PageState)[]).every(
    (k) => JSON.stringify(prev[k]) === JSON.stringify(out?.[k]),
  )
  return same ? prev : out
}

/** Installs the guard on `editor`'s store. Returns the disposer. */
export function installRebaseSelectionGuard(editor: Editor): () => void {
  return guardStore(editor.store)
}

export function guardStore(store: TLStore): () => void {
  let merging = 0
  const deletedDuringMerge = new Set<string>()
  const original = store.mergeRemoteChanges
  const patched: typeof store.mergeRemoteChanges = (fn) => {
    merging++
    try {
      // The Editor's cleanup runs in this call's flush, so the flag covers it.
      return original.call(store, fn)
    } finally {
      merging--
      if (merging === 0) deletedDuringMerge.clear()
    }
  }
  store.mergeRemoteChanges = patched

  const offDelete = store.sideEffects.registerBeforeDeleteHandler('shape', (shape) => {
    if (merging) deletedDuringMerge.add(shape.id)
  })
  const offChange = store.sideEffects.registerBeforeChangeHandler('instance_page_state', (prev, next) => {
    if (!merging || deletedDuringMerge.size === 0) return next
    return restoreDroppedRefs(
      prev,
      next,
      (id) => deletedDuringMerge.has(id) && store.has(id as TLRecord['id']),
    )
  })

  return () => {
    if (store.mergeRemoteChanges === patched) store.mergeRemoteChanges = original
    offDelete()
    offChange()
    deletedDuringMerge.clear()
  }
}
