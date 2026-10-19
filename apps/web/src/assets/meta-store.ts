import { useCallback, useSyncExternalStore } from 'react'
import { type AssetVersionMeta, isId, metaUrl } from './contract.ts'

export interface MetaSnapshot {
  /** Last meta the server returned for this version (null until the first successful fetch). */
  meta: AssetVersionMeta | null
  /** The server said this version does not exist on this board (or the ids are malformed). */
  missing: boolean
  /** The last fetch failed transiently (network / 5xx); polling continues. */
  error: boolean
}

export const isTerminal = (s: MetaSnapshot) =>
  s.missing || s.meta?.status === 'ready' || s.meta?.status === 'failed'

interface Entry {
  boardId: string
  assetId: string
  versionId: string
  snap: MetaSnapshot
  listeners: Set<() => void>
  timer: ReturnType<typeof setTimeout> | null
  delay: number
  inflight: Promise<void> | null
  fetchedAt: number
}

export interface MetaStoreOptions {
  fetchImpl?: typeof fetch
  minDelayMs?: number
  maxDelayMs?: number
  /** resolve() calls within this window reuse the cached (non-terminal) meta instead of refetching. */
  freshMs?: number
  now?: () => number
  /**
   * Meta GETs in flight at once, for the whole page (FIFO beyond that). A board of 2,000 photos opened
   * at fit resolves every image at once; uncapped, Chrome fails part of that storm
   * (net::ERR_INSUFFICIENT_RESOURCES) and those images never load.
   */
  maxConcurrent?: number
  /** Waits before each retry of a transiently failed load() (network error, 5xx, 408, 429). */
  retryDelaysMs?: readonly number[]
  /** 0..1, for the retry jitter (tests pin it). */
  random?: () => number
}

const LOADING: MetaSnapshot = Object.freeze({ meta: null, missing: false, error: false })
const MISSING: MetaSnapshot = Object.freeze({ meta: null, missing: true, error: false })

export const DEFAULT_MAX_CONCURRENT_META = 6
export const DEFAULT_META_RETRY_DELAYS_MS: readonly number[] = [500, 1000, 2000]
/** refresh(): a terminal answer is asked for again at most this often per version. */
export const REFRESH_MIN_INTERVAL_MS = 5_000

/**
 * Per-version cache + poller for the dev meta route. Versions are immutable, so a terminal meta
 * (ready/failed/missing) is cached for the lifetime of the page and never refetched. Non-terminal
 * versions are polled with backoff only while something is subscribed (a mounted card, or the
 * uploading tab's hint patcher) and polling stops as soon as the last subscriber leaves. Every
 * request (load, poll) goes through one FIFO queue of at most `maxConcurrent` requests in flight.
 */
export class AssetMetaStore {
  private readonly entries = new Map<string, Entry>()
  private readonly fetchImpl: typeof fetch
  private readonly minDelayMs: number
  private readonly maxDelayMs: number
  private readonly freshMs: number
  private readonly now: () => number
  private readonly maxConcurrent: number
  private readonly retryDelaysMs: readonly number[]
  private readonly random: () => number
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor(opts: MetaStoreOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args))
    this.minDelayMs = opts.minDelayMs ?? 500
    this.maxDelayMs = opts.maxDelayMs ?? 3000
    this.freshMs = opts.freshMs ?? 1000
    this.now = opts.now ?? (() => Date.now())
    this.maxConcurrent = Math.max(1, Math.floor(opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_META))
    this.retryDelaysMs = opts.retryDelaysMs ?? DEFAULT_META_RETRY_DELAYS_MS
    this.random = opts.random ?? Math.random
  }

  /** Requests currently in flight / waiting for a slot (for tests and diagnostics). */
  get queueStats() {
    return { active: this.active, waiting: this.waiting.length }
  }

  get(boardId: string, assetId: string, versionId: string): MetaSnapshot {
    return this.entry(boardId, assetId, versionId).snap
  }

  subscribe(boardId: string, assetId: string, versionId: string, listener: () => void): () => void {
    const e = this.entry(boardId, assetId, versionId)
    e.listeners.add(listener)
    this.ensurePolling(e, 0)
    return () => {
      e.listeners.delete(listener)
      if (e.listeners.size === 0 && e.timer) {
        clearTimeout(e.timer)
        e.timer = null
      }
    }
  }

  /**
   * One-shot read for TLAssetStore.resolve(): cached if terminal or fresh, otherwise fetched. A
   * transient failure (network error, 5xx, 408, 429) is retried after each of `retryDelaysMs` (with
   * ±25 % jitter); if every try fails the snapshot comes back with `error: true` and nothing terminal
   * is cached, so a later load() asks again.
   */
  async load(boardId: string, assetId: string, versionId: string): Promise<MetaSnapshot> {
    const e = this.entry(boardId, assetId, versionId)
    const fresh = () => !e.snap.error && e.snap.meta && this.now() - e.fetchedAt < this.freshMs
    if (isTerminal(e.snap) || fresh()) return e.snap
    await (e.inflight ?? this.fetchOnce(e))
    for (const delay of this.retryDelaysMs) {
      if (!e.snap.error || isTerminal(e.snap)) break
      await sleep(delay * (0.75 + this.random() * 0.5))
      // A poller (or another load) may have fetched it meanwhile.
      if (!e.snap.error || isTerminal(e.snap)) break
      await (e.inflight ?? this.fetchOnce(e))
    }
    return e.snap
  }

  /**
   * Wave W (WS4, deck import): asks the api again for a version whose cached answer may be out of date although it is
   * terminal: a ready PDF gains page renderings after its preview (render-pages ops make pages 9+), so a placed page
   * the cached meta does not list is asked for again rather than given up. At most once per `minIntervalMs` per
   * version (a fresher answer is returned as it is); subscribers hear a changed answer. A version that is not
   * terminal yet is left to its poller (load).
   */
  async refresh(
    boardId: string,
    assetId: string,
    versionId: string,
    minIntervalMs = REFRESH_MIN_INTERVAL_MS,
  ): Promise<MetaSnapshot> {
    const e = this.entry(boardId, assetId, versionId)
    if (!isTerminal(e.snap) || e.snap.missing) return this.load(boardId, assetId, versionId)
    if (e.inflight) await e.inflight
    else if (this.now() - e.fetchedAt >= minIntervalMs) await this.fetchOnce(e)
    return e.snap
  }

  /** Stops all polling and drops subscribers (cached metas are kept). Subscribing again restarts polling. */
  stopAll() {
    for (const e of this.entries.values()) {
      if (e.timer) clearTimeout(e.timer)
      e.timer = null
      e.listeners.clear()
    }
  }

  private entry(boardId: string, assetId: string, versionId: string): Entry {
    const key = `${boardId}/${assetId}/${versionId}`
    let e = this.entries.get(key)
    if (!e) {
      const valid = isId('ast', assetId) && isId('ver', versionId)
      e = {
        boardId,
        assetId,
        versionId,
        snap: valid ? LOADING : MISSING, // malformed ids can never exist server-side: don't ask
        listeners: new Set(),
        timer: null,
        delay: this.minDelayMs,
        inflight: null,
        fetchedAt: 0,
      }
      this.entries.set(key, e)
    }
    return e
  }

  /** Idempotent: at most one timer per version, and only while it has subscribers and is not terminal. */
  private ensurePolling(e: Entry, delay: number) {
    if (isTerminal(e.snap) || e.listeners.size === 0 || e.timer) return
    if (e.inflight) {
      void e.inflight.then(() => this.ensurePolling(e, e.delay))
      return
    }
    e.timer = setTimeout(() => {
      e.timer = null
      void this.fetchOnce(e).then(() => {
        e.delay = Math.min(Math.round(e.delay * 1.5), this.maxDelayMs)
        this.ensurePolling(e, e.delay)
      })
    }, delay)
  }

  /** Waits for one of the `maxConcurrent` request slots (FIFO). Pair every call with release(). */
  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++
      return Promise.resolve()
    }
    return new Promise((resolve) => this.waiting.push(resolve))
  }

  /** Hands the slot straight to the next waiter (so `active` never exceeds the cap). */
  private release() {
    const next = this.waiting.shift()
    if (next) next()
    else this.active--
  }

  private fetchOnce(e: Entry): Promise<void> {
    if (e.inflight) return e.inflight
    const run = async () => {
      let next: MetaSnapshot
      await this.acquire()
      try {
        const res = await this.fetchImpl(metaUrl(e.boardId, e.assetId, e.versionId), {
          cache: 'no-store',
          headers: { accept: 'application/json' },
        })
        if (res.ok) {
          const meta = (await res.json()) as AssetVersionMeta
          next = meta?.versionId === e.versionId ? { meta, missing: false, error: false } : errorOf(e.snap)
        } else if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
          next = MISSING
        } else {
          next = errorOf(e.snap)
        }
      } catch {
        next = errorOf(e.snap)
      } finally {
        this.release()
      }
      e.fetchedAt = this.now()
      if (!sameSnapshot(e.snap, next)) {
        e.snap = next
        for (const l of [...e.listeners]) l()
      }
    }
    e.inflight = run().finally(() => {
      e.inflight = null
    })
    return e.inflight
  }
}

const errorOf = (prev: MetaSnapshot): MetaSnapshot =>
  prev.error ? prev : { meta: prev.meta, missing: false, error: true }

function sameSnapshot(a: MetaSnapshot, b: MetaSnapshot) {
  if (a === b) return true
  if (a.missing !== b.missing || a.error !== b.error) return false
  return JSON.stringify(a.meta) === JSON.stringify(b.meta)
}

/**
 * Calls `onSnapshot` with the current snapshot and on every change until it returns true (done),
 * the version turns terminal, or `signal` aborts. Keeps the version polled meanwhile.
 */
export function watchMeta(
  store: AssetMetaStore,
  boardId: string,
  assetId: string,
  versionId: string,
  signal: AbortSignal,
  onSnapshot: (snap: MetaSnapshot) => boolean | undefined,
) {
  let unsubscribe: (() => void) | null = null
  let stopped = false
  const stop = () => {
    stopped = true
    unsubscribe?.()
    signal.removeEventListener('abort', stop)
  }
  const check = () => {
    if (stopped) return
    const snap = store.get(boardId, assetId, versionId)
    if (onSnapshot(snap) || isTerminal(snap)) stop()
  }
  if (signal.aborted) return
  unsubscribe = store.subscribe(boardId, assetId, versionId, check)
  signal.addEventListener('abort', stop)
  check() // a cached terminal snapshot never changes again, so look once up front
}

/**
 * Resolves with the version's snapshot once it is terminal (ready / failed / missing), or with the
 * latest snapshot after `timeoutMs` (or on abort). Polls meanwhile, like any subscriber.
 */
export function waitForTerminalMeta(
  store: AssetMetaStore,
  boardId: string,
  assetId: string,
  versionId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<MetaSnapshot> {
  return new Promise((resolve) => {
    const ctrl = new AbortController()
    const finish = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      ctrl.abort()
      resolve(store.get(boardId, assetId, versionId))
    }
    const timer = setTimeout(finish, timeoutMs)
    if (signal?.aborted) return finish()
    signal?.addEventListener('abort', finish)
    watchMeta(store, boardId, assetId, versionId, ctrl.signal, (snap) => {
      if (!isTerminal(snap)) return false
      // Resolve after watchMeta has unsubscribed (it stops right after this callback).
      queueMicrotask(finish)
      return true
    })
  })
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const noopSubscribe = () => () => {}
const getMissing = () => MISSING

/**
 * Subscribes a component to one asset version's meta; polling stops when it unmounts. With no store
 * (rendered outside a board) it reports `missing` and makes no requests.
 */
export function useAssetMeta(
  store: AssetMetaStore | null,
  boardId: string,
  assetId: string,
  versionId: string,
): MetaSnapshot {
  const subscribe = useCallback(
    (cb: () => void) => (store ? store.subscribe(boardId, assetId, versionId, cb) : noopSubscribe()),
    [store, boardId, assetId, versionId],
  )
  const get = useCallback(
    () => (store ? store.get(boardId, assetId, versionId) : getMissing()),
    [store, boardId, assetId, versionId],
  )
  return useSyncExternalStore(subscribe, get, get)
}
