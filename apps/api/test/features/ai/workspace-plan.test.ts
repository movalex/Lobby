// Wave M (M8-2): Ask across boards' prompt and answer rules (src/features/ai/workspace-plan.ts), pure.
import {
  WORKSPACE_ASK_INPUT_CAP_CHARS,
  WORKSPACE_ASK_MAX_CITATIONS,
  WORKSPACE_ASK_MAX_IDS_PER_CITATION,
} from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { BadOutput } from '../../../src/features/ai/plan.ts'
import {
  ASK_ITEM_MAX_CHARS,
  type AskItem,
  buildWorkspacePrompt,
  chooseItems,
  type RankedBoardEntries,
  workspaceAskPlan,
} from '../../../src/features/ai/workspace-plan.ts'

const board = (n: number, entries: string[]): RankedBoardEntries => ({
  board: { alias: `b${n}`, boardId: `board-${n}`, title: `Board ${n}` },
  entries: entries.map((body, i) => ({ elementId: `el-${n}-${i + 1}`, kind: 'note', body })),
})

describe('chooseItems', () => {
  it('takes entries in turns across boards (best first), numbered per board', () => {
    const { items, truncated } = chooseItems([board(1, ['a1', 'a2', 'a3']), board(2, ['b1'])])
    expect(items.map((i) => [i.alias, i.elementId, i.text])).toEqual([
      ['b1.n1', 'el-1-1', 'a1'],
      ['b2.n1', 'el-2-1', 'b1'],
      ['b1.n2', 'el-1-2', 'a2'],
      ['b1.n3', 'el-1-3', 'a3'],
    ])
    expect(truncated).toBe(false)
  })

  it('stays within the character cap (titles count once), cuts long entries, and says when it left some out', () => {
    const long = 'x'.repeat(5_000)
    const { items } = chooseItems([board(1, [long])])
    expect(items[0]?.text.length).toBe(ASK_ITEM_MAX_CHARS)
    const many = Array.from({ length: 8 }, (_, i) =>
      board(
        i + 1,
        Array.from({ length: 30 }, () => 'y'.repeat(200)),
      ),
    )
    const r = chooseItems(many)
    const used = r.items.reduce((n, i) => n + i.text.length, 0) + 8 * 'Board 1'.length
    expect(used).toBeLessThanOrEqual(WORKSPACE_ASK_INPUT_CAP_CHARS)
    expect(r.truncated).toBe(true)
    // every board got its best entries in
    expect(new Set(r.items.map((i) => i.boardId)).size).toBe(8)
  })
})

describe('buildWorkspacePrompt', () => {
  it('aliases only, the boards that are sent, untrusted data blocks, the question as a JSON string', () => {
    const { items } = chooseItems([board(1, ['Launch: Friday'])])
    const p = buildWorkspacePrompt('When "is" it?', [board(1, []).board, board(2, []).board], items)
    expect(p.schemaName).toBe('lobby_answer')
    expect(p.user).toContain(JSON.stringify('When "is" it?'))
    expect(p.user).toContain('<<<BOARDS\n{"id":"b1","title":"Board 1"}\nBOARDS>>>')
    expect(p.user).toContain('<<<ITEMS\n{"id":"b1.n1","type":"note","text":"Launch: Friday"}\nITEMS>>>')
    expect(p.user).not.toContain('Board 2')
    expect(p.user).not.toContain('board-1')
    expect(p.user).not.toContain('el-1-1')
  })
})

describe('workspaceAskPlan', () => {
  const sent: AskItem[] = [
    { alias: 'b1.n1', boardId: 'board-1', elementId: 'el-1', kind: 'note', text: 'a' },
    { alias: 'b1.n2', boardId: 'board-1', elementId: 'el-2', kind: 'note', text: 'b' },
    { alias: 'b2.n1', boardId: 'board-2', elementId: 'el-3', kind: 'note', text: 'c' },
  ]

  it('maps only sent aliases; a citation that spans boards points its marker at each', () => {
    const r = workspaceAskPlan(
      {
        answer: 'One [1], two [2], three [3], bogus [4].',
        found: 'yes',
        citations: [{ ids: ['b1.n2'] }, { ids: ['b2.n1', 'b1.n1'] }, { ids: ['el-1', 'b3.n1'] }, { nope: 1 }],
      },
      sent,
    )
    expect(r.citations).toEqual([
      { boardId: 'board-1', elementIds: ['el-2', 'el-1'] },
      { boardId: 'board-2', elementIds: ['el-3'] },
    ])
    expect(r.answer).toBe('One [1], two [1, 2], three, bogus.')
  })

  it('caps boards and ids per board; refuses a wrong shape and an empty answer that claims to answer', () => {
    const items: AskItem[] = []
    for (let b = 1; b <= WORKSPACE_ASK_MAX_CITATIONS + 2; b++)
      for (let n = 1; n <= WORKSPACE_ASK_MAX_IDS_PER_CITATION + 5; n++)
        items.push({
          alias: `b${b}.n${n}`,
          boardId: `board-${b}`,
          elementId: `e-${b}-${n}`,
          kind: 'note',
          text: 'x',
        })
    const r = workspaceAskPlan(
      { answer: 'x', found: 'yes', citations: [{ ids: items.map((i) => i.alias) }] },
      items,
    )
    expect(r.citations).toHaveLength(WORKSPACE_ASK_MAX_CITATIONS)
    for (const c of r.citations) expect(c.elementIds).toHaveLength(WORKSPACE_ASK_MAX_IDS_PER_CITATION)
    expect(() => workspaceAskPlan({ answer: 1 }, sent)).toThrow(BadOutput)
    expect(() => workspaceAskPlan({ answer: ' [9] ', found: 'yes', citations: [] }, sent)).toThrow(BadOutput)
    expect(workspaceAskPlan({ answer: '', found: 'no', citations: [] }, sent)).toEqual({
      answer: '',
      found: 'no',
      citations: [],
    })
  })
})
