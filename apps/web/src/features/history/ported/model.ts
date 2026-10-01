// OWNER: 3h. The element-side logic of the History panel on the Excalidraw board page (the tldraw
// panel's ../model.ts and ../checkpoints-model.ts keep their record-side twins until wave 4):
// what a change batch means for "Recently deleted", which of the ids a restore returned are on the
// board, and what a v2 checkpoint holds for its preview. Pure (Node-tested).

import { presentationOrderOf, readingOrder } from '@draftroom/board-ops/elements'
import { pluralize } from '../../../lib/format.ts'

/** api object refs are `shape:<elementId>` (canvas-schema refs.ts); the canvas speaks element ids. */
const SHAPE_REF = 'shape:'
export const elementIdOf = (ref: string): string =>
  ref.startsWith(SHAPE_REF) ? ref.slice(SHAPE_REF.length) : ref
export const refOfElement = (id: string): string => (id.startsWith(SHAPE_REF) ? id : `${SHAPE_REF}${id}`)

/**
 * A change batch that can change the "Recently deleted" list (tldraw: `touchesDeleted` on a store
 * diff): an element deleted by anyone (a remote delete included), or a listed element coming back (an
 * undo, another tab's restore: the change stream reports it as created).
 */
export function touchesDeletedElements(
  change: { readonly created: readonly string[]; readonly deleted: readonly string[] },
  listed: ReadonlySet<string>,
): boolean {
  if (change.deleted.length > 0) return true
  for (const id of change.created) if (listed.has(id) || listed.has(refOfElement(id))) return true
  return false
}

/** The element ids to select after a restore: those now on the board, in the order the server gave. */
export function restoredElementIds(restored: readonly string[], has: (id: string) => boolean): string[] {
  return restored.map(elementIdOf).filter((id) => has(id))
}

interface PreviewElement {
  readonly id?: unknown
  readonly type?: unknown
  readonly isDeleted?: unknown
  readonly containerId?: unknown
  readonly text?: unknown
  readonly originalText?: unknown
  readonly name?: unknown
  readonly x?: unknown
  readonly y?: unknown
  readonly width?: unknown
  readonly height?: unknown
}

const live = (e: PreviewElement) => e.isDeleted !== true && typeof e.id === 'string'
/** A note's or a shape's label: part of its container, not an object of its own. */
const isBoundLabel = (e: PreviewElement) => e.type === 'text' && typeof e.containerId === 'string'

/**
 * "12 objects" for the preview's header (the tldraw preview counted shape records): the checkpoint's
 * live elements less bound labels, so a note and its label are one object, as people see them.
 */
export function previewElementCounts(elements: readonly unknown[]): { objects: number; text: string } {
  let objects = 0
  for (const raw of elements) {
    const e = (raw ?? {}) as PreviewElement
    if (live(e) && !isBoundLabel(e)) objects++
  }
  return { objects, text: pluralize(objects, 'object') }
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * The checkpoint's words in reading order (frame names, notes', shapes' and free texts' text), for the
 * preview's text layer: the bitmap cannot be read by a screen reader or searched, the list can.
 */
export function previewTexts(elements: readonly unknown[], max = 400): string[] {
  const all = elements.map((e) => (e ?? {}) as PreviewElement).filter(live)
  const byId = new Map(all.map((e) => [e.id as string, e]))
  const items: { id: string; bounds: { x: number; y: number; w: number; h: number }; text: string }[] = []
  for (const e of all) {
    let text = ''
    if (e.type === 'frame') text = typeof e.name === 'string' ? e.name : ''
    else if (e.type === 'text') text = String(e.originalText ?? e.text ?? '')
    else continue
    text = text.replace(/\s+/g, ' ').trim()
    if (!text) continue
    // a label reads where its container is
    const at = isBoundLabel(e) ? (byId.get(e.containerId as string) ?? e) : e
    items.push({
      id: e.id as string,
      bounds: { x: num(at.x), y: num(at.y), w: num(at.width), h: num(at.height) },
      text,
    })
  }
  return readingOrder(items)
    .slice(0, max)
    .map((i) => i.text)
}

/**
 * DANA2-05, how a checkpoint opens: its first frame in presentation order (skipped frames only when
 * all are), in scene bounds, or null when it has no frame.
 */
export function firstFrameBounds(
  elements: readonly unknown[],
): { x: number; y: number; width: number; height: number } | null {
  const order = presentationOrderOf(elements)
  const entry = order.find((f) => !f.skip) ?? order[0]
  if (!entry || !(entry.bounds.w > 0) || !(entry.bounds.h > 0)) return null
  return { x: entry.bounds.x, y: entry.bounds.y, width: entry.bounds.w, height: entry.bounds.h }
}
