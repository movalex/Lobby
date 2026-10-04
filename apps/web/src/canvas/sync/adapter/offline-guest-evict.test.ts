import { afterEach, describe, expect, it } from 'vitest'
import { rect } from '../testing/elements.ts'
import type { OfflineEntry } from '../types.ts'
import { guestOfflineQueue, purgeGuestQueuesOf, releaseGuestQueue } from './offline-guest.ts'

// F2 (wave F; the wave E follow-up): a guest's page queue was never dropped after the page left its board.
// It is dropped now once nothing is unsent, and kept while an edit is unsent (a return finds it).

const entry = (id: string, x: number): OfflineEntry => ({
  element: rect(id, 'a0', { x }),
  groups: ['geometry'],
  base: 0,
  queuedAt: 1,
})

// the queues live for the whole module, as on a page: every test has boards and users of its own
let n = 0
const freshBoard = () => `b-evict-${++n}`
const users: string[] = []
const freshUser = (name: string) => {
  const uid = `${name}-${++n}`
  users.push(uid)
  return uid
}
afterEach(() => {
  for (const uid of users.splice(0)) purgeGuestQueuesOf(uid)
})

/** `uid`'s queue on `board` after a welcome that said guest, with `unsent` queued (none: all reached the room) */
async function guestOn(board: string, uid: string, unsent: readonly OfflineEntry[] = []) {
  const q = guestOfflineQueue({ boardId: board, uid })
  q.markGuest()
  if (unsent.length > 0) await q.save(unsent)
  return q
}
const known = (boardId: string, uid: string) => guestOfflineQueue({ boardId, uid }).known

describe('another board’s session starting on the page drops the queues of the boards it left', () => {
  it('a board left with nothing unsent is forgotten: its queue and its guest mark are gone', async () => {
    const gwen = freshUser('gwen')
    const left = freshBoard()
    await guestOn(left, gwen)
    expect(known(left, gwen)).toBe(true)
    guestOfflineQueue({ boardId: freshBoard(), uid: gwen }) // the next board's session
    expect(known(left, gwen)).toBe(false)
    expect(purgeGuestQueuesOf(gwen), 'no queue of theirs is held any more').toBe(0)
  })

  it('a board left with an unsent edit keeps it: coming back finds the edit and the guest mark', async () => {
    const gwen = freshUser('gwen')
    const left = freshBoard()
    await guestOn(left, gwen, [entry('r1', 5)])
    guestOfflineQueue({ boardId: freshBoard(), uid: gwen })
    guestOfflineQueue({ boardId: freshBoard(), uid: gwen }) // and another
    const back = guestOfflineQueue({ boardId: left, uid: gwen })
    expect(back.known).toBe(true)
    expect((await back.load()).map((e) => e.element.id)).toEqual(['r1'])
    expect(purgeGuestQueuesOf(gwen), 'the left board’s queue is still held').toBe(1)
  })

  it('once the edit is pushed (the queue is cleared) the board it was kept for is forgotten at the next sweep', async () => {
    const gwen = freshUser('gwen')
    const left = freshBoard()
    const q = await guestOn(left, gwen, [entry('r1', 5)])
    guestOfflineQueue({ boardId: freshBoard(), uid: gwen })
    expect(known(left, gwen), 'kept while unsent').toBe(true)
    await q.clear() // the room took it
    guestOfflineQueue({ boardId: freshBoard(), uid: gwen })
    expect(known(left, gwen)).toBe(false)
  })

  it('a later session of the same board is not a board left: its mark survives (a Retry)', async () => {
    const gwen = freshUser('gwen')
    const board = freshBoard()
    await guestOn(board, gwen)
    for (let i = 0; i < 3; i++) expect(known(board, gwen)).toBe(true)
  })

  it('the sweep reaches every user’s idle queues on the left boards, and none that holds an edit', async () => {
    const gwen = freshUser('gwen')
    const other = freshUser('other')
    const b1 = freshBoard()
    const b2 = freshBoard()
    await guestOn(b1, gwen)
    await guestOn(b1, other, [entry('r9', 9)])
    await guestOn(b2, gwen)
    guestOfflineQueue({ boardId: freshBoard(), uid: gwen })
    expect(known(b1, gwen)).toBe(false)
    expect(known(b2, gwen)).toBe(false)
    const kept = guestOfflineQueue({ boardId: b1, uid: other })
    expect(kept.known).toBe(true)
    expect(await kept.load()).toHaveLength(1)
  })
})

describe('releaseGuestQueue: the board page unmounting', () => {
  it('drops a queue with nothing unsent, and says so', async () => {
    const gwen = freshUser('gwen')
    const board = freshBoard()
    await guestOn(board, gwen)
    expect(releaseGuestQueue({ boardId: board, uid: gwen })).toBe(true)
    expect(known(board, gwen)).toBe(false)
    expect(purgeGuestQueuesOf(gwen)).toBe(0)
  })

  it('keeps one that holds an unsent edit, for the guest’s return', async () => {
    const gwen = freshUser('gwen')
    const board = freshBoard()
    await guestOn(board, gwen, [entry('r1', 5)])
    expect(releaseGuestQueue({ boardId: board, uid: gwen })).toBe(false)
    const back = guestOfflineQueue({ boardId: board, uid: gwen })
    expect(back.known).toBe(true)
    expect((await back.load()).map((e) => e.element.id)).toEqual(['r1'])
    await back.clear()
    expect(releaseGuestQueue({ boardId: board, uid: gwen })).toBe(true)
  })

  it('the empty save a session’s dispose makes afterwards does not bring the queue back', async () => {
    const gwen = freshUser('gwen')
    const board = freshBoard()
    const q = await guestOn(board, gwen)
    expect(releaseGuestQueue({ boardId: board, uid: gwen })).toBe(true)
    await q.save([]) // core.persistNow() of the session that is going
    expect(purgeGuestQueuesOf(gwen), 'no queue was made again').toBe(0)
    await q.save([entry('r1', 1)]) // a real unsent edit still makes one
    expect(purgeGuestQueuesOf(gwen)).toBe(1)
  })

  it('has nothing to drop for a member (their session made no page queue), another board or another user', async () => {
    const member = freshUser('member')
    const gwen = freshUser('gwen')
    const board = freshBoard()
    const q = guestOfflineQueue({ boardId: board, uid: member })
    await q.load()
    await q.clear()
    expect(releaseGuestQueue({ boardId: board, uid: member })).toBe(false)
    await guestOn(board, gwen)
    expect(releaseGuestQueue({ boardId: freshBoard(), uid: gwen })).toBe(false)
    expect(releaseGuestQueue({ boardId: board, uid: member })).toBe(false)
    expect(known(board, gwen)).toBe(true)
  })
})
