/**
 * Wave O (WO-PAN, O-1): the engine patch's pan speed-ups change no answer. The patch (pnpm-workspace.yaml
 * patchedDependencies: the wave O hunks of patches/@excalidraw__element@0.18.0-1118751.patch and all of
 * patches/@excalidraw__excalidraw@0.18.0-1118751.patch; the edits: docs/research/excalidraw/wave-o/pan-patch.mjs):
 *  - A1/A4: the renderer's two viewport passes (the visible elements, the render-offset pass) call
 *    `isElementInViewportAt`, isElementInViewport's test with the view as scalars. Here it gives the same answer as
 *    isElementInViewport for every element of the 10k board and of a corpus of every kind, over cameras at Lobby's
 *    zooms, cameras whose edge lies exactly on an element's bound, and render offsets (the LOD's cull offset too);
 *  - A2: a bound text's bounds are cached against its container (the same object at the same version). Here its bounds
 *    equal an uncached computation after a move, a resize and a rotation of its arrow or container (a new object or
 *    an in-place mutation), a text edit, an undo (the old object back), a remote change and a container removed;
 *  - C: shouldApplyFrameClip's bounding-box fast path. Here it equals the engine's own three tests (transcribed below
 *    from the pinned source) and leaves the same group bookkeeping, on the 10k board's notes and a corpus that touches,
 *    crosses, contains and sits a hair inside frames, rotated and grouped;
 *  - static pins: both builds of @excalidraw/excalidraw carry the A1, A3, A4 and E hunks (the renderer and the app
 *    cannot load in Node; the browser probe `pnpm probe:browser` mounts them: render-cull and embeddables).
 * Both builds of @excalidraw/element are loaded (dist/dev: Vitest and the dev server; dist/prod: the web bundle and the
 * sync service), as apps/web/src/canvas/engine/arrow-geometry.test.ts does for W5-53.
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BIG_BOARD_ID, bigBoard } from '../../../../e2e/excalidraw/support/big-board.ts'
import { count, readDist } from './bundle.ts'
import {
  answers,
  cameras,
  clipState,
  corpus,
  edgeSweep,
  type El,
  type Engine,
  engineFrameClip,
  mapOf,
  STYLE,
} from './pan/corpus.ts'

const require = createRequire(import.meta.url)
/** `dist/` of the @excalidraw/element copy the workspace resolves (the patched one). */
const DIST = dirname(dirname(require.resolve('@excalidraw/element')))
const BUILDS = ['dev', 'prod'] as const
const load = (build: (typeof BUILDS)[number]): Promise<Engine> =>
  import(/* @vite-ignore */ pathToFileURL(join(DIST, build, 'index.js')).href)

const BOARD = bigBoard(BIG_BOARD_ID).elements as unknown as El[]

describe.each(BUILDS)('wave O pan speed-ups, the %s build of @excalidraw/element', (build) => {
  const engine = load(build).then((X) => {
    X.setCustomTextMetricsProvider({ getLineWidth: (t: string) => t.length * 10 })
    return X
  })

  it('carries the patch: isElementInViewportAt is exported (an unpatched copy fails here)', async () => {
    const X = await engine
    expect(typeof X.isElementInViewportAt).toBe('function')
    // A2 and C: their call and their definition
    const src = readDist('element', build)
    expect(count(src, /lobbyBoundTextCacheHit\(/)).toBe(2)
    expect(count(src, /lobbyFrameClipNotNeeded\(/)).toBe(2)
  })

  describe('A1 / A4: the viewport test with the view as scalars answers as isElementInViewport', () => {
    it('on the 10k board, at Lobby’s zooms and on exact edges', async () => {
      const X = await engine
      const map = mapOf(BOARD)
      let compared = 0
      let visible = 0
      for (const cam of cameras(X, BOARD, map, 11)) {
        const a = answers(X, BOARD, map, cam)
        expect(a.patch).toEqual(a.engine)
        compared += a.engine.length
        visible += a.visible
      }
      // the corpus means something: some of it in view, most of it out
      expect(compared).toBeGreaterThan(400_000)
      expect(visible).toBeGreaterThan(10_000)
      expect(visible).toBeLessThan(compared / 2)
    })

    it('on every element kind (rotated, curved, elbow, labels, freedraw, frames, images)', async () => {
      const X = await engine
      const els = corpus(X)
      const map = mapOf(els)
      for (const cam of cameras(X, els, map, 5)) {
        const a = answers(X, els, map, cam)
        expect(a.patch).toEqual(a.engine)
      }
    })

    it('with render offsets: the LOD’s cull offset culls everything, a drag preview’s moves as the engine’s', async () => {
      const X = await engine
      const map = mapOf(BOARD)
      const cams = cameras(X, BOARD, map, 23).slice(0, 12)
      for (const offset of [
        { x: 1e9, y: 1e9 },
        { x: 1e7, y: 1e7 },
        { x: 37.25, y: -12.5 },
        { x: -0.1, y: 1e-7 },
      ])
        for (const cam of cams) {
          const a = answers(X, BOARD, map, cam, offset)
          expect(a.patch).toEqual(a.engine)
          if (offset.x >= 1e7) expect(a.visible).toBe(0)
        }
    })
  })

  describe('A2: a bound text’s cached bounds follow its container', () => {
    /** the label's bounds through the cache, which must equal an uncached computation */
    const check = (X: Engine, label: El, map: Map<string, El>, what: string) => {
      const truth = X.ElementBounds.calculateBounds(label, map)
      const got = X.getElementBounds(label, map)
      expect(got, what).toEqual(truth)
      return got
    }

    it('an arrow’s label: move, resize, rotate, in-place mutation, text edit, undo, remote change, container gone', async () => {
      const X = await engine
      const arrow0 = X.newArrowElement({
        ...STYLE,
        type: 'arrow',
        x: 100,
        y: 100,
        width: 400,
        height: 0,
        points: [
          [0, 0],
          [400, 0],
        ],
      })
      let label = X.newTextElement({ ...STYLE, x: 0, y: 0, text: 'label', containerId: arrow0.id })
      let arrow = { ...arrow0, boundElements: [{ id: label.id, type: 'text' }] }
      const map = new Map<string, El>([
        [arrow.id, arrow],
        [label.id, label],
      ])
      const first = check(X, label, map, 'first')
      // a hit: the same entry (the patch's point: the label no longer recomputes on every pan frame)
      expect(X.getElementBounds(label, map)).toBe(first)

      const before = arrow
      arrow = X.newElementWith(arrow, { x: 260, y: -40 })
      map.set(arrow.id, arrow)
      const moved = check(X, label, map, 'arrow moved (a new object)')
      expect(moved[0]).toBeCloseTo(first[0] + 160, 6)

      arrow = X.newElementWith(arrow, {
        width: 800,
        height: 300,
        points: [
          [0, 0],
          [800, 300],
        ],
      })
      map.set(arrow.id, arrow)
      const resized = check(X, label, map, 'arrow resized')
      expect(resized).not.toEqual(moved)

      X.mutateElement(arrow, map, {
        points: [
          [0, 0],
          [200, 600],
        ],
        width: 200,
        height: 600,
      })
      const mutated = check(X, label, map, 'arrow mutated in place (the same object, its version bumped)')
      expect(mutated).not.toEqual(resized)

      label = X.newElementWith(label, { text: 'a much longer label', width: 190 })
      map.set(label.id, label)
      check(X, label, map, 'label text edited')

      map.set(before.id, before)
      const undone = check(X, label, map, 'undo: the earlier arrow object back')
      expect(undone[0]).toBeLessThan(mutated[0])

      // a remote change: the server's copy, a new object at a later version
      const remote = { ...before, x: before.x - 75, version: arrow.version + 1, versionNonce: 42 }
      map.set(remote.id, remote)
      check(X, label, map, 'remote change')
      // the same remote copy applied twice (a reconnect's reset): a new object at the same version
      map.set(remote.id, { ...remote })
      check(X, label, map, 'remote copy again')

      map.delete(remote.id)
      check(X, label, map, 'container gone')
      map.set(remote.id, remote)
      check(X, label, map, 'container back')
    })

    it('a note’s label (a rectangle container): it is placed by its own x/y, the container’s change is followed', async () => {
      const X = await engine
      let note = X.newElement({ ...STYLE, type: 'rectangle', x: 0, y: 0, width: 220, height: 160 })
      let label = X.newTextElement({ ...STYLE, x: 10, y: 60, text: 'note', containerId: note.id })
      note = { ...note, boundElements: [{ id: label.id, type: 'text' }] }
      const map = new Map<string, El>([
        [note.id, note],
        [label.id, label],
      ])
      const first = check(X, label, map, 'first')
      note = X.newElementWith(note, { x: 500, angle: 0.5 })
      map.set(note.id, note)
      check(X, label, map, 'container moved and rotated')
      label = X.newElementWith(label, { x: 510, angle: 0.5 })
      map.set(label.id, label)
      const followed = check(X, label, map, 'label moved with it (the server re-lays it out)')
      expect(followed[0]).toBeGreaterThan(first[0] + 400)
      X.mutateElement(note, map, { width: 600 })
      check(X, label, map, 'container resized in place')
    })

    it('the nonRotated bounds of a rotated label are never served from the label cache', async () => {
      const X = await engine
      const arrow = X.newArrowElement({
        ...STYLE,
        type: 'arrow',
        x: 0,
        y: 0,
        points: [
          [0, 0],
          [300, 100],
        ],
      })
      const label = X.newTextElement({
        ...STYLE,
        x: 0,
        y: 0,
        text: 'tilted',
        containerId: arrow.id,
        angle: 0.6,
      })
      const map = new Map<string, El>([
        [arrow.id, arrow],
        [label.id, label],
      ])
      const rotated = X.getElementBounds(label, map)
      const flat = X.getElementBounds(label, map, true)
      expect(flat).toEqual(X.ElementBounds.calculateBounds({ ...label, angle: 0 }, map))
      expect(flat).not.toEqual(rotated)
    })
  })

  describe('C: shouldApplyFrameClip with its fast path answers as the engine’s three tests', () => {
    const compare = (X: Engine, element: El, frame: El, map: Map<string, El>, dragging: boolean) => {
      const appState = clipState(dragging)
      const gotGroups = new Map<string, boolean>()
      const wantGroups = new Map<string, boolean>()
      const got = X.shouldApplyFrameClip(element, frame, appState, map, gotGroups)
      const want = engineFrameClip(X, element, frame, appState, map, wantGroups)
      expect({ id: element.id, clip: got, groups: [...gotGroups] }).toEqual({
        id: element.id,
        clip: want,
        groups: [...wantGroups],
      })
      return want
    }

    it('on the 10k board’s frame children (the notes of every frame)', async () => {
      const X = await engine
      const map = mapOf(BOARD)
      let inside = 0
      for (const e of BOARD) {
        if (!e.frameId || e.type === 'frame' || (e.type === 'text' && e.containerId)) continue
        const frame = map.get(e.frameId)
        if (!compare(X, e, frame, map, false)) inside++
      }
      expect(inside).toBeGreaterThan(4_000)
    })

    it('on a corpus that sits inside, a hair inside, on the edge, across, around and outside, rotated and grouped', async () => {
      const X = await engine
      const frame = { ...X.newFrameElement({ x: 0, y: 0, width: 1000, height: 800 }), id: 'F' }
      const tilted = { ...frame, id: 'T', angle: 0.4 }
      const els: El[] = []
      const at = (x: number, y: number, w: number, h: number, extra: Record<string, unknown> = {}) => {
        for (const type of ['rectangle', 'ellipse', 'diamond'])
          for (const groupIds of [[], ['g1'], ['g1', 'g2']])
            els.push(
              X.newElement({ ...STYLE, type, x, y, width: w, height: h, groupIds, frameId: 'F', ...extra }),
              X.newElement({ ...STYLE, type, x, y, width: w, height: h, groupIds, frameId: null, ...extra }),
            )
      }
      at(100, 100, 200, 150) // well inside
      at(1e-9, 1e-9, 200, 150) // a hair inside the top-left corner
      at(0, 0, 200, 150) // on the edge
      at(800, 650, 200, 150) // touching the bottom-right edges
      at(900, 700, 200, 150) // across
      at(-50, -50, 1100, 900) // around: contains the frame
      at(1200, 100, 100, 100) // outside
      at(400, 300, 300, 200, { angle: 0.8 }) // rotated, inside
      at(850, 300, 300, 200, { angle: 0.8 }) // rotated, across
      at(100, 100, 300, 200, { roundness: { type: 3 }, roughness: 2 }) // rounded, rough, inside
      const arrow = X.newArrowElement({
        ...STYLE,
        type: 'arrow',
        x: 100,
        y: 400,
        frameId: 'F',
        points: [
          [0, 0],
          [400, -300],
          [850, 100],
        ],
        roundness: { type: 2 },
      })
      const across = X.newArrowElement({
        ...STYLE,
        type: 'arrow',
        x: 500,
        y: 400,
        frameId: 'F',
        points: [
          [0, 0],
          [700, 100],
        ],
      })
      const label = X.newTextElement({
        ...STYLE,
        x: 0,
        y: 0,
        text: 'inside',
        containerId: arrow.id,
        frameId: 'F',
      })
      const free = X.newFreeDrawElement({
        ...STYLE,
        type: 'freedraw',
        x: 200,
        y: 200,
        frameId: 'F',
        points: Array.from({ length: 30 }, (_, k) => [k * 9, Math.cos(k / 2) * 40]),
        pressures: [],
        simulatePressure: true,
      })
      // a grouped arrow label whose stored x/y went stale far outside: its bounds (from the arrow) are inside, the
      // group test reads the stored ones (getCommonBounds without the map), so the engine clips it
      const stale = { ...label, id: 'stale-label', x: 5000, y: 5000, groupIds: ['g3'] }
      els.push({ ...arrow, boundElements: [{ id: label.id, type: 'text' }] }, label, stale, across, free)
      const map = mapOf([frame, tilted, ...els])
      let fast = 0
      for (const f of [frame, tilted])
        for (const e of els)
          for (const dragging of [false, true]) if (!compare(X, e, f, map, dragging) && f === frame) fast++
      expect(fast).toBeGreaterThan(50)
    })

    it('every kind swept across each edge of a frame, from 20 px out to 20 px in, grouped and not', async () => {
      const X = await engine
      const { frame, els } = edgeSweep(X)
      const map = mapOf([frame, ...els])
      let clipped = 0
      for (const e of els)
        for (const dragging of [false, true]) if (compare(X, e, frame, map, dragging)) clipped++
      expect(clipped).toBeGreaterThan(100)
    })

    it('a rotated frame never takes the fast path: a grid over its unrotated rectangle', async () => {
      const X = await engine
      const tilted = { ...X.newFrameElement({ x: 0, y: 0, width: 1000, height: 800 }), id: 'T', angle: 0.4 }
      const els: El[] = []
      for (let x = 10; x < 1000; x += 110)
        for (let y = 10; y < 800; y += 90)
          els.push(X.newElement({ ...STYLE, type: 'rectangle', x, y, width: 80, height: 60, frameId: 'T' }))
      const map = mapOf([tilted, ...els])
      let clipped = 0
      for (const e of els) if (compare(X, e, tilted, map, false)) clipped++
      // the corners the rotation cuts off: part of the grid crosses the rotated outline
      expect(clipped).toBeGreaterThan(5)
    })

    it('frame clipping off: false, as before', async () => {
      const X = await engine
      const frame = X.newFrameElement({ x: 0, y: 0, width: 100, height: 100 })
      const e = X.newElement({ ...STYLE, type: 'rectangle', x: 50, y: 50, width: 200, height: 200 })
      const map = mapOf([frame, e])
      expect(X.shouldApplyFrameClip(e, frame, { frameRendering: { clip: false } }, map)).toBe(false)
    })
  })
})

describe('wave O pan speed-ups: static pins in both builds of @excalidraw/excalidraw', () => {
  const builds = { dev: readDist('excalidraw', 'dev'), prod: readDist('excalidraw', 'prod') }

  it.each(BUILDS)('%s: the A1/A4, A3 and E hunks are applied', (build) => {
    const src = builds[build]
    // A1/A4: the scalar test, in the engine's memoized offset pass (kept for its clear()) and in A4b's
    expect(count(src, build === 'dev' ? /isElementInViewportAt\(/ : /lobbyInViewAt\(/)).toBe(2)
    // A3: the kept renderable map; A5 and A4b: the viewport pass and the offset pass (each a call and a definition)
    expect(count(src, /lobbyKeptRenderableElementsMap\(/)).toBe(2)
    expect(count(src, /lobbyVisibleCanvasElements\(/)).toBe(2)
    expect(count(src, /lobbyOffsetsPass\(/)).toBe(2)
    // E: both scans memoized, the statuses' one writer bumps their revision
    expect(count(src, /lobbyEmbeddablesUnchanged\(this\)/)).toBe(1)
    expect(count(src, /lobbyEmbeddablesToRender\(this,/)).toBe(1)
    expect(count(src, /lobbyEmbedsRev ?= ?\(this\.lobbyEmbedsRev ?\?\? ?0\) ?\+ ?1/)).toBe(1)
    // the statuses have no other writer (a second one would need the revision too)
    expect(count(src, /embedsValidationStatus\.set\(/)).toBe(1)
  })

  it('dev: the in-place hunks keep every line where it was (the probes and the docs cite dist/dev lines)', () => {
    const lines = builds.dev.split('\n')
    expect(lines[24161]).toContain('const isVisible = (element, offset) => isElementInViewportAt(')
    expect(lines[24223]).toContain('lobbyKeptRenderableElementsMap(')
    expect(lines[24324]).toContain('return lobbyVisibleCanvasElements(')
    expect(lines[24287]).toContain('return lobbyOffsetsPass(this, {')
    expect(lines[42582]).toContain('this.lobbyEmbedsRev')
    expect(lines[42586]).toContain('if (lobbyEmbeddablesUnchanged(this)) return;')
    expect(lines[48405]).toContain('lobbyEmbeddablesToRender(this,')
    // and what came after them is where it was
    expect(lines[44684]).toContain('handleTextWysiwyg')
    expect(lines[47779]).toContain('__publicField(this, "savePointer"')
  })
})

describe('wave O O-2: the pan blit and the tie bias, static pins', () => {
  it.each(BUILDS)('%s element build: T, the element snap rounds the same at every scroll', (build) => {
    const src = readDist('element', build)
    // its two calls (dev: one a line; prod: one line) and its definition
    expect(count(src, /lobbySnapAnchor\(/)).toBe(3)
    // the shipped function itself, lifted out of the build and run on Chrome's single-precision transform: at zoom 0.5
    // and dpr 1.25 the context's scale is 0.625 x float32(0.8) = 0.5000000074505806, not 0.5
    const at = src.indexOf('function lobbySnapAnchor(')
    const body = src.slice(at, src.indexOf('\n}\n', at) + 2)
    const bias = build === 'dev' ? 'SNAP_TIE_BIAS' : 'nu'
    const snap = new Function(bias, `${body}\nreturn lobbySnapAnchor`)(1e-6) as (...a: unknown[]) => number
    const zoom = 0.5
    const dpr = 1.25
    const k = zoom * dpr
    const q = 0.625 * Math.fround(0.8)
    // a row of notes at y 732 (padding 20): its anchor term is an exact half pixel at every snapped scroll
    const shifts = { old: new Set<number>(), now: new Set<number>() }
    for (let raw = -40_000; raw <= 40_000; raw += 37.3) {
      const scrollY = Math.round(raw * k) / k
      const whole = Math.round(scrollY * k)
      const anchorY = (732 + scrollY) * dpr - 20
      const appState = { zoom: { value: zoom }, scrollX: 0, scrollY }
      shifts.old.add(Math.round(q * anchorY + 1e-6) - whole)
      shifts.now.add(snap(0, q, 0, 0, anchorY, 0, 732, { x: 0, y: 0 }, 20, appState, dpr) - whole)
    }
    // the engine's own rounding (with the bias) lands the row a pixel apart at some scrolls; the patch's never does
    expect(shifts.old.size).toBe(2)
    expect([...shifts.now]).toEqual([Math.round(q * (732 * dpr - 20) + 1e-6)])
    // off the pixel grid (an unsnapped scroll) or with another transform it rounds as before
    const appState = { zoom: { value: zoom }, scrollX: 0, scrollY: 10.3 }
    const anchorY = (732 + 10.3) * dpr - 20
    const before = Math.round(q * anchorY + 1e-6)
    expect(snap(0, q, 0, 0, anchorY, 0, 732, { x: 0, y: 0 }, 20, appState, dpr)).toBe(before)
  })

  it.each(BUILDS)(
    '%s excalidraw build: every static render goes through the blit, which is exported',
    (build) => {
      const chunk = readDist('excalidraw', build, build === 'dev' ? 'chunk-FN755BR4.js' : 'chunk-K5UJM3GG.js')
      const index = readDist('excalidraw', build)
      // the throttled render and the direct one, and the definition
      expect(count(chunk, /lobbyRenderStaticScene\(/)).toBe(3)
      // the engine's own render is left as it is: the blit shifts the frame into a scratch copy and copies it back
      expect(count(chunk, /lobbyPanBlitScratchOf\(/)).toBe(2)
      expect(count(index, /setPanBlit/)).toBeGreaterThanOrEqual(1)
      expect(count(index, /getPanBlitStats/)).toBeGreaterThanOrEqual(1)
      // StaticCanvas hands the canvas nonce to the render
      const nonce = build === 'dev' ? /canvasNonce: props\.canvasNonce/ : /canvasNonce:e\.canvasNonce/
      expect(count(index, nonce)).toBe(1)
    },
  )

  const devChunk = readDist('excalidraw', 'dev', 'chunk-FN755BR4.js')
  const devIndex = readDist('excalidraw', 'dev')
  const devElement = readDist('element', 'dev')
  /** the text from `from` (its last occurrence with `last`: esbuild marks a file's sections again) to `to` */
  const between = (src: string, from: string, to: string, last = false) => {
    const a = last ? src.lastIndexOf(from) : src.indexOf(from)
    const b = src.indexOf(to, a + from.length)
    expect(a, from).toBeGreaterThanOrEqual(0)
    expect(b, to).toBeGreaterThan(a)
    return src.slice(a, b)
  }
  const fields = (src: string, re: RegExp) => new Set([...src.matchAll(re)].map((m) => m[1] as string))
  const keyFields = fields(
    between(devChunk, 'function lobbyPanBlitKey(', 'function lobbySameKey('),
    /\ba\.(\w+)/g,
  )

  it('the key holds every app state field the StaticCanvas memo compares (areEqual: getRelevantAppStateProps)', () => {
    const memo = fields(
      between(devIndex, 'var getRelevantAppStateProps2 = (appState) => {', 'return relevantAppStateProps;'),
      /appState\.(\w+)/g,
    )
    expect(memo.size).toBeGreaterThan(20)
    for (const f of memo) if (f !== 'scrollX' && f !== 'scrollY') expect([...keyFields], f).toContain(f)
  })

  it('and every one the static render reads (the scene, the link icons, the element renderer)', () => {
    const reads = new Set([
      ...fields(
        between(devChunk, '// renderer/staticScene.ts', '// renderer/staticSvgScene.ts'),
        /appState\??\.(\w+)/g,
      ),
      ...fields(
        between(devElement, '// src/renderElement.ts', '// src/shape.ts', true),
        /appState\??\.(\w+)/g,
      ),
    ])
    expect(reads.size).toBeGreaterThan(8)
    for (const f of reads) if (f !== 'scrollX' && f !== 'scrollY') expect([...keyFields], f).toContain(f)
  })

  it('its copy of getCanvasPadding is the engine’s (an element draws only into its cached canvas’s margin)', () => {
    const engine = between(devElement, 'var getCanvasPadding = (element) => {', '\n};')
    const copy = between(devChunk, 'function lobbyCanvasPadding(el) {', '\n}')
    const cases = (s: string) =>
      s
        .replace(/\belement\b/g, 'el')
        .replace(/if \((.+)\) \{\s*return (\d+);\s*\}\s*return (\d+);/, 'return $1 ? $2 : $3;')
        .replace(/\s+/g, '')
    expect(cases(copy).replace(/^functionlobbyCanvasPadding\(el\)\{/, '')).toBe(
      cases(engine).replace(/^varg?etCanvasPadding=\(el\)=>\{/, ''),
    )
  })
})
