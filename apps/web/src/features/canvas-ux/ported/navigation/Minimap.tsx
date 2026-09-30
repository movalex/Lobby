// MAK-11 minimap on the new canvas (docs/EXCALIDRAW-MIGRATION.md §4.2 "Lobby-drawn from element bounds,
// throttled, closed by default"): a 2D canvas with every content item's box and the view's rectangle.
// Redrawn at most every 100 ms while the board or the camera changes, so a heavy board pays little while
// panning; not mounted at all while closed (PERF-03). A press or a drag on it centres the view there.
import { type PointerEvent, useEffect, useRef } from 'react'
import { type Bounds, geometry, items, type LobbyCanvas } from '../../../../canvas/api/index.ts'
import { react } from '../../../../lib/signals.ts'

export const MINIMAP_W = 200
export const MINIMAP_H = 120
const REDRAW_MS = 100
const PAD = 6

interface Mapping {
  /** the scene rectangle the minimap shows */
  readonly world: Bounds
  readonly scale: number
  readonly ox: number
  readonly oy: number
}

/** The scene rectangle shown (content and view, padded) and its scale into the minimap. */
export function minimapMapping(content: Bounds | null, view: Bounds, w = MINIMAP_W, h = MINIMAP_H): Mapping {
  const world = geometry.union([content, view]) ?? view
  const scale = Math.min((w - 2 * PAD) / Math.max(1, world.width), (h - 2 * PAD) / Math.max(1, world.height))
  const ox = (w - world.width * scale) / 2 - world.x * scale
  const oy = (h - world.height * scale) / 2 - world.y * scale
  return { world, scale, ox, oy }
}

const toMini = (m: Mapping, x: number, y: number) => ({ x: x * m.scale + m.ox, y: y * m.scale + m.oy })
const toScene = (m: Mapping, x: number, y: number) => ({ x: (x - m.ox) / m.scale, y: (y - m.oy) / m.scale })

function css(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

function draw(canvasEl: HTMLCanvasElement, canvas: LobbyCanvas): Mapping {
  const dpr = window.devicePixelRatio || 1
  if (canvasEl.width !== MINIMAP_W * dpr) {
    canvasEl.width = MINIMAP_W * dpr
    canvasEl.height = MINIMAP_H * dpr
  }
  const g = canvasEl.getContext('2d')
  const v = canvas.viewport.get()
  const view = { x: v.x, y: v.y, width: v.width, height: v.height }
  const content = items.contentItems(canvas.items()).filter((e) => !canvas.isHidden(e.id))
  const boxes = content.map((e) => ({ e, b: canvas.bounds(e.id) }))
  const m = minimapMapping(geometry.union(boxes.map((x) => x.b)), view)
  if (!g) return m
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, MINIMAP_W, MINIMAP_H)
  const ink = css('--dr-ink-muted', '#6b7280')
  const fill = css('--dr-line', '#d1d5db')
  for (const { e, b } of boxes) {
    if (!b) continue
    const p = toMini(m, b.x, b.y)
    const w = Math.max(1, b.width * m.scale)
    const h = Math.max(1, b.height * m.scale)
    if (e.type === 'frame') {
      g.strokeStyle = ink
      g.lineWidth = 1
      g.strokeRect(p.x, p.y, w, h)
    } else {
      const bg =
        typeof e.backgroundColor === 'string' && e.backgroundColor !== 'transparent'
          ? e.backgroundColor
          : fill
      g.fillStyle = bg
      g.fillRect(p.x, p.y, w, h)
    }
  }
  const vp = toMini(m, view.x, view.y)
  g.strokeStyle = css('--dr-focus', '#2563eb')
  g.lineWidth = 1.5
  g.fillStyle = 'rgba(37, 99, 235, 0.08)'
  g.fillRect(vp.x, vp.y, view.width * m.scale, view.height * m.scale)
  g.strokeRect(vp.x, vp.y, view.width * m.scale, view.height * m.scale)
  return m
}

export function Minimap({ canvas }: { canvas: LobbyCanvas }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const mapping = useRef<Mapping | null>(null)
  const dragging = useRef<number | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let frame: number | null = null
    let last = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    const paint = () => {
      frame = null
      last = performance.now()
      mapping.current = draw(el, canvas)
    }
    const schedule = () => {
      if (frame !== null || timer !== null) return
      const wait = REDRAW_MS - (performance.now() - last)
      if (wait > 0) {
        timer = setTimeout(() => {
          timer = null
          frame = requestAnimationFrame(paint)
        }, wait)
      } else frame = requestAnimationFrame(paint)
    }
    // track what the drawing reads (the board, the camera); repaint throttled
    const stop = react('nav-minimap', () => {
      canvas.items()
      canvas.viewport.get()
      schedule()
    })
    const offResize = canvas.on('resize', schedule)
    return () => {
      stop()
      offResize()
      if (frame !== null) cancelAnimationFrame(frame)
      if (timer !== null) clearTimeout(timer)
    }
  }, [canvas])

  const centreAt = (e: PointerEvent<HTMLCanvasElement>, animate: boolean) => {
    const m = mapping.current
    if (!m) return
    const r = e.currentTarget.getBoundingClientRect()
    const p = toScene(m, e.clientX - r.left, e.clientY - r.top)
    canvas.viewport.centerOn(p, animate ? { animate: true } : undefined)
  }

  return (
    <canvas
      ref={ref}
      className="dr-nav-minimap"
      data-testid="minimap.canvas"
      aria-label="Minimap: press or drag to move the view"
      role="img"
      style={{ width: MINIMAP_W, height: MINIMAP_H }}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        dragging.current = e.pointerId
        centreAt(e, true)
      }}
      onPointerMove={(e) => {
        if (dragging.current === e.pointerId) centreAt(e, false)
      }}
      onPointerUp={(e) => {
        if (dragging.current === e.pointerId) dragging.current = null
      }}
      onPointerCancel={() => {
        dragging.current = null
      }}
    />
  )
}
