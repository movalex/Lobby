/**
 * Frames of a board on the new canvas: the outline (Frames panel, export dialog) and the presentation order
 * (Present, thumbnails), the element versions of `../frames.ts`. Frames never nest in Excalidraw (a frame's
 * own `frameId` is null, canvas-schema invariants), so every entry is top level; there are no pages.
 *
 * The presentation order reads `customData.lobby.present` (canvas-schema custom-data.ts: `{index?, skip?}`,
 * today's `meta.presentationIndex` / `presentationSkip`): frames with an `index` first in ascending order
 * (ties keep reading order), then every other frame in reading order. `skip` is reported on each entry;
 * leaving skipped frames out of a slide show is the caller's (as today).
 */
import { type Box, readingOrder } from '../common.ts'
import { asElements, type BoardElement, elementBounds, isLive, lobbyValue } from './read.ts'

export interface ElementFrameEntry {
  id: string
  name: string
  /** scene-space axis-aligned bounds */
  bounds: Box
  /** `customData.lobby.present.index`, or null */
  presentIndex: number | null
  /** `customData.lobby.present.skip` */
  skip: boolean
}

export interface ElementFrameOrderOptions {
  /** Vertical jitter tolerated within one reading-order row; default max(24, 25% of the smaller height). */
  rowTolerance?: number
}

function presentOf(el: BoardElement): { index: number | null; skip: boolean } {
  const v = lobbyValue(el, 'present')
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { index: null, skip: false }
  const p = v as { index?: unknown; skip?: unknown }
  return {
    index: typeof p.index === 'number' && Number.isFinite(p.index) ? p.index : null,
    skip: p.skip === true,
  }
}

function collect(elements: Iterable<unknown>): ElementFrameEntry[] {
  const seen = new Set<string>()
  const out: ElementFrameEntry[] = []
  for (const el of asElements(elements)) {
    if (el.type !== 'frame' || !isLive(el) || seen.has(el.id)) continue
    seen.add(el.id)
    const present = presentOf(el)
    out.push({
      id: el.id,
      name: typeof el.name === 'string' ? el.name : '',
      bounds: elementBounds(el),
      presentIndex: present.index,
      skip: present.skip,
    })
  }
  return out
}

/** The board's frames in reading order (rows by top edge with jitter tolerance, then left to right). */
export function frameOutlineOf(
  elements: Iterable<unknown>,
  opts?: ElementFrameOrderOptions,
): ElementFrameEntry[] {
  return readingOrder(collect(elements), opts?.rowTolerance)
}

/** Slides: frames with a `present.index` first (ascending, ties in reading order), then the rest in reading order. */
export function presentationOrderOf(
  elements: Iterable<unknown>,
  opts?: ElementFrameOrderOptions,
): ElementFrameEntry[] {
  const outline = frameOutlineOf(elements, opts)
  const explicit: { entry: ElementFrameEntry; position: number }[] = []
  const rest: ElementFrameEntry[] = []
  outline.forEach((entry, position) => {
    if (entry.presentIndex === null) rest.push(entry)
    else explicit.push({ entry, position })
  })
  explicit.sort(
    (a, b) => (a.entry.presentIndex as number) - (b.entry.presentIndex as number) || a.position - b.position,
  )
  return [...explicit.map((e) => e.entry), ...rest]
}
