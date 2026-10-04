/**
 * The per-tab offline queue in IndexedDB (docs/EXCALIDRAW-MIGRATION.md §2.5.6):
 *
 *  - one record per board, user and tab (`<board>|<uid>|<tab>`); the tab id survives a reload
 *    (sessionStorage), so a reloaded page finds its own queue (D5);
 *  - the tab holds a Web Locks lock `lobby-offline:<board>:<tab>` for its lifetime; on load it ADOPTS the
 *    queues of the same user and board whose lock is free (a closed tab, D6), so their edits are replayed,
 *    not lost, and two tabs never replay the same queue;
 *  - guests get no persistence (the board page gives them the page's memory queue, ./offline-guest.ts),
 *    and `purge()` removes every queue of the board for this user (a FORBIDDEN close, a revocation);
 *  - when the person signs out themselves (the Sign out, Switch user or Sign out everywhere button, and
 *    only that) every queue that user left in this browser is deleted, every board and tab
 *    (`purgeOfflineQueuesOf`, from App.tsx through `createSignOutPurge`; CRIT-18): unsent edits are not
 *    left readable on a shared machine. An expired or revoked session (a 401, NOT_AUTHENTICATED, a
 *    sign-out in another tab) purges nothing: the queue is keyed by user, so only the same user's next
 *    session on this browser loads (and replays) it, never another account's (`load` and
 *    `adoptOthers` match `uid`);
 *  - a `save` or `clear` starts its transaction in the call itself once the database is open (and asks
 *    it to commit at once), so a write the core starts right before a reload or in `pagehide` is not
 *    left waiting for a later task (spike B part 3: the offline window); it resolves once committed.
 *
 * Browser only (not node-safe).
 */
import { mergeOfflineQueues } from '../core/offline-merge.ts'
import type { OfflineEntry, OfflineQueueStore } from '../types.ts'
import { purgeGuestQueuesOf } from './offline-guest.ts'

const DB = 'lobby-offline'
const STORE = 'queues'

interface QueueRecord {
  key: string
  boardId: string
  uid: string
  tab: string
  entries: OfflineEntry[]
  savedAt: number
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function tx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode)
    const r = fn(t.objectStore(STORE))
    if (mode === 'readwrite') {
      // resolved when durable (committed), not when the request succeeds
      t.oncomplete = () => resolve(r.result)
      t.onabort = () => reject(t.error ?? new Error('offline queue write aborted'))
      // no further request comes: commit now rather than when this task ends
      ;(t as IDBTransaction & { commit?: () => void }).commit?.()
    } else r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

const lockName = (boardId: string, tab: string) => `lobby-offline:${boardId}:${tab}`

/** This tab's id: stable across reloads of the tab, distinct per tab. */
export function tabId(): string {
  const k = 'lobby-tab-id'
  let id = sessionStorage.getItem(k)
  if (!id) {
    id = `t${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`
    sessionStorage.setItem(k, id)
  }
  return id
}

export interface IdbOfflineStore extends OfflineQueueStore {
  /** how many other tabs' queues the last load adopted */
  readonly adopted: number
  /** removes every queue of this board for this user (privacy purge) */
  purge(): Promise<void>
  /** gives up the tab's lock (the page unmounts) */
  release(): void
}

export function createIdbOfflineStore(o: { boardId: string; uid: string; tab: string }): IdbOfflineStore {
  const key = `${o.boardId}|${o.uid}|${o.tab}`
  let adopted = 0
  // `release()` may come before the lock is granted (React StrictMode disposes a page's first session in
  // the same task that made it; LEAD-1): the grant then gives the lock up at once, instead of a disposed
  // store holding it for good and the live store's `load()` waiting on it forever (the page never Saved).
  let released = false
  let releaseLock: () => void = () => {}
  const held = new Promise<void>((resolveHeld) => {
    if (!('locks' in navigator)) {
      resolveHeld()
      return
    }
    void navigator.locks.request(lockName(o.boardId, o.tab), { mode: 'exclusive' }, () => {
      resolveHeld()
      if (released) return
      return new Promise<void>((r) => {
        releaseLock = r
      })
    })
  })
  const dbp = openDb()
  // the open database, once there is one: writes start in the call (see the header)
  let opened: IDBDatabase | null = null
  void dbp.then(
    (db) => {
      opened = db
    },
    () => {},
  )
  const write = <T>(fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
    opened ? tx(opened, 'readwrite', fn) : dbp.then((db) => tx(db, 'readwrite', fn))

  const adoptOthers = async (db: IDBDatabase): Promise<OfflineEntry[]> => {
    const all = (await tx(db, 'readonly', (s) => s.getAll())) as QueueRecord[]
    const mine = all.filter((r) => r.boardId === o.boardId && r.uid === o.uid && r.tab !== o.tab)
    const out: OfflineEntry[] = []
    for (const rec of mine) {
      const free =
        !('locks' in navigator) ||
        (await navigator.locks.request(lockName(o.boardId, rec.tab), { ifAvailable: true }, async (lock) => {
          if (!lock) return false
          await tx(db, 'readwrite', (s) => s.delete(rec.key))
          return true
        }))
      if (free) {
        out.push(...rec.entries)
        adopted++
      }
    }
    return out
  }

  return {
    get adopted() {
      return adopted
    },
    async load() {
      await held
      const db = await dbp
      const own = ((await tx(db, 'readonly', (s) => s.get(key))) as QueueRecord | undefined)?.entries ?? []
      const others = await adoptOthers(db)
      // one entry per element (and one `#doc` entry with every tab's keys): core/offline-merge.ts
      const entries = mergeOfflineQueues([others, own])
      if (others.length)
        await tx(db, 'readwrite', (s) =>
          s.put({ key, boardId: o.boardId, uid: o.uid, tab: o.tab, entries, savedAt: Date.now() }),
        )
      return entries
    },
    async save(entries) {
      await write((s) =>
        s.put({
          key,
          boardId: o.boardId,
          uid: o.uid,
          tab: o.tab,
          entries: [...entries],
          savedAt: Date.now(),
        }),
      )
    },
    async clear() {
      await write((s) => s.delete(key))
    },
    async purge() {
      const db = await dbp
      const all = (await tx(db, 'readonly', (s) => s.getAll())) as QueueRecord[]
      for (const r of all)
        if (r.boardId === o.boardId && r.uid === o.uid) await tx(db, 'readwrite', (s) => s.delete(r.key))
    },
    release() {
      released = true
      releaseLock()
    },
  }
}

/**
 * CRIT-18: deletes every offline queue `uid` left in this browser (every board, every tab), in one
 * transaction; resolves with how many were deleted once it has committed. A queue write a closing board
 * page started before this call is ordered before it (IndexedDB runs overlapping transactions in the
 * order they were made), so it is deleted too. Never logs or returns the queues' content.
 */
export async function purgeOfflineQueuesOf(uid: string, idb: IDBFactory = indexedDB): Promise<number> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = idb.open(DB, 1)
    req.onupgradeneeded = () => {
      const created = req.result
      if (!created.objectStoreNames.contains(STORE)) created.createObjectStore(STORE, { keyPath: 'key' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  try {
    return await new Promise<number>((resolve, reject) => {
      const t = db.transaction(STORE, 'readwrite')
      const s = t.objectStore(STORE)
      let deleted = 0
      const all = s.getAll()
      all.onsuccess = () => {
        for (const r of all.result as QueueRecord[])
          if (r.uid === uid) {
            s.delete(r.key)
            deleted++
          }
      }
      t.oncomplete = () => resolve(deleted)
      t.onabort = () => reject(t.error ?? new Error('offline queue purge aborted'))
      t.onerror = () => reject(t.error ?? new Error('offline queue purge failed'))
    })
  } finally {
    db.close()
  }
}

/** What App.tsx tells the purge about the session: its status and, signed in, who. */
export interface SessionSeen {
  readonly status: 'loading' | 'signed-out' | 'signed-in' | 'unreachable'
  readonly uid: string | null
  /**
   * With `signed-out`: this is the person's own sign-out (the button finished), not a session that ended
   * under them. Only this purges.
   */
  readonly explicit?: boolean
}

/**
 * The session watch App.tsx feeds on every session change (CRIT-18): it remembers who is signed in here,
 * and when that person's own Sign out finishes (`explicit`), their offline queues are purged, once.
 * Nothing else purges: not an expired or revoked session (a 401 anywhere, a board socket's
 * NOT_AUTHENTICATED, a sign-out in another tab), whose unsent edits wait for the same user's next sign-in
 * on this browser; not loading or an unreachable api (the session may well be alive); not another account
 * signing in here, which never reads this user's queue (the records are keyed by user, `load` and
 * `adoptOthers` match the uid) and whose own sign-out purges only its own.
 */
export function createSignOutPurge(
  purge: (uid: string) => Promise<unknown> = (uid) => {
    // and the queues a guest has in this page's memory (./offline-guest.ts), which outlive a board session
    purgeGuestQueuesOf(uid)
    return purgeOfflineQueuesOf(uid)
  },
): (seen: SessionSeen) => void {
  let last: string | null = null
  return (seen) => {
    if (seen.status === 'signed-in') {
      last = seen.uid
      return
    }
    // an expired session is signed-out too: the user stays remembered, so an explicit sign-out that
    // arrives after a 401 raced it still purges
    if (seen.status !== 'signed-out' || !seen.explicit || !last) return
    const uid = last
    last = null
    void purge(uid).catch(() => {
      // no IndexedDB here (a private window that refuses it): there is nothing stored to purge
    })
  }
}
