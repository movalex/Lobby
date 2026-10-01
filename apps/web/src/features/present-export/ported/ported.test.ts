// Wave 3e: the pure parts of the ported present-export feature: slides and containers from elements, the
// CSV on elements (palette names, tags, votes, a selection), the badge placement in an export, and the
// camera that shows a slide.
import { describe, expect, it } from 'vitest'
import type { CanvasElement, LobbyCanvas } from '../../../canvas/api/index.ts'
import { exportBadges, exportOrigin, shiftBadges, svgWithBadges } from './badges.ts'
import { boardCsv, csvRowCount } from './csv.ts'
import { pageTexts } from './exporter.ts'
import { containersOf, frameOutline, presentationOrder, slidesOf } from './frames.ts'
import { viewportFor } from './presenter.ts'

const base = { angle: 0, groupIds: [], frameId: null, locked: false, isDeleted: false, version: 1 }
const el = (e: Record<string, unknown>) => ({ ...base, ...e }) as unknown as CanvasElement

const frame = (id: string, name: string, x: number, present?: Record<string, unknown>) =>
  el({
    id,
    type: 'frame',
    name,
    x,
    y: 0,
    width: 800,
    height: 600,
    ...(present ? { customData: { lobby: { present } } } : {}),
  })
const note = (id: string, x: number, y: number, words: string, extra: Record<string, unknown> = {}) => [
  el({
    id,
    type: 'stickynote',
    x,
    y,
    width: 200,
    height: 200,
    backgroundColor: '#f6c453',
    strokeColor: '#1b2330',
    boundElements: [{ id: `${id}.t`, type: 'text' }],
    ...extra,
  }),
  el({
    id: `${id}.t`,
    type: 'text',
    x: x + 10,
    y: y + 10,
    width: 180,
    height: 30,
    containerId: id,
    text: words,
    originalText: words,
    frameId: (extra.frameId as string | undefined) ?? null,
  }),
]

const BOARD = [
  frame('intro', 'Intro', 0),
  frame('backstage', 'Backstage', 1000, { skip: true }),
  frame('plan', 'Plan', 2000, { index: 0 }),
  ...note('n1', 100, 100, 'Kickoff agenda', { frameId: 'intro' }),
  ...note('n2', 2100, 100, '=SUM(A1)', {
    frameId: 'plan',
    backgroundColor: '#a7b7f6',
    customData: {
      lobby: { 'tag:t1': { name: 'zeta', color: 'blue' }, 'tag:t2': { name: 'Alpha', color: 'red' } },
    },
  }),
  ...note('loose', 0, 900, 'Outside'),
]

/** A canvas over a fixed element list: what the pure helpers read. */
function fakeCanvas(items: readonly CanvasElement[]): LobbyCanvas {
  const byId = new Map(items.map((e) => [e.id, e]))
  return {
    items: () => items,
    get: (id: string) => byId.get(id),
    bounds: (id: string) => {
      const e = byId.get(id)
      return e ? { x: e.x, y: e.y, width: e.width, height: e.height } : null
    },
  } as unknown as LobbyCanvas
}

describe('slides and frames on elements', () => {
  it('presentation order puts indexed frames first; slides leave skipped frames out', () => {
    const canvas = fakeCanvas(BOARD)
    expect(presentationOrder(canvas).map((f) => f.id)).toEqual(['plan', 'intro', 'backstage'])
    expect(slidesOf(presentationOrder(canvas)).map((s) => s.id)).toEqual(['plan', 'intro'])
    expect(frameOutline(canvas).map((f) => [f.id, f.depth])).toEqual([
      ['intro', 0],
      ['backstage', 0],
      ['plan', 0],
    ])
  })

  it("an element's containers: a label's note, then the note's frame", () => {
    const canvas = fakeCanvas(BOARD)
    expect(containersOf(canvas, 'n1.t')).toEqual(['n1', 'intro'])
    expect(containersOf(canvas, 'loose')).toEqual([])
  })
})

describe('CSV on elements', () => {
  it('rows in reading order, labels folded, palette names, tags sorted by name, formulas neutralized', () => {
    const csv = boardCsv(BOARD, undefined, { tagDefs: new Map([['t1', { name: 'Zeta (board)' }]]) })
    const lines = csv.split('\r\n').filter(Boolean)
    expect(lines[0]).toBe('id,type,text,frame,color,x,y,tags')
    const rows = new Map(lines.slice(1).map((l) => [l.split(',')[0], l]))
    expect(rows.get('n1')).toBe('n1,note,Kickoff agenda,Intro,Marigold,100,100,')
    // the board's tag definition wins over the element's copy; names sorted
    expect(rows.get('n2')).toBe("n2,note,'=SUM(A1),Plan,Iris,2100,100,Alpha; Zeta (board)")
    expect(rows.get('plan')).toBe('plan,frame,Plan,,,2000,0,')
    expect(rows.has('n1.t')).toBe(false)
    expect(csvRowCount(csv)).toBe(6)
  })

  it('a selection keeps only its rows; revealed votes add a votes column', () => {
    const csv = boardCsv(BOARD, new Set(['n2']), {
      votes: [{ shapeId: 'shape:n2', count: 3, rank: 1 } as never],
    })
    expect(csv).toBe(
      "id,type,text,frame,color,x,y,tags,votes\r\nn2,note,'=SUM(A1),Plan,Iris,2100,100,Alpha; zeta,3\r\n",
    )
  })
})

describe('badges in an export', () => {
  it('the export origin comes from the drawn elements, the margin and the export size', () => {
    const origin = exportOrigin(
      [{ x: 100, y: 200, width: 200, height: 200 }],
      { width: 264, height: 300 },
      32,
    )
    expect(origin).toEqual({ x: 68, y: 132 }) // a frame title 36 px above: the top is not the elements'
    expect(shiftBadges([{ x: 300, y: 200, rank: 1, n: 2 }], origin)).toEqual([
      { x: 232, y: 68, rank: 1, n: 2 },
    ])
  })

  it('badges go on the exported elements only, into the SVG before its end', () => {
    const canvas = fakeCanvas(BOARD)
    const badges = exportBadges(canvas, new Set(['n1']), [
      { shapeId: 'shape:n1', count: 2, rank: 1 } as never,
      { shapeId: 'shape:n2', count: 1, rank: 2 } as never,
    ])
    expect(badges).toEqual([{ x: 300, y: 100, rank: 1, n: 2 }])
    const svg = svgWithBadges(
      '<svg viewBox="0 0 400 300" xmlns="http://www.w3.org/2000/svg"><g/></svg>',
      badges,
    )
    expect(svg).toMatch(/<g data-dr-vote-results="">.*<\/g><\/svg>$/)
  })
})

describe('the PDF text layer on elements', () => {
  it("W5-30: a label's lines are the engine's wrapped lines, kept whole; a file card's name sits in its footer", () => {
    const items = [
      el({
        id: 'n',
        type: 'stickynote',
        x: 0,
        y: 0,
        width: 200,
        height: 200,
        boundElements: [{ id: 'n.t', type: 'text' }],
      }),
      el({
        id: 'n.t',
        type: 'text',
        x: 20,
        y: 60,
        width: 160,
        height: 75,
        containerId: 'n',
        // the engine wrapped `originalText` to the label's width; a PDF re-wrap split these words
        text: 'Story Brief\nDelivery plan',
        originalText: 'Story Brief Delivery plan',
        fontSize: 20,
        lineHeight: 1.25,
        textAlign: 'center',
      }),
      el({
        id: 'card',
        type: 'image',
        x: 300,
        y: 0,
        width: 260,
        height: 356,
        fileId: 'ver_0123456789abcdefghij',
        customData: { lobby: { file: { kind: 'pdf', name: 'Brief.pdf' } } },
      }),
    ]
    const byId = new Map(items.map((e) => [e.id, e]))
    const canvas = {
      items: () => items,
      visibleBounds: (id: string) => {
        const e = byId.get(id)
        return e ? { x: e.x, y: e.y, width: e.width, height: e.height } : null
      },
    } as unknown as LobbyCanvas
    const texts = pageTexts(canvas, items, { x: 0, y: 0, width: 1000, height: 1000 })
    expect(texts).toHaveLength(2)
    expect(texts[0]).toMatchObject({
      text: 'Story Brief\nDelivery plan',
      lines: true,
      lineHeight: 1.25,
      align: 'middle',
      x: 20,
      y: 60,
      w: 160,
    })
    expect(texts[1]).toMatchObject({ text: 'Brief.pdf', x: 354, y: 300, h: 56, verticalAlign: 'middle' })
  })
})

describe('the camera on a slide', () => {
  it('fits the slide in the middle of the view, within the zoom range', () => {
    const v = viewportFor({ x: 0, y: 0, w: 800, h: 600 }, { w: 1280, h: 720 }, 0, { min: 0.02, max: 8 })
    expect(v.zoom).toBeCloseTo(1.2)
    expect(v.x).toBeCloseTo(400 - 1280 / 1.2 / 2)
    expect(v.y).toBeCloseTo(0)
    expect(
      viewportFor({ x: 0, y: 0, w: 10, h: 10 }, { w: 1000, h: 1000 }, 0, { min: 0.02, max: 8 }).zoom,
    ).toBe(8)
  })
})
