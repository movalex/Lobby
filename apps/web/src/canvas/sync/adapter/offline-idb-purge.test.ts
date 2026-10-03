// CRIT-18: the offline edit queue (IndexedDB) is purged when the session ends. Before, purge() ran only on
// a guest welcome and on a FORBIDDEN or NOT_FOUND close; a signed-out user's unsent edits stayed readable
// in the browser (a shared machine).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OfflineEntry } from '../types.ts'
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

  it('purges the user signed in here once their session ends, once', () => {
    const r = rig()
    r.seen({ status: 'loading', uid: null })
    r.seen({ status: 'signed-in', uid: 'usr_a' })
    expect(r.calls).toEqual([])
    r.seen({ status: 'signed-out', uid: null })
    expect(r.calls).toEqual(['usr_a'])
    r.seen({ status: 'signed-out', uid: null })
    expect(r.calls).toEqual(['usr_a'])
  })

  it('an api that cannot be reached, or a session that was never signed in, purges nothing', () => {
    const r = rig()
    r.seen({ status: 'signed-out', uid: null })
    r.seen({ status: 'signed-in', uid: 'usr_a' })
    r.seen({ status: 'unreachable', uid: null })
    r.seen({ status: 'loading', uid: null })
    expect(r.calls).toEqual([])
    // back, still signed in: then signed out
    r.seen({ status: 'signed-in', uid: 'usr_a' })
    r.seen({ status: 'signed-out', uid: null })
    expect(r.calls).toEqual(['usr_a'])
  })

  it('another account signed in here ends the first one’s session: its queues go', () => {
    const r = rig()
    r.seen({ status: 'signed-in', uid: 'usr_a' })
    r.seen({ status: 'signed-in', uid: 'usr_a' })
    r.seen({ status: 'signed-in', uid: 'usr_b' })
    expect(r.calls).toEqual(['usr_a'])
  })

  it('a purge that fails (no IndexedDB) is swallowed', async () => {
    const seen = createSignOutPurge(() => Promise.reject(new Error('no idb')))
    seen({ status: 'signed-in', uid: 'usr_a' })
    expect(() => seen({ status: 'signed-out', uid: null })).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
  })
})
