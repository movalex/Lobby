// Wave N (N3-4): the CSV export's `reactions` column. A note's emoji reactions, as counts ("👍 3; ❤️ 1"), after the
// `votes` column, from the stored `react:<code>:<uid>` keys. Names and uids never leave the board. The column is
// there once an exported note has a reaction; a board without any exports the columns it always did (ported.test.ts
// holds those rows).
import { reactionKey } from '@draftroom/canvas-schema/reactions'
import { describe, expect, it } from 'vitest'
import type { CanvasElement } from '../../../canvas/api/index.ts'
import { boardCsv, REACTIONS_CSV_COLUMN, reactionsCell } from './csv.ts'

const base = { angle: 0, groupIds: [], frameId: null, locked: false, isDeleted: false, version: 1 }
const el = (e: Record<string, unknown>) => ({ ...base, ...e }) as unknown as CanvasElement

const keys = (...pairs: [code: 'up' | 'heart' | 'laugh' | 'party' | 'think' | 'clap', uid: string][]) =>
  Object.fromEntries(pairs.map(([c, u]) => [reactionKey(c, u), true]))

function note(id: string, x: number, y: number, words: string, lobby?: Record<string, unknown>) {
  return [
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
      ...(lobby ? { customData: { lobby } } : {}),
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
    }),
  ]
}

const SECRET_NAME = 'usr_ada_lovelace_secret'
const BOARD = [
  ...note(
    'loved',
    0,
    0,
    'Loved idea',
    keys(['up', 'u1'], ['up', 'u2'], ['up', SECRET_NAME], ['heart', 'u1']),
  ),
  ...note('plain', 300, 0, 'No reactions here'),
  ...note('once', 600, 0, 'One clap', keys(['clap', 'u9'])),
]

describe('the reactions column (N3-4)', () => {
  it('counts per emoji, in the reaction row order, after the tags column', () => {
    const csv = boardCsv(BOARD)
    const lines = csv.split('\r\n').filter(Boolean)
    expect(lines[0]).toBe(`id,type,text,frame,color,x,y,tags,${REACTIONS_CSV_COLUMN}`)
    const rows = new Map(lines.slice(1).map((l) => [l.split(',')[0], l]))
    expect(rows.get('loved')).toBe('loved,note,Loved idea,,Marigold,0,0,,👍 3; ❤️ 1')
    expect(rows.get('once')).toBe('once,note,One clap,,Marigold,600,0,,👏 1')
  })

  it('a note with none has an empty cell, the row keeps its column count', () => {
    const lines = boardCsv(BOARD).split('\r\n').filter(Boolean)
    const plain = lines.find((l) => l.startsWith('plain,'))
    expect(plain).toBe('plain,note,No reactions here,,Marigold,300,0,,')
    const width = lines[0]?.split(',').length
    for (const l of lines) expect(l.split(',').length, l).toBe(width)
  })

  it('sits after votes when a revealed vote adds that column', () => {
    const csv = boardCsv(BOARD, new Set(['loved']), {
      votes: [{ shapeId: 'shape:loved', count: 5, rank: 1 } as never],
    })
    expect(csv).toBe(
      'id,type,text,frame,color,x,y,tags,votes,reactions\r\nloved,note,Loved idea,,Marigold,0,0,,5,👍 3; ❤️ 1\r\n',
    )
  })

  it('no uid and no name is in the output', () => {
    const csv = boardCsv(BOARD, undefined, {
      tagDefs: new Map(),
    })
    expect(csv).not.toContain(SECRET_NAME)
    expect(csv).not.toContain('u1')
    expect(csv).not.toContain('u2')
    expect(csv).not.toContain('react:')
  })

  it('a board with no reactions exports exactly the columns it always did', () => {
    const csv = boardCsv([...note('a', 0, 0, 'One'), ...note('b', 300, 0, 'Two')])
    expect(csv.split('\r\n')[0]).toBe('id,type,text,frame,color,x,y,tags')
    expect(csv).not.toContain(REACTIONS_CSV_COLUMN)
  })

  it('a selection without reactions has no column even when the board has them', () => {
    expect(boardCsv(BOARD, new Set(['plain'])).split('\r\n')[0]).toBe('id,type,text,frame,color,x,y,tags')
    expect(boardCsv(BOARD, new Set(['plain', 'once'])).split('\r\n')[0]).toContain(',reactions')
  })

  it('keys that are not well formed reactions count for nothing, and only a sticky note has a cell', () => {
    const odd = el({
      id: 'odd',
      type: 'stickynote',
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      customData: {
        lobby: {
          'react:bogus:u1': true,
          'react:up:': true,
          [reactionKey('up', 'u1')]: 1,
          [reactionKey('laugh', 'u1')]: true,
        },
      },
    })
    expect(reactionsCell(odd as never)).toBe('😂 1')
    const rect = el({
      id: 'r',
      type: 'rectangle',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      customData: { lobby: keys(['up', 'u1']) },
    })
    expect(reactionsCell(rect as never)).toBe('')
  })
})
