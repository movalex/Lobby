// Wave M (W4, M4-3): the board popovers' chrome and placement (./board-chrome.ts), and the flow handles' obstacle box.
//  - What a popover keeps clear of: W1's registered obstacles, else the chrome measured from the page by its
//    selectors; a registered id wins over its fallback, and an excluded id is left out.
//  - placeInBoard answers in the canvas region's px, below its top band, clear of the style panel and the bottom
//    toolbar: a Sort menu for notes under the style panel opens beside the panel, not under it.
import { afterEach, describe, expect, it } from 'vitest'
import { OBSTACLE_IDS, registerObstacle, resetObstaclesForTests } from '../../lib/overlay-obstacles.ts'
import { handlesBox } from '../flow/Handles.tsx'
import { anchorRect, BOARD_TOP_BAND, boardObstacles, placeInBoard, topCentreAnchor } from './board-chrome.ts'

afterEach(() => resetObstaclesForTests())

type Box = { left: number; top: number; width: number; height: number }
const el = (b: Box | null) =>
  ({
    getBoundingClientRect: () =>
      b
        ? { ...b, right: b.left + b.width, bottom: b.top + b.height, x: b.left, y: b.top }
        : { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0 },
  }) as unknown as Element

/** A page whose selectors answer the boxes given (client px). */
const page = (boxes: Record<string, Box | null>) => ({
  querySelector: (sel: string) => {
    for (const [k, b] of Object.entries(boxes)) if (sel.includes(k)) return el(b)
    return null
  },
})

const STYLE: Box = { left: 1212, top: 60, width: 216, height: 450 }
const TOOLBAR: Box = { left: 460, top: 840, width: 568, height: 48 }

describe('boardObstacles (M4-3)', () => {
  it('measures the style panel, the bottom toolbar and the selection bar when nobody registered them', () => {
    const doc = page({
      'style.panel': STYLE,
      '"toolbar"': TOOLBAR,
      'selection-bar': { left: 430, top: 690, width: 560, height: 36 },
    })
    const got = boardObstacles(doc)
    expect(got.map((o) => o.id)).toEqual([
      OBSTACLE_IDS.stylePanel,
      OBSTACLE_IDS.bottomToolbar,
      OBSTACLE_IDS.selectionBar,
    ])
    expect(got[0]?.rect).toEqual({ x: 1212, y: 60, width: 216, height: 450 })
  })

  it('a registered id wins over its fallback; hidden chrome and excluded ids are left out', () => {
    registerObstacle(OBSTACLE_IDS.stylePanel, 'panel', () => ({ x: 1, y: 2, width: 3, height: 4 }))
    const doc = page({ 'style.panel': STYLE, '"toolbar"': null, 'selection-bar': null })
    expect(boardObstacles(doc)).toEqual([
      { id: OBSTACLE_IDS.stylePanel, kind: 'panel', rect: { x: 1, y: 2, width: 3, height: 4 } },
    ])
    expect(boardObstacles(doc, [OBSTACLE_IDS.stylePanel])).toEqual([])
    expect(boardObstacles(null)).toHaveLength(1)
  })
})

describe('placeInBoard (M4-3)', () => {
  // a 1440 x 900 window: the canvas region starts under the 48 px top bar and right of the 44 px dock rail
  const container = { left: 44, top: 48, width: 1396, height: 852 }

  it('answers in the region’s px, under its top band', () => {
    const p = placeInBoard({
      container,
      anchor: { x: 700, y: 120, width: 2, height: 40 },
      size: { width: 304, height: 300 },
      obstacles: [],
    })
    expect(p.fits).toBe(true)
    expect(p.side).toBe('below')
    expect(p.top).toBe(120 + 40 + 10 - container.top)
    expect(p.left).toBe(Math.round(701 - 152 - container.left))
    const up = placeInBoard({
      container,
      anchor: { x: 700, y: 70, width: 2, height: 0 },
      size: { width: 304, height: 900 },
      obstacles: [],
      prefer: 'above',
    })
    expect(up.top + container.top).toBeGreaterThanOrEqual(container.top + BOARD_TOP_BAND + 12)
  })

  it('the Sort menu for notes under the style panel opens clear of it and of the toolbar, every row hit-testable', () => {
    const style = { x: STYLE.left, y: STYLE.top, width: STYLE.width, height: STYLE.height }
    const toolbar = { x: TOOLBAR.left, y: TOOLBAR.top, width: TOOLBAR.width, height: TOOLBAR.height }
    const p = placeInBoard({
      container,
      // the selection bar's Sort button, at the right, under the panel's left edge
      anchor: anchorRect(container, { x: 1250 - container.left, top: 300, bottom: 336 }),
      size: { width: 304, height: 420 },
      obstacles: [
        { id: OBSTACLE_IDS.stylePanel, kind: 'panel', rect: style },
        { id: OBSTACLE_IDS.bottomToolbar, kind: 'toolbar', rect: toolbar },
      ],
    })
    expect(p.fits).toBe(true)
    const box = { x: p.left + container.left, y: p.top + container.top, width: 304, height: 420 }
    const clear = (o: typeof style) =>
      box.x + box.width <= o.x ||
      o.x + o.width <= box.x ||
      box.y + box.height <= o.y ||
      o.y + o.height <= box.y
    expect(clear(style)).toBe(true)
    expect(clear(toolbar)).toBe(true)
  })

  it('the top-centre anchor sits under the region’s top band, in its middle', () => {
    const canvas = { container: () => el({ left: 44, top: 48, width: 1396, height: 852 }) as HTMLElement }
    expect(topCentreAnchor(canvas)).toEqual({
      x: 44 + 698 - 1,
      y: 48 + BOARD_TOP_BAND + 2,
      width: 2,
      height: 0,
    })
    // a popover below it is centred under it, at the top of the room (not pushed beside it)
    const p = placeInBoard({
      container: { left: 44, top: 48, width: 1396, height: 852 },
      anchor: topCentreAnchor(canvas) as NonNullable<ReturnType<typeof topCentreAnchor>>,
      size: { width: 380, height: 100 },
      obstacles: [],
      prefer: 'below',
    })
    expect(p).toMatchObject({ side: 'below', fits: true, top: BOARD_TOP_BAND + 12 })
    expect(p.left + 190).toBeCloseTo(698, 0)
    expect(topCentreAnchor({ container: () => null })).toBeNull()
  })
})

describe('the flow handles’ obstacle box (M4-3, FTU-11)', () => {
  it('is the box around the shown + buttons, and nothing while none is shown', () => {
    const buttons = [
      { left: 100, top: 200, width: 20, height: 20 },
      { left: 400, top: 210, width: 20, height: 20 },
      { left: 250, top: 120, width: 20, height: 20 },
      { left: 250, top: 330, width: 20, height: 20 },
    ]
    const root = { querySelectorAll: () => buttons.map((b) => el(b)) } as unknown as HTMLElement
    expect(handlesBox(root)).toEqual({ x: 100, y: 120, width: 320, height: 230 })
    expect(handlesBox({ querySelectorAll: () => [] } as unknown as HTMLElement)).toBeNull()
    expect(handlesBox(null)).toBeNull()
  })
})
