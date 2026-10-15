// OWNER: WS3 (wave Q, the Elements panel; landed by the wave Q foundation, generalised from features/pieces/insert.ts,
// L8-3). Putting prepared elements on the board: the one insert path the Elements panel's three sources share (a
// built-in icon, a built-in shape, a library item; docs/WAVE-Q-CONTRACTS.md §4). The Shapes panel's insertPiece is a
// wrapper of it (../pieces/insert.ts).
//
//   placeElements(canvas, { label, elements, bounds? }, { at?, select?, keepTogether?, lock?, reveal? }): PlaceResult
//
// The elements come in WireElement-shaped, anywhere, with ids of their own (an icon's builder, a piece's builder, a
// library item's item-local ids from POST …/place). Here they are:
//  1. re-keyed: fresh element and group ids, references leaving the set cut (board-ops remapElements, the duplicate
//     path's rules), indices above the board's top; the input is never changed;
//  2. placed: a drop (`at`) centres them on the pointer and joins the unlocked frame under it (every element not in a
//     frame of the set gets the frame's id), unless the set holds a frame (frames do not nest) or that frame is locked;
//     a click, Enter or a command puts them at the free spot nearest the middle of the view, on the open canvas
//     (the AI's spot finder, ../ai/ported/apply.ts spotNear), so the same insert again lands next to the last one;
//  3. optionally kept together (one fresh outer group around everything, when there is more than one top-level
//     element) and locked;
//  4. checked as the room checks them (canvas-schema checkElement per element, checkInvariants across them) and
//     against the board's MAX_ITEMS, before anything is written;
//  5. written in ONE transact (`tx.insert`): one undo step takes the whole insert away, and the room validates every
//     element per op as it does any other create. Then they are selected, and this tab's camera shows them whole
//     (../ai/reveal.ts; the camera only).
// Images in a library item reach the board through the api's /place links, which the caller asks for BEFORE this
// runs (sync's file-refs answer is cached for 30 s). Nothing here fetches anything.

import {
  type BoardElement,
  type IdSource,
  itemBoundsOf,
  newElementId,
  remapElements,
} from '@draftroom/board-ops/elements'
import { checkElement } from '@draftroom/canvas-schema/elements'
import { checkInvariants } from '@draftroom/canvas-schema/invariants'
import { MAX_GROUP_IDS, MAX_ITEMS } from '@draftroom/canvas-schema/limits'
import { type Bounds, type CanvasElement, geometry, items, type LobbyCanvas } from '../../canvas/api/index.ts'
import { spotNear } from '../ai/ported/apply.ts'
import { revealResult } from '../ai/reveal.ts'

export interface PlaceSource {
  /** the undo step's label ('insert decision', 'insert arrow-right icon') */
  readonly label: string
  /** WireElement-shaped elements, at any position, with ids of their own (re-keyed here) */
  readonly elements: readonly Readonly<Record<string, unknown>>[]
  /** the box to centre and place by, in the elements' own space (default: the union of their boxes) */
  readonly bounds?: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
}

export interface PlaceOptions {
  /** the pointer (a drop): centred on it, and it joins the unlocked frame under it. Default: the free spot. */
  readonly at?: { x: number; y: number } | null
  /** select what was placed (default true) */
  readonly select?: boolean
  /** one fresh outer group around everything placed, when there is more than one top-level element (default false) */
  readonly keepTogether?: boolean
  /** lock everything placed (default false) */
  readonly lock?: boolean
  /** move this tab's camera to show it (default true) */
  readonly reveal?: boolean
  /** where new ids come from (tests) */
  readonly newId?: IdSource
}

export type PlaceFailure = 'readonly' | 'empty' | 'invalid' | 'too-many-shapes' | 'failed'

export type PlaceResult =
  | {
      ok: true
      /** the placed top-level elements (no bound labels), in paint order */
      ids: string[]
      /** every placed element, labels included */
      allIds: string[]
      bounds: Bounds
      frameId: string | null
    }
  | { ok: false; reason: PlaceFailure }

type El = Record<string, unknown>

const live = (el: CanvasElement | undefined): el is CanvasElement =>
  !!el && !(el as { isDeleted?: boolean }).isDeleted

const isLabel = (e: El) => e.type === 'text' && typeof e.containerId === 'string' && e.containerId !== ''

/** The innermost frame whose area holds `point`, or null. */
export function frameAtPoint(
  canvas: Pick<LobbyCanvas, 'items' | 'isHidden'>,
  point: { x: number; y: number },
) {
  let best: { el: CanvasElement; area: number } | null = null
  for (const el of canvas.items()) {
    if (el.type !== 'frame' || !live(el) || canvas.isHidden(el.id)) continue
    const b = { x: el.x, y: el.y, width: el.width, height: el.height }
    if (!geometry.containsPoint(b, point)) continue
    const area = b.width * b.height
    if (!best || area < best.area) best = { el, area }
  }
  return best?.el ?? null
}

/** The board's top fractional index (what is placed goes on top). */
export function topIndex(canvas: Pick<LobbyCanvas, 'items'>): string | null {
  let top: string | null = null
  for (const e of canvas.items()) if (e.index && (top === null || e.index > top)) top = e.index
  return top
}

/** Places `source` on the board in one undo step (see the module comment). Never throws. */
export function placeElements(
  canvas: LobbyCanvas,
  source: PlaceSource,
  opts: PlaceOptions = {},
): PlaceResult {
  if (canvas.readOnly()) return { ok: false, reason: 'readonly' }
  try {
    const input = source.elements.filter(
      (e) => typeof e.id === 'string' && typeof e.type === 'string' && e.isDeleted !== true,
    )
    if (!input.length) return { ok: false, reason: 'empty' }
    const box =
      source.bounds ??
      itemBoundsOf((input as unknown as BoardElement[]).filter((e) => !isLabel(e as unknown as El)))
    if (!box) return { ok: false, reason: 'empty' }
    const drop = opts.at ?? null
    // a drop: centred on the pointer; else the free spot nearest the middle of the view, on the open canvas
    const at = drop
      ? { x: drop.x - box.w / 2, y: drop.y - box.h / 2 }
      : spotNear(canvas, { w: box.w, h: box.h }, [])
    const offset = { x: Math.round(at.x - box.x), y: Math.round(at.y - box.y) }
    const newId = opts.newId ?? newElementId
    // tx.insert re-keys the indices on top of the scene anyway; a top key the remap cannot read starts a fresh run
    const remap = (indexAbove: string | null) => remapElements(input, { offset, indexAbove, newId })
    let elements: Record<string, unknown>[]
    try {
      elements = remap(topIndex(canvas)).elements
    } catch {
      elements = remap(null).elements
    }
    if (!elements.length) return { ok: false, reason: 'empty' }
    // only a drop joins the unlocked frame under the pointer, and never a set with a frame of its own
    const holdsFrame = elements.some((e) => e.type === 'frame')
    const frame = holdsFrame || !drop ? null : frameAtPoint(canvas, drop)
    const frameId = frame && !canvas.isLocked(frame.id) ? frame.id : null
    const top = elements.filter((e) => !isLabel(e))
    const group = opts.keepTogether && top.length > 1 ? newId() : null
    for (const e of elements) {
      if (group) {
        const groups = Array.isArray(e.groupIds) ? (e.groupIds as string[]) : []
        // the outermost group goes last (Excalidraw's order); an element already at the cap keeps its own
        if (groups.length < MAX_GROUP_IDS) e.groupIds = [...groups, group]
      }
      if (opts.lock) e.locked = true
    }
    // what the room would take, before anything is written
    for (const e of elements) {
      const check = checkElement(e)
      if (!check.ok) {
        console.warn('place: an element the board would refuse', check.code)
        return { ok: false, reason: 'invalid' }
      }
    }
    const violations = checkInvariants(elements as never)
    if (violations.length) {
      console.warn('place: inconsistent elements', [...new Set(violations.map((v) => v.code))].join(','))
      return { ok: false, reason: 'invalid' }
    }
    // the frame joined last: the set's own checks above see it as it came (its frame is the board's, not the set's)
    if (frameId) for (const e of elements) if (e.type !== 'frame' && e.frameId == null) e.frameId = frameId
    if (items.contentItems(canvas.items()).length + top.length > MAX_ITEMS)
      return { ok: false, reason: 'too-many-shapes' }
    canvas.transact(source.label, (tx) => tx.insert(elements))
    const ids = top.map((e) => e.id as string)
    if (ids.some((id) => !live(canvas.get(id)))) return { ok: false, reason: 'failed' }
    if (opts.select !== false) canvas.select(ids)
    const bounds = { x: box.x + offset.x, y: box.y + offset.y, width: box.w, height: box.h }
    // shown whole, clear of the board's chrome (this tab's camera only)
    if (opts.reveal !== false) void revealResult(canvas, ids)
    return { ok: true, ids, allIds: elements.map((e) => e.id as string), bounds, frameId }
  } catch (e) {
    console.error('place failed', e)
    return { ok: false, reason: 'failed' }
  }
}
