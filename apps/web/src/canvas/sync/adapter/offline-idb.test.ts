// The per-tab offline queue's Web Lock: a store released before its lock was granted must not keep the lock
// (LEAD-1: React StrictMode under `vite dev` disposes the page's first session in the task that made it; the
// live session's store then waited on `load()` forever, and the board never showed Saved).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIdbOfflineStore } from './offline-idb.ts'

/**
 * A Web Locks API with the real one's order and timing: one holder per name, waiters in request order,
 * and a grant is never synchronous (the browser grants in a later task, so a `release()` in the task that
 * made the request comes before the grant).
 */
function fakeLocks() {
  const queues = new Map<string, (() => void)[]>()
  const holders = new Set<string>()
  const next = (name: string) => {
    const waiter = queues.get(name)?.shift()
    if (waiter) waiter()
    else holders.delete(name)
  }
  return {
    holders,
    request: (name: string, _opts: unknown, cb: (lock: unknown) => unknown) =>
      new Promise<void>((resolve) => {
        const run = () => {
          holders.add(name)
          void Promise.resolve(cb({ name })).then(() => {
            resolve()
            next(name)
          })
        }
        setTimeout(() => {
          if (holders.has(name)) {
            const q = queues.get(name) ?? []
            q.push(run)
            queues.set(name, q)
          } else run()
        }, 0)
      }),
  }
}

/** The one IndexedDB request shape the store reads: fires onsuccess with `result` on the next tick. */
function request<T>(result: T) {
  const r = {
    result,
    error: null,
    onsuccess: null as (() => void) | null,
    onerror: null as (() => void) | null,
  }
  setTimeout(() => r.onsuccess?.(), 0)
  return r
}

/** An empty database: every read answers nothing, every transaction completes. */
function fakeIndexedDb() {
  const store = {
    get: () => request(undefined),
    getAll: () => request([]),
    put: () => request(undefined),
    delete: () => request(undefined),
  }
  const db = {
    objectStoreNames: { contains: () => true },
    transaction: () => {
      const t = {
        objectStore: () => store,
        oncomplete: null as (() => void) | null,
        onabort: null,
        error: null,
      }
      setTimeout(() => t.oncomplete?.(), 0)
      return t
    },
  }
  return {
    open: () => {
      const r = {
        result: db,
        error: null,
        onupgradeneeded: null,
        onsuccess: null as (() => void) | null,
        onerror: null,
      }
      setTimeout(() => r.onsuccess?.(), 0)
      return r
    },
  }
}

const settles = <T>(p: Promise<T>, ms = 300) =>
  Promise.race([
    p.then(() => 'settled' as const),
    new Promise<'hung'>((r) => setTimeout(() => r('hung'), ms)),
  ])

describe('the offline queue lock', () => {
  let locks: ReturnType<typeof fakeLocks>
  beforeEach(() => {
    locks = fakeLocks()
    vi.stubGlobal('navigator', { locks })
    vi.stubGlobal('indexedDB', fakeIndexedDb())
  })
  afterEach(() => vi.unstubAllGlobals())

  const ids = { boardId: 'b-3k9x0q2m7a', uid: 'usr_a', tab: 't1' }

  it('a store released before its grant gives the lock up at once, so the next store of the tab loads', async () => {
    const first = createIdbOfflineStore(ids)
    first.release() // StrictMode's cleanup, in the same task as the construction: no grant yet
    const second = createIdbOfflineStore(ids)
    expect(await settles(second.load())).toBe('settled')
    expect(locks.holders.has('lobby-offline:b-3k9x0q2m7a:t1')).toBe(true)
    second.release()
    await new Promise((r) => setTimeout(r, 0))
    expect(locks.holders.size).toBe(0)
  })

  it('a store released after its grant hands the lock to the next store of the tab', async () => {
    const first = createIdbOfflineStore(ids)
    expect(await settles(first.load())).toBe('settled')
    const second = createIdbOfflineStore(ids)
    expect(await settles(second.load(), 100)).toBe('hung') // the first still holds it
    first.release()
    expect(await settles(second.load())).toBe('settled')
  })
})
