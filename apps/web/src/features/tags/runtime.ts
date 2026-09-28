// Tags on an editor: reactive reads (the board's list, the rows with counts, the selection) and the
// writes, each one undo step. Writes put whole records (shapes and the document), because removing a
// meta key is not something a partial update (Editor.updateShapes merges meta) can express.
//
// Who may write: whoever may edit the canvas. The sync server makes viewer and commenter sessions
// read-only and skips their writes, which is the enforcement; `editor.getIsReadonly()` only keeps the UI
// from trying. Name-only guests follow their board role like everyone else: tags are canvas content,
// exactly like the text on the notes they may already edit.

import { parseBoardTags, type TagColor, type TagDef } from '@draftroom/contracts'
import { type Atom, atom, type Computed, computed, type Editor, type TLRecord, type TLShape } from 'tldraw'
import type { FeatureContext } from '../types.ts'
import {
  applyBoardChange,
  type BoardTagMap,
  type BoardTagRow,
  boardTagMap,
  boardTagRows,
  isTaggable,
  type Planned,
  planDeleteEverywhere,
  planRecolor,
  planRename,
  planSetTag,
  resolveTypedTag,
  sameBoardTags,
  type TagPlan,
} from './model.ts'

function perEditor<T>(make: (editor: Editor) => T) {
  const map = new WeakMap<Editor, T>()
  return (editor: Editor): T => {
    let v = map.get(editor)
    if (v === undefined) {
      v = make(editor)
      map.set(editor, v)
    }
    return v
  }
}

/** The board's tag list (document meta), stable while its entries are unchanged. */
export const boardTags = perEditor<Computed<BoardTagMap>>((editor) =>
  computed('dr-board-tags', () => boardTagMap(parseBoardTags(editor.getDocumentSettings().meta)), {
    isEqual: sameBoardTags,
  }),
)

/**
 * Every tag on the board with its count (all pages). Scans every shape (one cached parse per meta
 * object) when any shape changes, so read it only from UI that is open, never per shape: long-lived UI
 * goes through hooks.ts useTagRows (throttled); the picker and the writes read it directly.
 */
export const boardTagRowsOf = perEditor<Computed<BoardTagRow[]>>((editor) => {
  const shapes = editor.store.query.records('shape')
  return computed('dr-board-tag-rows', () => boardTagRows(boardTags(editor).get(), shapes.get()))
})

/** "Show only #tag" on the canvas: this person's view, not synced. */
export const tagFilter = perEditor<Atom<string | null>>(() => atom<string | null>('dr-tag-filter', null))

/** The selection (selectionKey) the tag picker is open for, or null (the selection bar shows it). */
export const tagPickerOpen = perEditor<Atom<string | null>>(() =>
  atom<string | null>('dr-tag-picker-open', null),
)

/** The latest feature context, for module-level UI (the selection-bar button, the context menu). */
const contexts = new WeakMap<Editor, FeatureContext>()
export const setTagsCtx = (editor: Editor, ctx: FeatureContext) => contexts.set(editor, ctx)
export const getTagsCtx = (editor: Editor) => contexts.get(editor)

/** The selected sticky notes and file cards (never locked ones: they cannot be changed). */
export function selectedTaggable(editor: Editor): TLShape[] {
  return editor.getSelectedShapes().filter((s) => isTaggable(s) && !editor.isShapeOrAncestorLocked(s))
}

export const canEditTags = (editor: Editor) => !editor.getIsReadonly()

function allShapes(editor: Editor): TLShape[] {
  return editor.store.query.records('shape').get()
}

/** Writes a plan as one undo step. Returns the number of shapes changed. */
function applyPlan(editor: Editor, plan: TagPlan, label: string): number {
  if (!canEditTags(editor)) return 0
  const hasBoard = plan.board.set.length > 0 || plan.board.remove.length > 0
  if (!plan.shapes.length && !hasBoard) return 0
  editor.markHistoryStoppingPoint(label)
  editor.run(() => {
    const records: TLRecord[] = []
    for (const change of plan.shapes) {
      const shape = editor.getShape(change.id as TLShape['id'])
      if (shape) records.push({ ...shape, meta: change.meta as TLShape['meta'] })
    }
    if (hasBoard) {
      const doc = editor.getDocumentSettings()
      records.push({ ...doc, meta: applyBoardChange(doc.meta, plan.board) as typeof doc.meta })
    }
    editor.store.put(records)
  })
  return plan.shapes.length
}

export interface ToggleResult {
  changed: number
  /** Shapes that already had 10 tags. */
  full: number
}

/** Adds `tag` to, or removes it from, the selected notes and cards. */
export function setTagOnSelection(editor: Editor, tag: TagDef, on: boolean): ToggleResult {
  const listed = boardTags(editor).get().has(tag.key)
  const plan = planSetTag(selectedTaggable(editor), tag, on, listed)
  const changed = applyPlan(editor, plan, on ? 'add tag' : 'remove tag')
  return { changed, full: plan.full }
}

/**
 * The picker's "Enter": the typed tag (existing or new) goes on every selected note and card; a new tag
 * joins the board's list in the same undo step.
 */
export function addTypedTagToSelection(
  editor: Editor,
  typed: string,
): Planned<ToggleResult & { tag: TagDef; created: boolean }> {
  const resolved = resolveTypedTag(boardTagRowsOf(editor).get(), typed)
  if (!resolved.ok) return resolved
  const { tag, created } = resolved.value
  const result = setTagOnSelection(editor, tag, true)
  return { ok: true, value: { ...result, tag, created } }
}

/** A tag on the board's list without putting it on anything (the panel's "New tag"). */
export function createBoardTag(editor: Editor, typed: string): Planned<{ tag: TagDef; created: boolean }> {
  const resolved = resolveTypedTag(boardTagRowsOf(editor).get(), typed)
  if (!resolved.ok) return resolved
  const { tag } = resolved.value
  if (!boardTags(editor).get().has(tag.key))
    applyPlan(editor, { shapes: [], board: { set: [tag], remove: [] } }, 'create tag')
  return resolved
}

export function renameTag(editor: Editor, key: string, typed: string): Planned<TagDef> {
  const plan = planRename(boardTagRowsOf(editor).get(), allShapes(editor), key, typed)
  if (!plan.ok) return plan
  applyPlan(editor, plan.value, 'rename tag')
  return { ok: true, value: plan.value.tag }
}

export function recolorTag(editor: Editor, key: string, color: TagColor): Planned<number> {
  const plan = planRecolor(boardTagRowsOf(editor).get(), allShapes(editor), key, color)
  if (!plan.ok) return plan
  return { ok: true, value: applyPlan(editor, plan.value, 'recolor tag') }
}

/** Off the board's list and off every note and card, locked ones included. One undo step. */
export function deleteTagEverywhere(editor: Editor, key: string): number {
  const changed = applyPlan(editor, planDeleteEverywhere(allShapes(editor), key), 'delete tag')
  if (tagFilter(editor).get() === key) tagFilter(editor).set(null)
  return changed
}

/**
 * Chip level of detail from the zoom (screen size of an 11 px chip): full chips from 60 %, colour dots
 * from 25 %, nothing below. One reactor per board sets `data-dr-tags-lod` on the editor container; the
 * chips follow through CSS, so nothing re-renders while zooming.
 */
export const LOD_FULL_ZOOM = 0.6
export const LOD_DOTS_ZOOM = 0.25
export type TagsLod = 'full' | 'dots' | 'off'
export const tagsLodFor = (zoom: number): TagsLod =>
  zoom >= LOD_FULL_ZOOM ? 'full' : zoom >= LOD_DOTS_ZOOM ? 'dots' : 'off'
