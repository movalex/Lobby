// L8-1 and L8-2: what the sort feature reads from the board. The notes a request is about (a selection, or the
// notes of a selected frame), which of them may be moved right now (locked, being typed in, being dragged by
// someone else: left alone and counted), and what each sort key needs to know about a note (its colour, its
// author, its tags, its votes). Everything here reads; nothing writes.
//
// The skip rules are read when the plan is made AND again when it is applied (an AI answer or a preview can
// take a while): `skipOf` reads the live board each time and caches nothing.

import { fromShapeRef } from '@draftroom/canvas-schema/refs'
import {
  type CanvasElement,
  type CanvasFeatureContext,
  items,
  type LobbyCanvas,
} from '../../canvas/api/index.ts'
import { boardTagRows, boardTagsOf, displayTags } from '../tags/ported/model.ts'
import { lastRevealedResults } from '../workshops/store.ts'
import { isFrame, isLive, isNote } from './geom.ts'
import type { SortContext, SortNote } from './keys.ts'

/** Notes one request handles at most (the layout and the api have their own limits; this keeps both sane). */
export const MAX_SORT_NOTES = 400

export type SkipReason = 'locked' | 'leased' | 'dragged'
export interface Skipped {
  readonly id: string
  readonly reason: SkipReason
}

/** A template's prompt or instruction note (`customData.lobby.prompt`): not an idea, so it is not sorted. */
const isPromptNote = (el: CanvasElement) => items.lobbyValue(el, 'prompt') !== undefined

/**
 * The notes `ids` stand for: a note itself (or its label), the notes of a frame. Hidden (collapsed) elements,
 * deleted ones and template prompt notes are left out. Order: the order of the ids, a frame's children in
 * paint order.
 */
export function targetNotes(canvas: LobbyCanvas, ids: readonly string[]): CanvasElement[] {
  const all = canvas.items()
  const out = new Map<string, CanvasElement>()
  const take = (el: CanvasElement | undefined) => {
    if (!isNote(el) || !isLive(el) || canvas.isHidden(el.id) || isPromptNote(el)) return
    out.set(el.id, el)
  }
  for (const id of ids) {
    const el = canvas.get(id)
    if (!isLive(el)) continue
    if (isFrame(el)) {
      for (const childId of items.childrenOf(el.id, all)) take(canvas.get(childId))
      continue
    }
    take(items.containerOf(el, (x) => canvas.get(x)))
  }
  return [...out.values()]
}

/** Why `note` may not be moved right now, or null when it may (read live; never cached). */
export function skipOf(canvas: LobbyCanvas, note: CanvasElement): SkipReason | null {
  if (canvas.isLocked(note.id)) return 'locked'
  const label = items.labelOf(note, (x) => canvas.get(x))
  // a lease sits on the note (its container); the label's id is checked too, and this tab's own open editor
  if (
    canvas.editingId() === note.id ||
    canvas.leaseHolder(note.id) !== null ||
    (label && canvas.leaseHolder(label.id) !== null)
  )
    return 'leased'
  if (canvas.presence.draggerOf(note.id) !== null) return 'dragged'
  return null
}

/** `notes` split into those that may move now and those that stay, with why. */
export function eligibility(
  canvas: LobbyCanvas,
  notes: readonly CanvasElement[],
): { movable: CanvasElement[]; skipped: Skipped[] } {
  const movable: CanvasElement[] = []
  const skipped: Skipped[] = []
  for (const n of notes) {
    const reason = skipOf(canvas, n)
    if (reason) skipped.push({ id: n.id, reason })
    else movable.push(n)
  }
  return { movable, skipped }
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

/** The notice for skipped notes: "2 notes were skipped: someone is editing or moving them." Empty for none. */
export function skippedText(skipped: readonly Skipped[]): string {
  const n = skipped.length
  if (!n) return ''
  const locked = skipped.filter((s) => s.reason === 'locked').length
  const busy = n - locked
  const head = `${n} ${plural(n, 'note was', 'notes were')} skipped`
  if (busy === 0) return `${head}: ${plural(n, 'it is locked', 'they are locked')}.`
  if (locked === 0) return `${head}: someone is editing or moving ${plural(n, 'it', 'them')}.`
  return `${head}: ${locked} ${plural(locked, 'is', 'are')} locked, ${busy} ${plural(busy, 'is', 'are')} being edited or moved by someone.`
}

// ---- what each key reads --------------------------------------------------------------------------------

/** The `lobbyServer.createdBy` of an element: who the server credits with making it, or null. */
function createdBy(el: CanvasElement): { uid: string; name: string } | null {
  const by = (el.customData?.lobbyServer as { createdBy?: unknown } | null | undefined)?.createdBy as
    | { uid?: unknown; name?: unknown }
    | null
    | undefined
  return by && typeof by.uid === 'string' && by.uid ? { uid: by.uid, name: String(by.name ?? '') } : null
}

const fillOf = (el: CanvasElement): unknown => (el as { backgroundColor?: unknown }).backgroundColor

/** The sort description of one note. */
export function sortNoteOf(el: CanvasElement, board: ReturnType<typeof boardTagsOf>): SortNote {
  return {
    id: el.id,
    fill: typeof fillOf(el) === 'string' ? (fillOf(el) as string) : null,
    author: createdBy(el),
    tags: displayTags(el, board).map((t) => ({ key: t.key, name: t.name })),
  }
}

/** The board's last revealed vote as note id → votes, or null when no vote has been revealed. */
export function revealedVotes(ctx: Pick<CanvasFeatureContext, 'events'>): Map<string, number> | null {
  const revealed = lastRevealedResults(ctx.events)
  if (!revealed) return null
  const out = new Map<string, number>()
  for (const r of revealed.results) {
    const id = fromShapeRef(r.ref)
    if (id) out.set(id, Math.max(out.get(id) ?? 0, r.count))
  }
  return out
}

/** Names, the board's tag order and the revealed vote: what the keys need besides the notes themselves. */
export function readSortContext(ctx: CanvasFeatureContext): SortContext {
  const { canvas } = ctx
  const names = new Map<string, string>()
  for (const p of canvas.collaborators()) if (p.name.trim()) names.set(p.uid, p.name.trim())
  if (ctx.me.user.name.trim()) names.set(ctx.me.user.id, ctx.me.user.name.trim())
  const board = boardTagsOf(canvas.doc.entries('tagDef:'))
  return {
    names,
    tagOrder: boardTagRows(board, canvas.items()).map((r) => r.key),
    votes: revealedVotes(ctx),
  }
}

/** The sort descriptions of `notes`, with the tag list read once. */
export function sortNotesOf(canvas: LobbyCanvas, notes: readonly CanvasElement[]): SortNote[] {
  const board = boardTagsOf(canvas.doc.entries('tagDef:'))
  return notes.map((n) => sortNoteOf(n, board))
}
