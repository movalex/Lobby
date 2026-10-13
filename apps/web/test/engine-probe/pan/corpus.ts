/**
 * Wave O (WO-PAN): the corpora and the engine's own answers that the pan speed-ups (A1/A4, C) are compared with, for
 * both loads of @excalidraw/element: pan-speed.test.ts (Vitest, each build by its file) and pan/prod-check.ts (a child
 * `node` that loads the package as the sync server does). Plain TypeScript Node can run (no Vitest import).
 */

// biome-ignore lint/suspicious/noExplicitAny: the engine module, one per build, typed loosely on purpose
export type Engine = any
// biome-ignore lint/suspicious/noExplicitAny: Excalidraw's own element objects
export type El = any

export const STYLE = {
  strokeColor: '#1e1e1e',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeWidth: 2,
  strokeStyle: 'solid',
  roughness: 0,
  opacity: 100,
  groupIds: [],
  frameId: null,
  roundness: null,
  link: null,
  locked: false,
} as const

/** A small deterministic PRNG (mulberry32): the corpora are the same on every run. */
export const rng = (seed: number) => {
  let s = seed
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Every element kind the renderer meets, rotated and not, with labels on a note, a rectangle and two arrows. */
export function corpus(X: Engine): El[] {
  const out: El[] = []
  const r = rng(7)
  const kinds = ['rectangle', 'ellipse', 'diamond'] as const
  for (let i = 0; i < 60; i++) {
    const type = kinds[i % 3] as string
    out.push(
      X.newElement({
        ...STYLE,
        type,
        x: (r() - 0.5) * 6000,
        y: (r() - 0.5) * 4000,
        width: 20 + r() * 400,
        height: 20 + r() * 300,
        angle: i % 4 === 0 ? r() * 6.28 : 0,
        roundness: i % 2 ? { type: 3 } : null,
        roughness: i % 5 === 0 ? 1 : 0,
      }),
    )
  }
  const note = X.newElement({ ...STYLE, type: 'rectangle', x: 300, y: 200, width: 220, height: 160 })
  const noteLabel = X.newTextElement({ ...STYLE, x: 310, y: 250, text: 'a label', containerId: note.id })
  out.push({ ...note, boundElements: [{ id: noteLabel.id, type: 'text' }] }, noteLabel)
  for (const [i, elbowed] of [false, true].entries()) {
    const arrow = X.newArrowElement({
      ...STYLE,
      type: 'arrow',
      x: -400 + i * 900,
      y: 900,
      width: 600,
      height: 240,
      points: [
        [0, 0],
        [300, -120],
        [600, 240],
      ],
      elbowed,
      roundness: elbowed ? null : { type: 2 },
    })
    const label = X.newTextElement({
      ...STYLE,
      x: 0,
      y: 0,
      text: `arrow label ${i} is wide`,
      containerId: arrow.id,
    })
    out.push({ ...arrow, boundElements: [{ id: label.id, type: 'text' }] }, label)
  }
  out.push(
    X.newLinearElement({
      ...STYLE,
      type: 'line',
      x: 1200,
      y: -800,
      points: [
        [0, 0],
        [80, 300],
        [-120, 420],
      ],
      angle: 0.7,
    }),
    X.newFreeDrawElement({
      ...STYLE,
      type: 'freedraw',
      x: -1500,
      y: 300,
      points: Array.from({ length: 40 }, (_, k) => [k * 7, Math.sin(k / 3) * 60]),
      pressures: [],
      simulatePressure: true,
    }),
    X.newTextElement({ ...STYLE, x: 2200, y: 1400, text: 'free text\non two lines', angle: 0.3 }),
    X.newFrameElement({ x: -2000, y: -1500, width: 1600, height: 1200 }),
    X.newImageElement({ ...STYLE, type: 'image', x: 800, y: -1700, width: 320, height: 240, fileId: 'f1' }),
  )
  return out
}

export const mapOf = (els: readonly El[]) => new Map<string, El>(els.map((e) => [e.id, e]))

export interface Camera {
  width: number
  height: number
  zoom: { value: number }
  offsetLeft: number
  offsetTop: number
  scrollX: number
  scrollY: number
}

/** Cameras at Lobby's zooms over the elements' extent, plus ones whose view edge lies exactly on an element's bound. */
export function cameras(X: Engine, els: readonly El[], map: Map<string, El>, seed: number): Camera[] {
  const r = rng(seed)
  let [x1, y1, x2, y2] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const e of els) {
    const b = X.getElementBounds(e, map)
    x1 = Math.min(x1, b[0])
    y1 = Math.min(y1, b[1])
    x2 = Math.max(x2, b[2])
    y2 = Math.max(y2, b[3])
  }
  const out: Camera[] = []
  const sizes: [number, number][] = [
    [1536, 864],
    [1229, 691.2],
    [375, 667],
  ]
  for (const z of [0.0353, 0.1, 0.25, 0.5, 1, 2.3]) {
    for (let k = 0; k < 4; k++) {
      const [width, height] = sizes[k % sizes.length] as [number, number]
      out.push({
        width,
        height,
        zoom: { value: z },
        offsetLeft: k % 2 ? 13.7 : 0,
        offsetTop: k % 2 ? 61.25 : 0,
        // the view's left edge somewhere over the extent (scene x = -scrollX)
        scrollX: -(x1 + r() * (x2 - x1)) + (width / z) * 0.3,
        scrollY: -(y1 + r() * (y2 - y1)) + (height / z) * 0.3,
      })
    }
  }
  // edges exactly on bounds: the comparisons are `<=` / `>=`, so these are the cases a reordering would flip
  for (let k = 0; k < 12; k++) {
    const e = els[Math.floor(r() * els.length)] as El
    const b = X.getElementBounds(e, map)
    const z = [0.25, 0.5, 1][k % 3] as number
    const w = 1536
    const h = 864
    out.push(
      {
        width: w,
        height: h,
        zoom: { value: z },
        offsetLeft: 0,
        offsetTop: 0,
        scrollX: -b[2],
        scrollY: -b[3],
      },
      {
        width: w,
        height: h,
        zoom: { value: z },
        offsetLeft: 7,
        offsetTop: 3,
        scrollX: w / z - b[0],
        scrollY: h / z - b[1],
      },
    )
  }
  return out
}

/** The answers for every element in `els` under `cam` with `offset`, the engine's way and the patch's way. */
export function answers(
  X: Engine,
  els: readonly El[],
  map: Map<string, El>,
  cam: Camera,
  offset = { x: 0, y: 0 },
) {
  const engine: boolean[] = []
  const patch: boolean[] = []
  const vt = {
    zoom: cam.zoom,
    offsetLeft: cam.offsetLeft,
    offsetTop: cam.offsetTop,
    scrollX: cam.scrollX + offset.x,
    scrollY: cam.scrollY + offset.y,
  }
  for (const e of els) {
    engine.push(X.isElementInViewport(e, cam.width, cam.height, vt, map))
    patch.push(
      X.isElementInViewportAt(
        e,
        cam.width,
        cam.height,
        cam.zoom,
        cam.offsetLeft,
        cam.offsetTop,
        cam.scrollX + offset.x,
        cam.scrollY + offset.y,
        map,
      ),
    )
  }
  return { engine, patch, visible: engine.filter(Boolean).length }
}

/**
 * shouldApplyFrameClip as the pinned nightly wrote it (element dist/dev/index.js 13373-13404 before the patch), from
 * the exported tests it calls: the reference the patched function must equal.
 */
export function engineFrameClip(
  X: Engine,
  element: El,
  frame: El,
  appState: El,
  map: Map<string, El>,
  groups?: Map<string, boolean>,
) {
  if (!appState.frameRendering?.clip) return false
  const self =
    X.isElementIntersectingFrame(element, frame, map) || X.isElementContainingFrame(element, frame, map)
  if (self) {
    for (const g of element.groupIds) groups?.set(g, true)
    return true
  }
  if (element.groupIds.length > 0 && !X.elementsAreInFrameBounds([element], frame, map)) {
    let shouldClip = false
    if (!appState.selectedElementsAreBeingDragged) {
      shouldClip = element.frameId === frame.id
      for (const g of element.groupIds) groups?.set(g, shouldClip)
    } else {
      shouldClip = X.isElementInFrame(element, map, appState, { targetFrame: frame, checkedGroups: groups })
    }
    for (const g of element.groupIds) groups?.set(g, shouldClip)
    return shouldClip
  }
  return false
}

/** The app state shouldApplyFrameClip reads, with frame clipping on. */
export const clipState = (dragging: boolean) => ({
  frameRendering: { enabled: true, clip: true, name: true, outline: true },
  selectedElementsAreBeingDragged: dragging,
  selectedElementIds: {},
  frameToHighlight: null,
})

/**
 * Every kind swept across each edge of a 1000 x 800 frame (id `F`), from 20 px out to 20 px in, grouped and not: the
 * elements whose outer side lies d px inside (d > 0) or outside (d < 0) each edge.
 */
export function edgeSweep(X: Engine): { frame: El; els: El[] } {
  const frame = { ...X.newFrameElement({ x: 0, y: 0, width: 1000, height: 800 }), id: 'F' }
  const els: El[] = []
  const kinds: Record<string, unknown>[] = [
    { type: 'rectangle' },
    { type: 'ellipse' },
    { type: 'diamond' },
    { type: 'rectangle', roundness: { type: 3 } },
    { type: 'rectangle', angle: 0.3 },
    { type: 'ellipse', angle: 1.1 },
  ]
  for (const d of [-20, -3, -1, -0.5, -0.01, -1e-7, 0, 1e-7, 0.01, 0.5, 1, 3, 20])
    for (const kind of kinds)
      for (const groupIds of [[], ['g1']]) {
        const make = (x: number, y: number) =>
          X.newElement({ ...STYLE, ...kind, x, y, width: 120, height: 90, groupIds, frameId: 'F' })
        els.push(make(d, 300), make(1000 - 120 - d, 300), make(400, d), make(400, 800 - 90 - d))
      }
  return { frame, els }
}
