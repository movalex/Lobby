// The CSV export's tags column (PRS-13), through present-export's boardCsv (what the Export dialog calls).
import {
  documentRecord,
  fileCard,
  geo,
  note,
  PAGE,
  page,
  readCsv,
  sid,
} from '@draftroom/board-ops/test-fixtures'
import { boardTagMetaKey, shapeTagMetaKey, type TagDef } from '@draftroom/contracts'
import type { TLRecord } from 'tldraw'
import { describe, expect, it } from 'vitest'
import { boardCsv } from '../present-export/csv-export.ts'
import { tagsCsvCells } from './csv.ts'

const T = (key: string, name: string, color: TagDef['color'] = 'blue'): TagDef => ({ key, name, color })
const tagsMeta = (...tags: TagDef[]) =>
  Object.fromEntries(tags.map((t) => [shapeTagMetaKey(t.key), { name: t.name, color: t.color }]))

const FORMULA = T('=sum(a1)', '=SUM(A1)', 'red')
const doc = {
  ...documentRecord(),
  meta: {
    [boardTagMetaKey('research')]: { name: 'User research', color: 'violet' }, // not the key's name: ignored
    [boardTagMetaKey('idea')]: { name: 'IDEA', color: 'green' }, // the board's spelling wins
  },
} as TLRecord

const records: TLRecord[] = [
  doc,
  page(PAGE, 'Page 1'),
  note('n1', 'Checkout is slow', {
    x: 0,
    y: 0,
    meta: tagsMeta(T('research', 'Research'), T('idea', 'Idea')),
  }),
  note('n2', 'No tags', { x: 300, y: 0 }),
  note('n3', 'Tricky', { x: 600, y: 0, meta: tagsMeta(FORMULA, T('a,-"b"', 'a, "b"')) }),
  fileCard('c1', 'survey.pdf', { x: 0, y: 400, meta: tagsMeta(T('idea', 'Idea')) }),
  geo('g1', 'Box', { x: 300, y: 400, meta: tagsMeta(T('idea', 'Idea')) }),
]

describe('CSV tags column', () => {
  it('adds a tags column: names as the board shows them, sorted, "; "-separated', () => {
    const rows = readCsv(boardCsv(records))
    expect(rows[0]).toEqual(['id', 'type', 'text', 'frame', 'color', 'x', 'y', 'tags'])
    const byId = new Map(rows.slice(1).map((r) => [r[0], r]))
    expect(byId.get(sid('n1'))?.[7]).toBe('IDEA; Research')
    expect(byId.get(sid('n2'))?.[7]).toBe('')
    expect(byId.get(sid('c1'))?.[7]).toBe('IDEA')
    expect(byId.get(sid('g1'))?.[7]).toBe('') // only notes and file cards carry tags
    for (const r of rows) expect(r).toHaveLength(8)
  })

  it('quotes tag names and neutralizes formulas like every text cell', () => {
    const cell = tagsCsvCells(records)(sid('n3'))
    // Symbols sort before letters; the cell starts with "=", so it gets the apostrophe.
    expect(cell).toBe(`"'=SUM(A1); a, ""b"""`)
    const row = readCsv(boardCsv(records)).find((r) => r[0] === sid('n3'))
    expect(row?.[7]).toBe(`'=SUM(A1); a, "b"`)
  })

  it('keeps the column when exporting a selection', () => {
    const rows = readCsv(boardCsv(records, new Set([sid('n1')])))
    expect(rows).toEqual([
      ['id', 'type', 'text', 'frame', 'color', 'x', 'y', 'tags'],
      [sid('n1'), 'note', 'Checkout is slow', '', 'yellow', '0', '0', 'IDEA; Research'],
    ])
  })
})
