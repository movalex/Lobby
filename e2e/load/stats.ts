// Small numeric helpers for the load generator's reports (docs/EXCALIDRAW-MIGRATION.md §8.3 B9): nearest-
// rank percentiles, a bounded latency recorder, and per-window rates. Pure; no imports.

/** Nearest-rank percentile of `values` (0 < p ≤ 100); NaN for an empty list. Does not modify the input. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN
  if (!(p > 0 && p <= 100)) throw new Error('percentile must be in (0, 100]')
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] as number
}

export interface Summary {
  readonly n: number
  readonly p50: number
  readonly p95: number
  readonly p99: number
  readonly max: number
  readonly mean: number
}

export function summarize(values: readonly number[]): Summary {
  const n = values.length
  const round = (x: number) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : x)
  // a loop, not Math.max(...values): a spread of 120,000 visibility samples (L2, 10 measuring sessions,
  // 10 minutes) overflows the call stack ("Maximum call stack size exceeded", NAS L2 r1 lost its report)
  let max = Number.NEGATIVE_INFINITY
  let sum = 0
  for (const v of values) {
    if (v > max) max = v
    sum += v
  }
  return {
    n,
    p50: round(percentile(values, 50)),
    p95: round(percentile(values, 95)),
    p99: round(percentile(values, 99)),
    max: round(n ? max : Number.NaN),
    mean: round(n ? sum / n : Number.NaN),
  }
}

/**
 * Keeps every sample up to `cap`, then a uniform reservoir sample of that size (so a 10-minute run with
 * millions of presence frames keeps bounded memory and unbiased percentiles). Deterministic for a seed.
 */
export class Recorder {
  private readonly cap: number
  private readonly samples: number[] = []
  private seen = 0
  private seed: number
  private maxSeen = Number.NEGATIVE_INFINITY
  constructor(cap = 50_000, seed = 1) {
    this.cap = cap
    this.seed = seed
  }
  private rand(): number {
    this.seed = (this.seed * 16807) % 2147483647
    return this.seed / 2147483647
  }
  add(value: number): void {
    if (!Number.isFinite(value)) return
    this.seen++
    if (value > this.maxSeen) this.maxSeen = value
    if (this.samples.length < this.cap) this.samples.push(value)
    else {
      const j = Math.floor(this.rand() * this.seen)
      if (j < this.cap) this.samples[j] = value
    }
  }
  get count(): number {
    return this.seen
  }
  summary(): Summary {
    const s = summarize(this.samples)
    return { ...s, n: this.seen, max: this.seen ? Math.round(this.maxSeen * 10) / 10 : Number.NaN }
  }
  values(): readonly number[] {
    return this.samples
  }
}

/** Counts per fixed window (e.g. bytes per 10 s), keyed by the window's start. */
export class Windows {
  private readonly ms: number
  private readonly t0: number
  private readonly buckets = new Map<number, number>()
  constructor(windowMs: number, t0: number) {
    this.ms = windowMs
    this.t0 = t0
  }
  add(at: number, amount = 1): void {
    const k = Math.floor((at - this.t0) / this.ms)
    this.buckets.set(k, (this.buckets.get(k) ?? 0) + amount)
  }
  /** [window start offset ms, amount per second] in order */
  perSecond(): [number, number][] {
    return [...this.buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([k, v]) => [k * this.ms, (v * 1000) / this.ms])
  }
}
