import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryOfflineStore } from '../core/offline-memory.ts'
import { rect } from '../testing/elements.ts'
import { stored } from '../testing/fakeRoom.ts'
import { createHarness } from '../testing/harness.ts'
import type { OfflineEntry, OfflineQueueStore } from '../types.ts'
import {
  guestOfflineQueue,
  purgeGuestQueuesOf,
  releaseGuestQueue,
  releaseGuestQueueSoon,
} from './offline-guest.ts'

// I2 (wave I; the wave F follow-up): the board page releases a guest's page queue when it unmounts
// (LobbyBoardShell), but AFTER the session's dispose. React runs an unmounting tree's passive cleanups from the
// parent down (react-dom 19.3): the shell's cleanup comes before the session's `dispose()`, whose
// `persistNow()` makes one last save. A release made first dropped the idle queue, and that late save made a
// new one with no guest mark, which the next session of the board did not route to: the unsent edit was
// stranded. The release now waits a tick, and a save of something carries the guest mark whatever the order.

const entry = (id: string, x: number): OfflineEntry => ({
  element: rect(id, 'a0', { x }),
  groups: ['geometry'],
  base: 0,
  queuedAt: 1,
})

// the queues live for the whole module, as on a page: every test has boards and users of its own
let n = 0
const freshBoard = () => `b-release-${++n}`
const users: string[] = []
const freshUser = (name: string) => {
  const uid = `${name}-${++n}`
  users.push(uid)
  return uid
}
beforeEach(() => {
  // only the timer the release uses: the engine harness runs on its own manual clock
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
afterEach(() => {
  vi.useRealTimers()
  for (const uid of users.splice(0)) purgeGuestQueuesOf(uid)
})

/** `uid`'s queue on `board` after a welcome that said guest, with nothing unsent */
const guestOn = (board: string, uid: string) => {
  const q = guestOfflineQueue({ boardId: board, uid })
  q.markGuest()
  return q
}
const known = (boardId: string, uid: string) => guestOfflineQueue({ boardId, uid }).known

describe('a save of something after the queue was released', () => {
  it('makes the queue again WITH the guest mark: the next session of the board still routes to it', async () => {
    const gwen = freshUser('gwen')
    const board = freshBoard()
    const q = guestOn(board, gwen)
    expect(releaseGuestQueue({ boardId: board, uid: gwen })).toBe(true)
    expect(known(board, gwen), 'released: the page forgot the board').toBe(false)

    await q.save([entry('r1', 5)]) // the last save of the session's dispose (persistNow)

    // Before the fix the queue came back unmarked: `known` was false, so a session of this board read the
    // device queue (a guest never has one) and the unsent edit sat in memory, unread.
    const back = guestOfflineQueue({ boardId: board, uid: gwen })
    expect(back.known).toBe(true)
    expect((await back.load()).map((e) => e.element.id)).toEqual(['r1'])
    // and it is kept like any queue with an unsent edit: it survives the page moving on to another board
    guestOfflineQueue({ boardId: freshBoard(), uid: gwen })
    expect(releaseGuestQueue({ boardId: board, uid: gwen })).toBe(false)
    expect(purgeGuestQueuesOf(gwen)).toBe(1)
  })

  it('an empty save after the release still makes nothing', async () => {
    const gwen = freshUser('gwen')
    const board = freshBoard()
    const q = guestOn(board, gwen)
    expect(releaseGuestQueue({ boardId: board, uid: gwen })).toBe(true)
    await q.save([])
    expect(known(board, gwen)).toBe(false)
    expect(purgeGuestQueuesOf(gwen)).toBe(0)
  })
})

describe('releaseGuestQueueSoon: the release waits for the rest of the unmount', () => {
  it('drops an idle queue (and its guest mark) once the tick has passed, not before', async () => {
    const gwen = freshUser('gwen')
    const board = freshBoard()
    guestOn(board, gwen)
    releaseGuestQueueSoon({ boardId: board, uid: gwen })
    // the rest of the unmount (the session's dispose) runs in this same tick: the queue is still there
    expect(known(board, gwen)).toBe(true)
    vi.runAllTimers()
    expect(known(board, gwen)).toBe(false)
    expect(purgeGuestQueuesOf(gwen), 'no queue of theirs is held any more').toBe(0)
  })

  it('keeps a queue that holds an unsent edit by the time the tick has passed', async () => {
    const gwen = freshUser('gwen')
    const board = freshBoard()
    const q = guestOn(board, gwen)
    releaseGuestQueueSoon({ boardId: board, uid: gwen })
    await q.save([entry('r1', 5)]) // the session's dispose, after the shell's cleanup
    vi.runAllTimers()
    const back = guestOfflineQueue({ boardId: board, uid: gwen })
    expect(back.known).toBe(true)
    expect((await back.load()).map((e) => e.element.id)).toEqual(['r1'])
  })

  it('is cancelled by a mount on the same board before the tick (StrictMode’s simulated unmount and remount)', () => {
    const gwen = freshUser('gwen')
    const board = freshBoard()
    guestOn(board, gwen)
    const cancel = releaseGuestQueueSoon({ boardId: board, uid: gwen })
    cancel()
    vi.runAllTimers()
    expect(known(board, gwen), 'the board is still open: its mark stays').toBe(true)
  })
})

describe('an unmount in the middle of a drag, an edit the debounce had not written (engine core, fake room)', () => {
  /**
   * What a guest's second session does (session.ts): routes to the page queue when a welcome of the page said
   * guest (`known`), else to the device's IndexedDB queue, which a guest never has (an empty one here).
   */
  const routedLikeTheSession = (board: string, uid: string): OfflineQueueStore => {
    const memory = guestOfflineQueue({ boardId: board, uid })
    const guest = memory.known // read once, when the session is made (session.ts: this.guest = memory.known)
    const idb = createMemoryOfflineStore()
    return {
      load: () => (guest ? memory.load() : idb.load()),
      save: (e) => (guest ? memory.save(e) : idb.save(e)),
      clear: () => (guest ? memory.clear() : idb.clear()),
    }
  }

  /**
   * The guest's first session loses its socket, the guest moves a rectangle (the offline queue is written
   * once per 100 ms during a drag, so nothing is in the queue yet), and the page unmounts: `unmount` runs the cleanups in
   * the order React does, the shell's first and the session's dispose after it. Then a second session starts.
   */
  async function unmountWithAnEditThenReturn(
    unmount: (o: { board: string; uid: string; sessionDispose(): void }) => void,
  ) {
    const board = freshBoard()
    const uid = freshUser('gwen')
    const h = createHarness({ seed: [stored(rect('r1', 'a0'))] })
    // session 1: a guest (a welcome said so: the page's queue is marked)
    const page = guestOfflineQueue({ boardId: board, uid })
    page.markGuest()
    const s1 = h.client(uid, { offline: page })
    h.settle()
    await Promise.resolve()
    h.settle()
    h.room.cut(s1.transport)
    h.settle()
    // mid-drag: while a gesture runs the queue is written once per 100 ms, so this change is not in it yet
    s1.change('r1', { x: 77 }, { dragging: true, selectedElementIds: ['r1'] })
    await Promise.resolve()
    expect(await page.load(), 'the edit is not in the queue yet (the write is debounced)').toEqual([])

    unmount({
      board,
      uid,
      sessionDispose: () => {
        s1.core.persistNow()
        s1.core.stop()
      },
    })
    await Promise.resolve()
    vi.runAllTimers()

    // the guest comes back to this board: a new session, routed as session.ts routes it
    const s2 = h.client(uid, { offline: routedLikeTheSession(board, uid), tab: 'tab2' })
    for (let i = 0; i < 4; i++) {
      await Promise.resolve()
      h.settle()
    }
    return { h, s2, board, uid }
  }

  it('the shell’s deferred release, then the session’s dispose (the order of the page): the edit reaches the board', async () => {
    const { h, s2, board, uid } = await unmountWithAnEditThenReturn((o) => {
      releaseGuestQueueSoon({ boardId: o.board, uid: o.uid }) // the shell's cleanup: first
      o.sessionDispose() // then the session's, with its last save
    })
    expect(h.room.elements.get('r1')?.x).toBe(77)
    expect(s2.get('r1')?.x).toBe(77)
    expect(known(board, uid)).toBe(true)
  })

  it('even a release made before the session’s last save (no deferral) does not strand the edit', async () => {
    const { h, s2, board, uid } = await unmountWithAnEditThenReturn((o) => {
      // what a plain shell cleanup would do: release at once, the queue being idle, then the dispose's save
      expect(releaseGuestQueue({ boardId: o.board, uid: o.uid })).toBe(true)
      o.sessionDispose()
    })
    // Before the fix the late save made the queue unmarked: the second session read the device queue and
    // the rectangle stayed where the room had it.
    expect(h.room.elements.get('r1')?.x).toBe(77)
    expect(s2.get('r1')?.x).toBe(77)
    expect(known(board, uid)).toBe(true)
  })
})
