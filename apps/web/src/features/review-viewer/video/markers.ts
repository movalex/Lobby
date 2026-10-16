// OWNER: WS3 (wave S, media comments). The video scrubber's comment markers: one per thread with a time, clustered
// when closer than MARKER_CLUSTER_PX on the track (a cluster opens a list of its threads). Pure: unit-tested.

/** Markers closer than this on the scrubber are drawn as one (docs/WAVE-S-CONTRACTS.md §4). */
export const MARKER_CLUSTER_PX = 6

export interface TimedThread {
  readonly id: string
  readonly timeMs: number
}

export interface MarkerCluster {
  /** where it is drawn, px from the track's left edge (its first thread's place) */
  readonly x: number
  /** the first thread's time (a click seeks there) */
  readonly timeMs: number
  /** its threads, earliest first */
  readonly ids: readonly string[]
}

/** A time's place on a track `width` px wide for a video `durationMs` long (clamped to the track). */
export function trackX(timeMs: number, durationMs: number, width: number): number {
  if (!(durationMs > 0) || !(width > 0)) return 0
  return Math.min(width, Math.max(0, (timeMs / durationMs) * width))
}

/**
 * The markers of `threads` on the track: sorted by time (then id), each joining the cluster before it when it is
 * less than `minPx` from that cluster's last marker. Times past the end sit at the end.
 */
export function clusterMarkers(
  threads: readonly TimedThread[],
  durationMs: number,
  width: number,
  minPx = MARKER_CLUSTER_PX,
): MarkerCluster[] {
  const sorted = [...threads]
    .filter((t) => Number.isFinite(t.timeMs) && t.timeMs >= 0)
    .sort((a, b) => a.timeMs - b.timeMs || a.id.localeCompare(b.id))
  const out: { x: number; timeMs: number; ids: string[]; lastX: number }[] = []
  for (const t of sorted) {
    const x = trackX(t.timeMs, durationMs, width)
    const last = out[out.length - 1]
    if (last && x - last.lastX < minPx) {
      last.ids.push(t.id)
      last.lastX = x
    } else out.push({ x, timeMs: t.timeMs, ids: [t.id], lastX: x })
  }
  return out.map(({ x, timeMs, ids }) => ({ x, timeMs, ids }))
}

/** The time under a click on the track (px from its left edge), rounded to the millisecond. */
export function timeAtX(x: number, durationMs: number, width: number): number {
  if (!(durationMs > 0) || !(width > 0)) return 0
  return Math.round(Math.min(1, Math.max(0, x / width)) * durationMs)
}
