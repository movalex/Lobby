// The time-travel scrubber's checkpoint contents (wave L, L7-1; owner W7): GET /api/snapshots/:sid/content is
// limited to 60 per minute per client (checkpoint-routes.ts PREVIEW_LIMIT) and each answer is a whole board, so
// the scrubber asks for a checkpoint only once it has rested on it for SCRUB_DEBOUNCE_MS, keeps the last
// SCRUB_CACHE_ENTRIES answers in memory (scrubbing back and forth costs nothing), and asks once for a checkpoint
// several ticks want at the same time. The neighbour ahead is asked for only after a longer rest
// (PREFETCH_IDLE_MS), and never after a 429 (ScrubLoader). Nothing here is stored beyond the page: closing the
// dialog drops it.

/** How long the scrubber rests on a tick before its content is asked for. */
export const SCRUB_DEBOUNCE_MS = 150
/** Checkpoint contents kept in memory while the dialog is open. */
export const SCRUB_CACHE_ENTRIES = 8

export class ContentCache<T> {
  private readonly map = new Map<string, T>()
  private readonly pending = new Map<string, Promise<T>>()
  private readonly load: (id: string) => Promise<T>
  private readonly max: number
  /** how many times `load` ran (the rate-limit budget the scrubber spent) */
  fetches = 0

  constructor(load: (id: string) => Promise<T>, max = SCRUB_CACHE_ENTRIES) {
    this.load = load
    this.max = Math.max(1, max)
  }

  /** The content when it is here (it becomes the most recently used). */
  peek(id: string): T | undefined {
    const hit = this.map.get(id)
    if (hit === undefined) return undefined
    this.map.delete(id)
    this.map.set(id, hit)
    return hit
  }

  has(id: string): boolean {
    return this.map.has(id)
  }

  /** The content, from memory or asked for once (callers asking meanwhile share the request). */
  get(id: string): Promise<T> {
    const hit = this.peek(id)
    if (hit !== undefined) return Promise.resolve(hit)
    const inFlight = this.pending.get(id)
    if (inFlight) return inFlight
    this.fetches++
    const p = this.load(id).then(
      (value) => {
        this.pending.delete(id)
        this.map.set(id, value)
        while (this.map.size > this.max) {
          const oldest = this.map.keys().next().value as string
          this.map.delete(oldest)
        }
        return value
      },
      (e: unknown) => {
        this.pending.delete(id)
        throw e
      },
    )
    this.pending.set(id, p)
    return p
  }

  get size(): number {
    return this.map.size
  }
}

/**
 * How long the scrubber rests on a tick before its neighbour (the way it moves) is asked for ahead. Longer than
 * SCRUB_DEBOUNCE_MS: a slow step through 30 checkpoints, resting a little longer than the debounce on each, must
 * not spend two requests per tick of the content route's 60 a minute (the L7-1 review).
 */
export const PREFETCH_IDLE_MS = 400

export interface ScrubLoaderOptions<T> {
  readonly cache: ContentCache<T>
  /**
   * The timeline's ids, oldest first, read whenever a neighbour is wanted: the dialog's list is refetched on every
   * checkpoint event, and a loader made again for it would drop the load waiting for the rest.
   */
  ticks(): readonly string[]
  /** the tick shown has its content (from memory, at once) */
  onReady(id: string, content: T): void
  /** the tick shown could not be loaded */
  onError(id: string, error: unknown): void
  /** a 429 of the content route: nothing more is asked for ahead while the dialog is open */
  isRateLimited(error: unknown): boolean
  readonly debounceMs?: number
  readonly prefetchIdleMs?: number
}

/**
 * The scrubber's loads (wave L, L7-1): one per dialog. The tick shown is asked for once the scrubber rested on it
 * for `debounceMs` (at once with `now`: the dialog's first tick, "Try again"), from memory when it is there. Its
 * neighbour the way the scrubber moved is asked for ahead once the scrubber rested `prefetchIdleMs` and the tick
 * shown has its content; never again after a 429 (a refused tick says so, and its "Try again" asks again).
 */
export class ScrubLoader<T> {
  private readonly o: ScrubLoaderOptions<T>
  private current: string | null = null
  private step = 1
  private loadTimer: ReturnType<typeof setTimeout> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  /** the rest was long enough while the tick shown was still loading: ask ahead once it is here */
  private aheadWanted = false
  /** asking ahead stopped (a 429 of the content route) */
  aheadStopped = false

  constructor(o: ScrubLoaderOptions<T>) {
    this.o = o
  }

  /** The scrubber is on `id` (`direction`: how it moved there, negative towards older). */
  show(id: string, opts: { now?: boolean; direction?: number } = {}): void {
    this.clear()
    this.current = id
    if (opts.direction) this.step = opts.direction > 0 ? 1 : -1
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.current !== null && this.o.cache.has(this.current)) this.ahead()
      else this.aheadWanted = true
    }, this.o.prefetchIdleMs ?? PREFETCH_IDLE_MS)
    const hit = this.o.cache.peek(id)
    if (hit !== undefined) {
      this.o.onReady(id, hit)
      return
    }
    if (opts.now) this.load(id)
    else
      this.loadTimer = setTimeout(() => {
        this.loadTimer = null
        this.load(id)
      }, this.o.debounceMs ?? SCRUB_DEBOUNCE_MS)
  }

  /** Nothing more is asked for, nor answered (the dialog closed; a later `show` starts again). */
  stop(): void {
    this.clear()
    this.current = null
  }

  private clear(): void {
    if (this.loadTimer) clearTimeout(this.loadTimer)
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.loadTimer = null
    this.idleTimer = null
    this.aheadWanted = false
  }

  private load(id: string): void {
    this.o.cache.get(id).then(
      (content) => {
        if (this.current !== id) return
        this.o.onReady(id, content)
        if (this.aheadWanted) this.ahead()
      },
      (e: unknown) => {
        if (this.o.isRateLimited(e)) this.aheadStopped = true
        if (this.current !== id) return
        this.o.onError(id, e)
      },
    )
  }

  private ahead(): void {
    this.aheadWanted = false
    const id = this.current
    if (this.aheadStopped || id === null) return
    const ticks = this.o.ticks()
    const at = ticks.indexOf(id)
    const next = at < 0 ? undefined : ticks[at + this.step]
    if (next === undefined || this.o.cache.has(next)) return
    this.o.cache.get(next).catch((e: unknown) => {
      if (this.o.isRateLimited(e)) this.aheadStopped = true
    })
  }
}
