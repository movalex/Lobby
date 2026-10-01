/**
 * OWNER: 3b (navigation). The level-of-detail pass for zoomed-out views (docs/EXCALIDRAW-MIGRATION.md
 * §8.5, row "Conditional: fit fps — applies"): below zoom 0.2 each frame's contents are drawn as ONE
 * cached bitmap instead of every element, and a frame's bitmap is invalidated by that frame's changes.
 * This file is the bookkeeping, pure and Node-tested (./model.test.ts): which frame each element belongs
 * to, which frames are stale, which bitmaps are current, and which elements the engine may leave out of
 * its render because a current bitmap draws them. ./index.ts runs it on the board page.
 *
 * Rules:
 *  - An element belongs to the frame of its `frameId`; a bound label to its container's frame. Frames
 *    themselves (outline and name) are always drawn by the engine; loose elements too.
 *  - A change to an element marks its frame stale, and its OLD frame when it left one (a note dragged
 *    out of a frame leaves the old bitmap stale). A change to a frame (moved, resized, renamed, deleted)
 *    marks that frame stale.
 *  - A stale frame is drawn live by the engine, at once (edit visibility is unchanged: a remote edit is
 *    painted as it arrives), and is re-rendered once it has been quiet for `LOD_QUIET_MS` (a drag or a
 *    typing burst re-renders once, after it).
 *  - A frame is `busy` while any of its members has a transient render override from another source (a
 *    peer's drag preview moves it; the bitmap would show it twice): busy frames are drawn live.
 *  - A render that finishes after its frame changed again is dropped (the frame stays stale).
 */

/** Below this zoom the pass is active (§8.5). */
export const LOD_ZOOM = 0.2
/** A stale frame is re-rendered after this long without changes (ms). */
export const LOD_QUIET_MS = 300
/** A frame bitmap's longer side, at most (px). */
export const LOD_MAX_SIDE = 2048

/** The slice of an element the pass reads (the engine's element satisfies it). */
export interface LodElement {
  readonly id: string
  readonly type: string
  readonly isDeleted?: boolean
  readonly frameId?: string | null
  readonly containerId?: string | null
  readonly boundElements?: readonly { readonly id: string; readonly type: string }[] | null
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface LodRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** A rendered frame: the bitmap (any drawable) and the scene rectangle it covers. */
export interface LodBitmap<B = unknown> {
  readonly image: B
  readonly rect: LodRect
  /** device pixels per scene pixel it was drawn at */
  readonly scale: number
}

type FrameState = 'stale' | 'rendering' | 'ready'

interface FrameEntry<B> {
  state: FrameState
  /** bumped by every change: a render started at an older version is dropped */
  version: number
  changedAt: number
  bitmap: LodBitmap<B> | null
  rect: LodRect
}

/** Whether the pass is on at `zoom` (§8.5: below 0.2). */
export const lodActiveAt = (zoom: number): boolean => Number.isFinite(zoom) && zoom > 0 && zoom < LOD_ZOOM

/**
 * The scale a frame of `rect` is rendered at: what the largest LOD zoom shows on this screen (`dpr`
 * device pixels per CSS pixel), no more than `LOD_MAX_SIDE` on the longer side.
 */
export function lodScale(rect: LodRect, dpr: number): number {
  const side = Math.max(1, rect.width, rect.height)
  return Math.max(0.001, Math.min(LOD_ZOOM * Math.max(1, dpr), LOD_MAX_SIDE / side))
}

export interface LodStats {
  readonly frames: number
  readonly ready: number
  readonly stale: number
  readonly rendering: number
  readonly busy: number
  readonly culled: number
}

export class LodModel<B = unknown> {
  /** element id → the frame it belongs to */
  private readonly memberOf = new Map<string, string>()
  /** frame id → its members */
  private readonly members = new Map<string, Set<string>>()
  private readonly frames = new Map<string, FrameEntry<B>>()
  private busyFrames = new Set<string>()
  /** bound labels: members for the bookkeeping, never culled (the engine draws a label with its container) */
  private readonly labels = new Set<string>()
  private culledCache: Set<string> | null = null
  /** called with every bitmap the model lets go of (replaced, its frame gone, a reset): free it there */
  private readonly onDrop: (bitmap: LodBitmap<B>) => void

  constructor(opts: { onDrop?: (bitmap: LodBitmap<B>) => void } = {}) {
    this.onDrop = opts.onDrop ?? (() => {})
  }

  /** Rebuilds everything from the scene: every frame stale and due at once. */
  reset(elements: Iterable<LodElement>): void {
    for (const f of this.frames.values()) if (f.bitmap) this.onDrop(f.bitmap)
    this.memberOf.clear()
    this.labels.clear()
    this.members.clear()
    this.frames.clear()
    this.culledCache = null
    const all = [...elements]
    const byId = new Map(all.map((e) => [e.id, e]))
    for (const e of all) {
      if (e.isDeleted) continue
      if (e.type === 'frame') this.ensureFrame(e, Number.NEGATIVE_INFINITY)
    }
    for (const e of all) {
      if (e.isDeleted || e.type === 'frame') continue
      const f = this.frameOfElement(e, (id) => byId.get(id))
      if (e.type === 'text' && e.containerId) this.labels.add(e.id)
      if (f && this.frames.has(f)) this.join(e.id, f)
    }
  }

  /**
   * Elements `ids` changed (created, updated or deleted) at `now`; `get` reads their current value
   * (undefined or deleted: gone). Marks their frames (old and new) stale.
   */
  changed(ids: Iterable<string>, get: (id: string) => LodElement | undefined, now: number): void {
    const list = [...ids]
    const liveOf = (id: string) => {
      const e = get(id)
      return e && !e.isDeleted ? e : undefined
    }
    // frames first: an element joining a frame created in the same batch finds it
    const rest: string[] = []
    for (const id of list) {
      const live = liveOf(id)
      if (live?.type === 'frame') {
        const f = this.ensureFrame(live, now)
        f.rect = rectOf(live)
        this.touch(id, now)
      } else if (!live && this.frames.has(id)) this.dropFrame(id)
      else rest.push(id)
    }
    for (const id of rest) {
      const live = liveOf(id)
      const before = this.memberOf.get(id)
      const after = live ? this.frameOfElement(live, get) : null
      if (live?.type === 'text' && live.containerId) this.labels.add(id)
      else this.labels.delete(id)
      if (before) this.touch(before, now)
      if (before && before !== after) this.leave(id, before)
      if (after && this.frames.has(after)) {
        if (before !== after) this.join(id, after)
        this.touch(after, now)
      }
      // a container's bound labels go where it goes
      for (const b of live?.boundElements ?? []) {
        if (b.type !== 'text') continue
        this.labels.add(b.id)
        const was = this.memberOf.get(b.id)
        if (was === (after ?? undefined)) continue
        if (was) this.leave(b.id, was)
        if (after && this.frames.has(after)) this.join(b.id, after)
      }
    }
  }

  /** Marks every frame stale (the theme changed, image files arrived). */
  invalidateAll(now: number): void {
    for (const id of this.frames.keys()) this.touch(id, now)
  }

  /** Marks the frames of `ids` stale (their members' look changed without a document change). */
  invalidateMembers(ids: Iterable<string>, now: number): void {
    const frames = new Set<string>()
    for (const id of ids) {
      const f = this.frames.has(id) ? id : this.memberOf.get(id)
      if (f) frames.add(f)
    }
    for (const f of frames) this.touch(f, now)
  }

  /** The ids another source moves right now (a peer's drag preview): their frames are drawn live. */
  setBusy(ids: Iterable<string>): void {
    const next = new Set<string>()
    for (const id of ids) {
      const f = this.frames.has(id) ? id : this.memberOf.get(id)
      if (f) next.add(f)
    }
    if (next.size === this.busyFrames.size && [...next].every((f) => this.busyFrames.has(f))) return
    this.busyFrames = next
    this.culledCache = null
  }

  /** Stale frames quiet for `LOD_QUIET_MS` at `now`, `first` ones (in view) first. */
  due(now: number, first?: (rect: LodRect) => boolean): string[] {
    const out: string[] = []
    for (const [id, f] of this.frames) {
      if (f.state !== 'stale' || now - f.changedAt < LOD_QUIET_MS) continue
      out.push(id)
    }
    if (!first) return out
    const a = out.filter((id) => first((this.frames.get(id) as FrameEntry<B>).rect))
    return [...a, ...out.filter((id) => !a.includes(id))]
  }

  /** The earliest time a stale frame becomes due (for the scheduler), or null. */
  nextDue(): number | null {
    let t: number | null = null
    for (const f of this.frames.values()) {
      if (f.state !== 'stale') continue
      const at = f.changedAt + LOD_QUIET_MS
      t = t === null ? at : Math.min(t, at)
    }
    return t
  }

  /** A render of frame `id` starts: its rectangle and the version to hand back to `finish`. */
  start(id: string): { version: number; rect: LodRect } | null {
    const f = this.frames.get(id)
    if (f?.state !== 'stale') return null
    f.state = 'rendering'
    return { version: f.version, rect: f.rect }
  }

  /** A render finished: kept when the frame did not change meanwhile; true when it was kept. */
  finish(id: string, version: number, bitmap: LodBitmap<B> | null): boolean {
    const f = this.frames.get(id)
    if (!f || f.version !== version || f.state !== 'rendering') return false
    if (f.bitmap && f.bitmap !== bitmap) this.onDrop(f.bitmap)
    if (!bitmap) {
      // nothing drawable (an empty frame, a failed render): drawn live, retried on its next change
      f.state = 'ready'
      f.bitmap = null
      this.culledCache = null
      return true
    }
    f.state = 'ready'
    f.bitmap = bitmap
    this.culledCache = null
    return true
  }

  /** The bitmaps to draw: ready, not busy, with a bitmap. */
  drawable(): { id: string; bitmap: LodBitmap<B> }[] {
    const out: { id: string; bitmap: LodBitmap<B> }[] = []
    for (const [id, f] of this.frames) {
      if (f.state === 'ready' && f.bitmap && !this.busyFrames.has(id)) out.push({ id, bitmap: f.bitmap })
    }
    return out
  }

  /** The elements the engine may leave out of its render: the members of every drawable frame. */
  culled(): ReadonlySet<string> {
    if (this.culledCache) return this.culledCache
    const out = new Set<string>()
    for (const { id } of this.drawable())
      for (const m of this.members.get(id) ?? []) if (!this.labels.has(m)) out.add(m)
    this.culledCache = out
    return out
  }

  /** The frame an element belongs to (tests and the change mapping). */
  frameOf(id: string): string | null {
    return this.memberOf.get(id) ?? null
  }

  stats(): LodStats {
    let ready = 0
    let stale = 0
    let rendering = 0
    for (const f of this.frames.values()) {
      if (f.state === 'ready') ready++
      else if (f.state === 'stale') stale++
      else rendering++
    }
    return {
      frames: this.frames.size,
      ready,
      stale,
      rendering,
      busy: this.busyFrames.size,
      culled: this.culled().size,
    }
  }

  // ---- internals ----

  private frameOfElement(e: LodElement, get: (id: string) => LodElement | undefined): string | null {
    if (e.type === 'text' && e.containerId) {
      const c = get(e.containerId)
      return c && !c.isDeleted ? (c.frameId ?? null) : null
    }
    return e.frameId ?? null
  }

  private ensureFrame(e: LodElement, changedAt: number): FrameEntry<B> {
    let f = this.frames.get(e.id)
    if (!f) {
      f = { state: 'stale', version: 0, changedAt, bitmap: null, rect: rectOf(e) }
      this.frames.set(e.id, f)
      if (!this.members.has(e.id)) this.members.set(e.id, new Set())
      this.culledCache = null
    }
    return f
  }

  private dropFrame(id: string): void {
    const f = this.frames.get(id)
    if (f?.bitmap) this.onDrop(f.bitmap)
    this.frames.delete(id)
    for (const m of this.members.get(id) ?? []) this.memberOf.delete(m)
    this.members.delete(id)
    this.busyFrames.delete(id)
    this.culledCache = null
  }

  private touch(id: string, now: number): void {
    const f = this.frames.get(id)
    if (!f) return
    f.version++
    f.changedAt = now
    if (f.state !== 'stale') {
      f.state = 'stale'
      this.culledCache = null
    }
  }

  private join(id: string, frame: string): void {
    this.memberOf.set(id, frame)
    let set = this.members.get(frame)
    if (!set) {
      set = new Set()
      this.members.set(frame, set)
    }
    set.add(id)
    this.culledCache = null
  }

  private leave(id: string, frame: string): void {
    this.memberOf.delete(id)
    this.members.get(frame)?.delete(id)
    this.culledCache = null
  }
}

const rectOf = (e: LodElement): LodRect => ({ x: e.x, y: e.y, width: e.width, height: e.height })
