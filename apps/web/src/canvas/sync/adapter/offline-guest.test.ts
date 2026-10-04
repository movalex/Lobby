import { describe, expect, it } from 'vitest'
import { createMemoryOfflineStore } from '../core/offline-memory.ts'
import { rect } from '../testing/elements.ts'
import { stored } from '../testing/fakeRoom.ts'
import { createHarness } from '../testing/harness.ts'
import type { OfflineEntry, OfflineQueueStore } from '../types.ts'
import { guestOfflineQueue, purgeGuestQueuesOf } from './offline-guest.ts'

// E2 (wave E, the D2 review of DEF-GAPS-1): a guest's in-memory offline queue is the page's, not one board
// session's. A new session on the same page (Retry after a terminal close, a remount) must find the guest's
// unsent changes, as a member's are found in the tab's IndexedDB record.

const entry = (id: string, x: number): OfflineEntry => ({
  element: rect(id, 'a0', { x }),
  groups: ['geometry'],
  base: 0,
  queuedAt: 1,
})

let n = 0
/** a board id no other test of this file uses (the queues live for the whole module, as on a page) */
const freshBoard = () => `b-guest-${++n}`

describe('guestOfflineQueue: one queue per board and user for the page', () => {
  it('a later session of the page reads what an earlier one saved; another board or user does not', async () => {
    const board = freshBoard()
    const first = guestOfflineQueue({ boardId: board, uid: 'gwen' })
    await first.save([entry('r1', 5)])
    const again = guestOfflineQueue({ boardId: board, uid: 'gwen' })
    expect((await again.load()).map((e) => e.element.id)).toEqual(['r1'])
    expect(await guestOfflineQueue({ boardId: freshBoard(), uid: 'gwen' }).load()).toEqual([])
    expect(await guestOfflineQueue({ boardId: board, uid: 'other' }).load()).toEqual([])
    // a copy, not the stored entries (as the memory store always did)
    const loaded = await again.load()
    ;(loaded as OfflineEntry[]).length = 0
    expect(await again.load()).toHaveLength(1)
    await again.clear()
    expect(await first.load()).toEqual([])
  })

  it('`known` says a session of this page learned the user is a guest on this board', () => {
    const board = freshBoard()
    const q = guestOfflineQueue({ boardId: board, uid: 'gwen' })
    expect(q.known).toBe(false)
    q.markGuest()
    expect(q.known).toBe(true)
    expect(guestOfflineQueue({ boardId: board, uid: 'gwen' }).known).toBe(true)
    expect(guestOfflineQueue({ boardId: board, uid: 'other' }).known).toBe(false)
    expect(guestOfflineQueue({ boardId: freshBoard(), uid: 'gwen' }).known).toBe(false)
  })

  it('reading or clearing a queue nobody saved makes none (a member’s session, an access loss)', async () => {
    const board = freshBoard()
    const q = guestOfflineQueue({ boardId: board, uid: 'member' })
    expect(await q.load()).toEqual([])
    await q.clear()
    expect(purgeGuestQueuesOf('member')).toBe(0)
    // an access loss clears a guest's queue; the page still knows they were a guest here
    const g = guestOfflineQueue({ boardId: board, uid: 'gwen' })
    g.markGuest()
    await g.save([entry('r1', 1)])
    await g.clear()
    expect(await guestOfflineQueue({ boardId: board, uid: 'gwen' }).load()).toEqual([])
    expect(g.known).toBe(true)
  })

  it("the person's own sign-out drops their queues on this page, nobody else's", async () => {
    const b1 = freshBoard()
    const b2 = freshBoard()
    const mine = guestOfflineQueue({ boardId: b1, uid: 'leaver' })
    mine.markGuest()
    await mine.save([entry('r1', 1)])
    await guestOfflineQueue({ boardId: b2, uid: 'leaver' }).save([entry('r2', 2)])
    const theirs = guestOfflineQueue({ boardId: b1, uid: 'stayer' })
    await theirs.save([entry('r3', 3)])
    expect(purgeGuestQueuesOf('leaver')).toBe(2)
    expect(await guestOfflineQueue({ boardId: b1, uid: 'leaver' }).load()).toEqual([])
    expect(await guestOfflineQueue({ boardId: b2, uid: 'leaver' }).load()).toEqual([])
    expect(guestOfflineQueue({ boardId: b1, uid: 'leaver' }).known).toBe(false)
    expect((await theirs.load()).map((e) => e.element.id)).toEqual(['r3'])
  })
})

describe('a session restart on the page keeps a guest’s unsent edit (engine core, fake room)', () => {
  /** one session's core: offline, an edit, then the session goes (dispose: persistNow, stop) */
  async function editThenRestart(store: () => OfflineQueueStore) {
    const h = createHarness({ seed: [stored(rect('r1', 'a0'))] })
    const s1 = h.client('gwen', { offline: store() })
    h.settle()
    await Promise.resolve()
    h.settle()
    // the socket goes (a terminal close in the browser), then the guest moves the rectangle
    h.room.cut(s1.transport)
    h.settle()
    s1.change('r1', { x: 77 })
    await Promise.resolve()
    s1.core.persistNow()
    s1.core.stop()
    // the page's next session (Retry): a new core, a new empty scene, the store its session constructs
    const s2 = h.client('gwen', { offline: store() })
    for (let i = 0; i < 4; i++) {
      await Promise.resolve()
      h.settle()
    }
    return { h, s2 }
  }

  it('the page queue: the next session adopts the edit and pushes it', async () => {
    const board = freshBoard()
    const { h, s2 } = await editThenRestart(() => guestOfflineQueue({ boardId: board, uid: 'gwen' }))
    expect(h.room.elements.get('r1')?.x).toBe(77)
    expect(s2.get('r1')?.x).toBe(77)
    expect(s2.core.saveStatus.state).toBe('saved')
  })

  it('a per-session queue (what guests had before) drops it', async () => {
    const { h } = await editThenRestart(() => createMemoryOfflineStore())
    expect(h.room.elements.get('r1')?.x).toBe(0)
  })
})
