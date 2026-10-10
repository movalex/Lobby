// OWNER: W1 (wave M, M1-3; written in the wave M foundation). The obstacle registry and placePopover.
import { afterEach, describe, expect, it } from 'vitest'
import {
  intersectionArea,
  MIN_SHOWN_HEIGHT,
  OBSTACLE_IDS,
  obstacleRects,
  type PlacePopoverInput,
  placePopover,
  type Rect,
  rectsIntersect,
  registerObstacle,
  resetObstaclesForTests,
} from './overlay-obstacles.ts'

afterEach(() => resetObstaclesForTests())

const VP: Rect = { x: 0, y: 0, width: 1440, height: 900 }
const PHONE: Rect = { x: 0, y: 0, width: 390, height: 844 }
/** The bottom toolbar (centred, 56 px tall) and the style panel (right, open). */
const TOOLBAR: Rect = { x: 520, y: 828, width: 400, height: 56 }
const STYLE_PANEL: Rect = { x: 1200, y: 80, width: 224, height: 600 }

describe('the registry', () => {
  it('registers, reads the box when asked, and unregisters', () => {
    let box: Rect | null = { x: 1, y: 2, width: 3, height: 4 }
    const off = registerObstacle('style-panel', 'panel', () => box)
    expect(obstacleRects()).toEqual([
      { id: 'style-panel', kind: 'panel', rect: { x: 1, y: 2, width: 3, height: 4 } },
    ])
    box = { x: 10, y: 20, width: 30, height: 40 }
    expect(obstacleRects()[0]?.rect).toEqual(box)
    box = null // hidden
    expect(obstacleRects()).toEqual([])
    off()
    box = { x: 1, y: 1, width: 1, height: 1 }
    expect(obstacleRects()).toEqual([])
  })

  it('leaves out excluded ids, empty or malformed boxes and getters that throw; keeps registration order', () => {
    registerObstacle('bottom-toolbar', 'toolbar', () => TOOLBAR)
    registerObstacle('selection-bar', 'bar', () => ({ x: 0, y: 0, width: 0, height: 10 }))
    registerObstacle('top-centre', 'stack', () => ({ x: Number.NaN, y: 0, width: 5, height: 5 }))
    registerObstacle('flow-handles', 'handles', () => {
      throw new Error('gone')
    })
    registerObstacle('style-panel', 'panel', () => STYLE_PANEL)
    expect(obstacleRects().map((o) => o.id)).toEqual(['bottom-toolbar', 'style-panel'])
    expect(obstacleRects(['style-panel']).map((o) => o.id)).toEqual(['bottom-toolbar'])
  })

  it('a second registration replaces the first; the first unregister then does nothing', () => {
    const offA = registerObstacle('top-centre', 'stack', () => ({ x: 0, y: 0, width: 10, height: 10 }))
    registerObstacle('top-centre', 'stack', () => ({ x: 5, y: 5, width: 10, height: 10 }))
    offA()
    expect(obstacleRects()).toEqual([
      { id: 'top-centre', kind: 'stack', rect: { x: 5, y: 5, width: 10, height: 10 } },
    ])
  })

  it('names the five frozen ids', () => {
    expect(Object.values(OBSTACLE_IDS).sort()).toEqual([
      'bottom-toolbar',
      'flow-handles',
      'selection-bar',
      'style-panel',
      'top-centre',
    ])
  })
})

describe('geometry', () => {
  it('intersection area; touching edges do not intersect', () => {
    const a = { x: 0, y: 0, width: 10, height: 10 }
    expect(intersectionArea(a, { x: 5, y: 5, width: 10, height: 10 })).toBe(25)
    expect(rectsIntersect(a, { x: 10, y: 0, width: 5, height: 5 })).toBe(false)
  })
})

const base = (over: Partial<PlacePopoverInput> = {}): PlacePopoverInput => ({
  anchor: { x: 600, y: 300, width: 100, height: 40 },
  size: { width: 200, height: 160 },
  viewport: VP,
  obstacles: [],
  ...over,
})

const covers = (p: { x: number; y: number }, size: { width: number; height: number }, o: Rect) =>
  rectsIntersect({ x: p.x, y: p.y, width: size.width, height: size.height }, o)

describe('placePopover', () => {
  it('free space: below, centred on the anchor, gap 8', () => {
    expect(placePopover(base())).toEqual({ x: 550, y: 348, side: 'below', maxHeight: 900 - 8 - 348, fits: true })
  })

  it('takes the preferred side first, as a string or a list', () => {
    expect(placePopover(base({ prefer: 'above' })).side).toBe('above')
    expect(placePopover(base({ prefer: ['right', 'below'] })).side).toBe('right')
    const above = placePopover(base({ prefer: 'above' }))
    expect(above.y + 160).toBe(300 - 8)
  })

  it('an anchor near the bottom toolbar: below would cover it, so above', () => {
    const anchor = { x: 680, y: 700, width: 80, height: 40 }
    const p = placePopover(base({ anchor, obstacles: [TOOLBAR] }))
    expect(p.side).toBe('above')
    expect(p.fits).toBe(true)
    expect(covers(p, { width: 200, height: 160 }, TOOLBAR)).toBe(false)
  })

  it('slides along the side to keep clear of the style panel (closest to centred)', () => {
    const anchor = { x: 1180, y: 200, width: 60, height: 40 }
    const p = placePopover(base({ anchor, obstacles: [STYLE_PANEL] }))
    expect(p.side).toBe('below')
    expect(covers(p, { width: 200, height: 160 }, STYLE_PANEL)).toBe(false)
    expect(p.x + 200).toBeLessThanOrEqual(STYLE_PANEL.x - 8)
  })

  it('maxHeight is clipped by the bottom toolbar (the popover then scrolls)', () => {
    const anchor = { x: 660, y: 560, width: 100, height: 40 }
    const tall = { width: 200, height: 600 }
    // above is blocked by a bar over the anchor, so the best is below with less room; a toolbar as wide as the viewport
    // leaves no column to slide to
    const bar = { x: 0, y: 0, width: 1440, height: 552 }
    const wide = { ...TOOLBAR, x: 0, width: 1440 }
    const p = placePopover(base({ anchor, size: tall, obstacles: [wide, bar] }))
    expect(p.side).toBe('below')
    expect(p.y).toBe(608)
    expect(p.maxHeight).toBe(wide.y - 8 - 608)
    // clipped, but clear of everything: not a fit (the caller knows the popover scrolls)
    expect(p.fits).toBe(false)
    expect(covers(p, { width: 200, height: p.maxHeight }, wide)).toBe(false)
    // with a column free of the toolbar, it slides there and gets the room down to the viewport's margin
    const slid = placePopover(base({ anchor, size: tall, obstacles: [TOOLBAR, bar] }))
    expect(slid.maxHeight).toBe(900 - 8 - 608)
    expect(covers(slid, { width: 200, height: slid.maxHeight }, TOOLBAR)).toBe(false)
  })

  it('every side blocked: the best fit (least covered), deterministic', () => {
    const anchor = { x: 150, y: 380, width: 90, height: 40 }
    const walls = [
      { x: 0, y: 0, width: 390, height: 370 }, // above
      { x: 0, y: 430, width: 390, height: 414 }, // below
      { x: 0, y: 370, width: 140, height: 60 }, // left
      { x: 250, y: 370, width: 140, height: 60 }, // right
    ]
    const input = base({ anchor, viewport: PHONE, size: { width: 200, height: 120 }, obstacles: walls })
    const p = placePopover(input)
    for (let i = 0; i < 10; i++) expect(placePopover(input)).toEqual(p)
    // whatever the obstacles' order
    expect(placePopover({ ...input, obstacles: [...walls].reverse() })).toEqual(p)
    // nothing fits, and it says so; the answer is never a sliver: it keeps its natural height (120, the minimum)
    // just below the anchor (the first side in the default order among the equally covered places)
    expect(p).toEqual({ x: 95, y: 428, side: 'below', maxHeight: 120, fits: false })
  })

  it('nothing fits on a phone with the style panel open: a usable height over the least chrome, never a 4 px strip', () => {
    // 390x844, the bottom toolbar at y 780, the style panel open on the left, a selection just above the toolbar
    const toolbar = { x: 20, y: 780, width: 350, height: 56 }
    const panel = { x: 0, y: 60, width: 240, height: 640 }
    const input = base({
      anchor: { x: 100, y: 700, width: 200, height: 60 },
      viewport: PHONE,
      size: { width: 280, height: 300 },
      obstacles: [toolbar, panel],
    })
    const p = placePopover(input)
    // below has 4 px before the toolbar (the foundation's first version answered below, maxHeight 4); above, at the
    // least height, covers less (part of the panel's foot) than below at that height (the toolbar and the screen edge)
    expect(p).toEqual({ x: 102, y: 572, side: 'above', maxHeight: MIN_SHOWN_HEIGHT, fits: false })
    expect(placePopover({ ...input, obstacles: [panel, toolbar] })).toEqual(p)
  })

  it('a full-height place over a small obstacle beats a sliver; minHeight sets the least height', () => {
    // as wide as the phone allows, so it cannot slide; the toolbar leaves 4 px below, a flow handle sits just above
    const anchor = { x: 120, y: 600, width: 150, height: 40 }
    const size = { width: 374, height: 100 }
    const toolbar = { x: 0, y: 652, width: 390, height: 56 }
    const handle = { x: 183, y: 560, width: 24, height: 24 }
    const p = placePopover(base({ anchor, viewport: PHONE, size, obstacles: [toolbar, handle] }))
    expect(p).toEqual({ x: 8, y: 492, side: 'above', maxHeight: 100, fits: false })
    // it covers only the handle
    expect(covers(p, size, handle)).toBe(true)
    expect(covers(p, size, toolbar)).toBe(false)
    // a caller that accepts a 4 px strip can ask for it (minHeight 0): below is then clear, clipped to 4
    const strip = placePopover(base({ anchor, viewport: PHONE, size, obstacles: [toolbar, handle], minHeight: 0 }))
    expect(strip).toEqual({ x: 8, y: 648, side: 'below', maxHeight: 0, fits: false })
  })

  it('stays inside the viewport (margin 8) on a phone', () => {
    const anchor = { x: 360, y: 100, width: 20, height: 20 }
    const p = placePopover(base({ anchor, viewport: PHONE, size: { width: 300, height: 200 } }))
    expect(p.x).toBeGreaterThanOrEqual(8)
    expect(p.x + 300).toBeLessThanOrEqual(390 - 8)
  })

  it('takes registered obstacles (ObstacleRect) as well as plain boxes', () => {
    registerObstacle('bottom-toolbar', 'toolbar', () => TOOLBAR)
    const anchor = { x: 680, y: 700, width: 80, height: 40 }
    expect(placePopover(base({ anchor, obstacles: obstacleRects() }))).toEqual(
      placePopover(base({ anchor, obstacles: [TOOLBAR] })),
    )
  })

  it('fed its own answer back as the anchor’s neighbour, it answers the same (no oscillation)', () => {
    const input = base({
      anchor: { x: 1180, y: 700, width: 60, height: 40 },
      obstacles: [TOOLBAR, STYLE_PANEL],
    })
    const first = placePopover(input)
    let p = first
    for (let i = 0; i < 10; i++) p = placePopover({ ...input })
    expect(p).toEqual(first)
  })
})
