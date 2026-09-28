import { frame, note, PAGE, page, sid, text } from '@draftroom/board-ops/test-fixtures'
import type { TLRecord } from 'tldraw'
import { describe, expect, it } from 'vitest'
import { boardCsv, CSV_MIME, csvBlob, csvRowCount, UTF8_BOM } from './csv-export.ts'

const records: TLRecord[] = [
  page(PAGE, 'Page 1'),
  frame('f', 'Ideas, round 1', { x: 0, y: 0, w: 600, h: 400 }),
  note('n1', 'First line\nsecond line', { x: 20, y: 20, parentId: sid('f') }),
  note('n2', '=HYPERLINK("http://evil")', { x: 300, y: 20, parentId: sid('f'), color: 'blue' }),
  text('t', 'Outside "quoted"', { x: 0, y: 800 }),
]

const lines = (csv: string) => csv.split('\r\n')

describe('boardCsv', () => {
  it('exports every shape with the contract header, quoting and formula neutralization', () => {
    const csv = boardCsv(records)
    expect(lines(csv)[0]).toBe('id,type,text,frame,color,x,y,tags')
    expect(csv.endsWith('\r\n')).toBe(true)
    expect(csv).toContain('shape:n1,note,"First line\nsecond line","Ideas, round 1",Marigold,20,20')
    // A formula-looking note is prefixed with ' so spreadsheets show it as text.
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`)
    expect(csv).toContain('"Outside ""quoted"""')
    expect(csvRowCount(csv)).toBe(4)
  })

  it('keeps only the selected shapes (multi-line cells stay intact, frame names still resolve)', () => {
    const csv = boardCsv(records, new Set([sid('n1'), sid('t')]))
    const rows = lines(csv)
    expect(rows[0]).toBe('id,type,text,frame,color,x,y,tags')
    expect(csvRowCount(csv)).toBe(2)
    expect(csv).toContain('shape:n1,note,"First line\nsecond line","Ideas, round 1",Marigold,20,20')
    expect(csv).toContain('shape:t,text,')
    expect(csv).not.toContain('shape:n2')
    expect(csv).not.toContain('shape:f,')
  })

  it('matches quoted ids too', () => {
    const odd = note('we,ird', 'odd id', { x: 0, y: 0 })
    const csv = boardCsv([page(PAGE, 'P'), odd], new Set([sid('we,ird')]))
    expect(csvRowCount(csv)).toBe(1)
    expect(csv).toContain('"shape:we,ird",note,odd id')
  })

  it('returns just the header for an empty selection', () => {
    expect(boardCsv(records, new Set())).toBe('id,type,text,frame,color,x,y,tags\r\n')
  })
})

describe('note colours and vote results (final review R14)', () => {
  it('names a note by the colour the palette shows: tldraw’s default "black" note is Butter (yellow), never "black"', () => {
    const board: TLRecord[] = [
      page(PAGE, 'P'),
      note('butter', 'Default note', { x: 0, y: 0, color: 'black' }),
      note('iris', 'Blue note', { x: 300, y: 0, color: 'blue' }),
      text('t', 'Plain text', { x: 0, y: 400 }),
    ]
    const rows = lines(boardCsv(board))
    expect(rows).toContain('shape:butter,note,Default note,,Butter,0,0,')
    expect(rows).toContain('shape:iris,note,Blue note,,Iris,300,0,')
    // Other shapes keep tldraw's colour names (a black text is black).
    expect(rows).toContain('shape:t,text,Plain text,,black,0,400,')
    // The board's own records are not changed.
    expect((board[1] as { props: { color: string } }).props.color).toBe('black')
  })

  it('adds a votes column once results are revealed, and only then', () => {
    const votes = [
      { shapeId: sid('n2'), count: 5, rank: 1 },
      { shapeId: sid('n1'), count: 2, rank: 2 },
    ]
    const csv = boardCsv(records, undefined, { votes })
    const rows = lines(csv)
    expect(rows[0]).toBe('id,type,text,frame,color,x,y,tags,votes')
    expect(rows.find((r) => r.startsWith('shape:n1,'))?.endsWith(',2')).toBe(true)
    expect(rows.find((r) => r.startsWith('"shape:n2"') || r.startsWith('shape:n2,'))?.endsWith(',5')).toBe(
      true,
    )
    expect(rows.find((r) => r.startsWith('shape:t,'))?.endsWith(',,')).toBe(true)
    expect(csvRowCount(csv)).toBe(4)
    expect(lines(boardCsv(records, undefined, { votes: null }))[0]).toBe('id,type,text,frame,color,x,y,tags')
    expect(lines(boardCsv(records, undefined, { votes: [] }))[0]).toBe('id,type,text,frame,color,x,y,tags')
  })
})

describe('csvBlob', () => {
  it('is UTF-8 CSV with a byte-order mark', async () => {
    const csv = boardCsv(records)
    const blob = csvBlob(csv)
    expect(blob.type).toBe(CSV_MIME)
    const buf = new Uint8Array(await blob.arrayBuffer())
    expect([...buf.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    // (Blob.text() decodes UTF-8 and drops the BOM, as spreadsheet apps do.)
    expect(await blob.text()).toBe(csv)
    expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(buf)).toBe(`${UTF8_BOM}${csv}`)
    expect(blob.size).toBe(3 + new TextEncoder().encode(csv).length)
  })
})
