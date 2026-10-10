// GET /healthz/deep (wave M, M7-6, CAP-ALERTS): what an external uptime monitor points at, so a stalled event
// loop, failing backups or an unreachable api alert someone. Public, like /healthz, and it says nothing but codes:
// 200 `ok`, or 503 with the reasons, comma-separated, in this order:
//  - disk:   the data disk is under DISK_LOW_RATIO (20 %) free (disk.ts; backups are pruned and paused there);
//  - backup: the offsite copy is failing for a board (its last attempt failed), or a local backup has waited
//            more than an hour to go up (backup/offsite.ts pendingSince); never while offsite backups are off;
//  - loop:   the event loop's p99 delay over the last 5-minute window was above 200 ms (LoopWatch);
//  - api:    the last periodic access round could not reach the api (access.ts lastRound).
// Render's healthCheckPath stays /healthz (render.yaml), so a deep failure never restarts the sync: it is an
// alert, not a liveness probe. No board id, user id, path or count is ever in the answer.

import { monitorEventLoopDelay } from 'node:perf_hooks'
import type { AccessRound } from './access.ts'
import type { OffsiteStatus } from './backup/offsite.ts'
import { DISK_LOW_RATIO } from './disk.ts'

export const DEEP_HEALTH = Object.freeze({
  /** the event-loop p99 (ms) over one window above which `loop` is reported */
  loopP99Ms: 200,
  /** the event-loop window (ms) */
  loopWindowMs: 5 * 60_000,
  /** a local backup waiting longer than this (ms) to go offsite is `backup` */
  backupPendingMs: 60 * 60_000,
})

export type DeepHealthReason = 'disk' | 'backup' | 'loop' | 'api'

/** What the deep check reads (app.ts gathers it at each request). */
export interface DeepHealthFacts {
  /** the data disk's free share (null: unreadable, never a reason) */
  readonly diskFreeRatio: number | null
  readonly backups: Pick<OffsiteStatus, 'store' | 'boards'>
  /** the event loop's p99 delay over the last complete window, ms (null before the first window ends) */
  readonly loopP99Ms: number | null
  /** the last periodic access round (null before the first) */
  readonly accessRound: AccessRound | null
  readonly now: number
}

/** The reasons the deep check fails, in a fixed order (empty: healthy). */
export function deepHealthReasons(f: DeepHealthFacts): DeepHealthReason[] {
  const out: DeepHealthReason[] = []
  if (f.diskFreeRatio !== null && f.diskFreeRatio < DISK_LOW_RATIO) out.push('disk')
  if (
    f.backups.store !== 'off' &&
    f.backups.boards.some(
      (b) =>
        b.failures > 0 ||
        (b.pendingSince !== null &&
          b.pendingSince !== undefined &&
          f.now - Date.parse(b.pendingSince) > DEEP_HEALTH.backupPendingMs),
    )
  )
    out.push('backup')
  if (f.loopP99Ms !== null && f.loopP99Ms > DEEP_HEALTH.loopP99Ms) out.push('loop')
  if (f.accessRound !== null && f.accessRound.failed > 0) out.push('api')
  return out
}

export interface LoopWatch {
  /** the p99 event-loop delay (ms) of the last complete window, or null before one ended */
  p99(): number | null
  stop(): void
}

/** The event loop's delay in fixed windows (DEEP_HEALTH.loopWindowMs): each window's p99, then a fresh start. */
export function createLoopWatch(opts: { windowMs?: number; resolutionMs?: number } = {}): LoopWatch {
  const h = monitorEventLoopDelay({ resolution: opts.resolutionMs ?? 20 })
  h.enable()
  let last: number | null = null
  const timer = setInterval(() => {
    last = h.count ? h.percentile(99) / 1e6 : null
    h.reset()
  }, opts.windowMs ?? DEEP_HEALTH.loopWindowMs)
  timer.unref?.()
  return {
    p99: () => last,
    stop() {
      clearInterval(timer)
      h.disable()
    },
  }
}
