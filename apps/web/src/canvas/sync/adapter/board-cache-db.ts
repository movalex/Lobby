/**
 * M6-1 (wave M): the board cache's database, and the light half of the cache that the app's first bundle loads
 * (./snapshot-cache.ts has the rest, in the board page's chunk): opening the database, the early read the board
 * route starts (`preloadBoardCache`, before the board code has arrived), and the Sign out purge
 * (`purgeBoardCachesOf`, from ./offline-idb.ts `createSignOutPurge`). No canvas-schema import here, so none of
 * it reaches the first bundle.
 *
 * Every call is guarded: no IndexedDB (a private window), a blocked open or a failed request means "no cache".
 *
 * Browser only.
 */

export const CACHE_DB = 'lobby-board-cache'
export const CACHE_BOARDS = 'boards'
export const CACHE_INDEX = 'index'
/** `?nocache=1` on a board URL: no cache read, paint, resume or write for that page (diagnosis). */
export const NOCACHE_PARAM = 'nocache'

/** A record's key: one per board and user. */
export const cacheKey = (boardId: string, uid: string): string => `${boardId}|${uid}`

/** Whether `search` (a page's `location.search`) turns the cache off (`?nocache=1`). */
export function cacheDisabledBy(search: string | undefined): boolean {
  if (!search) return false
  try {
    return new URLSearchParams(search).get(NOCACHE_PARAM) === '1'
  } catch {
    return false
  }
}

export const pageSearch = (): string | undefined => {
  try {
    return globalThis.location?.search
  } catch {
    return undefined
  }
}

const defaultIdb = (): IDBFactory | null => {
  try {
    return typeof indexedDB === 'undefined' ? null : indexedDB
  } catch {
    return null
  }
}

/** Opens (and creates) the database; null when there is no IndexedDB or it cannot be opened. */
export function openCacheDb(idb: IDBFactory | null | undefined): Promise<IDBDatabase | null> {
  return new Promise<IDBDatabase | null>((resolve) => {
    if (!idb) {
      resolve(null)
      return
    }
    try {
      const req = idb.open(CACHE_DB, 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(CACHE_BOARDS))
          db.createObjectStore(CACHE_BOARDS, { keyPath: 'key' })
        if (!db.objectStoreNames.contains(CACHE_INDEX)) db.createObjectStore(CACHE_INDEX, { keyPath: 'key' })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

/**
 * A connection kept open for the page (so a write in `pagehide` starts its transaction in its call), opened
 * again after another page upgrades or deletes the database. `opened()` is the open one, if any.
 */
export function cacheConnection(idb: () => IDBFactory | null | undefined = defaultIdb): {
  get(): Promise<IDBDatabase | null>
  opened(): IDBDatabase | null
} {
  let pending: Promise<IDBDatabase | null> | null = null
  let db: IDBDatabase | null = null
  return {
    get() {
      if (db) return Promise.resolve(db)
      if (pending) return pending
      let factory: IDBFactory | null | undefined
      try {
        factory = idb()
      } catch {
        factory = null
      }
      const p = openCacheDb(factory).then((d) => {
        if (pending === p) pending = null
        if (!d) return null
        db = d
        d.onversionchange = () => {
          try {
            d.close()
          } catch {}
          if (db === d) db = null
        }
        return d
      })
      pending = p
      return p
    },
    opened: () => db,
  }
}

let page: ReturnType<typeof cacheConnection> | null = null
/** This page's connection. */
export function pageCacheConnection(): ReturnType<typeof cacheConnection> {
  page ??= cacheConnection()
  return page
}

/** Tests: the page's connection over another IndexedDB (null: back to the default). */
export function setPageCacheConnectionForTests(c: ReturnType<typeof cacheConnection> | null): void {
  page = c
  preloads.clear()
}

/** The stored value under `key` (undefined: none), unchecked. */
export function readRawRecord(db: IDBDatabase, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    try {
      const r = db.transaction(CACHE_BOARDS, 'readonly').objectStore(CACHE_BOARDS).get(key)
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => reject(r.error)
    } catch (err) {
      reject(err)
    }
  })
}

// ---- the board route's early read ---------------------------------------------------------------------------

const preloads = new Map<string, Promise<unknown>>()

/**
 * K1-2's companion (wave M): the board route starts reading this user's copy of the board as soon as it renders
 * with a session, so the read runs while the board code, the board and its ticket load. Unchecked here: the board
 * page's chunk checks the record (./snapshot-cache.ts `takeBoardCache`). Nothing with `?nocache=1`.
 */
export function preloadBoardCache(boardId: string, uid: string): void {
  if (cacheDisabledBy(pageSearch())) return
  const key = cacheKey(boardId, uid)
  if (preloads.has(key)) return
  preloads.set(
    key,
    pageCacheConnection()
      .get()
      .then((db) => (db ? readRawRecord(db, key) : undefined))
      .catch(() => undefined),
  )
}

/** The early read of this open, taken once (null: none was started). */
export function takePreloadedBoardCache(boardId: string, uid: string): Promise<unknown> | null {
  const key = cacheKey(boardId, uid)
  const p = preloads.get(key) ?? null
  preloads.delete(key)
  return p
}

/** An early read whose record must never be shown (access lost, Sign out). */
export function forgetPreloadedBoardCache(boardId: string, uid: string): void {
  preloads.delete(cacheKey(boardId, uid))
}

// ---- Sign out ---------------------------------------------------------------------------------------------------

/**
 * The person's own Sign out (CRIT-18's companion): deletes every board copy `uid` has in this browser, in one
 * transaction; resolves with how many. Never rejects (no IndexedDB: nothing stored to delete). Never reads or
 * returns their content.
 */
export async function purgeBoardCachesOf(
  uid: string,
  connection: ReturnType<typeof cacheConnection> = pageCacheConnection(),
): Promise<number> {
  for (const k of [...preloads.keys()]) if (k.endsWith(`|${uid}`)) preloads.delete(k)
  try {
    const db = await connection.get()
    if (!db) return 0
    return await new Promise<number>((resolve, reject) => {
      const t = db.transaction([CACHE_BOARDS, CACHE_INDEX], 'readwrite')
      const boards = t.objectStore(CACHE_BOARDS)
      const index = t.objectStore(CACHE_INDEX)
      let deleted = 0
      const keys = boards.getAllKeys()
      keys.onsuccess = () => {
        for (const k of keys.result.map(String))
          if (k.endsWith(`|${uid}`)) {
            boards.delete(k)
            index.delete(k)
            deleted++
          }
      }
      t.oncomplete = () => resolve(deleted)
      t.onabort = () => reject(t.error ?? new Error('board cache purge aborted'))
      t.onerror = () => reject(t.error ?? new Error('board cache purge failed'))
    })
  } catch {
    return 0
  }
}
