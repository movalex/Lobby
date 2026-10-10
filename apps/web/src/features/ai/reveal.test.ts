// Wave M (W4, M4-4, FTU-8): reveal the result, and put new content in free space.
//  - safeViewRect: the view less the chrome along its edges (the style panel takes the right, the bottom toolbar the
//    bottom; the selection bar, which follows the selection, takes nothing).
//  - revealCamera / revealResult: a result already in the safe part stays put; one that is not is centred there, at
//    the same zoom when it fits, else zoomed out to fit (never in, never past 100%); the camera only, nothing written.
//  - findSpot (public.ts, ./ported/apply.ts spotNear) avoids frames and what is on the board; a Piece inserted with
//    Enter over a 2x2 frame lands outside it, on the open canvas (frameId null).
import { installServerTextMetrics } from '@draftroom/canvas-schema/engine'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { CanvasFeatureContext, LobbyCanvas } from '../../canvas/api/index.ts'
import { OBSTACLE_IDS } from '../../lib/overlay-obstacles.ts'
import { insertPiece } from '../pieces/insert.ts'
import { type El, fakeCanvas, frameEl, noteEls } from '../sort/test-kit.ts'
import { safeViewRect } from './board-chrome.ts'
import { findSpot } from './ported/public.ts'
import { revealCamera, revealResult } from './reveal.ts'

beforeAll(() => {
  installServerTextMetrics()
})

const VIEW = { x: 44, y: 48, width: 1396, height: 852 }
const STYLE = { x: 1212, y: 60, width: 216, height: 450 }
const TOOLBAR = { x: 460, y: 840, width: 568, height: 48 }

describe('safeViewRect (M4-4)', () => {
  it('takes the style panel off the right and the bottom toolbar off the bottom', () => {
    const safe = safeViewRect(VIEW, [
      { id: OBSTACLE_IDS.stylePanel, kind: 'panel', rect: STYLE },
      { id: OBSTACLE_IDS.bottomToolbar, kind: 'toolbar', rect: TOOLBAR },
    ])
    expect(safe).toEqual({ x: 44, y: 48, width: 1212 - 44, height: 840 - 48 })
  })

  it('leaves out the selection bar and the flow handles (they move with the selection), what lies in the middle of the view and what lies outside it', () => {
    const safe = safeViewRect(VIEW, [
      { id: OBSTACLE_IDS.selectionBar, kind: 'bar', rect: { x: 400, y: 840, width: 500, height: 36 } },
      { id: OBSTACLE_IDS.flowHandles, kind: 'handles', rect: { x: 600, y: 300, width: 300, height: 240 } },
      { x: 600, y: 300, width: 300, height: 240 },
      { x: 2000, y: 0, width: 100, height: 100 },
    ])
    expect(safe).toEqual(VIEW)
  })

  it('keeps at least a third of the view each way', () => {
    const safe = safeViewRect(VIEW, [{ x: 44, y: 48, width: 1396, height: 800 }])
    expect(safe.height).toBeGreaterThanOrEqual(VIEW.height / 3 - 0.5)
  })
})

describe('revealCamera (M4-4)', () => {
  const safe = { x: 44, y: 48, width: 1100, height: 760 }
  it('keeps the zoom when the result fits at it, and centres it in the safe part', () => {
    const to = revealCamera({ x: 5000, y: 3000, width: 400, height: 300 }, safe, VIEW, { zoom: 0.8 })
    expect(to.zoom).toBe(0.8)
    // the result's middle sits at the safe part's middle
    const cx = (5200 - to.x) * to.zoom + VIEW.x
    const cy = (3150 - to.y) * to.zoom + VIEW.y
    expect(cx).toBeCloseTo(safe.x + safe.width / 2)
    expect(cy).toBeCloseTo(safe.y + safe.height / 2)
  })

  it('zooms out to fit a result too big for the safe part, never in and never past 100%', () => {
    expect(revealCamera({ x: 0, y: 0, width: 4400, height: 1000 }, safe, VIEW, { zoom: 1 }).zoom).toBeCloseTo(
      0.25,
    )
    expect(revealCamera({ x: 0, y: 0, width: 10, height: 10 }, safe, VIEW, { zoom: 0.5 }).zoom).toBe(0.5)
    expect(revealCamera({ x: 0, y: 0, width: 10, height: 10 }, safe, VIEW, { zoom: 3 }).zoom).toBe(1)
    expect(
      revealCamera({ x: 0, y: 0, width: 1e6, height: 10 }, safe, VIEW, { zoom: 1 }, { min: 0.05, max: 1 })
        .zoom,
    ).toBe(0.05)
  })
})

/** A canvas at `zoom` 1 whose client px are scene px less `at` (the view's top-left in the scene). */
function cameraCanvas(bounds: { x: number; y: number; width: number; height: number }, at = { x: 0, y: 0 }) {
  const set = vi.fn()
  const transact = vi.fn()
  const canvas = {
    boundsOf: () => bounds,
    viewport: {
      screenRect: () => VIEW,
      get: () => ({ x: at.x, y: at.y, width: VIEW.width, height: VIEW.height, zoom: 1 }),
      set,
      limits: () => ({ min: 0.1, max: 4, steps: [], fit: 1 }),
    },
    sceneToScreen: (p: { x: number; y: number }) => ({ x: p.x - at.x + VIEW.x, y: p.y - at.y + VIEW.y }),
    container: () => null,
    transact,
  } as unknown as LobbyCanvas
  return { canvas, set, transact }
}

describe('revealResult (M4-4)', () => {
  it('a result already in the safe part leaves the camera alone', async () => {
    const { canvas, set } = cameraCanvas({ x: 200, y: 200, width: 300, height: 200 })
    expect(await revealResult(canvas, ['a'], { now: true })).toBe(false)
    expect(set).not.toHaveBeenCalled()
  })

  it('one cut off at the bottom right is brought in: the camera moves, nothing is written', async () => {
    const { canvas, set, transact } = cameraCanvas({ x: 1200, y: 700, width: 600, height: 400 })
    expect(await revealResult(canvas, ['a'], { now: true })).toBe(true)
    expect(set).toHaveBeenCalledTimes(1)
    expect(transact).not.toHaveBeenCalled()
  })

  it('a box of the feature’s own (a folded panel) counts as chrome too', async () => {
    const { canvas, set } = cameraCanvas({ x: 0, y: 0, width: 300, height: 200 })
    // the result sits under the panel at the view's top left
    const avoid = () => [{ x: 44, y: 48, width: 420, height: 120 }]
    expect(await revealResult(canvas, ['a'], { now: true, avoid })).toBe(true)
    expect(set).toHaveBeenCalledTimes(1)
  })
})

describe('new content goes in free space, never into a frame it was not dropped in (M4-4)', () => {
  // the sort test kit's view: 4000 x 3000 from (-500, -500), its middle (1500, 1000)
  const MATRIX: El = frameEl('m', 700, 300, 1600, 1400, 'Impact by Effort')
  const overlaps = (a: { x: number; y: number; w: number; h: number }, b: El) =>
    a.x < b.x + b.width && b.x < a.x + a.w && a.y < b.y + b.height && b.y < a.y + a.h

  it('findSpot keeps clear of a frame over the middle of the view and of the notes on the board', () => {
    const f = fakeCanvas([MATRIX, ...noteEls('n1', 2400, 900), ...noteEls('n2', 400, 1800)])
    const size = { w: 300, h: 200 }
    const spot = findSpot({ canvas: f.canvas } as unknown as CanvasFeatureContext, { size })
    expect(spot.frameId).toBeNull()
    const box = { x: spot.x, y: spot.y, ...size }
    for (const id of ['m', 'n1', 'n2']) expect(overlaps(box, f.els.get(id) as El), id).toBe(false)
  })

  it('a Piece inserted with Enter over a 2x2 frame lands outside it, on the open canvas', async () => {
    const f = fakeCanvas([MATRIX])
    const out = await insertPiece(f.canvas, 'decision')
    expect(out).toMatchObject({ ok: true, frameId: null })
    const made = [...f.els.values()].filter((e) => e.id !== 'm' && !e.isDeleted)
    expect(made.length).toBeGreaterThan(0)
    for (const e of made) expect(e.frameId ?? null, e.type).toBeNull()
    if (!out.ok) throw new Error('not inserted')
    const b = out.bounds
    expect(overlaps({ x: b.x, y: b.y, w: b.width, h: b.height }, MATRIX)).toBe(false)
  })

  it('a drop inside the frame still joins it', async () => {
    const f = fakeCanvas([MATRIX])
    const out = await insertPiece(f.canvas, 'decision', { at: { x: 1000, y: 600 } })
    expect(out).toMatchObject({ ok: true, frameId: 'm' })
  })
})
