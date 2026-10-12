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
 *    it was saved, its size and element count, and the SHA-256 of its stored text, checked when it is read: a record
 *    whose text no longer hashes to it is dropped.
 * The elements are stored as one JSON text (the W6 review: a record of plain objects cost a whole-board deep copy,
 * a scan, a canonical stringify and a structured clone per write, 0.7 s for 5,000 elements at CPU 4x): one
 * stringify (a second, blanking, only when the text holds a URL), one hash, and a string IndexedDB stores as is.
 * Bounded: at most CACHE_MAX_BOARDS records and CACHE_MAX_BYTES in all (least recently used go first: a record's
 * last read for an open, or its save); a board larger than the whole budget is not kept.
 *
 * Never cached: name-only guests (the board session writes only after a welcome that says `guest: false`); a board
 * whose export policy is off for this person; a page opened with `?nocache=1`. Purged (`purge`): a FORBIDDEN or
 * NOT_FOUND close, the board GET answering 403/404, the event stream's access-lost, a trashed board, the export
 * policy turning off for this person; and every record of a user at their own Sign out (`purgeBoardCachesOf`, from
 * offline-idb.ts `createSignOutPurge`). That Sign out holds in every tab of the browser (the W6 review): it leaves
 * a mark (board-cache-db.ts `SignOutMarks`) that every session started before it obeys (`cacheWriteGate`: it
 * writes nothing again), that the store's writes check (`write`'s `startedAt`), and under which a record saved
 * before it is dropped, never shown (`verify`).
 *
 * Every IndexedDB call is guarded: no IndexedDB (a private window), a quota error or a broken record makes the
 * cache say "nothing here" and the board opens as before.
 *
 * Known limits (the W6 review): a viewer's copy written while the export policy let them export stays on the device
 * until a page of this browser learns the policy is off (an open of the board, or its event stream while open);
 * the offline read (M6-4), which cannot ask, may show it for up to CACHE_OFFLINE_MAX_AGE_MS after the owner turned
 * exporting off. A copy that had a URL blanked (a link, an address typed in a note) paints but never resumes, and the
 * offline copy says its links are not kept. A warm open's socket names the cached clock in its hello like a
 * reconnect, so the room's reconnect counters count it as one.
 *
 * The pure helpers (cacheJsonOf, cacheElementsOf, storedRecordOf, cacheRecordOf, sha256Hex, sha256HexOf, hasUrl) are
 * node-safe; the store is browser-only.
 */
import { redactTombstone } from '@draftroom/canvas-schema/elements'
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
  pageSignOutMarks,
  purgeBoardCachesOf,
  readRawRecord,
  type SignOutMarks,
  signedOutSince,
  takePreloadedBoardCache,
} from './board-cache-db.ts'

export { CACHE_DB, cacheDisabledBy, cacheKey, NOCACHE_PARAM, purgeBoardCachesOf } from './board-cache-db.ts'
/** The most boards kept per browser (every user together). */
export const CACHE_MAX_BOARDS = 20
/** The most bytes kept (JSON size of the elements, every record together). */
export const CACHE_MAX_BYTES = 50 * 1024 * 1024
/** A session writes its board's record at most this often (and when the page is hidden or left). */
export const CACHE_WRITE_MIN_MS = 60_000
/**
 * The first welcome after a cached paint that brought nothing new (the same epoch and clock) writes no record when
 * the stored one is younger than this (the W6 review: a write is a whole-board clone, scan and hash); an older one
 * is written again, so its time (the offline copy's "from <time>", the 7-day rule) stays near the truth.
 */
export const CACHE_UNCHANGED_REFRESH_MS = 24 * 60 * 60 * 1000
/** M6-4: the oldest copy a member is shown offline. */
export const CACHE_OFFLINE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/**
 * M6-3's kill switch: false = paint only (phase 1). The hello then says `since: 0` as before and the room
 * answers with its full snapshot; the cached paint is replaced at that welcome.
 *
 * OFF (wave M round 1 refix): a resume cannot prove its lineage. A disk-snapshot restore of the sync (DEPLOY.md)
 * keeps each board's epoch and rolls its clock back; once new writes take the clock past a cached copy's, that
 * copy's hello is answered as a catch-up and the page keeps rows the room does not have, for good
 * (cache-resume.test.ts). Turn it on only with a lineage check in the hello, or a restore step that rotates epochs.
 */
export const RESUME_FROM_CACHE = false

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
  /** the stored text's length */
  readonly bytes: number
  readonly count: number
  /** the SHA-256 (hex) of the stored text */
  readonly hash: string
  /** every element is the server's copy as it sent it (no URL blanked): only such a record resumes (M6-3) */
  readonly exact: boolean
  /** in (index, id) order, the order a scene is installed in */
  readonly elements: readonly SceneElement[]
}

/** The record as IndexedDB holds it: a CachedBoard whose elements are one JSON text. */
export interface StoredBoard extends Omit<CachedBoard, 'elements'> {
  /** the elements, in (index, id) order, as one JSON array */
  readonly json: string
}

interface IndexEntry {
  key: string
  uid: string
  boardId: string
  savedAt: number
  bytes: number
  /** when the record was last read for an open (the LRU's "use"; absent: never since it was saved) */
  usedAt?: number
}

/** The LRU's last use of a record: its last read for an open, or its save. */
const lastUse = (e: IndexEntry): number => Math.max(e.savedAt, e.usedAt ?? Number.NEGATIVE_INFINITY)

// ---- the stored form (pure) -----------------------------------------------------------------------------------

/** A `data:`, `blob:` or `http(s)://` URL in a string. */
const URL_PATTERN = /(?:\bdata:|\bblob:|https?:\/\/)/i
/**
 * The stored text's quick check: any such scheme anywhere, word boundary or not (a superset of URL_PATTERN's
 * matches: in JSON text an escape such as `\n` puts a letter before `data:`, which URL_PATTERN's `\b` would miss).
 */
const URL_ANYWHERE = /data:|blob:|https?:\/\//i
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
 * The stored text of the core's confirmed copies: each tombstone in the server's redacted form (whatever content
 * this tab kept under it), every live element as it is, no URL anywhere (a note's other words stay, a link field
 * becomes ''), as one JSON array in (index, id) order. `exact`: nothing had to be blanked, so these are the server's
 * copies exactly. One stringify; a second, blanking string by string, only when the text may hold a URL (only a
 * string value can: no key or number has one).
 */
export function cacheJsonOf(confirmed: Iterable<SceneElement>): {
  json: string
  exact: boolean
  count: number
} {
  const bases: SceneElement[] = []
  for (const el of confirmed)
    bases.push(el.isDeleted === true ? (redactTombstone(el as never) as unknown as SceneElement) : el)
  bases.sort(compareIndexThenId)
  let json = JSON.stringify(bases)
  let exact = true
  if (URL_ANYWHERE.test(json))
    json = JSON.stringify(bases, (_key, value: unknown) => {
      if (typeof value !== 'string' || !URL_PATTERN.test(value)) return value
      exact = false
      return value.replace(URL_TOKENS, '')
    })
  return { json, exact, count: bases.length }
}

/** The stored form as elements (`cacheJsonOf`'s text, parsed). */
export function cacheElementsOf(confirmed: Iterable<SceneElement>): {
  elements: SceneElement[]
  exact: boolean
} {
  const { json, exact } = cacheJsonOf(confirmed)
  return { elements: JSON.parse(json) as SceneElement[], exact }
}

// SHA-256 (FIPS 180-4), synchronous: a record written in `pagehide` must start its IndexedDB write in that task,
// so its hash cannot wait for WebCrypto; and the read checks with it too, so an http origin that is not localhost
// (no crypto.subtle: the NAS rehearsal over the LAN) reads its records like any other.
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

/** The record a write stores (pure; null when its text alone is over the whole budget). */
export function storedRecordOf(
  boardId: string,
  uid: string,
  content: CacheContent,
  savedAt: number,
  maxBytes: number = CACHE_MAX_BYTES,
): StoredBoard | null {
  const { json, exact, count } = cacheJsonOf(content.elements)
  if (json.length > maxBytes) return null
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
    bytes: json.length,
    count,
    hash: sha256Hex(json),
    exact,
    json,
  }
}

/**
 * The same digest for a READ (wave N.1): WebCrypto's where the page has it (native, off the main thread: the
 * synchronous digest of a 10k board's 6.5 MB text was about 200 ms of the warm open's main thread at CPU 4x, on the
 * way to its paint), else `sha256Hex`, so an http origin that is not localhost (no `crypto.subtle`) reads its records
 * like any other, and a WebCrypto that throws (the W6 review: hash.ts's dropped every record) falls back to it too.
 * A write keeps the synchronous digest (`pagehide` must start its transaction in that task). Never rejects.
 */
export async function sha256HexOf(text: string): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle
  if (subtle && typeof subtle.digest === 'function') {
    try {
      const d = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(text)))
      let hex = ''
      for (const b of d) hex += b.toString(16).padStart(2, '0')
      return hex
    } catch {
      // the synchronous digest below
    }
  }
  return sha256Hex(text)
}

/** A stored record as the board page uses it (its text parsed); null when the text is not its elements. */
export function boardOfStored(r: StoredBoard): CachedBoard | null {
  let elements: unknown
  try {
    elements = JSON.parse(r.json)
  } catch {
    return null
  }
  if (!Array.isArray(elements) || elements.length !== r.count) return null
  const { json: _json, ...meta } = r
  return { ...meta, elements: elements as SceneElement[] }
}

/** The record a write would store, as the board page reads it back (pure; tests and the core's test helpers). */
export function cacheRecordOf(
  boardId: string,
  uid: string,
  content: CacheContent,
  savedAt: number,
  maxBytes: number = CACHE_MAX_BYTES,
): CachedBoard | null {
  const stored = storedRecordOf(boardId, uid, content, savedAt, maxBytes)
  return stored ? boardOfStored(stored) : null
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
export function isCurrentRecord(r: unknown, boardId: string, uid: string): r is StoredBoard {
  if (!r || typeof r !== 'object') return false
  const x = r as Partial<StoredBoard>
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
    typeof x.count === 'number' &&
    typeof x.json === 'string'
  )
}

// ---- the store (browser) --------------------------------------------------------------------------------------

export interface BoardCacheStore {
  /** this user's record of the board, verified (rev, schema, hash); null when there is none (or it was dropped) */
  read(boardId: string, uid: string): Promise<CachedBoard | null>
  /** checks a stored value read elsewhere (the route's early read): the record, or null (a bad one is dropped) */
  verify(raw: unknown, boardId: string, uid: string): Promise<CachedBoard | null>
  /**
   * stores the confirmed copy (its IndexedDB write starts in this call once the database is open); false: not kept.
   * `startedAt`: when the writing session started; nothing is kept once `uid` signed out in this browser since.
   */
  write(
    boardId: string,
    uid: string,
    content: CacheContent,
    o?: { readonly startedAt?: number },
  ): Promise<boolean>
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
  /** this browser's Sign out marks (default: the page's, board-cache-db.ts) */
  readonly marks?: SignOutMarks
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
  const marks = () => o.marks ?? pageSignOutMarks()
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

  /**
   * Keeps the most recently used records within CACHE_MAX_BOARDS and CACHE_MAX_BYTES (the least recently used go
   * first: a record's last read for an open, or its save).
   */
  const evict = async (db: IDBDatabase, keep: string) => {
    const all = await readIndex(db)
    all.sort((a, b) => lastUse(b) - lastUse(a) || (a.key === keep ? -1 : b.key === keep ? 1 : 0))
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

  /** A record read for an open counts as used (the LRU): its index entry says when, if the record is still there. */
  const touch = (db: IDBDatabase, r: StoredBoard) =>
    new Promise<void>((resolve, reject) => {
      // (its own transaction, not writeTx: its second request is made from the first one's answer)
      const t = db.transaction([CACHE_BOARDS, CACHE_INDEX], 'readwrite')
      t.oncomplete = () => resolve()
      t.onabort = () => reject(t.error ?? new Error('board cache touch aborted'))
      t.onerror = () => reject(t.error ?? new Error('board cache touch failed'))
      const g = t.objectStore(CACHE_BOARDS).get(r.key)
      g.onsuccess = () => {
        const cur = g.result as Partial<StoredBoard> | undefined
        // (only the record this read checked: a purge or a newer write since keeps its own entry)
        if (cur && cur.savedAt === r.savedAt)
          t.objectStore(CACHE_INDEX).put({
            key: r.key,
            uid: r.uid,
            boardId: r.boardId,
            savedAt: r.savedAt,
            bytes: r.bytes,
            usedAt: now(),
          } satisfies IndexEntry)
      }
    })

  const verify = async (raw: unknown, boardId: string, uid: string): Promise<CachedBoard | null> => {
    if (raw === undefined || raw === null) return null
    const key = cacheKey(boardId, uid)
    const drop = () => safely(undefined, (db) => remove(db, [key])).then(() => null)
    // another revision's form, or a broken record: dropped, never translated
    if (!isCurrentRecord(raw, boardId, uid)) return drop()
    // saved before this person's latest Sign out in this browser (another tab wrote it back): never shown
    const out = marks().at(uid)
    if (out !== null && raw.savedAt <= out) return drop()
    // the hash of what was stored: anything else is not the copy that was written. WebCrypto's digest where the page
    // has it (`sha256HexOf`, off the main thread), else the synchronous one (the write's own), which needs no
    // WebCrypto: an http origin that is not localhost (the NAS rehearsal over the LAN) has no crypto.subtle, where
    // hash.ts's WebCrypto digest threw and dropped every record (the W6 review)
    let digest: string | null
    try {
      digest = await sha256HexOf(raw.json)
    } catch {
      digest = null
    }
    if (digest !== raw.hash) return drop()
    // (again after the digest's wait: a Sign out in another tab meanwhile)
    const outNow = marks().at(uid)
    if (outNow !== null && raw.savedAt <= outNow) return drop()
    const board = boardOfStored(raw)
    if (!board) return drop()
    void safely(undefined, (db) => touch(db, raw)).catch(() => {})
    return board
  }

  return {
    read: (boardId, uid) =>
      safely(null, async (db) => verify(await readRawRecord(db, cacheKey(boardId, uid)), boardId, uid)),
    verify: (raw, boardId, uid) => verify(raw, boardId, uid).catch(() => null),
    write: (boardId, uid, content, w) => {
      const startedAt = w?.startedAt
      /** the person signed out in this browser since the writing session started: nothing of theirs is kept */
      const refused = () => startedAt !== undefined && signedOutSince(uid, startedAt, marks())
      if (refused()) return Promise.resolve(false)
      let record: StoredBoard | null
      try {
        record = storedRecordOf(boardId, uid, content, now(), maxBytes)
      } catch {
        return Promise.resolve(false)
      }
      const put = async (db: IDBDatabase): Promise<boolean> => {
        // (again once the database is open: a Sign out may have come in the meantime)
        if (refused()) return false
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
    purgeUser: (uid) => purgeBoardCachesOf(uid, conn, marks(), now()),
  }
}

/**
 * The W6 review (M6-1): whether a board session may still write its person's copy. It starts with the session; once
 * `uid` signs out in this browser (in this tab or any other, now or before `open()` is asked) it is shut for good,
 * and `onSignedOut` is told once (when the Sign out is heard: the session stops its writes and drops its board's
 * record, in case a write of its own got past the purge).
 */
export interface CacheWriteGate {
  readonly startedAt: number
  /** false once `uid` signed out in this browser since `startedAt` */
  open(): boolean
  /** stops listening */
  close(): void
}

export function cacheWriteGate(
  uid: string,
  o: { readonly marks?: SignOutMarks; readonly now?: () => number; readonly onSignedOut?: () => void } = {},
): CacheWriteGate {
  const marks = o.marks ?? pageSignOutMarks()
  const startedAt = (o.now ?? Date.now)()
  let shut = false
  const shutNow = () => {
    if (shut) return
    shut = true
    try {
      o.onSignedOut?.()
    } catch {}
  }
  const off = marks.subscribe((who, at) => {
    if (who === uid && at >= startedAt) shutNow()
  })
  return {
    startedAt,
    open() {
      if (shut) return false
      if (signedOutSince(uid, startedAt, marks)) shutNow()
      return !shut
    },
    close: () => off(),
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

/** A read under way for `uid` shows nothing (an access loss, a Sign out). */
function cancelRead(r: CacheRead): void {
  r.cancelled = true
  r.value = null
  reads.delete(cacheKey(r.boardId, r.uid))
}

let readsWatched: SignOutMarks | null = null
/** A Sign out heard from any tab cancels this page's reads of that person's copies. */
function watchReads(): void {
  const marks = pageSignOutMarks()
  if (readsWatched === marks) return
  readsWatched = marks
  marks.subscribe((uid) => {
    for (const r of [...reads.values()]) if (r.uid === uid) cancelRead(r)
  })
}

/**
 * The board page takes this open's read once (the route's early read, board-cache-db.ts `preloadBoardCache`, or a
 * read started now), checked. Null with `?nocache=1`. A later open of the board reads again.
 */
export function takeBoardCache(boardId: string, uid: string): CacheRead | null {
  if (cacheDisabledBy(pageSearch())) return null
  watchReads()
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
  if (r) cancelRead(r)
  return boardCache().purge(boardId, uid)
}
