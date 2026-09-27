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
}

const LOADING: MetaSnapshot = Object.freeze({ meta: null, missing: false, error: false })
const MISSING: MetaSnapshot = Object.freeze({ meta: null, missing: true, error: false })

/**
 * Per-version cache + poller for the dev meta route. Versions are immutable, so a terminal meta
 * (ready/failed/missing) is cached for the lifetime of the page and never refetched. Non-terminal
 * versions are polled with backoff only while something is subscribed (a mounted card, or the
 * uploading tab's hint patcher) and polling stops as soon as the last subscriber leaves.
 */
export class AssetMetaStore {
  private readonly entries = new Map<string, Entry>()
  private readonly fetchImpl: typeof fetch
  private readonly minDelayMs: number
  private readonly maxDelayMs: number
  private readonly freshMs: number
  private readonly now: () => number

  constructor(opts: MetaStoreOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args))
    this.minDelayMs = opts.minDelayMs ?? 500
    this.maxDelayMs = opts.maxDelayMs ?? 3000
    this.freshMs = opts.freshMs ?? 1000
    this.now = opts.now ?? (() => Date.now())
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

  /** One-shot read for TLAssetStore.resolve(): cached if terminal or fresh, otherwise fetched once. */
  async load(boardId: string, assetId: string, versionId: string): Promise<MetaSnapshot> {
    const e = this.entry(boardId, assetId, versionId)
    if (isTerminal(e.snap) || (e.snap.meta && this.now() - e.fetchedAt < this.freshMs)) return e.snap
    await (e.inflight ?? this.fetchOnce(e))
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

  private fetchOnce(e: Entry): Promise<void> {
    if (e.inflight) return e.inflight
    const run = async () => {
      let next: MetaSnapshot
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
