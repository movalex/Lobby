// Checkpoint preview without a second <Excalidraw> (docs/EXCALIDRAW-MIGRATION.md §4.6; spike check A11).
//
// Two Excalidraw instances on one page share module-global state (the editor jotai store, window flags,
// font caches) [REV], so a checkpoint is drawn with the engine's exporter instead: exportToCanvas
// renders the checkpoint's elements into bitmaps, and Lobby pans and zooms over those bitmaps itself.
//
// exportToCanvas always frames the content: it draws with scrollX = -minX + padding and zoom 1 over the
// bounds of the root elements, plus frame name labels it adds above frames
// (@excalidraw/excalidraw dist/dev/chunk-FN755BR4.js:4592-4668, getCanvasSize :4845, addFrameLabelsAsTextElements
// :4540). It ignores the appState's scroll and zoom. So the preview never passes a camera to it; it
// controls the output through `getDimensions` (canvas size and scale) and places each bitmap itself:
//   - overview: the whole checkpoint once, at the largest scale that fits `maxPixels`, framed by an
//     invisible anchor rectangle that encloses everything, so the bitmap's origin is known exactly;
//   - detail: when the view zooms in past the overview's resolution, only the elements that intersect
//     the view are rendered at the view's scale, 150 ms after the camera stops. Frames are clipped to the
//     view plus a margin in the local copy (a 4,000-unit frame would otherwise make the bitmap cover the
//     whole frame), and an anchor again fixes the origin.
// The checkpoint's elements are a local copy: nothing here touches the live board, its undo stack or sync.
//
// Wave L (L7-1, W7): outlines over the bitmaps (what changed since the checkpoint, what is picked for a
// restore), drawn by Lobby in view space after the bitmaps on every paint, and a click (a press that does not
// drag) reported to the caller, which picks the element under it.

import { getCommonBounds, getElementBounds } from '@excalidraw/element'
import type { ElementsMap, ExcalidrawElement, NonDeletedExcalidrawElement } from '@excalidraw/element/types'
import { exportToCanvas } from '@excalidraw/excalidraw'
import type { BinaryFiles } from '@excalidraw/excalidraw/types'

/** Lobby's camera: the scene point at the view's top-left corner, and the zoom (CSS px per scene unit). */
export interface PreviewCamera {
  x: number
  y: number
  zoom: number
}

export interface PreviewOptions {
  /** The checkpoint's elements (deleted ones are skipped). */
  elements: readonly ExcalidrawElement[]
  /** Runtime files for the checkpoint's images (blob: URLs from Lobby's loader). */
  files: BinaryFiles
  background?: string
  /** The view's own fill around the bitmaps (default: `background`; the dark theme's page colour). */
  fill?: string
  dark?: boolean
  /** Pixel budget per bitmap (default 16.7 M: 4096 × 4096). */
  maxPixels?: number
  minZoom?: number
  maxZoom?: number
  /** Delay after the last camera change before the detail pass (ms). */
  detailDelayMs?: number
}

interface Bitmap {
  canvas: HTMLCanvasElement
  /** Scene coordinates of the bitmap's top-left pixel. */
  originX: number
  originY: number
  /** Bitmap pixels per scene unit. */
  scale: number
  /** The camera zoom × dpr it was made for (detail only). */
  forScale?: number
  /** Scene rect it is valid for (detail only). */
  rect?: { x: number; y: number; w: number; h: number }
}

/** What an outline says (its colour; `added` is dashed: it is not in the checkpoint, it is where it is now). */
export type PreviewOutlineTone = 'removed' | 'added' | 'geometry' | 'text' | 'style'
export interface PreviewOutline {
  /** scene box */
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /** what changed (absent: an unchanged element that is only picked) */
  readonly tone?: PreviewOutlineTone
  /** picked for a restore: a thicker line and a light fill */
  readonly selected?: boolean
}
/** Colours readable on the light board and under the dark export filter's page alike. */
const OUTLINE_COLOURS: Record<PreviewOutlineTone, string> = {
  removed: '#e03131',
  added: '#2f9e44',
  geometry: '#e8590c',
  text: '#1971c2',
  style: '#9c36b5',
}
const SELECTED_COLOUR = '#5f3dc4'
/** A press that moves less than this (CSS px) is a click, not a drag. */
const CLICK_SLOP_PX = 4

export interface PreviewStats {
  overviewMs: number
  overviewScale: number
  overviewPixels: number
  detailRenders: number
  lastDetailMs: number
  lastDetailElements: number
  draws: number
}

/** Enough to enclose frame labels, which exportToCanvas adds ~20 units above each frame. */
const MARGIN = 64

const ANCHOR_BASE = {
  type: 'rectangle',
  angle: 0,
  strokeColor: 'transparent',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeWidth: 1,
  strokeStyle: 'solid',
  roughness: 0,
  opacity: 100,
  groupIds: [],
  frameId: null,
  roundness: null,
  seed: 1,
  version: 1,
  versionNonce: 1,
  isDeleted: false,
  boundElements: null,
  updated: 1,
  link: null,
  locked: false,
  index: null,
} as const

/** An invisible rectangle that becomes the export's top-left (it encloses every other element). */
function anchor(id: string, x: number, y: number, w: number, h: number): NonDeletedExcalidrawElement {
  return { ...ANCHOR_BASE, id, x, y, width: w, height: h } as unknown as NonDeletedExcalidrawElement
}

const isFrameLike = (e: ExcalidrawElement) => e.type === 'frame' || e.type === 'magicframe'

export class CheckpointPreview {
  private readonly live: NonDeletedExcalidrawElement[]
  private readonly map: ElementsMap
  private overview: Bitmap | null = null
  private detail: Bitmap | null = null
  private cam: PreviewCamera = { x: 0, y: 0, zoom: 1 }
  private detailTimer: ReturnType<typeof setTimeout> | null = null
  private detailSeq = 0
  private raf = 0
  private disposed = false
  private readonly listeners: (() => void)[] = []
  private outlines: readonly PreviewOutline[] = []
  readonly stats: PreviewStats = {
    overviewMs: 0,
    overviewScale: 0,
    overviewPixels: 0,
    detailRenders: 0,
    lastDetailMs: 0,
    lastDetailElements: 0,
    draws: 0,
  }
  /** Scene bounds of the checkpoint (without margin). */
  readonly bounds: readonly [number, number, number, number]

  private readonly view: HTMLCanvasElement
  private readonly opts: PreviewOptions

  constructor(view: HTMLCanvasElement, opts: PreviewOptions) {
    this.view = view
    this.opts = opts
    this.live = opts.elements.filter((e) => !e.isDeleted) as NonDeletedExcalidrawElement[]
    this.map = new Map(this.live.map((e) => [e.id, e])) as unknown as ElementsMap
    this.bounds = this.live.length ? getCommonBounds(this.live) : [0, 0, 1, 1]
  }

  private get dpr() {
    return window.devicePixelRatio || 1
  }
  private get maxPixels() {
    return this.opts.maxPixels ?? 4096 * 4096
  }

  /** Renders the overview and fits the camera. */
  async init(): Promise<void> {
    const [minX, minY, maxX, maxY] = this.bounds
    const x = minX - MARGIN
    const y = minY - MARGIN
    const w = maxX - minX + 2 * MARGIN
    const h = maxY - minY + 2 * MARGIN
    const scale = Math.min(2, Math.sqrt(this.maxPixels / (w * h)))
    const t0 = performance.now()
    const canvas = await this.render([anchor('lobby-preview-anchor', x, y, w, h), ...this.live], scale)
    this.stats.overviewMs = Math.round(performance.now() - t0)
    this.stats.overviewScale = scale
    this.stats.overviewPixels = canvas.width * canvas.height
    this.overview = { canvas, originX: x, originY: y, scale }
    this.fit()
  }

  private async render(elements: readonly NonDeletedExcalidrawElement[], scale: number) {
    return exportToCanvas({
      elements,
      files: this.opts.files,
      appState: {
        exportBackground: true,
        viewBackgroundColor: this.opts.background ?? '#ffffff',
        exportWithDarkMode: this.opts.dark ?? false,
      },
      exportPadding: 0,
      getDimensions: (w: number, h: number) => ({
        width: Math.ceil(w * scale),
        height: Math.ceil(h * scale),
        scale,
      }),
    })
  }

  get camera(): PreviewCamera {
    return { ...this.cam }
  }

  /** CSS px size of the view. */
  private viewSize() {
    const r = this.view.getBoundingClientRect()
    return { w: Math.max(1, r.width), h: Math.max(1, r.height) }
  }

  setCamera(cam: PreviewCamera): void {
    const zoom = Math.min(this.opts.maxZoom ?? 8, Math.max(this.opts.minZoom ?? 0.01, cam.zoom))
    this.cam = { x: cam.x, y: cam.y, zoom }
    this.scheduleDraw()
    this.scheduleDetail()
  }

  fit(padding = 24): void {
    const { w, h } = this.viewSize()
    const [minX, minY, maxX, maxY] = this.bounds
    const zoom = Math.min((w - 2 * padding) / (maxX - minX), (h - 2 * padding) / (maxY - minY))
    this.setCamera({
      x: minX - (w / zoom - (maxX - minX)) / 2,
      y: minY - (h / zoom - (maxY - minY)) / 2,
      zoom,
    })
  }

  /** Pans by a CSS px delta (drag). */
  panBy(dx: number, dy: number): void {
    this.setCamera({
      x: this.cam.x - dx / this.cam.zoom,
      y: this.cam.y - dy / this.cam.zoom,
      zoom: this.cam.zoom,
    })
  }

  /** Zooms by `factor` keeping the scene point under (vx, vy) CSS px (view-relative) fixed. */
  zoomAt(factor: number, vx: number, vy: number): void {
    const sx = this.cam.x + vx / this.cam.zoom
    const sy = this.cam.y + vy / this.cam.zoom
    const zoom = Math.min(this.opts.maxZoom ?? 8, Math.max(this.opts.minZoom ?? 0.01, this.cam.zoom * factor))
    this.setCamera({ x: sx - vx / zoom, y: sy - vy / zoom, zoom })
  }

  sceneToView(x: number, y: number): { x: number; y: number } {
    return { x: (x - this.cam.x) * this.cam.zoom, y: (y - this.cam.y) * this.cam.zoom }
  }

  viewToScene(x: number, y: number): { x: number; y: number } {
    return { x: this.cam.x + x / this.cam.zoom, y: this.cam.y + y / this.cam.zoom }
  }

  /** The outlines painted over the bitmaps from the next paint on (scene boxes). */
  setOutlines(outlines: readonly PreviewOutline[]): void {
    this.outlines = outlines
    this.scheduleDraw()
  }

  /**
   * Drag to pan, wheel to zoom (Ctrl/Cmd+wheel or a pinch: zoom; plain wheel: pan), as on the board. `onClick`:
   * a press released without dragging, at its view point (CSS px from the view's top-left).
   */
  attachInteraction(onClick?: (x: number, y: number, additive: boolean) => void): void {
    const el = this.view
    let drag: { id: number; x: number; y: number; startX: number; startY: number; moved: boolean } | null =
      null
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return
      drag = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        startX: e.clientX,
        startY: e.clientY,
        moved: false,
      }
      el.setPointerCapture(e.pointerId)
    }
    const move = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > CLICK_SLOP_PX) drag.moved = true
      this.panBy(e.clientX - drag.x, e.clientY - drag.y)
      drag = { ...drag, x: e.clientX, y: e.clientY }
    }
    const up = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return
      const click = !drag.moved && e.type === 'pointerup'
      drag = null
      if (click && onClick) {
        const r = el.getBoundingClientRect()
        onClick(e.clientX - r.left, e.clientY - r.top, e.shiftKey || e.ctrlKey || e.metaKey)
      }
    }
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      if (e.ctrlKey || e.metaKey)
        this.zoomAt(Math.exp(-e.deltaY / 300), e.clientX - r.left, e.clientY - r.top)
      else this.panBy(-e.deltaX, -e.deltaY)
    }
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
    el.addEventListener('wheel', wheel, { passive: false })
    this.listeners.push(() => {
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      el.removeEventListener('wheel', wheel)
    })
  }

  private scheduleDraw() {
    if (this.raf || this.disposed) return
    this.raf = requestAnimationFrame(() => {
      this.raf = 0
      this.draw()
    })
  }

  /** Paints the current camera now (the overview, then the detail bitmap when it matches). */
  draw(): void {
    if (this.disposed) return
    const { w, h } = this.viewSize()
    const dpr = this.dpr
    const pw = Math.round(w * dpr)
    const ph = Math.round(h * dpr)
    if (this.view.width !== pw || this.view.height !== ph) {
      this.view.width = pw
      this.view.height = ph
    }
    const ctx = this.view.getContext('2d')
    if (!ctx) return
    this.stats.draws++
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = this.opts.fill ?? this.opts.background ?? '#ffffff'
    ctx.fillRect(0, 0, pw, ph)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    const k = this.cam.zoom * dpr // device px per scene unit
    const paint = (b: Bitmap) => {
      ctx.drawImage(
        b.canvas,
        (b.originX - this.cam.x) * k,
        (b.originY - this.cam.y) * k,
        (b.canvas.width / b.scale) * k,
        (b.canvas.height / b.scale) * k,
      )
    }
    if (this.overview) paint(this.overview)
    const d = this.detail
    if (d?.forScale && Math.abs(d.forScale - k) / k < 0.01) paint(d)
    if (this.outlines.length) this.paintOutlines(ctx, k, dpr)
  }

  private paintOutlines(ctx: CanvasRenderingContext2D, k: number, dpr: number) {
    const pad = 4 * dpr
    for (const o of this.outlines) {
      const x = (o.x - this.cam.x) * k - pad
      const y = (o.y - this.cam.y) * k - pad
      const w = o.width * k + 2 * pad
      const h = o.height * k + 2 * pad
      ctx.setLineDash(o.tone === 'added' ? [6 * dpr, 4 * dpr] : [])
      if (o.selected) {
        ctx.fillStyle = 'rgba(95, 61, 196, 0.12)'
        ctx.fillRect(x, y, w, h)
        ctx.lineWidth = 3 * dpr
        ctx.strokeStyle = SELECTED_COLOUR
        ctx.strokeRect(x - dpr, y - dpr, w + 2 * dpr, h + 2 * dpr)
      }
      if (!o.tone) continue
      ctx.lineWidth = 2 * dpr
      ctx.strokeStyle = OUTLINE_COLOURS[o.tone]
      ctx.strokeRect(x, y, w, h)
    }
    ctx.setLineDash([])
  }

  /** Whether the next paint uses a detail bitmap (the overview is too coarse for the zoom). */
  needsDetail(): boolean {
    return !!this.overview && this.cam.zoom * this.dpr > this.overview.scale * 1.05
  }

  private scheduleDetail() {
    if (this.detailTimer) clearTimeout(this.detailTimer)
    this.detailTimer = null
    if (!this.needsDetail()) return
    this.detailTimer = setTimeout(() => void this.renderDetail(), this.opts.detailDelayMs ?? 150)
  }

  /** Renders the elements in view at the view's scale (called 150 ms after the camera stops). */
  async renderDetail(): Promise<void> {
    if (this.disposed || !this.needsDetail()) return
    const seq = ++this.detailSeq
    const { w, h } = this.viewSize()
    const k = this.cam.zoom * this.dpr
    const view = { x: this.cam.x, y: this.cam.y, w: w / this.cam.zoom, h: h / this.cam.zoom }
    const m = MARGIN / Math.max(1, this.cam.zoom) + 2
    const region = { x: view.x - m, y: view.y - m, w: view.w + 2 * m, h: view.h + 2 * m }
    const intersects = (e: ExcalidrawElement) => {
      const [x1, y1, x2, y2] = getElementBounds(e, this.map)
      return x2 >= region.x && x1 <= region.x + region.w && y2 >= region.y && y1 <= region.y + region.h
    }
    const picked: NonDeletedExcalidrawElement[] = []
    for (const e of this.live) {
      if (!intersects(e)) continue
      if (isFrameLike(e)) {
        // clip the frame (a local copy) to the region: its outline and name then fall outside the view
        // where the real frame continues, and its children are clipped to the region too
        const x1 = Math.max(e.x, region.x)
        const y1 = Math.max(e.y, region.y)
        const x2 = Math.min(e.x + e.width, region.x + region.w)
        const y2 = Math.min(e.y + e.height, region.y + region.h)
        picked.push({ ...e, x: x1, y: y1, width: Math.max(1, x2 - x1), height: Math.max(1, y2 - y1) })
      } else picked.push(e)
    }
    // the region's top-left must be the export's top-left: extend the anchor over anything that starts
    // further up or left (a big shape, frame labels)
    const [bx, by] = picked.length ? getCommonBounds(picked) : [region.x, region.y]
    const ax = Math.min(region.x, bx - MARGIN)
    const ay = Math.min(region.y, by - MARGIN)
    const aw = region.x + region.w - ax
    const ah = region.y + region.h - ay
    const scale = Math.min(k, Math.sqrt(this.maxPixels / (aw * ah)))
    const t0 = performance.now()
    const canvas = await exportToCanvas({
      elements: [anchor('lobby-preview-detail-anchor', ax, ay, aw, ah), ...picked],
      files: this.opts.files,
      appState: {
        exportBackground: false,
        viewBackgroundColor: this.opts.background ?? '#ffffff',
        exportWithDarkMode: this.opts.dark ?? false,
      },
      exportPadding: 0,
      // only the anchor's box: anything beyond its right or bottom edge is out of view
      getDimensions: () => ({ width: Math.ceil(aw * scale), height: Math.ceil(ah * scale), scale }),
    })
    if (this.disposed || seq !== this.detailSeq) return
    this.stats.detailRenders++
    this.stats.lastDetailMs = Math.round(performance.now() - t0)
    this.stats.lastDetailElements = picked.length
    // forScale is the camera it was made for; a bitmap capped by maxPixels is coarser but still used
    this.detail = { canvas, originX: ax, originY: ay, scale, forScale: k, rect: region }
    this.draw()
  }

  dispose(): void {
    this.disposed = true
    if (this.detailTimer) clearTimeout(this.detailTimer)
    if (this.raf) cancelAnimationFrame(this.raf)
    for (const off of this.listeners.splice(0)) off()
    this.overview = null
    this.detail = null
  }
}
