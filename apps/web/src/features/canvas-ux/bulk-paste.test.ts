import { draftroomSchema } from '@draftroom/canvas-schema'
import { describe, expect, it } from 'vitest'
import { analyzeBulkPaste, buildBulkNotes, pickPlainText, truncationMessage } from './bulk-paste.ts'
import { plainTextOf } from './deps.ts'

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
