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
  // (listening from now on: a Sign out in another tab forgets this read)
  pageSignOutMarks()
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
//
// The W6 review (M6-1): a Sign out in one tab must stay a Sign out in every tab of the browser. Another tab of the
// same user may still have the board open with a copy it has not written yet: its next idle, hidden-page or
// dispose-time write would put the board back after the purge. So the Sign out leaves a mark, `uid` signed out at
// <time>, before it deletes anything: in localStorage (every page of the origin sees it, now and after a restart),
// and told at once to the other pages (a BroadcastChannel message; another page also gets localStorage's `storage`
// event). A board session that started before the mark writes nothing again (snapshot-cache.ts
// `cacheWriteGate`), the store refuses its writes, and a record saved before the mark is dropped, never shown
// (`verify`). A session started after it (the same person signing in again) writes as usual.

/** localStorage: `<prefix><uid>` = the time (ms) of that user's latest Sign out in this browser. */
export const SIGNED_OUT_PREFIX = 'lobby-board-cache:signed-out:'
/** The BroadcastChannel a Sign out is told to the browser's other pages on. */
export const CACHE_CHANNEL = 'lobby-board-cache'

/** The part of a BroadcastChannel used here. */
export interface CacheChannelLike {
  postMessage(message: unknown): void
  close(): void
  onmessage: ((ev: { readonly data: unknown }) => void) | null
}

/** This browser's Sign out marks, every tab together. */
export interface SignOutMarks {
  /** when `uid` last signed out in this browser (any tab), as far as this page knows; null: never */
  at(uid: string): number | null
  /** this page's Sign out of `uid` at `at`: kept (localStorage), told to the other pages and this page's listeners */
  note(uid: string, at: number): void
  /** `fn(uid, at)` on each Sign out heard (this page's or another's), once per mark; returns the unsubscribe */
  subscribe(fn: (uid: string, at: number) => void): () => void
}

export interface SignOutMarksOptions {
  /** default: the page's localStorage (none: the marks live in this page and on the channel only) */
  readonly storage?: () => Pick<Storage, 'getItem' | 'setItem'> | null | undefined
  /** default: `new BroadcastChannel(CACHE_CHANNEL)` (none: localStorage and its `storage` event only) */
  readonly channel?: () => CacheChannelLike | null | undefined
  /** default: the window's `storage` events (another page wrote localStorage) */
  readonly storageEvents?: (fn: (key: string | null, value: string | null) => void) => () => void
}

const defaultStorage = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

const defaultChannel = (): CacheChannelLike | null => {
  try {
    return typeof BroadcastChannel === 'undefined'
      ? null
      : (new BroadcastChannel(CACHE_CHANNEL) as unknown as CacheChannelLike)
  } catch {
    return null
  }
}

const defaultStorageEvents = (fn: (key: string | null, value: string | null) => void): (() => void) => {
  try {
    const w = globalThis as unknown as {
      addEventListener?: (t: string, l: (e: { key: string | null; newValue: string | null }) => void) => void
      removeEventListener?: (
        t: string,
        l: (e: { key: string | null; newValue: string | null }) => void,
      ) => void
    }
    if (typeof w.addEventListener !== 'function') return () => {}
    const l = (e: { key: string | null; newValue: string | null }) => fn(e.key, e.newValue)
    w.addEventListener('storage', l)
    return () => w.removeEventListener?.('storage', l)
  } catch {
    return () => {}
  }
}

const markTime = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : Number.NaN
  return Number.isFinite(n) ? n : null
}

/** A page's view of the Sign out marks (the page has one, `pageSignOutMarks`; tests make several: "tabs"). */
export function createSignOutMarks(o: SignOutMarksOptions = {}): SignOutMarks {
  const storage = o.storage ?? defaultStorage
  const known = new Map<string, number>()
  const listeners = new Set<(uid: string, at: number) => void>()
  let channel: CacheChannelLike | null | undefined
  let watching = false
  /** a mark this page had not heard yet: kept, and its listeners told */
  const heard = (uid: string, at: number) => {
    if (!uid || (known.get(uid) ?? Number.NEGATIVE_INFINITY) >= at) return
    known.set(uid, at)
    for (const fn of [...listeners])
      try {
        fn(uid, at)
      } catch {}
  }
  const watch = () => {
    if (watching) return
    watching = true
    try {
      channel = (o.channel ?? defaultChannel)() ?? null
    } catch {
      channel = null
    }
    if (channel)
      channel.onmessage = (ev) => {
        const d = ev.data as { type?: unknown; uid?: unknown; at?: unknown } | null
        const at = markTime(d?.at)
        if (d && d.type === 'signed-out' && typeof d.uid === 'string' && at !== null) heard(d.uid, at)
      }
    try {
      ;(o.storageEvents ?? defaultStorageEvents)((key, value) => {
        const at = markTime(value)
        if (key?.startsWith(SIGNED_OUT_PREFIX) && at !== null) heard(key.slice(SIGNED_OUT_PREFIX.length), at)
      })
    } catch {}
  }
  return {
    at(uid) {
      let stored: number | null = null
      try {
        stored = markTime(storage()?.getItem(SIGNED_OUT_PREFIX + uid))
      } catch {
        stored = null
      }
      const mine = known.get(uid) ?? null
      if (stored === null) return mine
      return mine === null ? stored : Math.max(mine, stored)
    },
    note(uid, at) {
      watch()
      // kept first (a page that misses the message still sees it), then told
      try {
        const prev = markTime(storage()?.getItem(SIGNED_OUT_PREFIX + uid))
        if (prev === null || prev < at) storage()?.setItem(SIGNED_OUT_PREFIX + uid, String(at))
      } catch {}
      try {
        channel?.postMessage({ type: 'signed-out', uid, at })
      } catch {}
      heard(uid, at)
    },
    subscribe(fn) {
      watch()
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}

let pageMarks: SignOutMarks | null = null
/** This page's Sign out marks; a Sign out heard from another page also forgets the route's early reads. */
export function pageSignOutMarks(): SignOutMarks {
  if (!pageMarks) {
    const m = createSignOutMarks()
    m.subscribe((uid) => forgetPreloadsOf(uid))
    pageMarks = m
  }
  return pageMarks
}

/** Tests: the page's marks (null: back to the default, made on first use). */
export function setPageSignOutMarksForTests(m: SignOutMarks | null): void {
  pageMarks = m
}

/** Whether `uid` signed out in this browser at or after `since` (a session's start): nothing of theirs is kept. */
export function signedOutSince(
  uid: string,
  since: number,
  marks: SignOutMarks = pageSignOutMarks(),
): boolean {
  const at = marks.at(uid)
  return at !== null && at >= since
}

function forgetPreloadsOf(uid: string): void {
  for (const k of [...preloads.keys()]) if (k.endsWith(`|${uid}`)) preloads.delete(k)
}

/**
 * The person's own Sign out (CRIT-18's companion): marks `uid` signed out in this browser (every tab: see above),
 * then deletes every board copy `uid` has in it, in one transaction; resolves with how many. Never rejects (no
 * IndexedDB: nothing stored to delete). Never reads or returns their content.
 */
export async function purgeBoardCachesOf(
  uid: string,
  connection: ReturnType<typeof cacheConnection> = pageCacheConnection(),
  marks: SignOutMarks = pageSignOutMarks(),
  at: number = Date.now(),
): Promise<number> {
  // before any delete starts: a write another tab makes after this purge's transaction sees the mark
  try {
    marks.note(uid, at)
  } catch {}
  forgetPreloadsOf(uid)
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
      // and any index entry of theirs left without its record
      const entries = index.getAllKeys()
      entries.onsuccess = () => {
        for (const k of entries.result.map(String)) if (k.endsWith(`|${uid}`)) index.delete(k)
      }
      t.oncomplete = () => resolve(deleted)
      t.onabort = () => reject(t.error ?? new Error('board cache purge aborted'))
      t.onerror = () => reject(t.error ?? new Error('board cache purge failed'))
    })
  } catch {
    return 0
  }
}
