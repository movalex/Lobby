// Shared helpers of the render/files spike pages (render-*.tsx; checks A7, A9, A10, A11, A12, A14).
// Not a page: SpikeRoute globs ./pages/*.tsx only.

import type { ExcalidrawElement } from '@excalidraw/element/types'
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  exportToCanvas,
  exportToSvg,
  FONT_FAMILY,
  getCommonBounds,
  newElementWith,
  sceneCoordsToViewportCoords,
  viewportCoordsToSceneCoords,
} from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { type Derivative, ImageLoader } from '../../files/loader.ts'

/** Engine exports the render specs call through `window.__lobbySpike.extra.engine`. */
export const renderEngine = Object.freeze({
  CaptureUpdateAction,
  convertToExcalidrawElements,
  exportToCanvas,
  exportToSvg,
  FONT_FAMILY,
  getCommonBounds,
  newElementWith,
  sceneCoordsToViewportCoords,
  viewportCoordsToSceneCoords,
})

/**
 * The fixture file scheme of the spike: `ver_<body>` → /files/ast_<body>/ver_<body>/d/drv_<body>T (thumb)
 * or …D (display), the shape of Lobby's real derivative route (/files/:ast/:ver/d/:drv). The spike's
 * fixture server (e2e/spike/fixtures/files-server.ts) answers it behind the preview proxy, so the page
 * fetches same-origin exactly as on a board.
 */
export function fixtureUrl(versionId: string, derivative: Derivative): string | null {
  const body = versionId.slice(4)
  if (!/^[0-9A-Za-z]{10,40}$/.test(body)) return null
  return `/files/ast_${body}/${versionId}/d/drv_${body}${derivative === 'display' ? 'D' : 'T'}`
}

export interface EchoOp {
  id: string
  from: number
  to: number
  fields: string[]
}

const IGNORED_FIELDS = new Set(['version', 'versionNonce', 'updated'])

/**
 * What a sync adapter would push without a local gesture: every element whose version changed since the
 * scene state the "server" last applied (or the last change it already counted). Spike stand-in for the
 * engine's echo guard (plan §2.5.5 "Global guard").
 */
export class EchoProbe {
  private readonly known = new Map<string, ExcalidrawElement>()
  readonly ops: EchoOp[] = []
  /** Elements seen in onChange that the server never applied (a local create). */
  readonly unknown = new Set<string>()
  onChangeCalls = 0
  private readonly off: () => void
  private readonly api: ExcalidrawImperativeAPI

  constructor(api: ExcalidrawImperativeAPI) {
    this.api = api
    this.off = api.onChange((elements) => this.scan(elements))
  }

  /** The server's copy: what updateScene just installed. */
  applied(elements: readonly ExcalidrawElement[]): void {
    for (const e of elements) this.known.set(e.id, e)
  }

  /** Applies a server scene the way the adapter does (plan §2.5.4: captureUpdate NEVER). */
  applyServer(elements: readonly ExcalidrawElement[]): void {
    this.api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER })
    this.applied(this.api.getSceneElementsIncludingDeleted())
  }

  scan(elements: readonly ExcalidrawElement[] = this.api.getSceneElementsIncludingDeleted()): void {
    this.onChangeCalls++
    for (const e of elements) {
      const k = this.known.get(e.id)
      if (!k) {
        this.unknown.add(e.id)
        continue
      }
      if (k.version === e.version) continue
      const fields = Object.keys(e).filter(
        (f) =>
          !IGNORED_FIELDS.has(f) &&
          JSON.stringify((e as unknown as Record<string, unknown>)[f]) !==
            JSON.stringify((k as unknown as Record<string, unknown>)[f]),
      )
      this.ops.push({ id: e.id, from: k.version, to: e.version, fields })
      this.known.set(e.id, e)
    }
  }

  /** Version changes right now against the applied copy (independent of onChange). */
  versionDrift(): { id: string; from: number; to: number }[] {
    const out: { id: string; from: number; to: number }[] = []
    for (const e of this.api.getSceneElementsIncludingDeleted()) {
      const k = this.known.get(e.id)
      if (k && k.version !== e.version) out.push({ id: e.id, from: k.version, to: e.version })
    }
    return out
  }

  reset(): void {
    this.ops.length = 0
    this.unknown.clear()
    this.onChangeCalls = 0
  }

  dispose(): void {
    this.off()
  }
}

/** Lobby's loader wired to the page's API and the fixture file scheme. */
export function fixtureLoader(api: ExcalidrawImperativeAPI, opts: { retryWindowMs?: number } = {}) {
  return new ImageLoader({
    addFiles: (files) => api.addFiles(files),
    resolveUrl: fixtureUrl,
    ...(opts.retryWindowMs ? { retryWindowMs: opts.retryWindowMs } : {}),
  })
}

/** fileIds of the image elements whose bounds intersect the viewport. */
export function visibleFileIds(api: ExcalidrawImperativeAPI): Set<string> {
  const s = api.getAppState()
  const z = s.zoom.value
  const x1 = -s.scrollX
  const y1 = -s.scrollY
  const x2 = x1 + s.width / z
  const y2 = y1 + s.height / z
  const out = new Set<string>()
  for (const e of api.getSceneElements()) {
    if (e.type !== 'image' || !e.fileId) continue
    if (e.x + e.width >= x1 && e.x <= x2 && e.y + e.height >= y1 && e.y <= y2) out.add(e.fileId)
  }
  return out
}

/** Reads a pixel of Excalidraw's static canvas at a scene point (for pixel probes). */
export function staticPixel(
  api: ExcalidrawImperativeAPI,
  sceneX: number,
  sceneY: number,
  root: ParentNode = document,
) {
  const canvas = root.querySelector<HTMLCanvasElement>('canvas.excalidraw__canvas.static')
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) return null
  const s = api.getAppState()
  const box = canvas.getBoundingClientRect()
  const v = sceneCoordsToViewportCoords({ sceneX, sceneY }, s)
  const x = Math.round((v.x - box.left) * (canvas.width / box.width))
  const y = Math.round((v.y - box.top) * (canvas.height / box.height))
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return null
  const d = ctx.getImageData(x, y, 1, 1).data
  return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0, d[3] ?? 0]
}

/** Dark pixels (sum of RGB below 3 × 110) inside a scene rect of the static canvas. */
export function darkPixelsIn(
  api: ExcalidrawImperativeAPI,
  rect: { x: number; y: number; w: number; h: number },
  root: ParentNode = document,
): number {
  const canvas = root.querySelector<HTMLCanvasElement>('canvas.excalidraw__canvas.static')
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) return -1
  const s = api.getAppState()
  const box = canvas.getBoundingClientRect()
  const k = canvas.width / box.width
  const a = sceneCoordsToViewportCoords({ sceneX: rect.x, sceneY: rect.y }, s)
  const b = sceneCoordsToViewportCoords({ sceneX: rect.x + rect.w, sceneY: rect.y + rect.h }, s)
  const x = Math.max(0, Math.round((a.x - box.left) * k))
  const y = Math.max(0, Math.round((a.y - box.top) * k))
  const w = Math.min(canvas.width - x, Math.round((b.x - a.x) * k))
  const h = Math.min(canvas.height - y, Math.round((b.y - a.y) * k))
  if (w <= 0 || h <= 0) return 0
  const d = ctx.getImageData(x, y, w, h).data
  let n = 0
  for (let i = 0; i < d.length; i += 4) if ((d[i] ?? 255) + (d[i + 1] ?? 255) + (d[i + 2] ?? 255) < 330) n++
  return n
}
