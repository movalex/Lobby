/**
 * Wave O (O-2) T: the element snap lands an element on the same device pixels at every snapped scroll, so the pan blit's
 * shifted frame and a full render agree. drawElementFromCanvas rounds an element's anchor to whole device pixels from
 * the context's transform, which Chrome keeps in single precision (scale(1 / 1.25) reads back 0.800000011920929): the
 * scroll's share of the rounded sum carries that error, and an anchor on an exact half pixel rounded one way at one scroll
 * and the other way at another. A mirrored image (scale -1) or an element turned by a right angle carries the scroll in
 * the transform's translation too (twice it, for a mirror).
 * Here the shipped dev drawElementFromCanvas is lifted out of the build and run on a context that keeps its transform in
 * single precision as Chrome does: for a row of notes, mirrored images (each axis, both), a half and a quarter turn, at
 * dpr 1.25, 1.5 and 2, each on an exact tie at 0.5 x 1.25, over thousands of snapped scrolls, the device pixel the
 * element lands on less the scroll's whole device pixels is one number. Off the pixel grid (an unsnapped scroll) the
 * patch is the engine's own formula, to the bit (no tie bias in the anchor term). The prod build's function, lifted the
 * same way, gives the dev one's answer for every call.
 */
import { BOUND_TEXT_PADDING, distance } from '@excalidraw/common'
import * as X from '@excalidraw/element'
import { isRightAngleRads } from '@excalidraw/math'
import { describe, expect, it } from 'vitest'
import { readDist } from './bundle.ts'
import { type El, STYLE } from './pan/corpus.ts'

const f = Math.fround

/**
 * A 2D context's transform as Chrome keeps it: a double matrix, but scale's and translate's arguments (and
 * setTransform's) taken in single precision (Blink clamps them to float: scale(1 / 1.25) reads back 0.800000011920929);
 * rotate's angle in double.
 */
class Context32 {
  m = [1, 0, 0, 1, 0, 0]
  /** the last setTransform with six numbers (drawElementFromCanvas's snapped one), and the last transform read */
  snapped: number[] | null = null
  read: { a: number; b: number; c: number; d: number; e: number; f: number } | null = null
  private stack: number[][] = []
  save() {
    this.stack.push([...this.m])
  }
  restore() {
    this.m = this.stack.pop() ?? [1, 0, 0, 1, 0, 0]
  }
  scale(sx: number, sy: number) {
    const [a, b, c, d, e, g] = this.m as [number, number, number, number, number, number]
    const x = f(sx)
    const y = f(sy)
    this.m = [a * x, b * x, c * y, d * y, e, g]
  }
  translate(tx: number, ty: number) {
    const [a, b, c, d, e, g] = this.m as [number, number, number, number, number, number]
    const x = f(tx)
    const y = f(ty)
    this.m = [a, b, c, d, e + a * x + c * y, g + b * x + d * y]
  }
  rotate(r: number) {
    const [a, b, c, d, e, g] = this.m as [number, number, number, number, number, number]
    const cos = Math.cos(r)
    const sin = Math.sin(r)
    this.m = [a * cos + c * sin, b * cos + d * sin, c * cos - a * sin, d * cos - b * sin, e, g]
  }
  getTransform() {
    const [a, b, c, d, e, g] = this.m as [number, number, number, number, number, number]
    this.read = { a, b, c, d, e, f: g }
    return this.read
  }
  setTransform(...args: unknown[]) {
    if (args.length === 6) {
      this.snapped = args as number[]
      this.m = (args as number[]).map(f)
    } else {
      const t = args[0] as { a: number; b: number; c: number; d: number; e: number; f: number }
      this.m = [t.a, t.b, t.c, t.d, t.e, t.f]
    }
  }
  beginPath() {}
  rect() {}
  clip() {}
  drawImage() {}
  strokeRect() {}
}

/** a definition of a build, lifted out of its source: from `from` to the first `to` after it */
const lift = (src: string, from: string, to: string) => {
  const a = src.indexOf(from)
  const b = src.indexOf(to, a + from.length)
  if (a < 0 || b < 0) throw new Error(`the build has no ${from}`)
  return src.slice(a, b + to.length)
}

type Snap = (...args: unknown[]) => number
const DEV = readDist('element', 'dev')
const PROD = readDist('element', 'prod')
/** every call of the dev build's lobbySnapAnchor the scenarios made, and its answer */
const calls: { args: unknown[]; out: number }[] = []
const win = { devicePixelRatio: 1.25 }
/** dev's lobbySnapAnchor, renamed: the lifted drawElementFromCanvas calls it through a recorder */
const SNAP = lift(DEV, 'function lobbySnapAnchor(', '\n}\n').replace('lobbySnapAnchor(', 'lobbySnapBuilt(')

/** dev's drawElementFromCanvas as shipped, with the helpers it calls: the engine's own (pending images: none) */
const draw = new Function(
  'getElementAbsoluteCoords2',
  'getBoundTextElement',
  'isArrowElement',
  'isTextElement',
  'getContainerElement',
  'distance2',
  'BOUND_TEXT_PADDING3',
  'isRightAngleRads',
  'isPendingImageElement',
  'SNAP_TIE_BIAS',
  'define_import_meta_env_default',
  'window',
  'record',
  [
    lift(DEV, 'var getCanvasPadding = (element) => {', '\n};'),
    lift(DEV, 'var canSnapElement = ', ';\n'),
    SNAP,
    'var lobbySnapAnchor = (...args) => record(args, lobbySnapBuilt(...args));',
    lift(DEV, 'var drawElementFromCanvas = (', '\n  context.restore();\n};'),
    'return { drawElementFromCanvas, getCanvasPadding };',
  ].join('\n'),
)(
  X.getElementAbsoluteCoords,
  X.getBoundTextElement,
  X.isArrowElement,
  X.isTextElement,
  X.getContainerElement,
  distance,
  BOUND_TEXT_PADDING,
  isRightAngleRads,
  () => false,
  1e-6,
  {},
  win,
  (args: unknown[], out: number) => {
    calls.push({ args, out })
    return out
  },
) as {
  drawElementFromCanvas: (...a: unknown[]) => void
  getCanvasPadding: (el: El) => number
}

/** One draw of `el` on the static canvas (its scale, then the zoom, as bootstrapCanvas and the scene render set it). */
function drawAt(el: El, zoom: number, dpr: number, scrollX: number, scrollY: number) {
  win.devicePixelRatio = dpr
  const ctx = new Context32()
  ctx.scale(dpr, dpr)
  ctx.scale(zoom, zoom)
  const map = new Map([[el.id, el]])
  const appState = { zoom: { value: zoom }, scrollX, scrollY, shouldCacheIgnoreZoom: false }
  draw.drawElementFromCanvas(
    { element: el, canvas: { width: 64, height: 64 }, scale: 1 },
    ctx,
    { imageCache: new Map() },
    appState,
    map,
    { x: 0, y: 0 },
  )
  if (!ctx.snapped) throw new Error(`${el.type} was not snapped`)
  return ctx
}

/** drawElementFromCanvas's anchor rounding before T, on the transform it read: Math.round(p * anchor + q * anchor + t) */
function engineAnchor(ctx: Context32, el: El, dpr: number, scrollX: number, scrollY: number) {
  const t = ctx.read as NonNullable<Context32['read']>
  const padding = draw.getCanvasPadding(el)
  const ax = (el.x + scrollX) * dpr - padding
  const ay = (el.y + scrollY) * dpr - padding
  return { x: Math.round(t.a * ax + t.c * ay + t.e), y: Math.round(t.b * ax + t.d * ay + t.f), ax, ay, t }
}

/**
 * Over thousands of snapped scrolls: where `el` lands less the scroll's whole device pixels, on each axis (the patch's,
 * through drawElementFromCanvas), and the same for the engine's own rounding of the transform it read.
 */
function shifts(el: El, zoom: number, dpr: number) {
  const k = zoom * dpr
  const out = {
    x: new Set<number>(),
    y: new Set<number>(),
    engineX: new Set<number>(),
    engineY: new Set<number>(),
  }
  for (let raw = -40_000; raw <= 40_000; raw += 37.3) {
    const scrollX = Math.round(raw * k) / k
    const scrollY = Math.round(-raw * 0.61 * k) / k
    const ctx = drawAt(el, zoom, dpr, scrollX, scrollY)
    const [, , , , e, g] = ctx.snapped as number[]
    const wx = Math.round(scrollX * k)
    const wy = Math.round(scrollY * k)
    out.x.add((e as number) - wx)
    out.y.add((g as number) - wy)
    const engine = engineAnchor(ctx, el, dpr, scrollX, scrollY)
    out.engineX.add(engine.x - wx)
    out.engineY.add(engine.y - wy)
  }
  return out
}

const at = (type: string, x: number, y: number, w: number, h: number, extra: Record<string, unknown> = {}) =>
  ({
    ...(type === 'image'
      ? X.newImageElement({ ...STYLE, type: 'image', x, y, width: w, height: h, fileId: 'f' } as never)
      : X.newElement({ ...STYLE, type, x, y, width: w, height: h } as never)),
    ...extra,
  }) as El

// At 0.5 x 1.25 each is on an exact half device pixel (the rounded sum's own part, without the scroll; padding 20):
// a note at y 732 (732 x 1.25 - 20 = 895); a mirror's far edge at 0.8 (0.8 x 1.25 + 20 = 21); a quarter turn with
// x + (w + h) / 2 = 0.8 and y + (h - w) / 2 = 732. The sizes keep each centre off the binary grid, so the
// translation a mirror or a turn puts in the transform (the centre, scroll included, in single precision) is inexact.
const ELEMENTS: [string, El][] = [
  ['a note of a row on a tie', at('rectangle', 100.4, 732, 220, 180)],
  [
    'an image mirrored left to right (scale -1, 1)',
    at('image', -319.323, 732, 320.123, 240, { scale: [-1, 1] }),
  ],
  [
    'an image mirrored top to bottom (scale 1, -1)',
    at('image', 100.4, -239.323, 320, 240.123, { scale: [1, -1] }),
  ],
  ['an image mirrored both ways', at('image', -319.323, -239.323, 320.123, 240.123, { scale: [-1, -1] })],
  [
    'a rectangle turned a quarter (π / 2)',
    at('rectangle', -149.37, 781.953, 200.123, 100.217, { angle: Math.PI / 2 }),
  ],
  [
    'a rectangle turned a half (π)',
    at('rectangle', -319.323, -239.323, 320.123, 240.123, { angle: Math.PI }),
  ],
]

describe('T: an element lands on the same device pixels at every snapped scroll', () => {
  for (const dpr of [1.25, 1.5, 2])
    it.each(ELEMENTS)(`dpr ${dpr}, zoom 0.5: %s`, (_, el) => {
      const s = shifts(el, 0.5, dpr)
      expect([...s.x], 'x: where it lands less the whole scroll').toHaveLength(1)
      expect([...s.y], 'y: where it lands less the whole scroll').toHaveLength(1)
    })

  it('the cases mean something: the engine’s own rounding lands the tie a pixel apart at some scrolls', () => {
    for (const [what, el] of ELEMENTS.slice(0, 2)) {
      const s = shifts(el, 0.5, 1.25)
      expect(Math.max(s.engineX.size, s.engineY.size), what).toBe(2)
    }
  })

  it('off the pixel grid it is the engine’s formula to the bit: no tie bias in the anchor term', () => {
    // an unsnapped scroll whose anchor term lies 5e-7 under a half pixel: the engine rounds it down, a bias would not
    const el = ELEMENTS[0]?.[1] as El
    const zoom = 0.5
    const dpr = 1.25
    const probe = drawAt(el, zoom, dpr, 10.3, 0)
    const a = (probe.read as NonNullable<Context32['read']>).a
    const padding = draw.getCanvasPadding(el)
    let checked = 0
    for (const n of [101, 287, 413]) {
      const scrollX = ((n + 0.5 - 5e-7) / a + padding) / dpr - el.x
      const off = Math.abs(scrollX * zoom * dpr - Math.round(scrollX * zoom * dpr))
      expect(off, 'the scroll is off the grid').toBeGreaterThan(1e-3)
      const ctx = drawAt(el, zoom, dpr, scrollX, 0)
      const engine = engineAnchor(ctx, el, dpr, scrollX, 0)
      const term = engine.t.a * engine.ax + engine.t.c * engine.ay + engine.t.e
      expect(term - n, 'the anchor term').toBeGreaterThan(0.5 - 1e-6)
      expect(term - n, 'the anchor term').toBeLessThan(0.5)
      // the snapped transform's x: the engine's anchor rounding plus its own offset term (0 here: the anchor is itself)
      expect((ctx.snapped as number[])[4]).toBe(Math.round(term))
      checked++
    }
    expect(checked).toBe(3)
  })

  it('the prod build’s function gives the dev one’s answer for every call the scenarios made', () => {
    const body = lift(PROD, 'function lobbySnapAnchor(', '\n}\n')
    const prod = new Function('nu', `${body}\nreturn lobbySnapAnchor`)(1e-6) as Snap
    expect(calls.length).toBeGreaterThan(10_000)
    let differ = 0
    for (const c of calls) if (prod(...c.args) !== c.out) differ++
    expect(differ).toBe(0)
  })
})
