// OWNER: 3f. Dot voting on the canvas (Excalidraw page): which element a press votes on, the keyboard
// order of the objects a vote accepts, and where the markers go. Reads the canvas through the API only.
import type { VoteEligibilityRule } from '@draftroom/contracts'
import type { CanvasElement, LobbyCanvas, ScenePoint } from '../../../canvas/api/index.ts'
import { readingOrder } from '../voting.ts'
import { ensureVisible } from './camera.ts'
import { elementIdOf, isEligibleElement, refOf } from './elements.ts'

/** A plain press: no modifier (Shift+drag still moves a note while voting). */
export const plainPress = (e: { shift: boolean; ctrl: boolean; meta: boolean; alt: boolean }) =>
  !e.shift && !e.ctrl && !e.meta && !e.alt

/**
 * The topmost element under `point` that the vote accepts (locked ones included: tldraw's `hitLocked`),
 * or null. A bound label is never returned: its container is (the hit test counts a label's area as its
 * container's).
 */
export function eligibleAt(
  canvas: LobbyCanvas,
  point: ScenePoint,
  rule: VoteEligibilityRule,
): CanvasElement | null {
  const get = (id: string) => canvas.get(id)
  return canvas.hitTest(point, {
    hitInside: true,
    filter: (el) => isEligibleElement(el.id, get, rule),
  })
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
