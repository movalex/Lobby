import type { TLNoteShape, TLShape } from '@tldraw/tlschema'
import type { IndexKey } from '@tldraw/utils'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_NOTE_GAP,
  MAX_BULK_NOTES,
  MAX_NOTE_TEXT_CHARS,
  NOTE_SIZE,
  notesFromText,
  parseBulkText,
  plainTextOf,
  searchBoard,
} from './index.ts'
import { frame, PAGE, page, sid, validateAll } from './test-fixtures.ts'

describe('parseBulkText', () => {
  it('reads a spreadsheet copy (TSV, CRLF, trailing newline, empty cells)', () => {
    const copied = 'Name\tRole\tNotes\r\nAlice\tDev\t\r\nBob\t\tLikes tea\r\n'
    expect(parseBulkText(copied)).toEqual([
      ['Name', 'Role', 'Notes'],
      ['Alice', 'Dev'],
      ['Bob', 'Likes tea'],
    ])
  })

  it('reads quoted TSV cells with line breaks and doubled quotes (Excel / Google Sheets)', () => {
    const copied = 'Idea\t"multi\nline"\nnext\t"say ""hi"""\n'
    expect(parseBulkText(copied)).toEqual([
      ['Idea', 'multi\nline'],
      ['next', 'say "hi"'],
    ])
  })

  it('keeps literal quotes in TSV cells that are not quoted fields', () => {
    expect(parseBulkText('5" screen\t"Quoted" title\n"open\tb')).toEqual([
      ['5" screen', '"Quoted" title'],
      ['"open', 'b'],
    ])
  })

  it('reads CSV with quoted commas, escaped quotes and line breaks inside quotes', () => {
    const csv = 'name,quote,count\n"Smith, J","He said ""hi""",3\n"multi\nline",x,4\n'
    expect(parseBulkText(csv)).toEqual([
      ['name', 'quote', 'count'],
      ['Smith, J', 'He said "hi"', '3'],
      ['multi\nline', 'x', '4'],
    ])
  })

  it('reads CSV with Windows line endings and CRLF inside quoted cells', () => {
    expect(parseBulkText('a,b\r\n"c\r\nd",e\r\n')).toEqual([
      ['a', 'b'],
      ['c\nd', 'e'],
    ])
  })

  it('reads unquoted CSV only when every line has the same number of fields', () => {
    expect(parseBulkText('id,title\n1,Kickoff\n2,Review')).toEqual([
      ['id', 'title'],
      ['1', 'Kickoff'],
      ['2', 'Review'],
    ])
  })

  it('keeps prose with commas as one note per line', () => {
    expect(parseBulkText('Buy milk, eggs\nCall mom\n\n  Walk the dog  \n')).toEqual([
      ['Buy milk, eggs'],
      ['Call mom'],
      ['Walk the dog'],
    ])
    expect(parseBulkText('Hello, world\nGoodbye, moon')).toEqual([['Hello, world'], ['Goodbye, moon']])
    expect(parseBulkText('"Hello", she said\nok')).toEqual([['"Hello", she said'], ['ok']])
    expect(parseBulkText('a,b,c')).toEqual([['a,b,c']])
  })

  it('splits plain text on LF, CRLF and CR', () => {
    expect(parseBulkText('one\r\ntwo\nthree\rfour\r\n')).toEqual([['one'], ['two'], ['three'], ['four']])
  })

  it('strips a byte-order mark and returns nothing for blank or non-string input', () => {
    const bom = String.fromCharCode(0xfeff)
    expect(parseBulkText(`${bom}first\nsecond`)).toEqual([['first'], ['second']])
    expect(parseBulkText('')).toEqual([])
    expect(parseBulkText(' \n\t\n  ')).toEqual([])
    expect(parseBulkText(undefined as unknown as string)).toEqual([])
    expect(parseBulkText({ toString: () => 'x' } as unknown as string)).toEqual([])
  })

  it('stays fast on hostile quote patterns and caps the cell count', () => {
    for (const hostile of ['"x\t'.repeat(100_000), `"${'x\t'.repeat(200_000)}`, '"a\n'.repeat(200_000)]) {
      const start = Date.now()
      const rows = parseBulkText(hostile)
      expect(Date.now() - start).toBeLessThan(3000)
      expect(rows.flat().length).toBeLessThanOrEqual(50_000)
      expect(rows.length).toBeGreaterThan(0)
    }
  })
})

const notes = (shapes: TLShape[]) => shapes as TLNoteShape[]
const textOf = (shape: TLNoteShape) => plainTextOf(shape.props.richText)

describe('notesFromText', () => {
  const origin = { x: 1000, y: -400 }

  it('lays out one valid note per cell in a spreadsheet grid without overlaps', () => {
    const { shapes, truncated } = notesFromText('A1\tB1\tC1\nA2\tB2\tC2\n', { origin, pageId: PAGE })
    expect(truncated).toBe(false)
    expect(shapes).toHaveLength(6)
    validateAll(shapes)
    const step = NOTE_SIZE + DEFAULT_NOTE_GAP
    for (const shape of notes(shapes)) {
      const [col, row] = [textOf(shape).charCodeAt(0) - 65, Number(textOf(shape)[1]) - 1]
      expect(shape.x).toBe(origin.x + col * step)
      expect(shape.y).toBe(origin.y + row * step)
      expect(shape.type).toBe('note')
      expect(shape.parentId).toBe(PAGE)
      expect(shape.props.richText.type).toBe('doc')
    }
    // Rows share y, columns share x.
    const ysByRow = new Map<string, Set<number>>()
    const xsByCol = new Map<string, Set<number>>()
    for (const s of notes(shapes)) {
      const [colName, rowName] = [textOf(s)[0] as string, textOf(s)[1] as string]
      ysByRow.set(rowName, (ysByRow.get(rowName) ?? new Set()).add(s.y))
      xsByCol.set(colName, (xsByCol.get(colName) ?? new Set()).add(s.x))
    }
    expect([...ysByRow.values()].map((ys) => ys.size)).toEqual([1, 1])
    expect([...xsByCol.values()].map((xs) => xs.size)).toEqual([1, 1, 1])
    // No two notes overlap.
    for (const a of shapes)
      for (const b of shapes) {
        if (a === b) continue
        const overlap = Math.abs(a.x - b.x) < NOTE_SIZE && Math.abs(a.y - b.y) < NOTE_SIZE
        expect(overlap).toBe(false)
      }
    expect(new Set(shapes.map((s) => s.id)).size).toBe(6)
  })

  it('keeps spreadsheet columns when cells are empty and drops columns that are empty everywhere', () => {
    const { shapes } = notesFromText('\ta\t\tc\n\td\te\tf\n\n', {
      origin: { x: 0, y: 0 },
      pageId: PAGE,
      gap: 0,
    })
    const at = Object.fromEntries(notes(shapes).map((s) => [textOf(s), [s.x / NOTE_SIZE, s.y / NOTE_SIZE]]))
    expect(at).toEqual({ a: [0, 0], c: [2, 0], d: [0, 1], e: [1, 1], f: [2, 1] })
  })

  it('stacks plain lines into one column and keeps multi-line cells as multi-paragraph notes', () => {
    const { shapes } = notesFromText('first\nsecond\n"x"\t"two\nlines"', { origin, pageId: PAGE })
    // Tabs present -> TSV: rows "first", "second", ["x", "two\nlines"].
    expect(notes(shapes).map(textOf)).toEqual(['first', 'second', 'x', 'two\nlines'])
    const multi = notes(shapes)[3] as TLNoteShape
    expect(multi.props.richText.content).toHaveLength(2)
  })

  it('pastes into a frame: notes are children of the frame at frame-local positions', () => {
    const container = frame('col', 'Ideas', { x: 5000, y: 5000, w: 900, h: 900 })
    const { shapes } = notesFromText('one\ntwo', {
      origin: { x: 20, y: 60 },
      pageId: PAGE,
      parentId: container.id,
    })
    validateAll(shapes)
    expect(shapes.map((s) => s.parentId)).toEqual([container.id, container.id])
    expect(shapes.map((s) => [s.x, s.y])).toEqual([
      [20, 60],
      [20, 60 + NOTE_SIZE + DEFAULT_NOTE_GAP],
    ])
    // They resolve to the frame's page.
    const hits = searchBoard([page(PAGE, 'Main'), container, ...shapes], 'two')
    expect(hits.map((h) => [h.shapeId, h.pageId])).toEqual([[shapes[1]?.id, PAGE]])
  })

  it('stops at maxNotes in row-major order and reports truncation', () => {
    const text = Array.from({ length: 10 }, (_, i) => `n${i}`).join('\n')
    const limited = notesFromText(text, { origin, pageId: PAGE, maxNotes: 4 })
    expect(limited.truncated).toBe(true)
    expect(notes(limited.shapes).map(textOf)).toEqual(['n0', 'n1', 'n2', 'n3'])
    const exact = notesFromText(text, { origin, pageId: PAGE, maxNotes: 10 })
    expect(exact.truncated).toBe(false)
    expect(exact.shapes).toHaveLength(10)
    const partialRow = notesFromText('a\tb\tc\nd\te\tf', { origin, pageId: PAGE, maxNotes: 4 })
    expect(notes(partialRow.shapes).map(textOf)).toEqual(['a', 'b', 'c', 'd'])
    expect(partialRow.truncated).toBe(true)
    expect(notesFromText('a\nb', { origin, pageId: PAGE, maxNotes: 0 })).toEqual({
      shapes: [],
      truncated: true,
    })
  })

  it('defaults to 500 notes and never exceeds the hard cap', () => {
    const many = Array.from({ length: 6000 }, (_, i) => `n${i}`).join('\n')
    const byDefault = notesFromText(many, { origin, pageId: PAGE })
    expect(byDefault.shapes).toHaveLength(500)
    expect(byDefault.truncated).toBe(true)
    const capped = notesFromText(many, { origin, pageId: PAGE, maxNotes: 1e9 })
    expect(capped.shapes).toHaveLength(MAX_BULK_NOTES)
    expect(capped.truncated).toBe(true)
  })

  it('cuts oversized cells and reports it', () => {
    const { shapes, truncated } = notesFromText('x'.repeat(MAX_NOTE_TEXT_CHARS + 10), {
      origin,
      pageId: PAGE,
    })
    expect(truncated).toBe(true)
    expect(textOf(notes(shapes)[0] as TLNoteShape)).toHaveLength(MAX_NOTE_TEXT_CHARS)
  })

  it('assigns ascending, valid, unique index keys (above indexAbove when given)', () => {
    const { shapes } = notesFromText('a\tb\nc\td', { origin, pageId: PAGE, indexAbove: 'a5' as IndexKey })
    const indices = shapes.map((s) => s.index)
    expect([...indices].sort()).toEqual(indices)
    expect(new Set(indices).size).toBe(4)
    for (const index of indices) expect(index > 'a5').toBe(true)
    validateAll(shapes)
  })

  it('uses a valid color when asked and the tldraw default otherwise', () => {
    const blue = notesFromText('x', { origin, pageId: PAGE, color: 'blue' })
    expect((blue.shapes[0] as TLNoteShape).props.color).toBe('blue')
    const bogus = notesFromText('x', { origin, pageId: PAGE, color: 'chartreuse' })
    expect((bogus.shapes[0] as TLNoteShape).props.color).toBe('black')
    validateAll([...blue.shapes, ...bogus.shapes])
  })

  it('honours gap and returns nothing for empty text', () => {
    const { shapes } = notesFromText('a\tb', { origin: { x: 0, y: 0 }, pageId: PAGE, gap: 50 })
    expect(shapes.map((s) => s.x)).toEqual([0, NOTE_SIZE + 50])
    expect(notesFromText('   \n  ', { origin, pageId: PAGE })).toEqual({ shapes: [], truncated: false })
  })

  it('rejects invalid options with TypeError', () => {
    expect(() => notesFromText('x', { origin: { x: Number.NaN, y: 0 }, pageId: PAGE })).toThrow(TypeError)
    expect(() => notesFromText('x', { origin, pageId: sid('nope') as never })).toThrow(TypeError)
    expect(() => notesFromText('x', { origin, pageId: PAGE, parentId: 'binding:x' as never })).toThrow(
      TypeError,
    )
    expect(() => notesFromText('x', { origin, pageId: PAGE, indexAbove: '!!' as IndexKey })).toThrow(
      TypeError,
    )
  })
})

describe('bulk paste adversarial review', () => {
  const origin = { x: 0, y: 0 }

  it('handles 10k pasted lines within the note cap', () => {
    const text = Array.from({ length: 10_000 }, (_, i) => `idea ${i}`).join('\n')
    const start = Date.now()
    const { shapes, truncated } = notesFromText(text, { origin, pageId: PAGE })
    expect(Date.now() - start).toBeLessThan(2000)
    expect(truncated).toBe(true)
    expect(shapes).toHaveLength(500)
    validateAll(shapes)
    expect(parseBulkText(text)).toHaveLength(10_000)
  })

  it('handles a single 1 MB line (plain, comma and tab variants)', () => {
    for (const line of ['x'.repeat(1_000_000), 'ab,'.repeat(333_333), 'ab\t'.repeat(333_333)]) {
      const start = Date.now()
      const { shapes, truncated } = notesFromText(line, { origin, pageId: PAGE })
      expect(Date.now() - start).toBeLessThan(3000)
      expect(truncated).toBe(true)
      expect(shapes.length).toBeGreaterThan(0)
      expect(shapes.length).toBeLessThanOrEqual(500)
      for (const shape of notes(shapes)) expect(textOf(shape).length).toBeLessThanOrEqual(MAX_NOTE_TEXT_CHARS)
      validateAll(shapes)
    }
  })

  it('never cuts a long cell inside a surrogate pair', () => {
    const cell = `${'x'.repeat(MAX_NOTE_TEXT_CHARS - 1)}😀tail`
    const { shapes, truncated } = notesFromText(cell, { origin, pageId: PAGE })
    expect(truncated).toBe(true)
    const value = textOf(notes(shapes)[0] as TLNoteShape)
    expect(value.length).toBeLessThanOrEqual(MAX_NOTE_TEXT_CHARS)
    expect(value).toBe('x'.repeat(MAX_NOTE_TEXT_CHARS - 1))
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(value)).toBe(false) // no lone high surrogate
  })
})
