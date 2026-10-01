// Barriers (docs/EXCALIDRAW-MIGRATION.md §8.1): actions that must be simultaneous start within 20 ms of
// each other. Two ways, both measured so every evidence file can report the spread it actually got:
//
//  1. `createBarrier(n)` (the frozen `Barrier`): a shared promise in the test process. Each party awaits
//     `arrive()` right before its action; the last arrival resolves every party in the same tick. Actions
//     driven from Node (page.mouse, keyboard) then differ only by their own CDP round trip (a few ms).
//  2. `runTogether(parties)`: for actions that run IN the page (facade calls), each party's function is
//     armed in its own page with a timer for one common wall-clock instant, `releaseInMs` (default 20 ms)
//     after the last party is armed. Every browser runs on the same machine clock, so the in-page start
//     times differ by timer jitter only, independent of CDP latency. The result carries each party's
//     in-page start time and the spread.
import type { Page } from '@playwright/test'
import type { Barrier } from './types.ts'

/** The frozen Barrier plus the timing the evidence reports. */
export interface TimedBarrier extends Barrier {
  /** wall-clock arrival time of each party, in arrival order */
  arrivals(): readonly number[]
  /** wall clock of the release (the last arrival), or null before it */
  releasedAt(): number | null
}

export function createBarrier(parties: number, opts: { timeoutMs?: number } = {}): TimedBarrier {
  if (!Number.isInteger(parties) || parties < 1) throw new Error('a barrier needs at least one party')
  const arrivals: number[] = []
  let released: number | null = null
  let failed: Error | null = null
  const waiters: { resolve(): void; reject(e: Error): void }[] = []
  const timer = setTimeout(() => {
    if (released !== null) return
    failed = new Error(
      `barrier: ${arrivals.length} of ${parties} parties arrived in ${opts.timeoutMs ?? 60_000} ms`,
    )
    for (const w of waiters.splice(0)) w.reject(failed)
  }, opts.timeoutMs ?? 60_000)
  timer.unref?.()
  return {
    parties,
    arrivals: () => [...arrivals],
    releasedAt: () => released,
    arrive() {
      if (failed) return Promise.reject(failed)
      if (arrivals.length >= parties) return Promise.reject(new Error('barrier: more arrivals than parties'))
      arrivals.push(Date.now())
      const p = new Promise<void>((resolve, reject) => waiters.push({ resolve, reject }))
      if (arrivals.length === parties) {
        released = Date.now()
        clearTimeout(timer)
        for (const w of waiters.splice(0)) w.resolve()
      }
      return p
    },
  }
}

/** One party of `runTogether`: a function run in `page` (serialized like page.evaluate's) with `arg`. */
export interface InPageParty<A = unknown, R = unknown> {
  readonly name: string
  readonly page: Page
  readonly fn: (arg: A) => R | Promise<R>
  readonly arg?: A
}

export interface TogetherResult<R = unknown> {
  /** the common instant the parties were armed for (wall clock, ms) */
  readonly releaseAt: number
  /** per party: its in-page start time (wall clock) and what its function returned */
  readonly parties: readonly { readonly name: string; readonly startedAt: number; readonly value: R }[]
  /** max start − min start, ms */
  readonly spreadMs: number
}

/**
 * Arms every party's function in its page for one wall-clock instant and resolves with their start times
 * and results. `releaseInMs` is counted from the moment the last party is armed (default 20 ms).
 */
export async function runTogether<A, R>(
  parties: readonly InPageParty<A, R>[],
  opts: { releaseInMs?: number } = {},
): Promise<TogetherResult<R>> {
  // Arm first (each page gets a token), then fire: arming costs a CDP round trip per page, so the
  // instant is chosen only after every page is ready.
  const tokens = await Promise.all(
    parties.map((p) =>
      p.page.evaluate(
        ({ src, arg }) => {
          const w = window as unknown as { __o3Armed?: Map<number, () => Promise<unknown>>; __o3Seq?: number }
          w.__o3Armed ??= new Map()
          w.__o3Seq = (w.__o3Seq ?? 0) + 1
          const f = new Function(`return (${src})`)() as (a: unknown) => unknown
          w.__o3Armed.set(w.__o3Seq, async () => f(arg))
          return w.__o3Seq
        },
        { src: p.fn.toString(), arg: p.arg as unknown },
      ),
    ),
  )
  const releaseAt = Date.now() + (opts.releaseInMs ?? 20) + parties.length * 5
  const results = await Promise.all(
    parties.map((p, i) =>
      p.page.evaluate(
        async ({ token, releaseAt }) => {
          const w = window as unknown as { __o3Armed: Map<number, () => Promise<unknown>> }
          const run = w.__o3Armed.get(token)
          w.__o3Armed.delete(token)
          if (!run) throw new Error('runTogether: the armed function is gone (page reloaded?)')
          const now = () => Date.now()
          // the machine clock (Date.now) is shared by every browser process; coarse timer, then spin
          const wait = releaseAt - now() - 2
          if (wait > 0) await new Promise((r) => setTimeout(r, wait))
          while (now() < releaseAt) {
            // spin
          }
          const startedAt = now()
          const value = await run()
          return { startedAt, value }
        },
        { token: tokens[i] as number, releaseAt },
      ),
    ),
  )
  const starts = results.map((r) => r.startedAt)
  return {
    releaseAt,
    parties: parties.map((p, i) => ({
      name: p.name,
      startedAt: results[i]?.startedAt ?? Number.NaN,
      value: results[i]?.value as R,
    })),
    spreadMs: Math.max(...starts) - Math.min(...starts),
  }
}

/**
 * Runs Node-side actions released by one barrier (e.g. two pointer-ups) and reports when each action
 * started and finished in the test process.
 */
export async function releaseTogether<R>(
  actions: readonly { readonly name: string; readonly run: () => Promise<R> }[],
  opts: { timeoutMs?: number } = {},
): Promise<{ results: { name: string; startedAt: number; doneAt: number; value: R }[]; spreadMs: number }> {
  const barrier = createBarrier(actions.length, opts)
  const results = await Promise.all(
    actions.map(async (a) => {
      await barrier.arrive()
      const startedAt = Date.now()
      const value = await a.run()
      return { name: a.name, startedAt, doneAt: Date.now(), value }
    }),
  )
  const starts = results.map((r) => r.startedAt)
  return { results, spreadMs: Math.max(...starts) - Math.min(...starts) }
}
