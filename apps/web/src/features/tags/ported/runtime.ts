// Tags on the new canvas: reactive reads (the board's list, the rows with counts, the selection) and the
// writes. The port of ../runtime.ts onto `LobbyCanvas`:
//  - the element keys of one change go into ONE `transact` (one undo step, pushed by the sync engine);
//  - the board's list is lb_doc (`canvas.doc.set`), written just before, so it travels in the same push
//    (the server takes a `tag:<key>` only with its `tagDef:<key>`). lb_doc is per-key last-writer-wins and
//    not part of Lobby's undo (the history is the elements'): an undo takes back the elements' tags, and
//    the list then follows the elements' own copies (a definition that went is listed again, a colour or
//    name the undo changed is written back); a tag that only the undone step created stays listed.
//
// Who may write: whoever may edit the canvas. The server refuses read-only sessions' pushes (and a
// guest's doc writes), which is the enforcement; `canvas.readOnly()` only keeps the UI from trying.

import type { TagColor, TagDef } from '@draftroom/contracts'
import type { CanvasChange, CanvasElement, LobbyCanvas } from '../../../canvas/api/index.ts'
import { type Atom, atom, computed, type Signal, untracked } from '../../../lib/signals.ts'
import { resolveTypedTag, sameBoardTags } from '../tag-core.ts'
import {
  type BoardTagMap,
  type BoardTagRow,
  boardTagRows,
  boardTagsOf,
  elementTags,
  isTaggable,
  type Planned,
  planDeleteEverywhere,
  planRecolor,
  planRename,
  planSetTag,
  type TagPlan,
  tagDefKey,
} from './model.ts'

export interface ToggleResult {
  changed: number
  /** Elements that already had 10 tags. */
  full: number
}

const isLive = (el: CanvasElement | undefined): el is CanvasElement =>
  !!el && !(el as { isDeleted?: boolean }).isDeleted

export class TagsRuntime {
  readonly canvas: LobbyCanvas
  /** The board's tag list (lb_doc), stable while its entries are unchanged. */
  readonly board: Signal<BoardTagMap>
  /**
   * Every tag on the board with its count. Scans every element when any changes, so read it only from UI
   * that is open (the panel, the picker, the filter bar; ./hooks.ts throttles it for long-lived UI).
   */
  readonly rows: Signal<BoardTagRow[]>
  /** "Show only #tag": this person's view, not synced. */
  readonly filter: Atom<string | null> = atom<string | null>('tags.filter', null)
  /** The selection (selectionKey) the tag picker is open for, or null. */
  readonly pickerOpen: Atom<string | null> = atom<string | null>('tags.picker-open', null)
  /** The search panel's tag filter (a tag key), kept while the panel closes and opens. */
  readonly searchTag: Atom<string | null> = atom<string | null>('tags.search-tag', null)
  private offs: (() => void)[] = []

  constructor(canvas: LobbyCanvas) {
    this.canvas = canvas
    this.board = computed('tags.board', () => boardTagsOf(canvas.doc.entries('tagDef:')), {
      isEqual: sameBoardTags,
    })
    this.rows = computed('tags.rows', () => boardTagRows(this.board.get(), canvas.items()))
  }

  install(): () => void {
    this.offs.push(this.canvas.on('change', (c) => this.onChange(c)))
    return () => {
      for (const f of this.offs.splice(0)) f()
    }
  }

  /**
   * The board's list follows an undo or redo of the elements (lb_doc is not part of Lobby's history):
   * a tag put back on an element after its definition went (delete everywhere, then Ctrl+Z) is listed
   * again from the element's own copy, and a copy whose name or colour the undo changed (a recolour
   * taken back) sets the definition to it. Every change plans the copies and the list together, so after
   * an undo the elements' copies are what the list said at that step.
   */
  private onChange(c: CanvasChange) {
    if (c.source !== 'history' || this.canvas.readOnly()) return
    untracked(() => {
      const board = this.board.get()
      const defs: Record<string, { name: string; color: TagColor }> = {}
      for (const id of [...c.updated, ...c.created]) {
        for (const t of elementTags(this.canvas.get(id))) {
          const listed = board.get(t.key)
          if (!listed || listed.name !== t.name || listed.color !== t.color)
            defs[tagDefKey(t.key)] = { name: t.name, color: t.color }
        }
      }
      if (Object.keys(defs).length) this.canvas.doc.set(defs)
    })
  }

  canEdit(): boolean {
    return !this.canvas.readOnly()
  }

  /** Identifies a selection, so a picker opened for one never shows up for the next. */
  selectionKey(): string {
    return this.canvas.selection.join(',')
  }

  /** The selected taggable elements (a selected label stands for its container). */
  selectedElements(): CanvasElement[] {
    const out = new Map<string, CanvasElement>()
    for (const id of this.canvas.selection) {
      const el = this.canvas.get(id)
      const target = el?.type === 'text' && el.containerId ? this.canvas.get(el.containerId) : el
      if (isTaggable(target) && !this.canvas.isHidden(target.id)) out.set(target.id, target)
    }
    return [...out.values()]
  }

  /** The selected taggable elements that can be changed (never locked ones). */
  selectedTaggable(): CanvasElement[] {
    return this.selectedElements().filter((el) => !this.canvas.isLocked(el.id))
  }

  /** Writes a plan: the list first (same push), then the elements as one undo step. Returns elements changed. */
  private apply(plan: TagPlan, label: string): number {
    if (!this.canEdit()) return 0
    const hasDoc = Object.keys(plan.doc).length > 0
    if (!plan.elements.length && !hasDoc) return 0
    if (hasDoc) this.canvas.doc.set(plan.doc)
    if (plan.elements.length) {
      this.canvas.transact(label, (tx) => {
        for (const p of plan.elements)
          if (isLive(this.canvas.get(p.id))) tx.update(p.id, { customData: { lobby: p.lobby } })
      })
    }
    return plan.elements.length
  }

  /** Adds `tag` to, or removes it from, the selected elements. */
  setTagOnSelection(tag: TagDef, on: boolean): ToggleResult {
    const listed = this.board.get().has(tag.key)
    const plan = planSetTag(this.selectedTaggable(), tag, on, listed, (el) => this.canvas.isLocked(el.id))
    const changed = this.apply(plan, on ? 'add tag' : 'remove tag')
    return { changed, full: plan.full }
  }

  /**
   * The picker's "Enter": the typed tag (existing or new) goes on every selected element; a new tag
   * joins the board's list in the same push.
   */
  addTypedTagToSelection(typed: string): Planned<ToggleResult & { tag: TagDef; created: boolean }> {
    const resolved = resolveTypedTag(this.rows.get(), typed)
    if (!resolved.ok) return resolved
    const { tag, created } = resolved.value
    const result = this.setTagOnSelection(tag, true)
    return { ok: true, value: { ...result, tag, created } }
  }

  /** A tag on the board's list without putting it on anything (the panel's "New tag"). */
  createBoardTag(typed: string): Planned<{ tag: TagDef; created: boolean }> {
    const resolved = resolveTypedTag(this.rows.get(), typed)
    if (!resolved.ok) return resolved
    const { tag } = resolved.value
    if (!this.board.get().has(tag.key))
      this.apply(
        { elements: [], doc: { [tagDefKey(tag.key)]: { name: tag.name, color: tag.color } } },
        'create tag',
      )
    return resolved
  }

  renameTag(key: string, typed: string): Planned<TagDef> {
    const plan = planRename(this.rows.get(), this.canvas.items(), key, typed)
    if (!plan.ok) return plan
    this.apply(plan.value, 'rename tag')
    return { ok: true, value: plan.value.tag }
  }

  recolorTag(key: string, color: TagColor): Planned<number> {
    const plan = planRecolor(this.rows.get(), this.canvas.items(), key, color)
    if (!plan.ok) return plan
    return { ok: true, value: this.apply(plan.value, 'recolor tag') }
  }

  /** Off the board's list and off every element, locked ones included. One undo step (the elements). */
  deleteTagEverywhere(key: string): number {
    const changed = this.apply(planDeleteEverywhere(this.canvas.items(), key), 'delete tag')
    if (this.filter.get() === key) this.filter.set(null)
    return changed
  }

  /** Opens the picker for the current selection (the context menu's "Tags…"). */
  openPicker(): void {
    this.pickerOpen.set(this.selectionKey())
  }
}
