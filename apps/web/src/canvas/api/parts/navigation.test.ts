// 3b's camera members (./navigation.ts): the pure camera math, and the members on a bare port.
import { describe, expect, it } from 'vitest'
import type { CanvasElement, CanvasPort, Viewport } from '../../port.ts'
import { createLobbyCanvas } from '../impl.ts'
import { createFeatureRegistries } from '../registries.ts'
import {
  centeredOn,
  contentBox,
  ENGINE_MIN_ZOOM,
  elementBox,
  ensureVisibleCamera,
  FIT_FILL,
  fitCamera,
  fitZoom,
  limitsFor,
  MAX_ZOOM,
  nextZoomStep,
  ZOOM_STEPS,
  zoomAround,
  zoomToCamera,
} from './navigation.ts'

const SCREEN = { width: 1000, height: 600 }

describe('camera math', () => {
  it('fits a rectangle with the inset on each side', () => {
    expect(fitZoom({ x: 0, y: 0, width: 872, height: 100 }, SCREEN)).toBeCloseTo(1)
    expect(fitZoom({ x: 0, y: 0, width: 100, height: 472 }, SCREEN)).toBeCloseTo(1)
    expect(fitZoom({ x: 0, y: 0, width: 0, height: 0 }, SCREEN, 0)).toBe(600)
  })

  it('zooms to a rectangle: centred, capped at 100% unless told, clamped to the limits, or an exact zoom', () => {
    const limits = { min: 0.05, max: MAX_ZOOM }
    const small = { x: 100, y: 100, width: 50, height: 50 }
    const a = zoomToCamera(small, SCREEN, limits)
    expect(a.zoom).toBe(1)
    expect(a.x + SCREEN.width / 2).toBe(125)
    expect(a.y + SCREEN.height / 2).toBe(125)
    expect(zoomToCamera(small, SCREEN, limits, { maxZoom: 20 }).zoom).toBe(MAX_ZOOM)
    expect(zoomToCamera(small, SCREEN, limits, { zoom: 0.5 }).zoom).toBe(0.5)
    // a huge board: below Excalidraw's 0.1, down to the floor
    const huge = { x: 0, y: 0, width: 100_000, height: 10 }
    expect(zoomToCamera(huge, SCREEN, limits).zoom).toBe(0.05)
    expect(zoomToCamera(huge, SCREEN, { min: 0.001, max: 8 }).zoom).toBeCloseTo(872 / 100_000)
  })

  it('limits: the floor is the whole-board fit when that is below 0.1, else 0.1', () => {
    expect(limitsFor(null)).toEqual({ min: ENGINE_MIN_ZOOM, max: MAX_ZOOM, steps: ZOOM_STEPS, fit: 1 })
    expect(limitsFor(0.4).min).toBe(ENGINE_MIN_ZOOM)
    const heavy = limitsFor(0.054)
    expect(heavy.min).toBe(0.054)
    expect(heavy.steps[0]).toBe(0.054)
    expect(heavy.steps.slice(1)).toEqual(ZOOM_STEPS)
    expect(limitsFor(0.0001).min).toBe(0.01)
  })

  it('zoom steps as tldraw steps them', () => {
    expect(nextZoomStep(1, ZOOM_STEPS, 'in')).toBe(2)
    expect(nextZoomStep(1, ZOOM_STEPS, 'out')).toBe(0.5)
    expect(nextZoomStep(0.9, ZOOM_STEPS, 'in')).toBe(2) // past the halfway point to 1: the next one
    expect(nextZoomStep(0.6, ZOOM_STEPS, 'in')).toBe(1)
    expect(nextZoomStep(8, ZOOM_STEPS, 'in')).toBe(8)
    expect(nextZoomStep(0.1, ZOOM_STEPS, 'out')).toBe(0.1)
    expect(nextZoomStep(0.1, [0.05, ...ZOOM_STEPS], 'out')).toBe(0.05)
    // above the top step (Excalidraw's own wheel goes to 30): tldraw's rule lands one below it
    expect(nextZoomStep(20, ZOOM_STEPS, 'out')).toBe(4)
  })

  it('zooms around a point that stays put on screen', () => {
    const v: Viewport = { x: 0, y: 0, width: 1000, height: 600, zoom: 1 }
    const to = zoomAround(v, { x: 250, y: 150 }, 2)
    // the point was 250 px from the left; at zoom 2 it still is
    expect((250 - to.x) * 2).toBe(250)
    expect((150 - to.y) * 2).toBe(150)
    expect(centeredOn({ x: 0, y: 0 }, 2, SCREEN)).toEqual({ x: -250, y: -150, zoom: 2 })
  })

  it('ensure visible: nothing when on screen, a pan when it fits, a zoom out (never in) when it does not', () => {
    const v: Viewport = { x: 0, y: 0, width: 1000, height: 600, zoom: 1 }
    const limits = { min: 0.05, max: 8 }
    expect(ensureVisibleCamera(v, { x: 100, y: 100, width: 50, height: 50 }, 16, limits)).toBeNull()
    const panned = ensureVisibleCamera(v, { x: 1200, y: 100, width: 100, height: 50 }, 16, limits)
    expect(panned).toEqual({ x: 1300 + 16 - 1000, y: 0, zoom: 1 })
    const out = ensureVisibleCamera(v, { x: 0, y: 0, width: 4000, height: 50 }, 16, limits)
    expect(out?.zoom).toBeLessThan(1)
    const tiny = ensureVisibleCamera(
      { ...v, zoom: 0.5, width: 2000, height: 1200 },
      { x: 5000, y: 0, width: 1, height: 1 },
      16,
      limits,
    )
    expect(tiny?.zoom).toBe(0.5)
  })
})

describe('the members on a bare port (composed from C0 members alone)', () => {
  function port(elements: CanvasElement[], view: Viewport) {
    let v = view
    const sets: Partial<Viewport>[] = []
    const p: CanvasPort = {
      items: () => elements,
      get: (id) => elements.find((e) => e.id === id),
      bounds: (id) => {
        const e = elements.find((x) => x.id === id)
        return e ? { x: e.x, y: e.y, width: e.width, height: e.height } : null
      },
      selection: [],
      select: () => {},
      viewport: {
        get: () => v,
        set: (next) => {
          sets.push(next)
          const zoom = next.zoom ?? v.zoom
          v = {
            x: next.x ?? v.x,
            y: next.y ?? v.y,
            width: (v.width * v.zoom) / zoom,
            height: (v.height * v.zoom) / zoom,
            zoom,
          }
        },
        fit: () => {},
      },
      sceneToScreen: (q) => ({ x: (q.x - v.x) * v.zoom, y: (q.y - v.y) * v.zoom }),
      screenToScene: (q) => ({ x: q.x / v.zoom + v.x, y: q.y / v.zoom + v.y }),
      transact: (_l, fn) => fn({ create: () => 'n', update: () => {}, delete: () => {} }),
      setTool: () => true,
      tool: () => 'select',
      on: () => () => {},
      editingId: () => null,
      leaseHolder: () => null,
      collaborators: () => [],
      saveStatus: () => ({ state: 'saved', pending: 0, offlineChanges: 0, lastReject: null }),
      engine: null,
    }
    return { p, sets, now: () => v }
  }
  const el = (id: string, x: number, y: number, width: number, height: number) =>
    ({
      id,
      type: 'rectangle',
      x,
      y,
      width,
      height,
      angle: 0,
      groupIds: [],
      frameId: null,
      locked: false,
      isDeleted: false,
      version: 1,
      versionNonce: 1,
      index: 'a0',
    }) as unknown as CanvasElement

  it('zoomTo, centerOn, zoomStep and limits move through viewport.set', () => {
    const els = [el('a', 0, 0, 100, 100), el('far', 20_000, 0, 100, 100)]
    const { p, sets, now } = port(els, { x: 0, y: 0, width: 1000, height: 600, zoom: 1 })
    const { canvas } = createLobbyCanvas({ port: p, registries: createFeatureRegistries() })
    const l = canvas.viewport.limits()
    expect(l.fit).toBeCloseTo(872 / 20_100)
    expect(l.min).toBeCloseTo(872 / 20_100)
    canvas.viewport.zoomTo({ x: 0, y: 0, width: 20_100, height: 100 }, { maxZoom: 8 })
    expect(now().zoom).toBeCloseTo(l.fit)
    canvas.viewport.centerOn({ x: 50, y: 50 })
    expect(now().x + now().width / 2).toBeCloseTo(50)
    canvas.viewport.set({ zoom: 1 })
    canvas.viewport.zoomStep('in', { x: 0, y: 0 })
    expect(now().zoom).toBe(2)
    canvas.viewport.zoomStep('out')
    expect(now().zoom).toBe(1)
    const n = sets.length
    canvas.viewport.ensureVisible(['a'])
    expect(sets.length).toBe(n + 1)
  })
})

describe('the whole board in one pass, and Lobby’s own fit (wave 3b)', () => {
  const base = {
    angle: 0,
    groupIds: [],
    frameId: null,
    locked: false,
    isDeleted: false,
    version: 1,
    versionNonce: 1,
    index: 'a0',
  }
  const box = (e: Record<string, unknown>) => elementBox({ ...base, ...e } as unknown as CanvasElement)

  it('an element’s box from its own fields: rotated about its centre; a line’s box of its points', () => {
    expect(box({ id: 'r', type: 'rectangle', x: 10, y: 20, width: 100, height: 50 })).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 50,
    })
    const turned = box({ id: 'r', type: 'rectangle', x: 0, y: 0, width: 100, height: 50, angle: Math.PI / 2 })
    expect(turned.x).toBeCloseTo(25)
    expect(turned.y).toBeCloseTo(-25)
    expect(turned.width).toBeCloseTo(50)
    expect(turned.height).toBeCloseTo(100)
    const arrow = box({
      id: 'a',
      type: 'arrow',
      x: 100,
      y: 100,
      width: 50,
      height: 80,
      points: [
        [0, 0],
        [-20, 30],
        [50, 80],
      ],
    })
    expect(arrow).toEqual({ x: 80, y: 100, width: 70, height: 80 })
  })

  it('the content box skips bound labels, deleted and hidden items', () => {
    const els = [
      { ...base, id: 'a', type: 'stickynote', x: 0, y: 0, width: 200, height: 200 },
      { ...base, id: 'l', type: 'text', containerId: 'a', x: -500, y: -500, width: 10, height: 10 },
      { ...base, id: 'gone', type: 'rectangle', x: 9000, y: 0, width: 10, height: 10, isDeleted: true },
      { ...base, id: 'hid', type: 'rectangle', x: -9000, y: 0, width: 10, height: 10 },
      { ...base, id: 'b', type: 'frame', x: 1000, y: 500, width: 400, height: 300 },
    ] as unknown as CanvasElement[]
    expect(contentBox(els, (id) => id === 'hid')).toEqual({ x: 0, y: 0, width: 1400, height: 800 })
    expect(contentBox([])).toBeNull()
  })

  it('fit: 80% of the canvas, never above 100%, down to Lobby’s floor instead of Excalidraw’s 0.1', () => {
    const screen = { width: 1000, height: 600 }
    const small = fitCamera({ x: 0, y: 0, width: 100, height: 100 }, screen, { min: 0.1 })
    expect(small.zoom).toBe(1)
    const wide = fitCamera({ x: -30_000, y: 0, width: 60_000, height: 200 }, screen, { min: 0.01 })
    expect(wide.zoom).toBeCloseTo((1000 / 60_000) * FIT_FILL)
    expect(wide.x + screen.width / wide.zoom / 2).toBeCloseTo(0)
    expect(fitCamera({ x: 0, y: 0, width: 60_000, height: 10 }, screen, { min: 0.1 }).zoom).toBe(0.1)
  })

  it('viewport.fit on a canvas goes below 0.1 for a wide board, and fits given ids', () => {
    const els = [
      { ...base, id: 'w', type: 'stickynote', x: -30_000, y: 0, width: 200, height: 200 },
      { ...base, id: 'e', type: 'stickynote', x: 30_000, y: 0, width: 200, height: 200 },
    ] as unknown as CanvasElement[]
    let v: Viewport = { x: 0, y: 0, width: 1000, height: 600, zoom: 1 }
    const set = (next: Partial<Viewport>) => {
      const zoom = next.zoom ?? v.zoom
      v = {
        x: next.x ?? v.x,
        y: next.y ?? v.y,
        width: (v.width * v.zoom) / zoom,
        height: (v.height * v.zoom) / zoom,
        zoom,
      }
    }
    const p = {
      items: () => els,
      get: (id: string) => els.find((e) => e.id === id),
      bounds: (id: string) => {
        const e = els.find((x) => x.id === id)
        return e ? { x: e.x, y: e.y, width: e.width, height: e.height } : null
      },
      selection: [],
      select: () => {},
      viewport: { get: () => v, set, fit: () => set({ zoom: 0.1 }) },
      sceneToScreen: (q: { x: number; y: number }) => q,
      screenToScene: (q: { x: number; y: number }) => q,
      transact: () => undefined,
      setTool: () => true,
      tool: () => 'select',
      on: () => () => {},
      editingId: () => null,
      leaseHolder: () => null,
      collaborators: () => [],
      saveStatus: () => ({ state: 'saved', pending: 0, offlineChanges: 0, lastReject: null }),
      engine: null,
    } as unknown as CanvasPort
    const { canvas } = createLobbyCanvas({ port: p, registries: createFeatureRegistries() })
    canvas.viewport.fit()
    expect(v.zoom).toBeLessThan(ENGINE_MIN_ZOOM)
    // 80% of the canvas would be below the floor (the whole-board fit with its 64 px inset): the floor
    expect(v.zoom).toBeCloseTo((1000 - 128) / 60_200)
    expect(v.x).toBeLessThanOrEqual(-30_000)
    expect(v.x + v.width).toBeGreaterThanOrEqual(30_200)
    canvas.viewport.fit(['e'])
    expect(v.zoom).toBe(1)
    expect(v.x + v.width / 2).toBeCloseTo(30_100)
  })
})
