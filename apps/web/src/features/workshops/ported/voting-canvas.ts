// OWNER: 3f. Dot voting on the canvas (Excalidraw page): which element a press votes on, the keyboard
// order of the objects a vote accepts, where the markers go, and what a selection vote (RETRO-10) would
// list. Reads the canvas through the API only.
import { VOTE_INELIGIBLE_TYPES, VOTE_SELECTION_MAX, type VoteEligibilityRule } from '@draftroom/contracts'
import { type CanvasElement, items, type LobbyCanvas, type ScenePoint } from '../../../canvas/api/index.ts'
import { notInVoteText, readingOrder, type VoteClick, voteClick } from '../voting.ts'
import { ensureVisible } from './camera.ts'
import { elementIdOf, isEligibleElement, labelOfRef, refOf, voteTypeOf } from './elements.ts'

/** A plain press: no modifier (Shift+drag still moves a note while voting). */
export const plainPress = (e: { shift: boolean; ctrl: boolean; meta: boolean; alt: boolean }) =>
  !e.shift && !e.ctrl && !e.meta && !e.alt

/**
 * What a plain click at `point` does while voting (W5-03): the topmost element there decides, as a click
 * would pick it (locked ones included: tldraw's `hitLocked`; a bound label counts as its container). The
 * hit test takes no filter: a click on an object the vote does not take never passes through it to one
 * the vote takes underneath, which is hidden and which nobody clicked.
 */
export function voteClickAt(
  canvas: LobbyCanvas,
  point: ScenePoint,
  rule: VoteEligibilityRule,
): VoteClick<CanvasElement> {
  const get = (id: string) => canvas.get(id)
  return voteClick(canvas.hitTest(point, { hitInside: true }), (el) => isEligibleElement(el.id, get, rule))
}

/** The element a plain click at `point` votes on (the topmost one, when the vote takes it), or null. */
export function eligibleAt(
  canvas: LobbyCanvas,
  point: ScenePoint,
  rule: VoteEligibilityRule,
): CanvasElement | null {
  const click = voteClickAt(canvas, point, rule)
  return click.kind === 'vote' ? click.target : null
}

/** What a click on an object the vote does not take says (W5-03): "Not part of this vote: only …". */
export function notInVoteNotice(canvas: LobbyCanvas, rule: VoteEligibilityRule): string {
  const frame =
    rule.scope === 'frame' && rule.frameId ? labelOfRef(rule.frameId, (id) => canvas.get(id)) : null
  return notInVoteText(rule, frame)
}

/** The element ids this vote accepts, in reading order (keyboard voting), hidden ones left out. */
export function eligibleInOrder(canvas: LobbyCanvas, rule: VoteEligibilityRule): string[] {
  const get = (id: string) => canvas.get(id)
  const list: { id: string; x: number; y: number; w: number; h: number }[] = []
  for (const el of canvas.items()) {
    if (!isEligibleElement(el.id, get, rule) || canvas.isHidden(el.id)) continue
    const b = canvas.bounds(el.id)
    if (!b) continue
    list.push({ id: el.id, x: b.x, y: b.y, w: b.width, h: b.height })
  }
  return readingOrder(list).map((i) => i.id)
}

/**
 * Selects the object `step` places after (or before) the selected one among those the vote accepts,
 * bringing it into view. No wrapping: past the last one, the keyboard moves on (to the voting bar).
 * With nothing selected, "next" is the first one. Returns whether an object was selected.
 */
export function selectEligible(canvas: LobbyCanvas, rule: VoteEligibilityRule, step: 1 | -1): boolean {
  const order = eligibleInOrder(canvas, rule)
  const sel = canvas.selection
  const current = sel.length === 1 ? sel[0] : undefined
  const at = current ? order.indexOf(current) : -1
  const next = at < 0 ? (step > 0 ? order[0] : undefined) : order[at + step]
  if (!next) return false
  canvas.select([next])
  const b = canvas.bounds(next)
  if (b) ensureVisible(canvas, b, 256)
  return true
}

/** The one selected element the vote accepts, or null. */
export function selectedEligible(canvas: LobbyCanvas, rule: VoteEligibilityRule | null): string | null {
  if (!rule) return null
  const sel = canvas.selection
  if (sel.length !== 1) return null
  const id = sel[0] as string
  return isEligibleElement(id, (x) => canvas.get(x), rule) ? id : null
}

/** Overlay-pixel positions of the top-right corners of the objects named by api refs (hidden ones left out). */
export function cornersOf(
  canvas: LobbyCanvas,
  refs: Iterable<string>,
): { ref: string; id: string; x: number; y: number }[] {
  const out: { ref: string; id: string; x: number; y: number }[] = []
  for (const ref of refs) {
    const id = elementIdOf(ref)
    if (!id || canvas.isHidden(id)) continue
    const el = canvas.get(id)
    if (!el || (el as { isDeleted?: boolean }).isDeleted) continue
    const b = canvas.bounds(id)
    if (!b) continue
    const p = canvas.sceneToOverlay({ x: b.x + b.width, y: b.y })
    out.push({ ref, id, x: Math.round(p.x), y: Math.round(p.y) })
  }
  return out
}

export { refOf }

// ---- a vote over the selection (RETRO-10) ----------------------------------------------------------------

/** What "Only the selection" would list: frames (their contents take votes) and single objects. */
export interface SelectionScope {
  /** The api refs, frames first, in selection order; at most VOTE_SELECTION_MAX when `tooMany` is false. */
  refs: string[]
  frames: number
  objects: number
  /** More than VOTE_SELECTION_MAX frames and objects: the vote cannot list them all. */
  tooMany: boolean
}

const isLive = (el: CanvasElement | undefined): el is CanvasElement =>
  !!el && !(el as { isDeleted?: boolean }).isDeleted

/**
 * The selection as a selection vote's list, or null when it holds nothing a vote can cover. A bound
 * label stands for its container; connectors, lines and ink are left out (they never take votes); an
 * object inside a selected frame is left out (the frame already covers it).
 */
export function selectionScopeOf(canvas: LobbyCanvas): SelectionScope | null {
  const get = (id: string) => canvas.get(id)
  const frames: CanvasElement[] = []
  const objects: CanvasElement[] = []
  const seen = new Set<string>()
  for (const id of canvas.selection) {
    const el = get(id)
    if (!isLive(el)) continue
    const target = items.containerOf(el, get)
    if (!isLive(target) || seen.has(target.id) || refOf(target.id) === null) continue
    seen.add(target.id)
    if (target.type === 'frame') frames.push(target)
    else {
      const type = voteTypeOf(target)
      if (type && !VOTE_INELIGIBLE_TYPES.includes(type)) objects.push(target)
    }
  }
  const frameIds = new Set(frames.map((f) => f.id))
  const loose = objects.filter((o) => !(o.frameId && frameIds.has(o.frameId)))
  const refs = [...frames, ...loose].map((el) => refOf(el.id) as string)
  if (refs.length === 0) return null
  return { refs, frames: frames.length, objects: loose.length, tooMany: refs.length > VOTE_SELECTION_MAX }
}

/** The setup dialog's scope value for "Only the selection". */
export const SELECTION_SCOPE = 'selection'

/**
 * What the setup dialog's scope starts on: the selection when it holds two frames or more (a retro's
 * columns), else the frame the selection is in (or is), else the whole board.
 */
export function initialScope(selection: SelectionScope | null, frameRef: string | null): string {
  if (selection && !selection.tooMany && selection.frames >= 2) return SELECTION_SCOPE
  return frameRef ?? 'board'
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** "2 frames, 3 objects" (the setup dialog's option). */
export function selectionCounts(scope: Pick<SelectionScope, 'frames' | 'objects'>): string {
  const parts: string[] = []
  if (scope.frames) parts.push(plural(scope.frames, 'frame'))
  if (scope.objects) parts.push(plural(scope.objects, 'object'))
  return parts.join(', ')
}

/**
 * What a selection vote covers, for the Voting panel: "in frames “Went well” and “To improve”", "on 3
 * selected objects", "in 5 frames and on 2 selected objects". A listed object that is gone counts as an
 * object.
 */
export function selectionText(refs: readonly string[], canvas: LobbyCanvas): string {
  const get = (id: string) => canvas.get(id)
  const frames: string[] = []
  let objects = 0
  for (const ref of refs) {
    const id = elementIdOf(ref)
    const el = id ? get(id) : undefined
    if (isLive(el) && el.type === 'frame') frames.push(`“${labelOfRef(ref, get)}”`)
    else objects++
  }
  const parts: string[] = []
  if (frames.length > 0 && frames.length <= 3)
    parts.push(
      `in frame${frames.length === 1 ? '' : 's'} ${frames.length === 1 ? frames[0] : `${frames.slice(0, -1).join(', ')} and ${frames.at(-1)}`}`,
    )
  else if (frames.length > 3) parts.push(`in ${frames.length} frames`)
  if (objects > 0) parts.push(`on ${plural(objects, 'selected object')}`)
  return parts.join(' and ') || 'on the selected objects'
}
