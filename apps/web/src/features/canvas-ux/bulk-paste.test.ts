import { draftroomSchema } from '@draftroom/canvas-schema'
import { describe, expect, it } from 'vitest'
import {
  analyzeBulkPaste,
  buildBulkNotes,
  FRAME_GAP,
  NOTE_STEP,
  PAGE_GAP,
  pickPlainText,
  placeBulkGrid,
  reflowLine,
  truncationMessage,
} from './bulk-paste.ts'
import { NOTE_SIZE, plainTextOf } from './deps.ts'
import { type Rect, rectContains, rectsOverlap } from './placement.ts'

const textOf = (s: { props: unknown }) => plainTextOf((s.props as { richText: unknown }).richText)

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

describe('buildBulkNotes', () => {
  it('creates one valid note per non-empty cell in the source grid, centred on the paste point', () => {
    const { shapes, bounds, omitted } = buildBulkNotes('a\tb\tc\nd\t\tf', {
      center: { x: 1000, y: 500 },
      pageId: 'page:page',
    })
    expect(shapes).toHaveLength(5)
    expect(omitted).toBe(0)
    for (const s of shapes) {
      expect(s.type).toBe('note')
      expect(s.parentId).toBe('page:page')
      expect('index' in s).toBe(false)
      // valid once the editor assigns an index
      expect(() => draftroomSchema.types.shape.validate({ ...s, index: 'a1' })).not.toThrow()
    }
    expect(bounds.x + bounds.w / 2).toBeCloseTo(1000)
    expect(bounds.y + bounds.h / 2).toBeCloseTo(500)
    // Row/column layout kept: "f" sits in column 3 of row 2, under "c".
    const byText = new Map(shapes.map((s) => [plainTextOf((s.props as { richText: unknown }).richText), s]))
    expect(byText.get('f')?.x).toBe(byText.get('c')?.x)
    expect(byText.get('d')?.y).toBe(byText.get('f')?.y)
    expect(new Set(shapes.map((s) => s.id)).size).toBe(5)
  })

  it('uses the colour picked for the next note', () => {
    const { shapes } = buildBulkNotes('x\ny', { center: { x: 0, y: 0 }, pageId: 'page:page', color: 'blue' })
    for (const s of shapes) expect((s.props as { color: string }).color).toBe('blue')
  })

  it('caps at 500 notes and reports how many cells were left out', () => {
    const text = Array.from({ length: 620 }, (_, i) => `idea ${i + 1}`).join('\n')
    const r = buildBulkNotes(text, { center: { x: 0, y: 0 }, pageId: 'page:page' })
    expect(r.shapes).toHaveLength(500)
    expect(r.omitted).toBe(120)
    expect(truncationMessage(r.shapes.length, r.omitted, r.textShortened)).toBe(
      'Pasted the first 500 notes. 120 more cells were left out (limit: 500 notes per paste).',
    )
  })

  it('says nothing when nothing was cut', () => {
    expect(truncationMessage(3, 0, false)).toBeNull()
    expect(truncationMessage(3, 0, true)).toMatch(/shortened/)
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
  it('buildBulkNotes lays a 5×1 TSV column out 3 wide, 2 high, centred on the paste point', () => {
    const cells = ['Scope creep', 'Handoffs', 'Too many meetings', 'Late feedback', 'Unclear owner']
    const { shapes, bounds } = buildBulkNotes(cells.join('\n'), {
      center: { x: 500, y: 700 },
      pageId: 'page:page',
    })
    expect(shapes.map(textOf)).toEqual(cells)
    expect(new Set(shapes.map((s) => s.x)).size).toBe(3)
    expect(new Set(shapes.map((s) => s.y)).size).toBe(2)
    expect(bounds.w).toBe(3 * NOTE_SIZE + 2 * (NOTE_STEP - NOTE_SIZE))
    expect(bounds.h).toBe(NOTE_SIZE + NOTE_STEP)
    expect(bounds.x + bounds.w / 2).toBeCloseTo(500)
    expect(bounds.y + bounds.h / 2).toBeCloseTo(700)
    // row-major: "Late feedback" starts row 2 under "Scope creep"
    expect(shapes[3]?.x).toBe(shapes[0]?.x)
    expect(shapes[3]?.y).toBe((shapes[0]?.y ?? 0) + NOTE_STEP)
  })
  it('uses the font picked for the next shape (sans by default, RETRO-21a)', () => {
    const { shapes } = buildBulkNotes('x\ny', { center: { x: 0, y: 0 }, pageId: 'page:page', font: 'sans' })
    for (const s of shapes) expect((s.props as { font: string }).font).toBe('sans')
    expect(() => draftroomSchema.types.shape.validate({ ...shapes[0], index: 'a1' })).not.toThrow()
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
