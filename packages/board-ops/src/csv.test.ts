import type { TLRecord } from '@tldraw/tlschema'
import { describe, expect, it } from 'vitest'
import { boardToCsv, csvTextCell } from './index.ts'
import {
  frame,
  geo,
  group,
  image,
  imageAsset,
  note,
  PAGE,
  PAGE_2,
  page,
  readCsv,
  sid,
  text,
  validateAll,
} from './test-fixtures.ts'

function board(): TLRecord[] {
  const records: TLRecord[] = [
    page(PAGE, 'Main', 'a1'),
    page(PAGE_2, 'Second', 'a2'),
    frame('f', '=HYPERLINK("http://evil")', { x: 100, y: 100, w: 1000, h: 800 }),
    note('n1', 'Hello, "world"', { parentId: sid('f'), x: 20, y: 60, color: 'blue' }),
    note('n2', 'line one\nline two', { parentId: sid('f'), x: 300, y: 70, index: 'a2' }),
    geo('g', 'Box', { x: -120.456, y: 2000 }),
    group('grp', { x: 0, y: 3000 }),
    text('t', 'in a group', { parentId: sid('grp'), x: 5, y: 5 }),
    imageAsset('img'),
    image('i', 'asset:img', { x: 0, y: 4000, altText: 'photo' }),
    note('p2', 'second page', { parentId: PAGE_2 }),
  ]
  validateAll(records)
  return records
}

describe('boardToCsv', () => {
  it('writes the header, CRLF record separators and a trailing CRLF', () => {
    const csv = boardToCsv(board(), { pageId: PAGE })
    expect(csv.startsWith('id,type,text,frame,color,x,y\r\n')).toBe(true)
    expect(csv.endsWith('\r\n')).toBe(true)
    expect(readCsv(csv)[0]).toEqual(['id', 'type', 'text', 'frame', 'color', 'x', 'y'])
  })

  it('writes one row per shape in reading order with frame names, colors and page-space positions', () => {
    const rows = readCsv(boardToCsv(board(), { pageId: PAGE })).slice(1)
    expect(rows).toEqual([
      [sid('f'), 'frame', `'=HYPERLINK("http://evil")`, '', 'black', '100', '100'],
      [sid('n1'), 'note', 'Hello, "world"', `'=HYPERLINK("http://evil")`, 'blue', '120', '160'],
      [sid('n2'), 'note', 'line one\nline two', `'=HYPERLINK("http://evil")`, 'yellow', '400', '170'],
      [sid('g'), 'geo', 'Box', '', 'black', '-120.46', '2000'],
      [sid('t'), 'text', 'in a group', '', 'black', '5', '3005'],
      [sid('i'), 'image', 'photo', '', '', '0', '4000'],
    ])
  })

  it('quotes per RFC 4180', () => {
    const csv = boardToCsv(board(), { pageId: PAGE })
    expect(csv).toContain('"Hello, ""world"""')
    expect(csv).toContain('"line one\nline two"')
    expect(csvTextCell('plain')).toBe('plain')
    expect(csvTextCell('a,b')).toBe('"a,b"')
    expect(csvTextCell('say "x"')).toBe('"say ""x"""')
    expect(csvTextCell('crlf\r\ninside')).toBe('"crlf\ninside"')
  })

  it.each(['=', '+', '-', '@', '\t', '\r'])('neutralizes a leading %j in every text cell', (prefix) => {
    const payload = `${prefix}cmd|' /C calc'!A0`
    const records = [
      frame('f', payload, { w: 900, h: 900 }),
      note('n', payload, { parentId: sid('f'), y: 50 }),
    ]
    const rows = readCsv(boardToCsv(records)).slice(1)
    const expected = `'${payload}`.replace(/\r\n?/g, '\n')
    expect(rows.map((row) => row[2])).toEqual([expected, expected])
    expect(rows[1]?.[3]).toBe(expected) // frame-name column
    for (const row of rows) for (const cell of row.slice(0, 5)) expect(/^[=+\-@\t\r]/.test(cell)).toBe(false)
  })

  it('exports every page in page order when no page is given, and skips groups and orphans', () => {
    const records = [...board(), note('orphan', 'lost', { parentId: sid('nowhere') })]
    const rows = readCsv(boardToCsv(records)).slice(1)
    expect(rows.map((row) => row[0])).toEqual([
      sid('f'),
      sid('n1'),
      sid('n2'),
      sid('g'),
      sid('t'),
      sid('i'),
      sid('p2'),
    ])
    expect(
      readCsv(boardToCsv(records, { pageId: PAGE_2 }))
        .slice(1)
        .map((row) => row[0]),
    ).toEqual([sid('p2')])
    expect(boardToCsv([])).toBe('id,type,text,frame,color,x,y\r\n')
  })
})

describe('boardToCsv adversarial review', () => {
  // Spreadsheets (or users who "trim spaces" on import) can still evaluate these.
  const variants = [
    ' =1+1',
    '   +SUM(A1:A2)',
    '\u00a0=HYPERLINK("http://evil")', // no-break space
    '\u3000-2+3', // ideographic space
    '\n=cmd|"/C calc"!A0', // leading line break
    '\uff1d1+1', // fullwidth equals sign
    '\uff0bcmd', // fullwidth plus
    '\uff0d1', // fullwidth hyphen-minus
    '\uff20SUM(1)', // fullwidth commercial at
    '\t \t=1',
  ]
  it.each(variants)('neutralizes the formula trigger in %j', (payload) => {
    const cell = readCsv(csvTextCell(payload))[0]?.[0] as string
    expect(cell.startsWith("'")).toBe(true)
    expect(cell.slice(1)).toBe(payload.replace(/\r\n?/g, '\n'))
  })

  it('leaves ordinary text (including inner formula characters) alone', () => {
    for (const plain of ['a = b', 'Budget: -5%', 'mail me @ noon', '  indented text', 'x+y']) {
      expect(csvTextCell(plain)).toBe(plain)
    }
    expect(csvTextCell('')).toBe('')
    expect(csvTextCell('   ')).toBe('   ')
  })

  it('neutralizes whitespace-prefixed formulas in every text column of a board export', () => {
    const records = [
      frame('f', ' =frame', { w: 900, h: 900 }),
      note('n', '\u00a0@note', { parentId: sid('f'), y: 50 }),
    ]
    const rows = readCsv(boardToCsv(records)).slice(1)
    expect(rows.map((row) => row[2])).toEqual(["' =frame", "'\u00a0@note"])
    expect(rows[1]?.[3]).toBe("' =frame")
  })
})
