// Wave T review: a new board made from content (here a duplicate) keeps a card's assignee only when that person has
// access to the NEW board. The api seeds before the board's row exists, so the sync's assignee-refs lookup for the
// target answers 404 and kept nobody; the api now decides it in a dry run of the board's own transaction and names
// those people in the seed (`assignees`), and the sync keeps only them (apps/sync seed.ts).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import { base, LobbySync } from '../backup/support.ts'

let api: TestApi
let sync: LobbySync
let alice: Client // Dev Studio's owner (a creator)
let carol: Client // a Dev Studio member, given editor on the source board
let dave: Client // not on the board
let boardId: string

const card = (id: string, who: string, x = 0) =>
  base(id, 'rectangle', {
    x,
    index: `a${x / 100}`,
    customData: { lobby: { 'card:status': 'todo', 'card:who': who } },
  })

beforeEach(async () => {
  sync = new LobbySync()
  api = await createTestApi({ deps: { syncInternal: sync } })
  alice = await api.login('alice')
  carol = await api.login('carol')
  dave = await api.login('dave')
  boardId = await createBoard(alice, DEV_STUDIO, 'Plan')
  expect(
    (await alice.req('PUT', `/api/boards/${boardId}/members/${carol.userId}`, { role: 'editor' })).statusCode,
  ).toBe(200)
  sync.setBoard(boardId, [
    card('C1', alice.userId),
    card('C2', carol.userId, 300),
    card('C3', dave.userId, 600),
  ])
})
afterEach(() => api.close())

const counts = async () => {
  const n = async (sql: string) =>
    (await api.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`)).n
  return {
    boards: await n('boards'),
    grants: await n('board_members'),
    audits: await n("audit_events WHERE action = 'board.create'"),
  }
}

const lastSeed = () => sync.seeds.at(-1)?.body as { assignees?: string[]; elements: unknown[] } | undefined

describe('a duplicate of a board with assigned cards', () => {
  it('names the people who have access to the copy: the creator on a private copy; with keep sharing, its people too', async () => {
    const before = await counts()
    const plain = await alice.req('POST', `/api/boards/${boardId}/duplicate`, {})
    expect(plain.statusCode, plain.body).toBe(201)
    expect(lastSeed()?.assignees).toEqual([alice.userId])
    const shared = await alice.req('POST', `/api/boards/${boardId}/duplicate`, { keepSharing: true })
    expect(shared.statusCode, shared.body).toBe(201)
    expect([...(lastSeed()?.assignees ?? [])].sort()).toEqual([alice.userId, carol.userId].sort())
    // the dry runs left nothing behind: the two copies, no more boards, grants or audit rows
    expect(await counts()).toEqual({
      boards: before.boards + 2,
      grants: before.grants + 3,
      audits: before.audits + 2,
    })
  })

  it('a board without assigned cards asks nothing (no assignees in the seed)', async () => {
    sync.setBoard(boardId, [base('N', 'rectangle')])
    const res = await alice.req('POST', `/api/boards/${boardId}/duplicate`, {})
    expect(res.statusCode, res.body).toBe(201)
    expect(lastSeed()?.assignees).toBeUndefined()
  })
})
