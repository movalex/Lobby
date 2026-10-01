// Renders the board thumbnail on the Excalidraw page (the port of ../render.ts; plan.ts's area rules are
// shared). Areas with up to DETAILED_MAX_SHAPES items go through the engine's own export
// (`canvas.export.canvas` with the exact area as `bounds`, drawn from what the canvas shows: never an
// original, §4.5 "exportToBlob of the start view") with the frames' outlines drawn over it as on the
// board; larger ones through ./schematic.ts. Either way the picture is made once and encoded as WebP
// (PNG where the browser cannot encode WebP, JPEG when those are over the size target).
//
// renderNowSync draws the simplified picture synchronously for a board that closes before the schedule
// rendered the latest changes (F11). The board page tears its canvas down in the same commit that
// unmounts the features, so it draws from a BoardView snapshot (the scene and the start view as the last
// change left them: ./capture.ts keeps it) instead of the live canvas.
import { presentationOrderOf } from '@draftroom/board-ops/elements'
import { THUMBNAIL_MIME_TYPES, THUMBNAIL_TARGET_BYTES, type ThumbnailMimeType } from '@draftroom/contracts'
import {
  type CanvasElement,
  type LobbyCanvas,
  NotImplementedError,
  SINGLE_PAGE_ID,
} from '../../../canvas/api/index.ts'
import {
  chooseArea,
  intersects,
  type Rect,
  rendererFor,
  type ThumbnailFrame,
  thumbnailFrame,
} from '../plan.ts'
import type { RenderResult } from '../scheduler.ts'
import { drawSchematic } from './schematic.ts'

const ENCODINGS: readonly { type: 'webp' | 'jpeg'; quality: number }[] = [
  { type: 'webp', quality: 0.82 },
  { type: 'jpeg', quality: 0.8 },
  { type: 'jpeg', quality: 0.6 },
]
/** Image previews the schematic draws at most (the rest are grey tiles). */
const MAX_IMAGES = 60
const IMAGE_TIMEOUT_MS = 3000
/** A frame's outline on the board (board-ops/elements LOBBY_FRAME_STROKE). */
const FRAME_STROKE = '#bbb'

export interface StartView {
  x: number
  y: number
  w: number
  h: number
  frameId?: string
}

/** What the planner reads: the live canvas, or a snapshot of it (see the header). */
export interface BoardView {
  readonly items: readonly CanvasElement[]
  isHidden(id: string): boolean
  /** an element's visible scene rectangle (clipped by its frame when live), or null */
  boundsOf(el: CanvasElement): Rect | null
  readonly startView: StartView | null
}

const rectOf = (b: { x: number; y: number; width: number; height: number }): Rect => ({
  x: b.x,
  y: b.y,
  w: b.width,
  h: b.height,
})

export function startViewOf(canvas: LobbyCanvas): StartView | null {
  const v = canvas.doc.get('startView') as Partial<StartView> | undefined
  if (!v || typeof v !== 'object') return null
  const { x, y, w, h, frameId } = v
  if (![x, y, w, h].every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  if ((w as number) <= 0 || (h as number) <= 0) return null
  return { x, y, w, h, ...(typeof frameId === 'string' ? { frameId } : {}) } as StartView
}

/** The live canvas as a BoardView. */
export function liveView(canvas: LobbyCanvas): BoardView {
  return {
    items: canvas.items(),
    isHidden: (id) => canvas.isHidden(id),
    boundsOf: (el) => {
      const b = canvas.visibleBounds(el.id)
      return b ? rectOf(b) : null
    },
    startView: startViewOf(canvas),
  }
}

/** An element's own rectangle (no rotation, no frame clip): enough for a card-sized drawing. */
function ownRect(el: CanvasElement): Rect | null {
  const pts = (el as { points?: readonly (readonly [number, number])[] }).points
  if ((el.type === 'arrow' || el.type === 'line' || el.type === 'freedraw') && pts?.length) {
    const xs = pts.map((p) => el.x + p[0])
    const ys = pts.map((p) => el.y + p[1])
    const x = Math.min(...xs)
    const y = Math.min(...ys)
    return { x, y, w: Math.max(1, Math.max(...xs) - x), h: Math.max(1, Math.max(...ys) - y) }
  }
  return Number.isFinite(el.x) && Number.isFinite(el.y)
    ? { x: el.x, y: el.y, w: el.width, h: el.height }
    : null
}

/** A snapshot BoardView: the elements and start view kept by the capture, with their own rectangles. */
export function snapshotView(
  items: readonly CanvasElement[],
  startView: StartView | null,
  isHidden: (id: string) => boolean,
): BoardView {
  return { items, isHidden, boundsOf: ownRect, startView }
}

const isLabel = (e: CanvasElement) => e.type === 'text' && !!e.containerId

/** The board's visible items (labels drawn with their containers) and the union of their bounds. */
function content(view: BoardView) {
  const shown: { el: CanvasElement; b: Rect }[] = []
  let bounds: Rect | null = null
  for (const el of view.items) {
    if (el.isDeleted || isLabel(el) || view.isHidden(el.id)) continue
    const r = view.boundsOf(el)
    if (!r || r.w <= 0 || r.h <= 0) continue
    shown.push({ el, b: r })
    bounds = bounds
      ? {
          x: Math.min(bounds.x, r.x),
          y: Math.min(bounds.y, r.y),
          w: Math.max(bounds.x + bounds.w, r.x + r.w) - Math.min(bounds.x, r.x),
          h: Math.max(bounds.y + bounds.h, r.y + r.h) - Math.min(bounds.y, r.y),
        }
      : r
  }
  return { shown, bounds }
}

/**
 * The frame the card shows: the first visible frame in presentation order (what Present opens on; frames
 * set to skip are left out), unless frames hold images: then the one with the most of them by area (F13:
 * a mood board's card shows its imagery, not its prompts).
 */
function firstFrame(view: BoardView): Rect | null {
  const shown = presentationOrderOf(view.items)
    .filter((f) => !f.skip && !view.isHidden(f.id) && f.bounds.w > 0 && f.bounds.h > 0)
    .map((f) => ({ id: f.id, bounds: f.bounds }))
  if (!shown.length) return null
  const index = new Map(shown.map((f, i) => [f.id, i]))
  const area = shown.map(() => 0)
  for (const e of view.items) {
    if (e.type !== 'image' || !e.frameId || e.isDeleted || view.isHidden(e.id)) continue
    const i = index.get(e.frameId)
    const b = view.boundsOf(e)
    if (i !== undefined && b) area[i] = (area[i] ?? 0) + b.w * b.h
  }
  let best = 0
  area.forEach((a, i) => {
    if (a > (area[best] ?? 0)) best = i
  })
  return (shown[best] ?? shown[0])?.bounds ?? null
}

/** Whether the board has anything a thumbnail could show. */
export const boardHasContent = (canvas: LobbyCanvas): boolean => content(liveView(canvas)).bounds !== null

/**
 * The person is in the middle of something: a press, drag, resize, pan or drawing, a moving camera,
 * text being edited or typed in a field, a menu or dialog open, or presenting. (capture.ts adds "any
 * pointer, key or wheel input in the last few seconds".)
 */
export function isBusy(canvas: LobbyCanvas, menusOpen: () => boolean): boolean {
  const g = canvas.gesture()
  if (g !== 'idle' && g !== 'tool') return true
  if (canvas.viewport.moving() || canvas.editingId() !== null || menusOpen()) return true
  if (typeof document === 'undefined') return false
  if (document.querySelector('dialog[open]') !== null) return true
  if (document.documentElement.hasAttribute('data-dr-presenting')) return true
  const a = document.activeElement
  return (
    a instanceof HTMLElement && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)
  )
}

type Plan =
  | { kind: 'empty' }
  | { kind: 'too-many' }
  | {
      kind: 'draw'
      elements: CanvasElement[]
      /** the frames in the area (their outlines go over the engine's export) */
      frames: Rect[]
      frame: ThumbnailFrame
      renderer: 'detailed' | 'schematic'
      count: number
    }

export function planThumbnail(view: BoardView): Plan {
  const start = view.startView
  let startFrame: Rect | null = null
  if (start?.frameId) {
    const f = view.items.find((e) => e.id === start.frameId)
    const b = f && !f.isDeleted && f.type === 'frame' ? view.boundsOf(f) : null
    if (b) startFrame = b
  }
  const { shown, bounds } = content(view)
  const choice = chooseArea({
    startView: start
      ? { pageId: SINGLE_PAGE_ID, area: { x: start.x, y: start.y, w: start.w, h: start.h } }
      : null,
    startFrame,
    pages: [{ pageId: SINGLE_PAGE_ID, bounds, firstFrame: bounds ? firstFrame(view) : null }],
  })
  if (choice.kind === 'empty') return { kind: 'empty' }
  const frame = thumbnailFrame(choice.area, choice.fit)
  if (!frame) return { kind: 'empty' }
  // Only what shows inside the area is drawn (a start view over part of a big board stays cheap).
  const inArea = shown.filter((s) => intersects(s.b, frame.box))
  if (!inArea.length) return { kind: 'empty' }
  const renderer = rendererFor(inArea.length)
  if (!renderer) return { kind: 'too-many' }
  // the drawing needs the labels too (bars for their containers' text)
  const keep = new Set(inArea.map((s) => s.el.id))
  const elements = view.items.filter((e) => keep.has(e.id) || (isLabel(e) && keep.has(e.containerId ?? '')))
  const frames = inArea.filter((s) => s.el.type === 'frame').map((s) => s.b)
  return { kind: 'draw', elements, frames, frame, renderer, count: inArea.length }
}

/** Waits for an idle period (or a short timeout where requestIdleCallback does not exist). */
function idle(timeoutMs = 2000): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function')
      requestIdleCallback(() => resolve(), { timeout: timeoutMs })
    else setTimeout(resolve, 50)
  })
}

const isAccepted = (t: string): t is ThumbnailMimeType =>
  (THUMBNAIL_MIME_TYPES as readonly string[]).includes(t)

type Encoder = (enc: { type: 'webp' | 'jpeg'; quality: number }) => Promise<Blob | null>

const encoderOf =
  (c: HTMLCanvasElement): Encoder =>
  (enc) =>
    new Promise<Blob | null>((resolve) => c.toBlob(resolve, `image/${enc.type}`, enc.quality))

/**
 * The engine's own export of the exact area on a canvas of the card's size, with the frames' outlines
 * over it (an export of an exact area draws frames without them).
 */
async function detailed(
  canvas: LobbyCanvas,
  frame: ThumbnailFrame,
  frames: readonly Rect[],
): Promise<Encoder | null> {
  const { box, scale, width, height } = frame
  const drawn = await canvas.export.canvas({
    bounds: { x: box.x, y: box.y, width: box.w, height: box.h },
    scale,
    background: true,
    theme: 'light',
    files: 'canvas',
  })
  const out = document.createElement('canvas')
  out.width = width
  out.height = height
  const ctx = out.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(drawn, 0, 0, drawn.width, drawn.height, 0, 0, box.w * scale, box.h * scale)
  ctx.strokeStyle = FRAME_STROKE
  ctx.lineWidth = 1
  for (const f of frames)
    ctx.strokeRect((f.x - box.x) * scale + 0.5, (f.y - box.y) * scale + 0.5, f.w * scale, f.h * scale)
  return encoderOf(out)
}

/** Previews for the schematic's images: the files' URLs once media (3g) lands `files.urlOf`, else none. */
async function loadImages(canvas: LobbyCanvas, elements: readonly CanvasElement[]) {
  const out = new Map<string, HTMLImageElement>()
  const wanted = elements.filter((e) => e.type === 'image').slice(0, MAX_IMAGES)
  await Promise.all(
    wanted.map(async (e) => {
      try {
        const url = await canvas.files.urlOf(e.id)
        if (!url) return
        const img = new Image()
        img.decoding = 'async'
        img.src = url
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), IMAGE_TIMEOUT_MS),
        )
        await Promise.race([img.decode(), timeout])
        out.set(e.id, img)
      } catch (err) {
        if (err instanceof NotImplementedError) return
        // a grey tile instead
      }
    }),
  )
  return out
}

/**
 * `force`: render now (the tab is being hidden). Otherwise wait for an idle period and give up with
 * 'busy' if `busy()` says the person is in the middle of something by then.
 */
export async function renderThumbnail(
  canvas: LobbyCanvas,
  opts: { force: boolean; busy: () => boolean },
): Promise<RenderResult> {
  if (!opts.force) {
    await idle()
    if (opts.busy()) return { kind: 'busy' }
  }
  const plan = planThumbnail(liveView(canvas))
  if (plan.kind === 'empty') return { kind: 'empty' }
  if (plan.kind === 'too-many') return { kind: 'skipped' }
  const { width, height } = plan.frame
  let encode: Encoder | null
  if (plan.renderer === 'detailed') encode = await detailed(canvas, plan.frame, plan.frames)
  else {
    const images = await loadImages(canvas, plan.elements)
    const drawn = drawSchematic(plan.elements, plan.frame, images)
    encode = drawn ? encoderOf(drawn) : null
  }
  if (!encode) return { kind: 'empty' }
  for (const enc of ENCODINGS) {
    const blob = await encode(enc)
    if (!blob || !isAccepted(blob.type)) continue
    if (blob.size <= THUMBNAIL_TARGET_BYTES)
      return { kind: 'image', blob, type: blob.type, width, height, renderer: plan.renderer }
  }
  return { kind: 'skipped' }
}

/** A `data:` URL from canvas.toDataURL as a Blob, synchronously. */
function dataUrlToBlob(url: string): Blob | null {
  const m = /^data:([^;,]+);base64,(.*)$/.exec(url)
  if (!m?.[1] || m[2] === undefined) return null
  const bin = atob(m[2])
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: m[1] })
}

/**
 * The thumbnail drawn right now, without awaiting anything (F11): always the simplified drawing, with
 * images as grey tiles, encoded with toDataURL. Never throws.
 */
export function renderNowSync(view: BoardView): RenderResult & { standIn?: boolean } {
  try {
    const plan = planThumbnail(view)
    if (plan.kind === 'empty') return { kind: 'empty' }
    if (plan.kind === 'too-many') return { kind: 'skipped' }
    const drawn = drawSchematic(plan.elements, plan.frame)
    if (!drawn) return { kind: 'skipped' }
    const { width, height } = plan.frame
    // DANA2-06: a stand-in when the schedule would have drawn the detailed picture (capture.ts renders
    // that one on the next open).
    const standIn = plan.renderer === 'detailed'
    for (const enc of ENCODINGS) {
      const blob = dataUrlToBlob(drawn.toDataURL(`image/${enc.type}`, enc.quality))
      if (!blob || !isAccepted(blob.type)) continue
      if (blob.size <= THUMBNAIL_TARGET_BYTES)
        return { kind: 'image', blob, type: blob.type, width, height, renderer: 'schematic', standIn }
    }
    return { kind: 'skipped' }
  } catch {
    return { kind: 'skipped' }
  }
}
