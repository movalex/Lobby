import { describe, expect, it } from 'vitest'
import {
  analyzeBulkPaste,
  FRAME_GAP,
  NOTE_STEP,
  PAGE_GAP,
  pickPlainText,
  placeBulkGrid,
  reflowLine,
} from './bulk-paste.ts'
import { type Rect, rectContains, rectsOverlap } from './placement.ts'

describe('analyzeBulkPaste: when to ask "notes or text?"', () => {
  it('leaves single-line text, URLs and prose to the default paste', () => {
    for (const text of [
      'hello',
      'https://example.com/a?b=1',
      'Buy milk, eggs, and bread',
      '   ',
      '',
      'a,b', // one CSV-looking line is still one cell
    ]) {
      expect(analyzeBulkPaste(text)).toBeNull()
    }
  })

  it('asks for multi-line text, TSV and CSV', () => {
    expect(analyzeBulkPaste('one\ntwo\nthree')).toEqual({ cells: 3, rows: 3 })
    expect(analyzeBulkPaste('a\tb\tc\nd\te\tf')).toEqual({ cells: 6, rows: 2 })
    expect(analyzeBulkPaste('name,role\nAna,lead\nBo,design')).toEqual({ cells: 6, rows: 3 })
    // Windows line endings and blank lines
    expect(analyzeBulkPaste('one\r\n\r\ntwo\r\n')).toEqual({ cells: 2, rows: 2 })
  })

  it('prefers the clipboard text/plain source over tag-stripped HTML (spreadsheet copies)', () => {
    const content = {
      text: 'a b c d', // what tldraw derives from the HTML table
      sources: [
        { type: 'text', subtype: 'html', data: '<table>…</table>' },
        { type: 'text', subtype: 'text', data: 'a\tb\nc\td' },
      ],
    }
    expect(pickPlainText(content)).toBe('a\tb\nc\td')
    expect(pickPlainText({ text: 'x' })).toBe('x')
  })
})

describe('RETRO-01: a long single column or row becomes a compact grid', () => {
  it('reflows 5 cells of one column into ceil(sqrt(5)) = 3 columns, in source order', () => {
    const column = [0, 1, 2, 3, 4].map((i) => ({ x: 0, y: i * NOTE_STEP }))
    expect(reflowLine(column)).toEqual([
      { x: 0, y: 0 },
      { x: NOTE_STEP, y: 0 },
      { x: 2 * NOTE_STEP, y: 0 },
      { x: 0, y: NOTE_STEP },
      { x: NOTE_STEP, y: NOTE_STEP },
    ])
    const row = [0, 1, 2, 3].map((i) => ({ x: i * NOTE_STEP, y: 0 }))
    expect(reflowLine(row)?.map((p) => [p.x / NOTE_STEP, p.y / NOTE_STEP])).toEqual([
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ])
  })
  it('keeps 3 cells or fewer, and true 2-D selections, as they are', () => {
    expect(reflowLine([0, 1, 2].map((i) => ({ x: 0, y: i * NOTE_STEP })))).toBeNull()
    expect(
      reflowLine([
        { x: 0, y: 0 },
        { x: NOTE_STEP, y: 0 },
        { x: 0, y: NOTE_STEP },
        { x: NOTE_STEP, y: NOTE_STEP },
      ]),
    ).toBeNull()
  })
})

describe('RETRO-01: placeBulkGrid', () => {
  // The retro's "What to improve" column: 800×960, heading + intro at the top, three prompt notes in a row.
  const frame: Rect = { x: 880, y: 540, w: 800, h: 960 }
  const children: Rect[] = [
    { x: 920, y: 572, w: 720, h: 50 }, // heading
    { x: 920, y: 632, w: 720, h: 40 }, // intro
    { x: 920, y: 730, w: 200, h: 200 },
    { x: 1140, y: 730, w: 200, h: 200 },
    { x: 1360, y: 730, w: 200, h: 200 },
  ]
  const size = { w: 640, h: 420 }
  const box = (p: { x: number; y: number }) => ({ ...p, ...size })

  it('pasting into the empty lower half keeps the grid in the frame, clear of its notes', () => {
    const at = placeBulkGrid({
      size,
      center: { x: 1280, y: 1250 },
      frame,
      frameObstacles: children,
      pageObstacles: [frame],
    })
    expect(at.inFrame).toBe(true)
    expect(rectContains(frame, box(at.topLeft))).toBe(true)
    for (const c of children) expect(rectsOverlap(box(at.topLeft), c, FRAME_GAP - 1)).toBe(false)
  })

  it('pasting over the existing notes moves the grid to the nearest empty spot in the frame', () => {
    const at = placeBulkGrid({
      size,
      center: { x: 1280, y: 830 },
      frame,
      frameObstacles: children,
      pageObstacles: [frame],
    })
    expect(at.inFrame).toBe(true)
    expect(rectContains(frame, box(at.topLeft))).toBe(true)
    for (const c of children) expect(rectsOverlap(box(at.topLeft), c)).toBe(false)
    expect(at.topLeft.y).toBeGreaterThanOrEqual(930 + FRAME_GAP)
  })

  it('a grid that cannot fit in the frame goes on the page, clear of the page shapes', () => {
    const big = { w: 2000, h: 1200 }
    const other: Rect = { x: -1200, y: 0, w: 800, h: 800 }
    const at = placeBulkGrid({
      size: big,
      center: { x: 1280, y: 1000 },
      frame,
      frameObstacles: children,
      pageObstacles: [frame, other],
    })
    expect(at.inFrame).toBe(false)
    for (const o of [frame, other])
      expect(rectsOverlap({ ...at.topLeft, ...big }, o, PAGE_GAP - 1)).toBe(false)
  })

  it('with no frame under the paste point: the nearest empty spot on the page', () => {
    const note: Rect = { x: 0, y: 0, w: 200, h: 200 }
    const at = placeBulkGrid({ size, center: { x: 100, y: 100 }, pageObstacles: [note] })
    expect(at.inFrame).toBe(false)
    expect(rectsOverlap(box(at.topLeft), note)).toBe(false)
    const free = placeBulkGrid({ size, center: { x: 5000, y: 5000 }, pageObstacles: [note] })
    expect(free.topLeft).toEqual({ x: 5000 - size.w / 2, y: 5000 - size.h / 2 })
  })
})
