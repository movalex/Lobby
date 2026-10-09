// The time-travel scrubber's checkpoint contents (wave L, L7-1; owner W7): GET /api/snapshots/:sid/content is
// limited to 60 per minute per client (checkpoint-routes.ts PREVIEW_LIMIT) and each answer is a whole board, so
// the scrubber asks for a checkpoint only once it has rested on it for SCRUB_DEBOUNCE_MS, keeps the last
// SCRUB_CACHE_ENTRIES answers in memory (scrubbing back and forth costs nothing), and asks once for a checkpoint
// several ticks want at the same time. Nothing here is stored beyond the page: closing the dialog drops it.

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
 * Runs `fn` with the last value given once `ms` passed without another (the scrubber's rest). `flush` runs a
 * waiting call now; `cancel` drops it.
 */
export function debounced<A>(fn: (arg: A) => void, ms = SCRUB_DEBOUNCE_MS) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let last: { arg: A } | null = null
  const run = () => {
    timer = null
    const a = last
    last = null
    if (a) fn(a.arg)
  }
  return {
    call(arg: A) {
      last = { arg }
      if (timer) clearTimeout(timer)
      timer = setTimeout(run, ms)
    },
    flush() {
      if (timer) clearTimeout(timer)
      run()
    },
    cancel() {
      if (timer) clearTimeout(timer)
      timer = null
      last = null
    },
  }
}
