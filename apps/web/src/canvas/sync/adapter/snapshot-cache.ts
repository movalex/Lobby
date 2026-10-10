/**
 * M6-1 (wave M, PWR-4): this browser's private copy of a board's CONFIRMED server state, so the next open of the
 * board can paint at once (M6-2) and resume as a catch-up instead of a full snapshot (M6-3), and a member can read
 * the board offline (M6-4). It is never a second authority: what it holds is shown read-only and replaced by the
 * room's state at the first welcome, and it is written only from the core's confirmed copies.
 *
 * What is stored, one record per board and user (`<board>|<uid>`, its own database `lobby-board-cache`):
 *  - the engine core's confirmed map ONLY (the server's copies: live elements, and tombstones in the server's own
 *    redacted form, `redactTombstone`): never a pending or local edit, an offline queue entry, a file, presence, a
 *    cursor, or the local content `keepTombstoneContent` keeps under a tombstone;
 *  - no URL: a `data:`, `blob:` or `http(s)://` string anywhere in an element is blanked, and such a record is not
 *    `exact` (it paints, but never seeds a resume: its elements are not the server's copies any more);
 *  - `{epoch, clock, horizon}` of that copy, the ELEMENT_SCHEMA_VERSION and CONTRACTS_REV it was written under (a
 *    record under another revision is dropped, never translated: the lesson of the offline queue's q2: form), when
 *    it was saved, its size, and its convergence hash (canvas-schema hash.ts, the digest the room's test snapshot
 *    hashes to), checked when it is read: a record whose elements no longer hash to it is dropped.
 * Bounded: at most CACHE_MAX_BOARDS records and CACHE_MAX_BYTES in all (least recently saved go first); a board
 * larger than the whole budget is not kept.
 *
 * Never cached: name-only guests (the board session writes only after a welcome that says `guest: false`); a board
 * whose export policy is off for this person; a page opened with `?nocache=1`. Purged (`purge`): a FORBIDDEN or
 * NOT_FOUND close, the board GET answering 403/404, the event stream's access-lost, a trashed board, the export
 * policy turning off for this person; and every record of a user at their own Sign out (`purgeBoardCachesOf`, from
 * offline-idb.ts `createSignOutPurge`).
 *
 * Every IndexedDB call is guarded: no IndexedDB (a private window), a quota error or a broken record makes the
 * cache say "nothing here" and the board opens as before.
 *
 * The pure helpers (cacheElementsOf, cacheHash, sha256Hex, hasUrl) are node-safe; the store is browser-only.
 */
import { redactTombstone } from '@draftroom/canvas-schema/elements'
import { canonicalElementList, hashElements } from '@draftroom/canvas-schema/hash'
import { CONTRACTS_REV, ELEMENT_SCHEMA_VERSION } from '@draftroom/canvas-schema/protocol'
import { compareIndexThenId } from '../index-keys.ts'
import type { SceneElement } from '../types.ts'
import {
  CACHE_BOARDS,
  CACHE_INDEX,
  type cacheConnection,
  cacheDisabledBy,
  cacheKey,
  forgetPreloadedBoardCache,
  pageCacheConnection,
  pageSearch,
  purgeBoardCachesOf,
  readRawRecord,
  takePreloadedBoardCache,
} from './board-cache-db.ts'

export { CACHE_DB, cacheDisabledBy, cacheKey, NOCACHE_PARAM, purgeBoardCachesOf } from './board-cache-db.ts'
/** The most boards kept per browser (every user together). */
export const CACHE_MAX_BOARDS = 20
/** The most bytes kept (JSON size of the elements, every record together). */
export const CACHE_MAX_BYTES = 50 * 1024 * 1024
/** A session writes its board's record at most this often (and when the page is hidden or left). */
export const CACHE_WRITE_MIN_MS = 60_000
/** M6-4: the oldest copy a member is shown offline. */
export const CACHE_OFFLINE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/**
 * M6-3's kill switch: false = paint only (phase 1). The hello then says `since: 0` as before and the room
 * answers with its full snapshot; the cached paint is replaced at that welcome.
 */
export const RESUME_FROM_CACHE = true

/** What a board session hands the store: the core's confirmed copy at one consistent point. */
export interface CacheContent {
  readonly epoch: string
  readonly clock: number
  readonly horizon: number
  /** the confirmed copies, as the core holds them (cacheElementsOf makes them the stored form) */
  readonly elements: Iterable<SceneElement>
}

export interface CachedBoard {
  readonly key: string
  readonly boardId: string
  readonly uid: string
  readonly epoch: string
  readonly clock: number
  readonly horizon: number
  readonly schema: number
  readonly rev: number
  readonly savedAt: number
  readonly bytes: number
  /** hash.ts `hashElements(elements)`, as the room hashes its own copy */
  readonly hash: string
  /** every element is the server's copy as it sent it (no URL blanked): only such a record resumes (M6-3) */
  readonly exact: boolean
  /** in (index, id) order, the order a scene is installed in */
  readonly elements: readonly SceneElement[]
}

interface IndexEntry {
  key: string
  uid: string
  boardId: string
  savedAt: number
  bytes: number
}

// ---- the stored form (pure) -----------------------------------------------------------------------------------

/** A `data:`, `blob:` or `http(s)://` URL in a string. */
const URL_PATTERN = /(?:\bdata:|\bblob:|https?:\/\/)/i
/** The same URLs as whole tokens (to the next white space), for blanking. */
const URL_TOKENS = /(?:\bdata:|\bblob:|https?:\/\/)\S*/gi

/** Whether any string inside `value` holds a URL (the privacy scan of every stored value). */
export function hasUrl(value: unknown): boolean {
  if (typeof value === 'string') return URL_PATTERN.test(value)
  if (Array.isArray(value)) return value.some(hasUrl)
  if (value && typeof value === 'object') return Object.values(value).some(hasUrl)
  return false
}

/**
 * `value` with every URL inside its strings blanked (a note's other words stay, a link field becomes ''), and
 * whether any was.
 */
function withoutUrls(value: unknown): { value: unknown; blanked: boolean } {
  if (typeof value === 'string')
    return URL_PATTERN.test(value)
      ? { value: value.replace(URL_TOKENS, ''), blanked: true }
      : { value, blanked: false }
  if (Array.isArray(value)) {
    let blanked = false
    const out = value.map((v) => {
      const r = withoutUrls(v)
      blanked ||= r.blanked
      return r.value
    })
    return { value: out, blanked }
  }
  if (value && typeof value === 'object') {
    let blanked = false
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      const r = withoutUrls(v)
      blanked ||= r.blanked
      out[k] = r.value
    }
    return { value: out, blanked }
  }
  return { value, blanked: false }
}

/**
 * The stored form of the core's confirmed copies: each tombstone in the server's redacted form (whatever content
 * this tab kept under it), every live element as a plain copy, no URL anywhere; in (index, id) order. `exact`:
 * nothing had to be blanked, so these are the server's copies exactly.
 */
export function cacheElementsOf(confirmed: Iterable<SceneElement>): {
  elements: SceneElement[]
  exact: boolean
} {
  let exact = true
  const out: SceneElement[] = []
  for (const el of confirmed) {
    const base = el.isDeleted === true ? (redactTombstone(el as never) as unknown as SceneElement) : el
    const r = withoutUrls(JSON.parse(JSON.stringify(base)))
    if (r.blanked) exact = false
    out.push(r.value as SceneElement)
  }
  out.sort(compareIndexThenId)
  return { elements: out, exact }
}

// SHA-256 (FIPS 180-4), synchronous: a record written in `pagehide` must start its IndexedDB write in that task,
// so its hash cannot wait for WebCrypto. Its input is hash.ts's own (`canonicalElementList`), so the digest is
// exactly `hashElements` (snapshot-cache.test.ts checks it), which the read verifies with.
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
])

/** The lowercase hex SHA-256 of `text`'s UTF-8. */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text)
  const n = bytes.length
  const size = (((n + 9 + 63) / 64) | 0) * 64
  const buf = new Uint8Array(size)
  buf.set(bytes)
  buf[n] = 0x80
  const view = new DataView(buf.buffer)
  view.setUint32(size - 8, Math.floor(n / 0x20000000))
  view.setUint32(size - 4, (n * 8) >>> 0)
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const w = new Uint32Array(64)
  const rotr = (x: number, r: number) => (x >>> r) | (x << (32 - r))
  for (let off = 0; off < size; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15] as number
      const y = w[i - 2] as number
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) | 0
    }
    let a = h[0] as number
    let b = h[1] as number
    let c = h[2] as number
    let d = h[3] as number
    let e = h[4] as number
    let f = h[5] as number
    let g = h[6] as number
    let k = h[7] as number
    for (let i = 0; i < 64; i++) {
      const t1 =
        (k +
          (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) +
          ((e & f) ^ (~e & g)) +
          (K256[i] as number) +
          (w[i] as number)) |
        0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0
      k = g
      g = f
      f = e
      e = (d + t1) | 0
      d = c
      c = b
      b = a
      a = (t1 + t2) | 0
    }
    h[0] = (h[0] as number) + a
    h[1] = (h[1] as number) + b
    h[2] = (h[2] as number) + c
    h[3] = (h[3] as number) + d
    h[4] = (h[4] as number) + e
    h[5] = (h[5] as number) + f
    h[6] = (h[6] as number) + g
    h[7] = (h[7] as number) + k
  }
  let hex = ''
  for (const v of h) hex += v.toString(16).padStart(8, '0')
  return hex
}

/** hash.ts `hashElements(elements)`, computed synchronously. */
export const cacheHash = (elements: Iterable<Readonly<Record<string, unknown>>>): string =>
  sha256Hex(canonicalElementList(elements))

/** The record a write stores (pure; null when the elements alone are over the whole budget). */
export function cacheRecordOf(
  boardId: string,
  uid: string,
  content: CacheContent,
  savedAt: number,
  maxBytes: number = CACHE_MAX_BYTES,
): CachedBoard | null {
  const { elements, exact } = cacheElementsOf(content.elements)
  const bytes = JSON.stringify(elements).length
  if (bytes > maxBytes) return null
  return {
    key: cacheKey(boardId, uid),
    boardId,
    uid,
    epoch: content.epoch,
    clock: content.clock,
    horizon: content.horizon,
    schema: ELEMENT_SCHEMA_VERSION,
    rev: CONTRACTS_REV,
    savedAt,
    bytes,
    hash: cacheHash(elements),
    exact,
    elements,
  }
}

/**
 * M6-3: whether the first welcome after a cached paint makes the stored copy one to drop: the room is in another
 * epoch (the board was restored meanwhile; the resume, if any, was answered with the reset path). The room's own
 * state is written in its place once the session has it. Pure.
 */
export function cacheDroppedAtWelcome(
  shown: { readonly epoch: string } | null,
  welcome: { readonly epoch: string },
  resume: 'catch-up' | 'reset' | 'epoch' | null,
): boolean {
  if (!shown) return false
  return resume === 'epoch' || shown.epoch !== welcome.epoch
}

/** Whether a stored value is a record of this build's form for `boardId` and `uid` (anything else is dropped). */
export function isCurrentRecord(r: unknown, boardId: string, uid: string): r is CachedBoard {
  if (!r || typeof r !== 'object') return false
  const x = r as Partial<CachedBoard>
  return (
    x.key === cacheKey(boardId, uid) &&
    x.boardId === boardId &&
    x.uid === uid &&
    x.rev === CONTRACTS_REV &&
    x.schema === ELEMENT_SCHEMA_VERSION &&
    typeof x.epoch === 'string' &&
    typeof x.clock === 'number' &&
    Number.isFinite(x.clock) &&
    x.clock >= 0 &&
    typeof x.horizon === 'number' &&
    typeof x.savedAt === 'number' &&
    typeof x.hash === 'string' &&
    typeof x.exact === 'boolean' &&
    Array.isArray(x.elements)
  )
}

// ---- the store (browser) --------------------------------------------------------------------------------------

export interface BoardCacheStore {
  /** this user's record of the board, verified (rev, schema, hash); null when there is none (or it was dropped) */
  read(boardId: string, uid: string): Promise<CachedBoard | null>
  /** checks a stored value read elsewhere (the route's early read): the record, or null (a bad one is dropped) */
  verify(raw: unknown, boardId: string, uid: string): Promise<CachedBoard | null>
  /** stores the confirmed copy (its IndexedDB write starts in this call once the database is open); false: not kept */
  write(boardId: string, uid: string, content: CacheContent): Promise<boolean>
  /** drops this user's record of the board */
  purge(boardId: string, uid: string): Promise<void>
  /** drops every record of this user; resolves with how many */
  purgeUser(uid: string): Promise<number>
}

export interface BoardCacheOptions {
  /** the database connection (default: the page's, board-cache-db.ts) */
  readonly connection?: ReturnType<typeof cacheConnection>
  readonly now?: () => number
  /** the bounds (tests); default CACHE_MAX_BOARDS and CACHE_MAX_BYTES */
  readonly maxBoards?: number
  readonly maxBytes?: number
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

/**
 * One read-write transaction over both stores: `fn` makes its requests synchronously; resolves once committed.
 */
function writeTx(
  db: IDBDatabase,
  fn: (boards: IDBObjectStore, index: IDBObjectStore) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    try {
      const t = db.transaction([CACHE_BOARDS, CACHE_INDEX], 'readwrite')
      t.oncomplete = () => resolve()
      t.onabort = () => reject(t.error ?? new Error('board cache write aborted'))
      t.onerror = () => reject(t.error ?? new Error('board cache write failed'))
      fn(t.objectStore(CACHE_BOARDS), t.objectStore(CACHE_INDEX))
      // no further request comes: commit now rather than when this task ends
      ;(t as IDBTransaction & { commit?: () => void }).commit?.()
    } catch (err) {
      reject(err)
    }
  })
}

const readIndex = (db: IDBDatabase): Promise<IndexEntry[]> =>
  request(db.transaction(CACHE_INDEX, 'readonly').objectStore(CACHE_INDEX).getAll()) as Promise<IndexEntry[]>

export function createBoardCacheStore(o: BoardCacheOptions = {}): BoardCacheStore {
  const conn = o.connection ?? pageCacheConnection()
  const now = o.now ?? (() => Date.now())
  const maxBoards = o.maxBoards ?? CACHE_MAX_BOARDS
  const maxBytes = o.maxBytes ?? CACHE_MAX_BYTES
  const safely = async <T>(fallback: T, fn: (db: IDBDatabase) => Promise<T>): Promise<T> => {
    try {
      const db = await conn.get()
      return db ? await fn(db) : fallback
    } catch {
      return fallback
    }
  }
  const remove = (db: IDBDatabase, keys: readonly string[]) =>
    writeTx(db, (boards, index) => {
      for (const k of keys) {
        boards.delete(k)
        index.delete(k)
      }
    })

  /** Keeps the newest records within CACHE_MAX_BOARDS and CACHE_MAX_BYTES (least recently saved go first). */
  const evict = async (db: IDBDatabase, keep: string) => {
    const all = await readIndex(db)
    all.sort((a, b) => b.savedAt - a.savedAt || (a.key === keep ? -1 : b.key === keep ? 1 : 0))
    let bytes = 0
    let kept = 0
    const drop: string[] = []
    for (const e of all) {
      bytes += e.bytes
      kept++
      if (e.key !== keep && (kept > maxBoards || bytes > maxBytes)) {
        drop.push(e.key)
        bytes -= e.bytes
        kept--
      }
    }
    if (drop.length) await remove(db, drop)
  }

  const verify = async (raw: unknown, boardId: string, uid: string): Promise<CachedBoard | null> => {
    if (raw === undefined || raw === null) return null
    const key = cacheKey(boardId, uid)
    const drop = () => safely(undefined, (db) => remove(db, [key])).then(() => null)
    // another revision's form, or a broken record: dropped, never translated
    if (!isCurrentRecord(raw, boardId, uid)) return drop()
    // the convergence hash (hash.ts) of what was stored: anything else is not the copy that was written
    const digest = await hashElements(raw.elements).catch(() => null)
    if (digest !== raw.hash) return drop()
    return raw
  }

  return {
    read: (boardId, uid) =>
      safely(null, async (db) => verify(await readRawRecord(db, cacheKey(boardId, uid)), boardId, uid)),
    verify: (raw, boardId, uid) => verify(raw, boardId, uid).catch(() => null),
    write: (boardId, uid, content) => {
      let record: CachedBoard | null
      try {
        record = cacheRecordOf(boardId, uid, content, now(), maxBytes)
      } catch {
        return Promise.resolve(false)
      }
      const put = async (db: IDBDatabase): Promise<boolean> => {
        if (!record) {
          // over the whole budget: not kept (and an older copy of it is not left either)
          await remove(db, [cacheKey(boardId, uid)])
          return false
        }
        const r = record
        const entry: IndexEntry = { key: r.key, uid, boardId, savedAt: r.savedAt, bytes: r.bytes }
        await writeTx(db, (boards, index) => {
          boards.put(r)
          index.put(entry)
        })
        await evict(db, r.key).catch(() => {})
        return true
      }
      // the database already open: the transaction starts in this call (a write in `pagehide` must)
      const open = conn.opened()
      if (open) return put(open).catch(() => false)
      return safely(false, put)
    },
    purge: (boardId, uid) =>
      safely(undefined, async (db) => {
        await remove(db, [cacheKey(boardId, uid)])
      }),
    purgeUser: (uid) => purgeBoardCachesOf(uid, conn),
  }
}

// ---- the page's store and reads -------------------------------------------------------------------------------

let pageStore: BoardCacheStore | null = null
/** This page's store (on the page's connection). */
export function boardCache(): BoardCacheStore {
  pageStore ??= createBoardCacheStore()
  return pageStore
}

/** Tests: a page store over another database (null: back to the default). */
export function setBoardCacheForTests(store: BoardCacheStore | null): void {
  pageStore = store
  reads.clear()
}

/** A read of the cache for one open; `value` is set once it has answered (null: nothing to show). */
export interface CacheRead {
  readonly boardId: string
  readonly uid: string
  /** undefined while the read is under way */
  value: CachedBoard | null | undefined
  readonly done: Promise<CachedBoard | null>
  /** an access loss came first: this read's record is never shown */
  cancelled: boolean
}

const reads = new Map<string, CacheRead>()

/**
 * The board page takes this open's read once (the route's early read, board-cache-db.ts `preloadBoardCache`, or a
 * read started now), checked. Null with `?nocache=1`. A later open of the board reads again.
 */
export function takeBoardCache(boardId: string, uid: string): CacheRead | null {
  if (cacheDisabledBy(pageSearch())) return null
  const key = cacheKey(boardId, uid)
  const early = takePreloadedBoardCache(boardId, uid)
  const store = boardCache()
  const read: CacheRead = {
    boardId,
    uid,
    value: undefined,
    cancelled: false,
    done: (early ? early.then((raw) => store.verify(raw, boardId, uid)) : store.read(boardId, uid))
      .catch(() => null)
      .then((r) => {
        const v = read.cancelled ? null : r
        read.value = v
        if (reads.get(key) === read) reads.delete(key)
        return v
      }),
  }
  reads.set(key, read)
  return read
}

/** Access to the board is gone (or the board is trashed): its record goes, and a read under way shows nothing. */
export function purgeBoardCache(boardId: string, uid: string): Promise<void> {
  const key = cacheKey(boardId, uid)
  forgetPreloadedBoardCache(boardId, uid)
  const r = reads.get(key)
  if (r) {
    r.cancelled = true
    r.value = null
    reads.delete(key)
  }
  return boardCache().purge(boardId, uid)
}
