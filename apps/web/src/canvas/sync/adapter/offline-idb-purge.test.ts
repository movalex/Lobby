// CRIT-18: the offline edit queue (IndexedDB) is purged when the person signs out themselves. Before,
// purge() ran only on a guest welcome and on a FORBIDDEN or NOT_FOUND close; a signed-out user's unsent
// edits stayed readable in the browser (a shared machine). An expired or revoked session (a 401) keeps the
// queue: unsent work, held per user for that user's next session (wave A follow-up before deploy).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Old from '../testing/rev11-437b4e7/offline-idb.ts'
import type { OfflineEntry } from '../types.ts'
import { guestOfflineQueue } from './offline-guest.ts'
import { createIdbOfflineStore, createSignOutPurge, purgeOfflineQueuesOf } from './offline-idb.ts'

interface Rec {
  key: string
  uid: string
  boardId: string
}

/**
 * A small IndexedDB with real records: one object store keyed by `key`, requests answered on a later
 * task, transactions run one at a time in the order they were made (as overlapping ones do in a browser)
 * and complete once their last request (including those made in a callback) has answered.
 */
function memoryIndexedDb() {
  const records = new Map<string, Rec>()
  let opened = 0
  let closed = 0
  let created = false
  const queue: (() => void)[] = []
  let running = false
  const runNext = () => {
    const next = queue.shift()
    if (!next) {
      running = false
      return
    }
    running = true
    next()
  }
  const db = {
    objectStoreNames: { contains: () => created },
    createObjectStore: () => {
      created = true
    },
    close: () => {
      closed++
    },
    transaction: () => {
      let pending = 0
      let started = false
      const ops: (() => void)[] = []
      const t = {
        oncomplete: null as (() => void) | null,
        onabort: null as (() => void) | null,
        onerror: null as (() => void) | null,
        error: null,
        commit: () => {},
        objectStore: () => store,
      }
      const finish = () => {
        if (pending > 0) return
        setTimeout(() => {
          if (pending > 0) return
          t.oncomplete?.()
          runNext()
        }, 0)
      }
      const req = <T>(fn: () => T) => {
        const r = {
          result: undefined as T | undefined,
          error: null,
          onsuccess: null as (() => void) | null,
          onerror: null as (() => void) | null,
        }
        pending++
        const op = () =>
          setTimeout(() => {
            r.result = fn()
            r.onsuccess?.()
            pending--
            finish()
          }, 0)
        if (started) op()
        else ops.push(op)
        return r
      }
      const store = {
        get: (k: string) => req(() => records.get(k)),
        getAll: () => req(() => [...records.values()].map((r) => structuredClone(r))),
        put: (v: Rec) => req(() => void records.set(v.key, structuredClone(v))),
        delete: (k: string) => req(() => void records.delete(k)),
      }
      queue.push(() => {
        started = true
        for (const op of ops.splice(0)) op()
        finish()
      })
      if (!running) setTimeout(runNext, 0)
      return t
    },
  }
  const factory = {
    open: () => {
      opened++
      const r = {
        result: db,
        error: null,
        onupgradeneeded: null as (() => void) | null,
        onsuccess: null as (() => void) | null,
        onerror: null,
      }
      setTimeout(() => {
        if (!created) r.onupgradeneeded?.()
        r.onsuccess?.()
      }, 0)
      return r
    },
  }
  const seed = (r: Rec & Record<string, unknown>) => {
    created = true
    records.set(r.key, r)
  }
  return { factory, records, seed, counts: () => ({ opened, closed }) }
}

const entry = (id: string): OfflineEntry => ({
  element: { id, type: 'rectangle', version: 2, versionNonce: 7, isDeleted: false, index: 'a0' },
  groups: ['pos'],
  base: 1,
  queuedAt: 1,
})

describe('purgeOfflineQueuesOf (CRIT-18)', () => {
  let idb: ReturnType<typeof memoryIndexedDb>
  beforeEach(() => {
    idb = memoryIndexedDb()
    vi.stubGlobal('indexedDB', idb.factory)
    vi.stubGlobal('navigator', {}) // no Web Locks: the store needs none for this
  })
  afterEach(() => vi.unstubAllGlobals())

  it('deletes every queue of the user (every board, every tab), keeps other users’, closes the database', async () => {
    const q = (boardId: string, uid: string, tab: string) => ({
      key: `${boardId}|${uid}|${tab}`,
      boardId,
      uid,
      tab,
      entries: [entry('r1')],
      savedAt: 1,
    })
    idb.seed(q('b-1', 'usr_a', 't1'))
    idb.seed(q('b-1', 'usr_a', 't2'))
    idb.seed(q('b-2', 'usr_a', 't1'))
    idb.seed(q('b-1', 'usr_b', 't9'))
    expect(await purgeOfflineQueuesOf('usr_a', idb.factory as unknown as IDBFactory)).toBe(3)
    expect([...idb.records.keys()]).toEqual(['b-1|usr_b|t9'])
    expect(idb.counts()).toEqual({ opened: 1, closed: 1 })
  })

  it('a queue the board page wrote just before (not yet committed) is deleted too; the next page loads nothing', async () => {
    const store = createIdbOfflineStore({ boardId: 'b-1', uid: 'usr_a', tab: 't1' })
    await store.load()
    // pagehide or a dispose starts the write; the sign-out purge follows at once
    const saving = store.save([entry('r1'), entry('r2')])
    const purged = purgeOfflineQueuesOf('usr_a')
    await saving
    expect(await purged).toBe(1)
    expect(idb.records.size).toBe(0)
    store.release()
    const next = createIdbOfflineStore({ boardId: 'b-1', uid: 'usr_a', tab: 't1' })
    expect(await next.load()).toEqual([])
    next.release()
  })

  it('with no database yet: nothing to delete', async () => {
    expect(await purgeOfflineQueuesOf('usr_a')).toBe(0)
  })
})

describe('createSignOutPurge: the session watch App.tsx feeds (CRIT-18)', () => {
  const rig = () => {
    const calls: string[] = []
    const seen = createSignOutPurge(async (uid) => {
      calls.push(uid)
    })
    return { calls, seen }
  }

  it('purges the user signed in here when their own Sign out finishes, once', () => {
    const r = rig()
    r.seen({ status: 'loading', uid: null })
    r.seen({ status: 'signed-in', uid: 'usr_a' })
    expect(r.calls).toEqual([])
    r.seen({ status: 'signed-out', uid: null, explicit: true })
    expect(r.calls).toEqual(['usr_a'])
    r.seen({ status: 'signed-out', uid: null, explicit: true })
    expect(r.calls).toEqual(['usr_a'])
  })

  it('an expired, revoked or other-tab-signed-out session (a 401, no explicit flag) purges nothing', () => {
    const r = rig()
    r.seen({ status: 'signed-in', uid: 'usr_a' })
    r.seen({ status: 'signed-out', uid: null })
    r.seen({ status: 'signed-out', uid: null, explicit: false })
    expect(r.calls).toEqual([])
    // the same user signs in again: still nothing purged, and now their own Sign out purges
    r.seen({ status: 'signed-in', uid: 'usr_a' })
    expect(r.calls).toEqual([])
    r.seen({ status: 'signed-out', uid: null, explicit: true })
    expect(r.calls).toEqual(['usr_a'])
  })

  it('a 401 that lands first in the same tick as the Sign out does not hide it: the user is still remembered', () => {
    const r = rig()
    r.seen({ status: 'signed-in', uid: 'usr_a' })
    r.seen({ status: 'signed-out', uid: null }) // the 401 handler
    r.seen({ status: 'signed-out', uid: null, explicit: true }) // the Sign out finishing
    expect(r.calls).toEqual(['usr_a'])
  })

  it('an api that cannot be reached, or a session that was never signed in, purges nothing', () => {
    const r = rig()
    r.seen({ status: 'signed-out', uid: null, explicit: true })
    r.seen({ status: 'signed-in', uid: 'usr_a' })
    r.seen({ status: 'unreachable', uid: null })
    r.seen({ status: 'loading', uid: null })
    expect(r.calls).toEqual([])
    // back, still signed in: then the person signs out
    r.seen({ status: 'signed-in', uid: 'usr_a' })
    r.seen({ status: 'signed-out', uid: null, explicit: true })
    expect(r.calls).toEqual(['usr_a'])
  })

  it('another account signing in here purges nothing; each one’s own Sign out purges only their own', () => {
    const r = rig()
    r.seen({ status: 'signed-in', uid: 'usr_a' })
    r.seen({ status: 'signed-in', uid: 'usr_a' })
    r.seen({ status: 'signed-in', uid: 'usr_b' })
    expect(r.calls).toEqual([])
    r.seen({ status: 'signed-out', uid: null, explicit: true })
    expect(r.calls).toEqual(['usr_b'])
  })

  it('a purge that fails (no IndexedDB) is swallowed', async () => {
    const seen = createSignOutPurge(() => Promise.reject(new Error('no idb')))
    seen({ status: 'signed-in', uid: 'usr_a' })
    expect(() => seen({ status: 'signed-out', uid: null, explicit: true })).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
  })
})

describe('the offline queue across sessions (CRIT-18: an expiry keeps unsent edits, a Sign out deletes them)', () => {
  let idb: ReturnType<typeof memoryIndexedDb>
  beforeEach(() => {
    idb = memoryIndexedDb()
    vi.stubGlobal('indexedDB', idb.factory)
    vi.stubGlobal('navigator', {})
  })
  afterEach(() => vi.unstubAllGlobals())

  const queueOf = async (uid: string) => {
    const store = createIdbOfflineStore({ boardId: 'b-1', uid, tab: 't1' })
    const entries = await store.load()
    store.release()
    return entries.map((e) => e.element.id)
  }

  it('an expired session keeps the user’s queue for their next session; their own Sign out deletes it', async () => {
    const seen = createSignOutPurge() // the real purge, against the stubbed IndexedDB
    const store = createIdbOfflineStore({ boardId: 'b-1', uid: 'usr_a', tab: 't1' })
    await store.load()
    await store.save([entry('r1'), entry('r2')])
    store.release()
    seen({ status: 'signed-in', uid: 'usr_a' })

    // the session expires (a 401): nothing is deleted, and usr_a's next session replays it
    seen({ status: 'signed-out', uid: null })
    await new Promise((r) => setTimeout(r, 20))
    expect(idb.records.size).toBe(1)
    expect(await queueOf('usr_a')).toEqual(['r1', 'r2'])

    // they sign in again, then sign out themselves: the queue is deleted
    seen({ status: 'signed-in', uid: 'usr_a' })
    seen({ status: 'signed-out', uid: null, explicit: true })
    await vi.waitFor(() => expect(idb.records.size).toBe(0))
    expect(await queueOf('usr_a')).toEqual([])
  })

  // F2 (wave F, the E2 follow-up): nothing asserted that the default purge reaches the guest queues a page holds
  // in memory (./offline-guest.ts), which outlive a board session: a guest's unsent edits stayed readable by the
  // next person on a shared machine's open tab after the guest's own Sign out
  it('their own Sign out also drops the guest queues this page holds in memory (not another account’s); a 401 keeps them', async () => {
    const seen = createSignOutPurge() // the real purge: the device queues and the page's guest queues
    const mine = guestOfflineQueue({ boardId: 'b-signout-guest', uid: 'usr_g' })
    mine.markGuest()
    await mine.save([entry('r1'), entry('r2')])
    const theirs = guestOfflineQueue({ boardId: 'b-signout-guest', uid: 'usr_h' })
    theirs.markGuest()
    await theirs.save([entry('r3')])
    // a device record of the same account (what a member of other boards has), so the purge's device half is seen too
    idb.seed({
      key: 'b-other|usr_g|t1',
      boardId: 'b-other',
      uid: 'usr_g',
      tab: 't1',
      entries: [entry('d1')],
      savedAt: 1,
    })
    seen({ status: 'signed-in', uid: 'usr_g' })

    // the session expires (a 401): the guest's unsent edits wait for their return, as a member's do
    seen({ status: 'signed-out', uid: null })
    expect((await mine.load()).map((e) => e.element.id)).toEqual(['r1', 'r2'])
    expect(mine.known).toBe(true)
    expect(idb.records.size).toBe(1)

    // their own Sign out: gone from this page's memory, with the mark that routed a later session to it
    seen({ status: 'signed-in', uid: 'usr_g' })
    seen({ status: 'signed-out', uid: null, explicit: true })
    expect(await mine.load()).toEqual([])
    expect(mine.known).toBe(false)
    // the other account's queue on the same board is not theirs to lose
    expect((await theirs.load()).map((e) => e.element.id)).toEqual(['r3'])
    expect(theirs.known).toBe(true)
    await vi.waitFor(() => expect(idb.records.size).toBe(0)) // the device half of the same purge
    seen({ status: 'signed-in', uid: 'usr_h' })
    seen({ status: 'signed-out', uid: null, explicit: true })
    expect(await theirs.load()).toEqual([])
  })

  it('another account on the same browser never loads or adopts a kept queue (it is keyed by user)', async () => {
    const saved = (boardId: string, uid: string, tab: string, id: string) => ({
      key: `${boardId}|${uid}|${tab}`,
      boardId,
      uid,
      tab,
      entries: [entry(id)],
      savedAt: 1,
    })
    idb.seed(saved('b-1', 'usr_a', 't0', 'a-closed-tab')) // usr_a's queue from a closed tab
    idb.seed(saved('b-1', 'usr_a', 't1', 'a-same-tab'))
    // usr_b opens the same board in the same tab id (a tab survives the session change): nothing of usr_a's
    expect(await queueOf('usr_b')).toEqual([])
    expect(idb.records.size).toBe(2)
    // usr_a's next session on this browser gets both back
    expect((await queueOf('usr_a')).sort()).toEqual(['a-closed-tab', 'a-same-tab'])
  })
})

// Wave L compat refix, round 2: a tab of the web deployed before wave L (437b4e7, CONTRACTS_REV 11; its store,
// frozen in ../testing/rev11-437b4e7/offline-idb.ts) stays open across the deploy, possibly for days, on the same
// IndexedDB as this web's tabs. Its `load` adopted every free-lock queue of the board and user and sent it on a
// socket that names no revision, so a rev-12 page's queued removal of a frame's planned minutes was completed as
// a rev-11 write and undone (or re-saved without its `rev` while it stayed offline). This web's records are in a
// form that store never matches; this web still takes the older form over; both web's Sign out delete both.
describe('the offline queue across the wave L deploy (a 437b4e7 tab beside this web, one IndexedDB)', () => {
  let idb: ReturnType<typeof memoryIndexedDb>
  beforeEach(() => {
    idb = memoryIndexedDb()
    vi.stubGlobal('indexedDB', idb.factory)
    // Web Locks with every other tab's lock free (its tab is closed): an adopted queue's record is deleted
    vi.stubGlobal('navigator', {
      locks: { request: async (_n: string, _o: unknown, cb: (l: object) => unknown) => cb({}) },
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  const rev12 = (id: string): OfflineEntry => ({ ...entry(id), groups: ['c:present'], rev: 12 })
  const ids = (entries: readonly OfflineEntry[]) => entries.map((e) => e.element.id).sort()

  it("a queue this web left is never adopted by a 437b4e7 page; that page's own Sign out still deletes it", async () => {
    const mine = createIdbOfflineStore({ boardId: 'b-1', uid: 'usr_a', tab: 't-new' })
    await mine.load()
    await mine.save([rev12('f1')])
    mine.release()
    // the 437b4e7 tab opens the board: it takes nothing of it (before, it adopted f1 and cleared the record)
    const old = Old.createIdbOfflineStore({ boardId: 'b-1', uid: 'usr_a', tab: 't-old' })
    expect(await old.load()).toEqual([])
    old.release()
    expect([...idb.records.keys()]).toEqual(['q2:b-1|usr_a|t-new'])
    // this web's next page of the board takes it over, with its revision
    const next = createIdbOfflineStore({ boardId: 'b-1', uid: 'usr_a', tab: 't-next' })
    const taken = await next.load()
    expect(taken.map((e) => [e.element.id, e.rev])).toEqual([['f1', 12]])
    next.release()
    // a Sign out in the 437b4e7 tab (CRIT-18: by user) deletes this web's form too
    expect(await Old.purgeOfflineQueuesOf('usr_a', idb.factory as unknown as IDBFactory)).toBe(1)
    expect(idb.records.size).toBe(0)
  })

  it("this web takes the 437b4e7 form over (a closed tab's, and this tab's own from before the reload)", async () => {
    for (const [tab, id] of [
      ['t0', 'closed-tab'],
      ['t1', 'same-tab'],
    ] as const) {
      // saved by the 437b4e7 page of each tab (no load here: one would adopt the other's)
      const old = Old.createIdbOfflineStore({ boardId: 'b-1', uid: 'usr_a', tab })
      await old.save([entry(id)])
      old.release()
    }
    const other = Old.createIdbOfflineStore({ boardId: 'b-2', uid: 'usr_a', tab: 't1' })
    await other.save([entry('other-board')])
    other.release()
    const store = createIdbOfflineStore({ boardId: 'b-1', uid: 'usr_a', tab: 't1' })
    expect(ids(await store.load())).toEqual(['closed-tab', 'same-tab'])
    // kept in this web's form only (the older records gone), the other board's untouched
    expect([...idb.records.keys()].sort()).toEqual(['b-2|usr_a|t1', 'q2:b-1|usr_a|t1'])
    await store.clear()
    store.release()
    expect([...idb.records.keys()]).toEqual(['b-2|usr_a|t1'])
  })

  it("purge (a FORBIDDEN close) deletes this board's queues of the user in both forms, nothing else", async () => {
    const old = Old.createIdbOfflineStore({ boardId: 'b-1', uid: 'usr_a', tab: 't0' })
    await old.load()
    await old.save([entry('r0')])
    old.release()
    const left = createIdbOfflineStore({ boardId: 'b-1', uid: 'usr_a', tab: 't9' })
    await left.load()
    await left.save([rev12('r9')])
    left.release()
    const elsewhere = createIdbOfflineStore({ boardId: 'b-2', uid: 'usr_a', tab: 't9' })
    await elsewhere.load()
    await elsewhere.save([rev12('r2')])
    elsewhere.release()
    const store = createIdbOfflineStore({ boardId: 'b-1', uid: 'usr_a', tab: 't1' })
    await store.purge()
    store.release()
    expect([...idb.records.keys()]).toEqual(['q2:b-2|usr_a|t9'])
  })
})
