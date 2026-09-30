// What one export draws and at what size (docs/EXCALIDRAW-MIGRATION.md §4.5; wave 3e). Pure: no DOM, no
// engine import, unit-tested in Node. scene.ts runs the plan on Excalidraw's exporters.
//
// Three kinds of export, as `LobbyCanvas.export.*` takes them (canvas/api/lobby-canvas.ts ExportOptions):
//  - the board or a selection (`ids`): the live, non-hidden elements (with their bound labels and a chosen
//    frame's children, select.ts), with a margin (`padding`) around what is drawn;
//  - one frame (`frameId`): Excalidraw's own frame export (`exportingFrame`: the frame's rectangle, no
//    title or outline, its children clipped to it), exactly the frame's size: the frame and its children
//    only, not a loose element that overlaps it (tldraw's single-frame export did the same);
//  - an exact scene rectangle (`bounds`: a thumbnail's start view, a PDF page of the whole board). The
//    exporters size an export by what it draws, so the rectangle becomes a SYNTHETIC frame: every element
//    that intersects it is re-parented to that frame for the export only (Excalidraw's frame export
//    keeps an element only when its frameId is null or the exported frame), and the frame itself is drawn
//    as nothing (a frame export shows no outline or title). The scene is never touched: these are copies.
//
// Sizes: the output is `scale` × the drawn size, capped at `maxSide` (thumbnails) and at what browsers can
// draw (16,384 px per side, about 125 megapixels: tldraw's export clamped the same way, and the Export
// dialog warns before it happens, pdf-layout.ts CANVAS_SAFE).

export interface PlanElement {
  readonly id: string
  readonly type: string
  readonly isDeleted?: boolean
  readonly containerId?: string | null
  readonly frameId?: string | null
}

export interface PlanRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** The id of the synthetic frame a `bounds` export clips to (never a real element: ids here have no space). */
export const EXPORT_BOUNDS_FRAME_ID = 'lobby export bounds'

/** Margin around a board or selection export when the caller gives none (Excalidraw's default). */
export const DEFAULT_EXPORT_PADDING = 16

/** What browsers draw reliably (Chrome/Edge 16,384 px per side; Firefox about 11,180² px of area). */
export const EXPORT_CANVAS_LIMITS = { maxSide: 16_384, maxArea: 11_180 * 11_180 } as const

export interface PlanOptions {
  readonly ids?: readonly string[]
  readonly bounds?: PlanRect
  readonly frameId?: string
  readonly padding?: number
}

export type ExportPlan<T extends PlanElement> =
  | { readonly kind: 'elements'; readonly elements: T[]; readonly padding: number }
  | { readonly kind: 'frame'; readonly elements: T[]; readonly frame: T }
  | { readonly kind: 'bounds'; readonly elements: T[]; readonly bounds: PlanRect }

const finite = (n: number | undefined, fallback: number) =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : fallback

/** The chosen elements with their bound labels and a chosen frame's children, to a fixed point. */
function withMembers<T extends PlanElement>(live: readonly T[], chosen: ReadonlySet<string>): T[] {
  const keep = new Set(chosen)
  for (let grew = true; grew; ) {
    grew = false
    for (const e of live) {
      if (keep.has(e.id)) continue
      const viaLabel = e.type === 'text' && !!e.containerId && keep.has(e.containerId)
      const viaFrame = !!e.frameId && keep.has(e.frameId)
      if (viaLabel || viaFrame) {
        keep.add(e.id)
        grew = true
      }
    }
  }
  return live.filter((e) => keep.has(e.id))
}

const overlaps = (a: PlanRect, b: PlanRect) =>
  a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y

/**
 * The plan for one export. `elements` is the scene in paint order; `isHidden` names collapsed mind-map
 * branches (never exported); `boundsOf` is an element's axis-aligned scene rectangle (rotation included).
 * Throws when `frameId` names no live frame.
 */
export function planExport<T extends PlanElement>(
  elements: readonly T[],
  opts: PlanOptions,
  deps: { isHidden?: (id: string) => boolean; boundsOf: (el: T) => PlanRect },
): ExportPlan<T> {
  const live = elements.filter((e) => !e.isDeleted && !deps.isHidden?.(e.id))
  const chosen = opts.ids ? withMembers(live, new Set(opts.ids)) : live
  if (opts.frameId) {
    const frame = live.find((e) => e.id === opts.frameId && e.type === 'frame')
    if (!frame) throw new Error(`export: no frame ${opts.frameId}`)
    return { kind: 'frame', frame, elements: withMembers(live, new Set([frame.id, ...(opts.ids ?? [])])) }
  }
  if (opts.bounds) {
    const b = opts.bounds
    return { kind: 'bounds', bounds: b, elements: chosen.filter((e) => overlaps(deps.boundsOf(e), b)) }
  }
  return { kind: 'elements', elements: chosen, padding: finite(opts.padding, DEFAULT_EXPORT_PADDING) }
}

/**
 * A `bounds` export's element list: copies of the elements re-parented to the synthetic frame (see the
 * header), after the frame itself (built by the caller, the engine's `newFrameElement`).
 */
export function reparentToBounds<T extends PlanElement>(elements: readonly T[], frame: T): T[] {
  return [frame, ...elements.map((e) => ({ ...e, frameId: EXPORT_BOUNDS_FRAME_ID }))]
}

/**
 * The scale an export is drawn at: `scale` (default 1), no more than `maxSide` px on the longer side,
 * and within what browsers can draw. `width`, `height`: the drawn size in scene px.
 */
export function exportScale(
  width: number,
  height: number,
  opts: { scale?: number; maxSide?: number },
  limits: { maxSide: number; maxArea: number } = EXPORT_CANVAS_LIMITS,
): number {
  const w = Math.max(width, 1e-6)
  const h = Math.max(height, 1e-6)
  let s = typeof opts.scale === 'number' && opts.scale > 0 && Number.isFinite(opts.scale) ? opts.scale : 1
  if (opts.maxSide && opts.maxSide > 0) s = Math.min(s, opts.maxSide / Math.max(w, h))
  s = Math.min(s, limits.maxSide / Math.max(w, h), Math.sqrt(limits.maxArea / (w * h)))
  return s
}
