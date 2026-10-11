/**
 * Wave N (WS1, N1-5) probe: a render-override offset still culls on the pinned nightly. Lobby's level-of-detail pass
 * leaves the elements a frame or tile bitmap draws out of the engine's static render by giving each a render offset
 * far outside any view (apps/web/src/canvas/lod/cull.ts LOD_CULL_OFFSET through `setElementRenderOverrides`), and
 * relies on the renderer culling an element its offset moves out of view (Renderer.getVisibleElementsWithRenderOffsets
 * in 0.18.0-1118751). A bump that drew offset elements anyway (or that moved them on screen) would draw every culled
 * element under its bitmap again: the 10k-board fps of N1-5 gone, silently.
 *
 * Three filled squares in view at zoom 1; the middle one gets the cull offset. On the static canvas the outer two
 * keep their fill and the middle one's place shows the background; nothing of it appears anywhere else in view; the
 * document is untouched (the override is render-only); and clearing the overrides draws it again.
 */
import { newElement } from '@excalidraw/element'
import { CaptureUpdateAction } from '@excalidraw/excalidraw'

/** apps/web/src/canvas/lod/cull.ts LOD_CULL_OFFSET (repeated: the probe page imports no Lobby canvas module). */
export const PROBE_CULL_OFFSET = { x: 1e9, y: 1e9 } as const

type Api = {
  updateScene: (data: { elements?: readonly unknown[]; appState?: unknown; captureUpdate: unknown }) => void
  getSceneElements: () => readonly { id: string; x: number; y: number }[]
  setElementRenderOverrides: (o: ReadonlyMap<string, { offset?: { x: number; y: number } }> | null) => void
}

export interface RenderCullReport {
  /** the engine has the render-override API Lobby's pass uses */
  hasApi: boolean
  /** the squares without an override are drawn */
  othersDrawn: boolean
  /** the culled square's place shows the background */
  culledNotDrawn: boolean
  /** no pixel of the culled square's fill anywhere in view */
  culledNowhereInView: boolean
  /** the document keeps the culled element where it was (the override changes only what is drawn) */
  documentUntouched: boolean
  /** clearing the overrides draws it again */
  drawnAfterClear: boolean
}

const COLORS = { a: '#ff0000', b: '#00ff00', c: '#0000ff' } as const

const square = (id: string, x: number, color: string, index: string) =>
  ({
    ...newElement({
      type: 'rectangle',
      x,
      y: 100,
      width: 100,
      height: 100,
      strokeColor: color,
      backgroundColor: color,
      fillStyle: 'solid',
      strokeWidth: 1,
      strokeStyle: 'solid',
      roughness: 0,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: null,
      link: null,
      locked: false,
    } as never),
    id,
    index,
  }) as unknown

const frames = (n: number) =>
  new Promise<void>((resolve) => {
    let left = n
    const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick))
    requestAnimationFrame(tick)
  })

const hex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`

export async function checkRenderCull(apiIn: unknown): Promise<RenderCullReport & { ok: boolean }> {
  const api = apiIn as Api
  const hasApi = typeof api.setElementRenderOverrides === 'function'
  api.updateScene({
    elements: [
      square('a', 100, COLORS.a, 'a0'),
      square('b', 300, COLORS.b, 'a1'),
      square('c', 500, COLORS.c, 'a2'),
    ],
    appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 }, viewBackgroundColor: '#ffffff' },
    captureUpdate: CaptureUpdateAction.NEVER,
  })
  await frames(3)
  const canvas = document.querySelector<HTMLCanvasElement>('canvas.excalidraw__canvas.static')
  if (!canvas || !hasApi)
    return {
      hasApi,
      othersDrawn: false,
      culledNotDrawn: false,
      culledNowhereInView: false,
      documentUntouched: false,
      drawnAfterClear: false,
      ok: false,
    }
  const dpr = canvas.width / Math.max(1, canvas.clientWidth)
  const pixel = (x: number, y: number) => {
    const ctx = canvas.getContext('2d')
    const d = ctx?.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data
    return d ? hex(d[0] ?? 0, d[1] ?? 0, d[2] ?? 0) : ''
  }
  const before = { a: pixel(150, 150), b: pixel(350, 150), c: pixel(550, 150) }
  if (before.a !== COLORS.a || before.b !== COLORS.b || before.c !== COLORS.c)
    console.warn('render-cull probe: the squares were not drawn as expected before the override', before)

  api.setElementRenderOverrides(new Map([['b', { offset: PROBE_CULL_OFFSET }]]))
  await frames(3)
  const after = { a: pixel(150, 150), b: pixel(350, 150), c: pixel(550, 150) }
  const othersDrawn = after.a === COLORS.a && after.c === COLORS.c
  const culledNotDrawn = after.b === '#ffffff'
  // the whole view, sampled every 10 px: no green anywhere
  let culledNowhereInView = true
  const ctx = canvas.getContext('2d')
  const img = ctx?.getImageData(0, 0, canvas.width, canvas.height).data
  if (img)
    for (let y = 0; y < canvas.height && culledNowhereInView; y += 10)
      for (let x = 0; x < canvas.width; x += 10) {
        const i = (y * canvas.width + x) * 4
        if (img[i] === 0 && img[i + 1] === 255 && img[i + 2] === 0) {
          culledNowhereInView = false
          break
        }
      }
  const b = api.getSceneElements().find((e) => e.id === 'b')
  const documentUntouched = !!b && b.x === 300 && b.y === 100

  api.setElementRenderOverrides(null)
  await frames(3)
  const drawnAfterClear = pixel(350, 150) === COLORS.b
  const report = {
    hasApi,
    othersDrawn,
    culledNotDrawn,
    culledNowhereInView,
    documentUntouched,
    drawnAfterClear,
  }
  // leave the page as it was for the next probe
  api.updateScene({ elements: [], captureUpdate: CaptureUpdateAction.NEVER })
  return { ...report, ok: Object.values(report).every(Boolean) && before.b === COLORS.b }
}
