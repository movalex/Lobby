/**
 * The shared laser on the client (wave L, L6-1; CONTRACTS_REV 12, canvas-schema protocol.ts `PresenceIn.t`,
 * `trail`). Pure: no engine, no DOM, so the canvas API (node-safe) can compose `presence.lasers()` from it.
 *
 * - Whether this tab's laser tool is the active tool, keyed by the board's engine core: the canvas API
 *   (canvas/api/impl.ts) registers the port's `tool()` for its core, and the presence hub (./hub.ts) of the
 *   same core reads it when the pointer goes down (the same keying as ./follow-target.ts, so the board session
 *   needs no new wiring).
 * - The samples this tab sends (`laserTrailOut`): at most MAX_LASER_TRAIL_POINTS integer scene points inside
 *   the coordinate limit, thinned evenly, oldest first, without the pointer itself.
 * - The other sessions' lasers (`LaserTrails`): each entry with `t: 'laser'` adds its `trail` and its pointer,
 *   stamped across the time since that peer's previous entry (a 10 Hz frame carries about 100 ms of path), and
 *   every sample lives LASER_TRAIL_MS. An entry without `t` (released, or from an older room or client) adds
 *   nothing and ends the press; what was drawn fades on its own. The hub keeps one per core and offers it
 *   through `provideLasers`; the canvas API reads it with `lasersOf`.
 *
 * Nothing here is written to the board.
 */
import { COORD_LIMIT } from '@draftroom/canvas-schema/limits'
import { MAX_LASER_TRAIL_POINTS, type PeerPresence } from '@draftroom/canvas-schema/protocol'

/** How long a laser sample is drawn (ms): the trail decays over about a second. */
export const LASER_TRAIL_MS = 1_000
/** The most samples kept per peer (10 Hz frames of 7 samples for LASER_TRAIL_MS, with room to spare). */
export const LASER_MAX_SAMPLES = 120
/** A pressed laser with no entry for this long counts as released (its sender stopped sending). */
export const LASER_HOLD_MS = 3_000
/**
 * M2-6: a laser pressed and held still re-sends its last point this often, so a peer does not count it released
 * (LASER_HOLD_MS): two sends may be lost before it would. It is one message a second, the same fields as any
 * other laser message (no protocol change), and goes through the same 20 Hz gate (./hub.ts).
 */
export const LASER_RESEND_MS = 1_000
/** The span one entry's samples are spread over when the previous entry is older (the room's 10 Hz tick). */
const FRAME_SPAN_MS = 100

export interface LaserPointIn {
  readonly x: number
  readonly y: number
}

/** One sample of another session's laser: a scene point and when this tab got it (its `now` clock, ms). */
export interface LaserSample {
  readonly x: number
  readonly y: number
  readonly at: number
}

/** Another session's laser, as the hub keeps it (identity is added by the reader). */
export interface LaserTrailState {
  readonly sid: string
  /** the peer's latest entry says its laser is pressed */
  readonly active: boolean
  /** oldest first, each younger than LASER_TRAIL_MS */
  readonly points: readonly LaserSample[]
}

// ---- this tab's tool, keyed by the engine core ----------------------------------------------------------

const toolSources = new WeakMap<object, () => boolean>()

/** Registers whether the laser is this tab's active tool, for `core`'s presence hub; returns the removal. */
export function setLaserToolSource(core: object | null | undefined, isLaser: () => boolean): () => void {
  if (!core) return () => {}
  toolSources.set(core, isLaser)
  return () => {
    if (toolSources.get(core) === isLaser) toolSources.delete(core)
  }
}

/** Whether the laser is the active tool of the tab of `core` (false when nothing says so). */
export function laserToolOn(core: object | null | undefined): boolean {
  if (!core) return false
  try {
    return toolSources.get(core)?.() === true
  } catch {
    return false
  }
}

// ---- the lasers of the other sessions, keyed by the engine core -------------------------------------------

const laserSources = new WeakMap<object, (now: number) => readonly LaserTrailState[]>()

/** The presence hub offers the lasers it receives for `core`; returns the removal. */
export function provideLasers(
  core: object | null | undefined,
  read: (now: number) => readonly LaserTrailState[],
): () => void {
  if (!core) return () => {}
  laserSources.set(core, read)
  return () => {
    if (laserSources.get(core) === read) laserSources.delete(core)
  }
}

/** The other sessions' lasers on the tab of `core`, as of `now` (empty when no hub provides them). */
export function lasersOf(core: object | null | undefined, now: number): readonly LaserTrailState[] {
  if (!core) return []
  return laserSources.get(core)?.(now) ?? []
}

// ---- what this tab sends ----------------------------------------------------------------------------------------

const clampInt = (v: number) => Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, Math.round(v)))

/**
 * `points` thinned evenly to at most `n`, keeping the first and the last, in order (the room thins the same
 * way). The same array when it is short enough.
 */
export function thinPoints<T>(points: readonly T[], n: number): readonly T[] {
  if (points.length <= n) return points
  if (n <= 1) return points.length ? [points[points.length - 1] as T] : []
  const out: T[] = []
  for (let i = 0; i < n; i++) out.push(points[Math.round((i * (points.length - 1)) / (n - 1))] as T)
  return out
}

/**
 * The `trail` of one presence message: the samples taken since the previous message (`samples`, oldest
 * first), as integer scene points inside the coordinate limit, without repeats and without the message's own
 * `pointer`, thinned to at most MAX_LASER_TRAIL_POINTS. Empty when there is nothing between.
 */
export function laserTrailOut(
  samples: readonly LaserPointIn[],
  pointer: LaserPointIn | null,
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = []
  for (const s of samples) {
    if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) continue
    const p = { x: clampInt(s.x), y: clampInt(s.y) }
    const last = out[out.length - 1]
    if (last && last.x === p.x && last.y === p.y) continue
    out.push(p)
  }
  if (pointer) {
    const px = clampInt(pointer.x)
    const py = clampInt(pointer.y)
    while (out.length && out[out.length - 1]?.x === px && out[out.length - 1]?.y === py) out.pop()
  }
  return [...thinPoints(out, MAX_LASER_TRAIL_POINTS)]
}

// ---- the other sessions' lasers ---------------------------------------------------------------------------------

interface Trail {
  active: boolean
  /** when the latest entry with the laser came (spreads the next entry's samples) */
  lastAt: number
  points: LaserSample[]
}

/** The lasers of the other sessions, from their presence entries (one per hub). */
export class LaserTrails {
  private readonly bySid = new Map<string, Trail>()

  /** One presence entry of a peer, received at `now`. */
  apply(peer: PeerPresence, now: number): void {
    const had = this.bySid.get(peer.sid)
    if (peer.t !== 'laser') {
      if (had) had.active = false
      return
    }
    const samples: LaserPointIn[] = [...(peer.trail ?? [])]
    if (peer.pointer) samples.push(peer.pointer)
    const t: Trail = had ?? { active: false, lastAt: now, points: [] }
    // this entry's samples took place since the previous one (at most a tick back, a fresh press: now)
    const from = t.active ? Math.max(t.lastAt, now - FRAME_SPAN_MS) : now
    const n = samples.length
    samples.forEach((s, i) => {
      const at = n > 1 ? from + ((now - from) * (i + 1)) / n : now
      const last = t.points[t.points.length - 1]
      if (last && last.x === s.x && last.y === s.y) return
      t.points.push({ x: s.x, y: s.y, at })
    })
    if (t.points.length > LASER_MAX_SAMPLES) t.points.splice(0, t.points.length - LASER_MAX_SAMPLES)
    t.active = true
    t.lastAt = now
    if (!had) this.bySid.set(peer.sid, t)
  }

  /** The peer is gone (left, or past the cursor cap): its laser goes at once. */
  remove(sid: string): void {
    this.bySid.delete(sid)
  }

  /** A new socket: nobody's laser is known. */
  clear(): void {
    this.bySid.clear()
  }

  /**
   * The lasers to draw at `now`: samples older than LASER_TRAIL_MS are gone, and so is a laser with none. A
   * pressed laser keeps its newest sample (the dot where it points) until LASER_HOLD_MS pass without an entry
   * (a sender whose tab stopped sending, still pressed, does not leave a dot behind for good).
   */
  trails(now: number): LaserTrailState[] {
    const out: LaserTrailState[] = []
    for (const [sid, t] of this.bySid) {
      if (t.active && now - t.lastAt > LASER_HOLD_MS) t.active = false
      const keep = t.active ? 1 : 0
      let drop = 0
      while (drop < t.points.length - keep && now - (t.points[drop] as LaserSample).at > LASER_TRAIL_MS)
        drop++
      if (drop) t.points.splice(0, drop)
      if (!t.points.length) {
        if (!t.active) this.bySid.delete(sid)
        continue
      }
      out.push({ sid, active: t.active, points: [...t.points] })
    }
    return out
  }

  /** Whether any laser has samples left to draw at `now`. */
  any(now: number): boolean {
    return this.trails(now).length > 0
  }
}
