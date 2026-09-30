// Frames on the Excalidraw page as present mode and the exports read them (docs/EXCALIDRAW-MIGRATION.md
// §4.5): the presentation order and the outline (board-ops/elements: `customData.lobby.present`, today's
// `meta.presentationIndex` / `presentationSkip`), slides, and what contains an element. Frames never nest
// on the new canvas and there are no pages: every frame is top level (`depth` 0).
import { type ElementFrameEntry, frameOutlineOf, presentationOrderOf } from '@draftroom/board-ops/elements'
import type { CanvasElement, LobbyCanvas } from '../../../canvas/api/index.ts'
import { buildSlides, type MetaCarrier, type Slide } from '../slides.ts'

export type { ElementFrameEntry }

/** A frame entry as the export dialog lists it (the tldraw outline's `depth`, always 0 here). */
export interface FrameRow extends ElementFrameEntry {
  readonly depth: 0
}

/** Reactive: the board's frames in presentation order (skipped ones included). */
export const presentationOrder = (canvas: LobbyCanvas): ElementFrameEntry[] =>
  presentationOrderOf(canvas.items())

/** Reactive: the board's frames in reading order (the Frames panel's outline). */
export const frameOutline = (canvas: LobbyCanvas): FrameRow[] =>
  frameOutlineOf(canvas.items()).map((f) => ({ ...f, depth: 0 as const }))

/** A skip flag in the shape slides.ts reads (`meta.presentationSkip`). */
export const skipCarrier = (entry: Pick<ElementFrameEntry, 'skip'> | undefined): MetaCarrier => ({
  meta: { presentationSkip: entry?.skip === true },
})

/** Slides: frames in presentation order without the skipped ones (and without empty frames). */
export function slidesOf(order: readonly ElementFrameEntry[]): Slide<string>[] {
  const byId = new Map(order.map((e) => [e.id, e]))
  return buildSlides<string>(order, (id) => skipCarrier(byId.get(id)))
}

/**
 * An element's containers, nearest first: a bound label's container, then the frame (tldraw's
 * `getShapeAncestors`, reversed). What a presentation opened on a selection starts at.
 */
export function containersOf(canvas: LobbyCanvas, id: string): string[] {
  const out: string[] = []
  let el: CanvasElement | undefined = canvas.get(id)
  for (let hops = 0; el && hops < 4; hops++) {
    const next = (el as { containerId?: string | null }).containerId || el.frameId || null
    if (!next || out.includes(next)) break
    out.push(next)
    el = canvas.get(next)
  }
  return out
}
