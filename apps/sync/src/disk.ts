// The sync disk's free space (wave M, M7-4, CAP-DISK): one place that reads it (statfs on the data dir: on Render
// the rooms, the backups and every board file are on the one attached disk), with the thresholds that act on it.
//  - below DISK_LOW_RATIO (20 %): the backup pass prunes local copies to the newest offsite-confirmed one per
//    board and makes no new local copy (backup/element-backups.ts), and GET /healthz/deep answers `disk`;
//  - below DISK_NOTICE_RATIO (10 %; it was 5 %): every room broadcasts the DISK notice (the web tells people);
//  - lobby_disk_free_ratio in /internal/metrics and the hourly metrics.summary line.
// Tests replace statfs (a fake), or, in a real server process, set DRAFTROOM_TEST_DISK_FREE (config.ts: honoured
// only with DRAFTROOM_TEST_HOOKS=1, never in production).

import { statfsSync } from 'node:fs'

/** Below this free share of the disk: backups are pruned and paused, and the deep health check says `disk`. */
export const DISK_LOW_RATIO = 0.2
/** Below this free share: the rooms' DISK notice to everyone (it was 0.05 before wave M). */
export const DISK_NOTICE_RATIO = 0.1

/** What statfs gives (node:fs StatsFs; numbers or bigints). */
export interface StatfsLike {
  readonly blocks: number | bigint
  readonly bavail: number | bigint
}
export type Statfs = (path: string) => StatfsLike

/** How the free share of a path's disk is read: statfs, a fake (tests), or a fixed answer (the test hook). */
export interface DiskProbe {
  /** the free share (0..1) of the disk holding `path`, or null when it cannot be read */
  freeRatio(path: string): number | null
}

/** The free share of `path`'s disk available to this process (bavail / blocks), or null when unreadable. */
export function diskFreeRatio(path: string, statfs: Statfs = statfsSync): number | null {
  try {
    const s = statfs(path)
    const blocks = Number(s.blocks)
    const avail = Number(s.bavail)
    if (!Number.isFinite(blocks) || blocks <= 0 || !Number.isFinite(avail) || avail < 0) return null
    return Math.min(1, avail / blocks)
  } catch {
    return null // statfs unavailable: never a reason to act
  }
}

/** The probe over statfs (or `statfs`), or a fixed answer (`fixed`: DRAFTROOM_TEST_DISK_FREE, test hooks only). */
export function diskProbe(opts: { statfs?: Statfs; fixed?: number | null } = {}): DiskProbe {
  const { fixed } = opts
  if (typeof fixed === 'number') return { freeRatio: () => fixed }
  const statfs = opts.statfs ?? statfsSync
  return { freeRatio: (path) => diskFreeRatio(path, statfs) }
}

/** The process's probe: statfs. */
export const STATFS_PROBE: DiskProbe = diskProbe()
