// Wave L foundation (W5 owns; W1 imports): the board-scoped vote reads behind the AI recap and the vote-weighted
// action items. Only REVEALED votes carry results; another board's vote is none; the window is by reveal time.
import { afterEach, describe, expect, it } from 'vitest'
import {
  findSessionForBoard,
  REVEALED_FOR_BOARD_MAX,
  revealedResultsForBoard,
} from '../../../src/features/workshops/votes.ts'
import { createBoard, DEV_STUDIO } from '../../helpers.ts'
import { expectStatus, json, note, setupWorld, type World } from './support.ts'

let w: World
afterEach(async () => {
  await w?.api.close()
})

async function startVote(title: string, boardId = w.boardId): Promise<string> {
  const res = await w.owner.req('POST', `/api/boards/${boardId}/votes`, {
    title,
    votesPerPerson: 5,
    onePerObject: false,
    scope: 'board',
  })
  expectStatus(res, 201)
  return json<{ session: { id: string } }>(res).session.id
}
const cast = (vid: string, shapeId: string) =>
  w.owner.req('POST', `/api/votes/${vid}/cast`, { shapeId, delta: 1 })

describe('wave L vote reads (findSessionForBoard, revealedResultsForBoard)', () => {
  it('a vote of the board is found, another board’s is not', async () => {
    w = await setupWorld()
    w.sync.add(w.boardId, note('n1'))
    const vid = await startVote('Here')
    expect((await findSessionForBoard(w.api.db, w.boardId, vid))?.id).toBe(vid)
    const other = await createBoard(w.owner, DEV_STUDIO, 'Elsewhere')
    expect(await findSessionForBoard(w.api.db, other, vid)).toBeNull()
    expect(await findSessionForBoard(w.api.db, w.boardId, 'vot_00000000000000000000')).toBeNull()
  })

  it('only revealed votes, at or after the window start, newest first, with ranked results', async () => {
    w = await setupWorld()
    w.sync.add(w.boardId, note('n1'), note('n2'), note('n3'))
    // an open vote with ballots: nothing
    const open = await startVote('Open')
    expectStatus(await cast(open, 'shape:n1'), 200)
    expect(await revealedResultsForBoard(w.api.db, w.boardId, 0)).toEqual([])
    // closed but not revealed: still nothing
    expectStatus(await w.owner.req('POST', `/api/votes/${open}/close`), 200)
    expect(await revealedResultsForBoard(w.api.db, w.boardId, 0)).toEqual([])
    // revealed: its results
    expectStatus(await w.owner.req('POST', `/api/votes/${open}/reveal`), 200)
    const first = await revealedResultsForBoard(w.api.db, w.boardId, 0)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ sessionId: open, title: 'Open', participants: 1 })
    expect(first[0]?.results).toEqual([{ shapeId: 'shape:n1', count: 1, rank: 1 }])
    const revealedAt = first[0]?.revealedAt.getTime() ?? 0
    // a later one, with a tie
    w.clock.advance(60_000)
    const second = await startVote('Second')
    for (const s of ['shape:n2', 'shape:n2', 'shape:n3', 'shape:n3', 'shape:n1'])
      expectStatus(await cast(second, s), 200)
    expectStatus(await w.owner.req('POST', `/api/votes/${second}/close`), 200)
    expectStatus(await w.owner.req('POST', `/api/votes/${second}/reveal`), 200)
    const both = await revealedResultsForBoard(w.api.db, w.boardId, 0)
    expect(both.map((v) => v.sessionId)).toEqual([second, open])
    expect(both[0]?.results).toEqual([
      { shapeId: 'shape:n2', count: 2, rank: 1 },
      { shapeId: 'shape:n3', count: 2, rank: 1 },
      { shapeId: 'shape:n1', count: 1, rank: 3 },
    ])
    // the window starts after the first reveal: only the second
    const since = await revealedResultsForBoard(w.api.db, w.boardId, revealedAt + 1)
    expect(since.map((v) => v.sessionId)).toEqual([second])
    // another board has none
    const other = await createBoard(w.owner, DEV_STUDIO, 'Elsewhere')
    expect(await revealedResultsForBoard(w.api.db, other, 0)).toEqual([])
    expect(REVEALED_FOR_BOARD_MAX).toBe(20)
  })
})
