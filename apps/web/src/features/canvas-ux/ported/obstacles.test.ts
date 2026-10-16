// Wave M (M1-3): canvas-ux's chrome as obstacles (lib/overlay-obstacles.ts), and what the selection bar reads: the
// chrome it keeps clear of and the selection's flow '+' handles. A stand-in document (the web tests run in Node).
import { afterEach, describe, expect, it } from 'vitest'
import {
  OBSTACLE_IDS,
  obstacleRects,
  type Rect,
  registerObstacle,
  resetObstaclesForTests,
} from '../../../lib/overlay-obstacles.ts'
import {
  BOTTOM_TOOLBAR_SELECTOR,
  barObstacles,
  HANDLES_REACH,
  handlesOf,
  installChromeObstacles,
  NAVIGATION_SELECTOR,
  STORYBOARD_STRIP_SELECTOR,
  STYLE_PANEL_SELECTOR,
  selectionHandlesRect,
  WORKSHOP_STACK_SELECTOR,
} from './obstacles.ts'

afterEach(() => resetObstaclesForTests())

interface FakeEl {
  box: Rect | null
  attrs?: Record<string, string>
  children?: FakeEl[]
}

const el = (box: Rect | null, attrs: Record<string, string> = {}, children: FakeEl[] = []): FakeEl => ({
  box,
  attrs,
  children,
})

/** An element as the DOM answers it: its box (0 x 0 when hidden), its attributes, its handle buttons. */
function dom(e: FakeEl): Element {
  const r = e.box ?? { x: 0, y: 0, width: 0, height: 0 }
  return {
    getBoundingClientRect: () => ({ left: r.x, top: r.y, width: r.width, height: r.height }),
    getAttribute: (k: string) => e.attrs?.[k] ?? null,
    querySelectorAll: () => (e.children ?? []).map(dom),
  } as unknown as Element
}

function fakeDoc(bySelector: Record<string, FakeEl[]>): Document {
  return {
    querySelector: (s: string) => (bySelector[s]?.[0] ? dom(bySelector[s][0] as FakeEl) : null),
    querySelectorAll: (s: string) => (bySelector[s] ?? []).map(dom),
  } as unknown as Document
}

const PANEL: Rect = { x: 1164, y: 72, width: 216, height: 450 }
const TOOLBAR: Rect = { x: 460, y: 840, width: 520, height: 48 }

describe('canvas-ux registers its chrome', () => {
  it('the style panel and the bottom toolbar, read when asked; hidden ones are left out; unregistered on cleanup', () => {
    const shown: Record<string, FakeEl[]> = {
      [STYLE_PANEL_SELECTOR]: [el(PANEL)],
      [BOTTOM_TOOLBAR_SELECTOR]: [el(TOOLBAR)],
    }
    const off = installChromeObstacles(fakeDoc(shown))
    expect(obstacleRects()).toEqual([
      { id: OBSTACLE_IDS.stylePanel, kind: 'panel', rect: PANEL },
      { id: OBSTACLE_IDS.bottomToolbar, kind: 'toolbar', rect: TOOLBAR },
    ])
    // the panel closes (nothing selected): its box is gone, the toolbar stays
    shown[STYLE_PANEL_SELECTOR] = []
    expect(obstacleRects().map((o) => o.id)).toEqual([OBSTACLE_IDS.bottomToolbar])
    off()
    expect(obstacleRects()).toEqual([])
  })
})

describe("the selection's flow handles", () => {
  const sel: Rect = { x: 400, y: 300, width: 160, height: 100 }
  // the four + buttons: 22 px out, 24 px across (features/flow/Handles.tsx)
  const around: Rect = { x: 400 - 34, y: 300 - 34, width: 160 + 68, height: 100 + 68 }

  it('handlesOf: a box around the selection within reach; not the full-canvas layer, nor one elsewhere', () => {
    expect(handlesOf(sel, around)).toBe(true)
    expect(handlesOf(sel, { x: 468, y: 410, width: 24, height: 24 })).toBe(true) // the bottom one alone
    expect(handlesOf(sel, { x: 0, y: 0, width: 1440, height: 900 })).toBe(false)
    expect(handlesOf(sel, { ...around, x: around.x - HANDLES_REACH - 1 })).toBe(false)
    expect(handlesOf(sel, { x: 1000, y: 700, width: 24, height: 24 })).toBe(false)
    expect(handlesOf(sel, null)).toBe(false)
  })

  it("W4's registered obstacle when it is a box around the selection", () => {
    registerObstacle(OBSTACLE_IDS.flowHandles, 'handles', () => around)
    expect(selectionHandlesRect(fakeDoc({}), ['n1'], sel)).toEqual(around)
  })

  it('else the handle buttons on screen, only while their source is selected', () => {
    // a registration of the whole layer is no box around the selection: ignored
    registerObstacle(OBSTACLE_IDS.flowHandles, 'handles', () => ({ x: 0, y: 0, width: 1440, height: 900 }))
    const buttons = [
      el({ x: 468, y: 254, width: 24, height: 24 }),
      el({ x: 570, y: 338, width: 24, height: 24 }),
      el({ x: 468, y: 410, width: 24, height: 24 }),
      el({ x: 366, y: 338, width: 24, height: 24 }),
    ]
    const layer = (source: string) => ({
      '[data-testid="flow-handles"]': [
        el({ x: 0, y: 0, width: 1440, height: 900 }, { 'data-flow-source': source }, buttons),
      ],
    })
    expect(selectionHandlesRect(fakeDoc(layer('n1')), ['n1'], sel)).toEqual({
      x: 366,
      y: 254,
      width: 228,
      height: 180,
    })
    // the handles of a shape the pointer is over, not the selection
    expect(selectionHandlesRect(fakeDoc(layer('other')), ['n1'], sel)).toBeNull()
    expect(selectionHandlesRect(fakeDoc({}), ['n1'], sel)).toBeNull()
  })
})

describe('what the bar keeps clear of', () => {
  it('every registered obstacle but its own box and the handles (part of the selection), and the navigation panel', () => {
    registerObstacle(OBSTACLE_IDS.stylePanel, 'panel', () => PANEL)
    registerObstacle(OBSTACLE_IDS.bottomToolbar, 'toolbar', () => TOOLBAR)
    registerObstacle(OBSTACLE_IDS.topCentre, 'stack', () => ({ x: 600, y: 12, width: 240, height: 44 }))
    registerObstacle(OBSTACLE_IDS.selectionBar, 'bar', () => ({ x: 1, y: 1, width: 10, height: 10 }))
    registerObstacle(OBSTACLE_IDS.flowHandles, 'handles', () => ({ x: 2, y: 2, width: 10, height: 10 }))
    const nav = { x: 12, y: 840, width: 180, height: 40 }
    expect(barObstacles(fakeDoc({ [NAVIGATION_SELECTOR]: [el(nav), el(null)] }))).toEqual([
      PANEL,
      TOOLBAR,
      { x: 600, y: 12, width: 240, height: 44 },
      nav,
    ])
  })

  it('the workshop’s bottom-centre stack: each shown item (the vote banner, the vote bar), not the gap between them', () => {
    const banner = { x: 434, y: 457, width: 460, height: 134 }
    const voteBar = { x: 459, y: 600, width: 408, height: 44 }
    expect(barObstacles(fakeDoc({ [WORKSHOP_STACK_SELECTOR]: [el(banner), el(null), el(voteBar)] }))).toEqual(
      [banner, voteBar],
    )
  })

  it('the storyboard strip (wave T): the bar keeps clear of it, so its Play animatic is never under the strip', () => {
    const strip = { x: 154, y: 590, width: 1178, height: 240 }
    expect(barObstacles(fakeDoc({ [STORYBOARD_STRIP_SELECTOR]: [el(strip)] }))).toEqual([strip])
  })
})
