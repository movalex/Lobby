// The load profiles of docs/EXCALIDRAW-MIGRATION.md §2.13, as the load generator runs them (§8.3 B9).
//
// L1 "all-hands workshop": one board of about 2k objects (about 4k elements, 18 frames of 100 notes,
// bound arrows) with 200 sessions: 40 editors and 160 watchers; plus 20 other boards with 3 sessions
// each, light editing (one push every 5 s per session); a join ramp of 200 sessions in 60 s; one SIGKILL
// and restart at minute 8 (done by the NAS script from outside the container; the generator measures
// the way back). How the budget's sentences became behaviours (each is a parameter below):
//  - "40 editors (one gesture commit every 3 s each; 10 of them typing)": 30 gesture editors, one gesture
//    every 3 s (±30 %), half of them drags of 0.8 s relayed at 20 Hz through presence (ids once, then
//    deltas) and committed at pointer-up, half one-shot edits (recolour, nudge); and 10 typists, each
//    holding the text lease on its own note and pushing text at most every 500 ms in 8 s bursts with 4 s
//    pauses, a new note each burst. Together about 23 pushes/s (the budget: "~20/s on the big board",
//    "about 30 writes/s" counting the typists' fits, which ride in their text pushes).
//  - one of the 30 editors instead drags a 100-note frame every 30 s (the drag relay's worst case).
//  - "160 watchers with cursors moving half the time": 100 viewers and 60 editors that only watch (so
//    echo suppression is measured on editor-role clients too), each moving its cursor at 20 Hz for 5 s,
//    then idle for 5 s, with a random phase. Watchers are B10's receiving-only clients: 0 ops each. Five
//    of the viewers measure: the first is the presence probe (its cursor moves all the time and carries
//    its send time, meter.ts), the others parse its cursor (presence delay) and every change (A→B).
// L2 "heavy board": 30 sessions on the heavy perf board (about 9,220 elements), 10 editors making 20
// remote edits/s in total (one-shot edits, 2/s each), 20 watchers; one watcher per editor measures A→B
// visibility through the server.
import { HEAVY_SPEC, L1_SPEC, SMALL_SPEC } from './boards.ts'

export type SessionKind = 'gesture' | 'typist' | 'frame-dragger' | 'oneshot' | 'watcher' | 'light'

export interface SessionGroup {
  readonly kind: SessionKind
  readonly count: number
  readonly role: 'editor' | 'viewer'
  /** ms between actions (gesture, one-shot, light push) */
  readonly periodMs?: number
  /** share of gestures that are drags (gesture editors) */
  readonly dragShare?: number
  readonly dragMs?: number
  /** watchers: ms moving, ms still */
  readonly moveMs?: number
  readonly stillMs?: number
  /** typists: burst and pause, and the text push interval */
  readonly burstMs?: number
  readonly pauseMs?: number
  readonly typeEveryMs?: number
  /** this group measures A→B visibility (its `changes` frames are parsed) */
  readonly measureVisibility?: boolean
}

export interface BoardLoad {
  readonly kind: 'l1' | 'heavy' | 'small'
  /** how many boards of this kind */
  readonly boards: number
  readonly groups: readonly SessionGroup[]
}

export interface Profile {
  readonly name: string
  readonly durationMs: number
  /** every session of the profile joins within this window, evenly spread */
  readonly joinRampMs: number
  readonly boards: readonly BoardLoad[]
  /** presence send rate while moving (Hz); the server relays at 10 Hz */
  readonly presenceHz: number
  /** scrape sync's /internal/metrics every … ms (0: never) */
  readonly metricsEveryMs: number
  /** when the sync kill is expected (the NAS script does it); only reported */
  readonly killAtMs: number | null
}

export const L1: Profile = {
  name: 'L1',
  durationMs: 10 * 60_000,
  joinRampMs: 60_000,
  presenceHz: 20,
  metricsEveryMs: 10_000,
  killAtMs: 8 * 60_000,
  boards: [
    {
      kind: 'l1',
      boards: 1,
      groups: [
        { kind: 'gesture', count: 29, role: 'editor', periodMs: 3_000, dragShare: 0.5, dragMs: 800 },
        { kind: 'frame-dragger', count: 1, role: 'editor', periodMs: 30_000, dragMs: 800 },
        { kind: 'typist', count: 10, role: 'editor', burstMs: 8_000, pauseMs: 4_000, typeEveryMs: 500 },
        { kind: 'watcher', count: 60, role: 'editor', moveMs: 5_000, stillMs: 5_000 },
        // 5 viewers measure (the first is the presence probe; the others read its cursor and every change)
        { kind: 'watcher', count: 5, role: 'viewer', moveMs: 5_000, stillMs: 5_000, measureVisibility: true },
        { kind: 'watcher', count: 95, role: 'viewer', moveMs: 5_000, stillMs: 5_000 },
      ],
    },
    {
      kind: 'small',
      boards: 20,
      groups: [{ kind: 'light', count: 3, role: 'editor', periodMs: 5_000 }],
    },
  ],
}

export const L2: Profile = {
  name: 'L2',
  durationMs: 10 * 60_000,
  joinRampMs: 15_000,
  presenceHz: 20,
  metricsEveryMs: 10_000,
  killAtMs: null,
  boards: [
    {
      kind: 'heavy',
      boards: 1,
      groups: [
        { kind: 'oneshot', count: 10, role: 'editor', periodMs: 500 },
        {
          kind: 'watcher',
          count: 10,
          role: 'viewer',
          moveMs: 5_000,
          stillMs: 5_000,
          measureVisibility: true,
        },
        { kind: 'watcher', count: 10, role: 'viewer', moveMs: 5_000, stillMs: 5_000 },
      ],
    },
  ],
}

/** A short, small profile for local dry runs (the plumbing, not the numbers). */
export const DRY: Profile = {
  name: 'dry',
  durationMs: 60_000,
  joinRampMs: 10_000,
  presenceHz: 20,
  metricsEveryMs: 10_000,
  killAtMs: null,
  boards: [
    {
      kind: 'l1',
      boards: 1,
      groups: [
        { kind: 'gesture', count: 4, role: 'editor', periodMs: 3_000, dragShare: 0.5, dragMs: 800 },
        { kind: 'frame-dragger', count: 1, role: 'editor', periodMs: 20_000, dragMs: 800 },
        { kind: 'typist', count: 2, role: 'editor', burstMs: 8_000, pauseMs: 4_000, typeEveryMs: 500 },
        { kind: 'watcher', count: 6, role: 'editor', moveMs: 5_000, stillMs: 5_000, measureVisibility: true },
        { kind: 'watcher', count: 6, role: 'viewer', moveMs: 5_000, stillMs: 5_000 },
      ],
    },
    { kind: 'small', boards: 2, groups: [{ kind: 'light', count: 3, role: 'editor', periodMs: 5_000 }] },
  ],
}

export const PROFILES: Readonly<Record<string, Profile>> = { L1, L2, dry: DRY }

export function sessionCount(p: Profile): number {
  return p.boards.reduce((n, b) => n + b.boards * b.groups.reduce((m, g) => m + g.count, 0), 0)
}

/** The board spec of each board kind (boards.ts). */
export const BOARD_SPECS = { l1: L1_SPEC, heavy: HEAVY_SPEC, small: SMALL_SPEC } as const

/** Writes per second a profile asks of a board kind, by the formulas above (the report compares). */
export function plannedWritesPerSecond(b: BoardLoad): number {
  let w = 0
  for (const g of b.groups) {
    if (g.kind === 'gesture' || g.kind === 'oneshot' || g.kind === 'light' || g.kind === 'frame-dragger')
      w += g.count * (1_000 / (g.periodMs ?? 1_000))
    if (g.kind === 'typist') {
      const duty = (g.burstMs ?? 0) / ((g.burstMs ?? 0) + (g.pauseMs ?? 0) || 1)
      w += g.count * duty * (1_000 / (g.typeEveryMs ?? 500))
    }
  }
  return w * b.boards
}
