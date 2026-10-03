/**
 * OWNER: 3b (navigation). The level-of-detail pass on the Excalidraw board page (docs/EXCALIDRAW-
 * MIGRATION.md §8.5): below zoom 0.2, every frame whose bitmap is current is drawn as that one bitmap and
 * its members are left out of the engine's render (./cull.ts); a frame's changes make it stale, drawn
 * live at once and re-rendered once quiet (./model.ts). Browser only; the board page installs it once
 * per engine (canvas/board/session.ts `attach`) and disposes it with the engine.
 *
 * Pieces:
 *  - the bitmaps: Lobby's own frame export (canvas/export/scene.ts `exportSceneCanvas` with `frameId`:
 *    the frame's members clipped to it, no outline or title, what the canvas shows now: `files: 'canvas'`,
 *    nothing fetched), transparent, in the board's theme, at 0.2 × the device pixel ratio (capped);
 *  - the layer: one <canvas> inside Excalidraw's static-canvas wrapper, right after the static canvas, so
 *    it paints above the static scene (the frames' outlines and names, loose elements) and below the
 *    interactive canvas (selection, handles, the pointer's hover): `pointer-events: none`;
 *  - the schedule: one render at a time, frames in view first, yielding between renders; nothing renders
 *    while the pass is off (zoomed in), and the bitmaps are kept for the next time.
 *
 * What does not change: hit tests, selection, editing, exports and every document value (the pass only
 * changes what the static canvas draws); presence and overlays (Lobby's DOM layers); edit visibility (a
 * changed frame is live until it is quiet).
 *
 * `window.__lobbyLod` (dev-auth builds): `setEnabled(on)` and `state()` for the fps measurement
 * (e2e/excalidraw/navigation-lod-fps.spec.ts) and the specs.
 */
import type { BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { DEV_AUTH_ENABLED } from '../../lib/identity.ts'
import type { CanvasChange, LobbyCanvas } from '../api/lobby-canvas.ts'
import type { LodTarget } from './cull.ts'
import { installFrameNameGuard } from './frame-names.ts'
import { type LodBitmap, type LodElement, LodModel, type LodRect, lodActiveAt, lodScale } from './model.ts'

export { createLodTarget, type LodTarget } from './cull.ts'
export { LOD_ZOOM } from './model.ts'

export interface LodOptions {
  /** the engine (the real API: reads and the frame exports) */
  readonly api: ExcalidrawImperativeAPI
  /** the render seam the board overrides were installed on (./cull.ts) */
  readonly target: LodTarget
  readonly canvas: LobbyCanvas
  /** collapsed mind-map branches (never drawn, never exported) */
  readonly isHidden: (id: string) => boolean
  /** the board's canvas region (Excalidraw's canvases are inside it) */
  readonly root: HTMLElement
  /** default true */
  readonly enabled?: boolean
}

export interface LodState {
  readonly enabled: boolean
  readonly active: boolean
  readonly zoom: number
  readonly frames: number
  readonly ready: number
  readonly stale: number
  readonly rendering: number
  readonly busy: number
  readonly culled: number
  /** bitmaps drawn by the layer in its last paint */
  readonly drawn: number
  readonly renders: number
  readonly renderMs: number
  readonly failures: number
  readonly layer: boolean
  /** W5-51: frames whose name is hidden because it would run into a neighbouring frame (./frame-names.ts) */
  readonly crowdedNames: number
}

export interface LodHandle {
  setEnabled(on: boolean): void
  state(): LodState
  dispose(): void
}

/** An ImageBitmap where the browser has them (a GPU texture drawn without a re-upload per paint). */
type Image = ImageBitmap | HTMLCanvasElement
type Bitmap = LodBitmap<Image>

const closeImage = (image: Image) => {
  if ('close' in image) image.close()
  else image.width = 0
}

const now = () => performance.now()

/** Device pixels per scene pixel, rounded so that a zoom that did not really move reuses its copies. */
const scaleKey = (zoom: number, dpr: number) => Math.round(zoom * dpr * 1e4) / 1e4

/**
 * The frame bitmaps, drawn at the camera, between Excalidraw's static and interactive canvases. Each
 * paint draws every bitmap in view once; a bitmap drawn at a new scale is resampled on every paint (a
 * zoom in progress), so once the scale holds for two paints the layer asks the browser for a copy at
 * that size (`createImageBitmap` with a resize, off the main thread) and a pan then draws the copies
 * pixel for pixel. Measured on the heavy board: 20 downscaled draws cost ~6.5 ms of main thread per paint.
 */
class LodLayer {
  readonly el: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D | null
  private readonly win: Window
  /** a copy of each bitmap at the last settled scale */
  private readonly scaled = new Map<Image, { key: number; image: ImageBitmap }>()
  /** the scale a copy is being made at */
  private readonly making = new Map<Image, number>()
  private lastKey = 0
  drawn = 0
  /** a copy arrived: the owner repaints */
  onCopy: () => void = () => {}

  constructor(doc: Document, win: Window) {
    this.win = win
    this.el = doc.createElement('canvas')
    this.el.setAttribute('data-lobby-lod', '')
    this.el.setAttribute('aria-hidden', 'true')
    this.el.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;'
    this.ctx = this.el.getContext('2d')
  }

  /** Keeps the layer right after the static canvas (Excalidraw's wrapper keeps foreign children). */
  mount(root: HTMLElement): boolean {
    const staticCanvas = root.querySelector('canvas.excalidraw__canvas.static')
    const wrapper = staticCanvas?.parentElement
    if (!staticCanvas || !wrapper) return false
    if (this.el.previousElementSibling !== staticCanvas) staticCanvas.after(this.el)
    return true
  }

  paint(
    bitmaps: readonly { bitmap: Bitmap }[],
    view: { scrollX: number; scrollY: number; zoom: number; width: number; height: number },
    dpr: number,
  ): boolean {
    const ctx = this.ctx
    if (!ctx) return true
    const w = Math.max(1, Math.round(view.width * dpr))
    const h = Math.max(1, Math.round(view.height * dpr))
    if (this.el.width !== w || this.el.height !== h) {
      this.el.width = w
      this.el.height = h
      this.el.style.width = `${view.width}px`
      this.el.style.height = `${view.height}px`
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, w, h)
    this.drawn = 0
    const key = scaleKey(view.zoom, dpr)
    const settled = key === this.lastKey
    this.lastKey = key
    if (!bitmaps.length) return true
    const s = dpr * view.zoom
    ctx.imageSmoothingEnabled = true
    // the scene rectangle in view (only bitmaps that touch it are drawn)
    const vx = -view.scrollX
    const vy = -view.scrollY
    const vw = view.width / view.zoom
    const vh = view.height / view.zoom
    for (const { bitmap } of bitmaps) {
      const r = bitmap.rect
      if (r.x > vx + vw || r.y > vy + vh || r.x + r.width < vx || r.y + r.height < vy) continue
      const dx = s * (r.x + view.scrollX)
      const dy = s * (r.y + view.scrollY)
      const copy = this.scaled.get(bitmap.image)
      if (copy && copy.key === key) ctx.drawImage(copy.image, dx, dy)
      else {
        ctx.imageSmoothingQuality = 'low'
        ctx.drawImage(bitmap.image, dx, dy, r.width * s, r.height * s)
        if (settled) this.makeCopy(bitmap, key, s)
      }
      this.drawn++
    }
    return settled
  }

  private makeCopy(bitmap: Bitmap, key: number, s: number): void {
    const src = bitmap.image
    if (this.making.get(src) === key || typeof this.win.createImageBitmap !== 'function') return
    const width = Math.max(1, Math.round(bitmap.rect.width * s))
    const height = Math.max(1, Math.round(bitmap.rect.height * s))
    this.making.set(src, key)
    this.win
      .createImageBitmap(src, { resizeWidth: width, resizeHeight: height, resizeQuality: 'medium' })
      .then(
        (image) => {
          if (this.making.get(src) !== key || !this.ctx) {
            image.close()
            return
          }
          this.making.delete(src)
          this.scaled.get(src)?.image.close()
          this.scaled.set(src, { key, image })
          this.onCopy()
        },
        () => {
          if (this.making.get(src) === key) this.making.delete(src)
        },
      )
  }

  /** A bitmap is let go of: its copy too. */
  forget(image: Image): void {
    this.scaled.get(image)?.image.close()
    this.scaled.delete(image)
    this.making.delete(image)
  }

  clear(): void {
    const ctx = this.ctx
    if (!ctx || !this.drawn) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.el.width, this.el.height)
    this.drawn = 0
  }

  remove(): void {
    for (const c of this.scaled.values()) c.image.close()
    this.scaled.clear()
    this.making.clear()
    this.el.remove()
    this.ctx = null
  }
}

/** The pass on one board page (see the header). */
export function installLod(o: LodOptions): LodHandle {
  const { api, target, canvas } = o
  const doc = o.root.ownerDocument
  const win = doc.defaultView ?? window
  const layer = new LodLayer(doc, win)
  // W5-51: frame names that would run into a neighbouring frame (at any zoom; zoomed out is where they do)
  const names = installFrameNameGuard({
    api,
    root: o.root,
    subscribe: (onChange) => canvas.on('change', onChange),
  })
  const release = (b: Bitmap) => {
    layer.forget(b.image)
    closeImage(b.image)
  }
  const model = new LodModel<Image>({ onDrop: release })
  let enabled = o.enabled ?? true
  let active = false
  let disposed = false
  let rendering = false
  let paintFrame: number | null = null
  let workTimer: ReturnType<typeof setTimeout> | null = null
  let settleTimer: ReturnType<typeof setTimeout> | null = null
  let theme = canvas.theme()
  let files: BinaryFiles = api.getFiles()
  const stats = { renders: 0, renderMs: 0, failures: 0 }

  const elements = () =>
    api.getSceneElementsMapIncludingDeleted() as unknown as ReadonlyMap<string, LodElement>
  model.reset(elements().values())

  const viewNow = () => {
    const s = api.getAppState()
    return { scrollX: s.scrollX, scrollY: s.scrollY, zoom: s.zoom.value, width: s.width, height: s.height }
  }
  const inView = (r: LodRect) => {
    const v = viewNow()
    const vx = -v.scrollX
    const vy = -v.scrollY
    return !(
      r.x > vx + v.width / v.zoom ||
      r.y > vy + v.height / v.zoom ||
      r.x + r.width < vx ||
      r.y + r.height < vy
    )
  }

  /** Culls what the current bitmaps draw (nothing while off) and repaints the layer. */
  const apply = () => {
    if (disposed) return
    target.setCulled(active ? model.culled() : null)
    schedulePaint()
  }

  const schedulePaint = () => {
    if (paintFrame !== null || disposed) return
    paintFrame = win.requestAnimationFrame(() => {
      paintFrame = null
      if (disposed) return
      if (!active) {
        layer.clear()
        return
      }
      if (!layer.mount(o.root)) return
      const settled = layer.paint(model.drawable(), viewNow(), win.devicePixelRatio || 1)
      // a new scale: paint once more when it has held, which asks for the copies at that scale
      if (!settled && settleTimer === null)
        settleTimer = setTimeout(() => {
          settleTimer = null
          schedulePaint()
        }, 120)
    })
  }
  layer.onCopy = () => schedulePaint()

  const scheduleWork = (delayMs = 0) => {
    if (disposed || !active || rendering) return
    if (workTimer !== null) clearTimeout(workTimer)
    workTimer = setTimeout(
      () => {
        workTimer = null
        void work()
      },
      Math.max(0, delayMs),
    )
  }

  /** Renders the next due frame (one at a time), then schedules the next. */
  const work = async () => {
    if (disposed || !active || rendering) return
    const t = now()
    const next = model.due(t, inView)[0]
    if (!next) {
      const at = model.nextDue()
      if (at !== null) scheduleWork(at - t + 5)
      return
    }
    // not in the middle of a gesture: a drag paused mid-way, or an open text editor (the engine leaves
    // the edited text out of its render; a bitmap would draw it under the editor), stays live
    if (!RENDER_GESTURES.has(canvas.gesture())) return scheduleWork(LOD_WORK_DELAY * 4)
    const job = model.start(next)
    if (!job) return scheduleWork()
    rendering = true
    let bitmap: Bitmap | null = null
    const t0 = now()
    try {
      bitmap = await renderFrame(next, job.rect)
    } catch (e) {
      stats.failures++
      console.warn('lod: a frame could not be rendered', next, e)
    } finally {
      rendering = false
    }
    stats.renders++
    stats.renderMs += now() - t0
    if (disposed) return
    if (model.finish(next, job.version, bitmap)) apply()
    else if (bitmap) release(bitmap)
    // yield to input between renders
    scheduleWork(16)
  }

  const renderFrame = async (frameId: string, rect: LodRect): Promise<Bitmap | null> => {
    const { exportSceneCanvas } = await import('../export/scene.ts')
    const scale = lodScale(rect, win.devicePixelRatio || 1)
    const out = await exportSceneCanvas(
      { api, boardId: null, resolver: null, isHidden: o.isHidden },
      {
        frameId,
        scale,
        maxSide: 4096,
        background: false,
        files: 'canvas',
        theme: canvas.theme(),
      },
    )
    // an ImageBitmap is a texture the layer draws as is; a canvas source would be re-read on every paint
    if (typeof win.createImageBitmap === 'function') {
      const image = await win.createImageBitmap(out.canvas)
      out.canvas.width = 0
      return { image, rect, scale: out.scale }
    }
    return { image: out.canvas, rect, scale: out.scale }
  }

  /** The model's frames match the scene's (a snapshot installed without a change batch): else rebuilt. */
  const reconcile = () => {
    let frames = 0
    for (const e of elements().values()) if (e.type === 'frame' && !e.isDeleted) frames++
    if (frames !== model.stats().frames) model.reset(elements().values())
  }

  const updateActive = () => {
    const was = active
    active = enabled && !disposed && lodActiveAt(api.getAppState().zoom.value)
    if (active !== was) {
      if (active) reconcile()
      apply()
      if (active) scheduleWork()
    } else if (active) schedulePaint()
  }

  // ---- inputs -------------------------------------------------------------------------------------------

  const offs: (() => void)[] = []
  offs.push(api.onScrollChange(() => updateActive()))
  offs.push(
    canvas.on('change', (c: CanvasChange) => {
      const map = elements()
      model.changed([...c.created, ...c.updated, ...c.deleted], (id) => map.get(id), now())
      if (active) {
        apply()
        scheduleWork(model.nextDue() !== null ? (model.nextDue() as number) - now() + 5 : 0)
      }
    }),
  )
  offs.push(
    target.onSnapshot((opacityChanged) => {
      model.setBusy(target.moved())
      if (opacityChanged.size) model.invalidateMembers(opacityChanged, now())
      if (active) {
        apply()
        scheduleWork(LOD_WORK_DELAY)
      }
    }),
  )
  // the theme and the image files (a preview arriving changes what an image draws): no document change
  // (onChange runs on every camera move too: only compare two references there)
  offs.push(
    api.onChange(() => {
      const t = canvas.theme()
      const f = api.getFiles()
      if (t === theme && f === files) return
      if (t !== theme) {
        theme = t
        model.invalidateAll(now())
      } else {
        const before = files
        const added = Object.keys(f).filter((k) => before[k] !== f[k])
        if (added.length) {
          const fresh = new Set(added)
          const ids: string[] = []
          for (const e of elements().values()) {
            const fileId = (e as { fileId?: string | null }).fileId
            if (e.type === 'image' && fileId && fresh.has(fileId)) ids.push(e.id)
          }
          model.invalidateMembers(ids, now())
        }
      }
      files = f
      if (active) {
        apply()
        scheduleWork(LOD_WORK_DELAY)
      }
    }),
  )

  updateActive()

  const handle: LodHandle = {
    setEnabled(on) {
      enabled = on
      updateActive()
      if (!on) layer.clear()
    },
    state() {
      const s = model.stats()
      return {
        enabled,
        active,
        zoom: api.getAppState().zoom.value,
        ...s,
        drawn: layer.drawn,
        renders: stats.renders,
        renderMs: Math.round(stats.renderMs),
        failures: stats.failures,
        layer: layer.el.isConnected,
        crowdedNames: names.hidden().size,
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const off of offs.splice(0)) off()
      if (paintFrame !== null) win.cancelAnimationFrame(paintFrame)
      if (workTimer !== null) clearTimeout(workTimer)
      if (settleTimer !== null) clearTimeout(settleTimer)
      target.setCulled(null)
      layer.remove()
      names.dispose()
      model.reset([])
      if (DEV_AUTH_ENABLED && (win as unknown as { __lobbyLod?: LodHandle }).__lobbyLod === handle)
        delete (win as unknown as { __lobbyLod?: LodHandle }).__lobbyLod
    },
  }
  if (DEV_AUTH_ENABLED) (win as unknown as { __lobbyLod?: LodHandle }).__lobbyLod = handle
  return handle
}

/** A snapshot or file change re-checks the schedule after this long (ms), coalescing bursts. */
const LOD_WORK_DELAY = 50

/** The gestures a frame may be re-rendered during (nothing is being moved, drawn or typed). */
const RENDER_GESTURES: ReadonlySet<string> = new Set(['idle', 'tool', 'panning'])
