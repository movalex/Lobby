/**
 * OWNER: 3b (navigation); wave N (WS1, N1-5, PERF-5) made it scale with the board. The level-of-detail pass for
 * zoomed-out views (docs/EXCALIDRAW-MIGRATION.md §8.5, row "Conditional: fit fps — applies"): below the LOD zoom
 * each frame's contents are drawn as ONE cached bitmap instead of every element, and a frame's bitmap is
 * invalidated by that frame's changes. This file is the bookkeeping, pure and Node-tested (./model.test.ts,
 * ./cull.test.ts): which frame (or tile) each element belongs to, which are stale, which bitmaps are current, and
 * which elements the engine may leave out of its render because a current bitmap draws them. ./index.ts runs it
 * on the board page.
 *
 * Rules:
 *  - An element belongs to the frame of its `frameId`; a bound label to its container's frame. Frames
 *    themselves (outline and name) are always drawn by the engine.
 *  - N1-5 (`sizeAware`, sync/flags.ts SIZE_AWARE_LOD): the pass turns on below zoom 0.2 on a board of at most
 *    LOD_LARGE_LIVE (1,500) live elements, and below 0.35 above it or once more than LOD_LARGE_VISIBLE (3,000) are in
 *    view (`lodActiveAt`). Bitmaps are kept per zoom bucket (0.2 and 0.35: a bucket's bitmaps are drawn at that zoom
 *    times the device pixel ratio), under an LRU cap of LOD_MEMORY_CAP (96 MB, w x h x 4; bitmaps drawn in the last
 *    paint are never evicted). Loose (unframed) elements belong to the LOD_TILE (2,048 scene px) grid cells their
 *    box meets: each such tile is a region with a bitmap of its own (its loose elements clipped to the cell), under
 *    the same staleness rule, and a loose element is culled only while every tile it meets is drawn. Without
 *    `sizeAware`: one bucket (0.2), no tiles, loose elements always live (the pass before wave N).
 *  - A change to an element marks its region stale (frame or tiles), and its OLD region when it left one (a note
 *    dragged out of a frame leaves the old bitmap stale). A change to a frame (moved, resized, renamed, deleted)
 *    marks that frame stale. A stale region's bitmaps (every bucket's) are let go of at once.
 *  - A stale region is drawn live by the engine, at once (edit visibility is unchanged: a remote edit is painted as
 *    it arrives), and is re-rendered once it has been quiet for `LOD_QUIET_MS` (a drag or a typing burst re-renders
 *    once, after it).
 *  - A region is `busy` while any of its members has a transient render override from another source (a peer's
 *    drag preview moves it; the bitmap would show it twice): busy regions are drawn live.
 *  - A render that finishes after its region changed again (or at another bucket) is dropped (it stays stale).
 */

/** Below this zoom the pass is active (§8.5), and the smaller zoom bucket. */
export const LOD_ZOOM = 0.2
/** N1-5: on a large board (or with many elements in view) the pass is active below this zoom: the larger bucket. */
export const LOD_ZOOM_LARGE = 0.35
/** N1-5: a board of more live elements than this is large. */
export const LOD_LARGE_LIVE = 1_500
/** N1-5: a view with more elements than this in it is large. */
export const LOD_LARGE_VISIBLE = 3_000
/** N1-5: the side of a loose-element tile (scene px). */
export const LOD_TILE = 2_048
/** N1-5: the bitmaps' memory cap (bytes, w x h x 4), least recently drawn evicted first. */
export const LOD_MEMORY_CAP = 96 * 1024 * 1024
/** A stale region is re-rendered after this long without changes (ms). */
export const LOD_QUIET_MS = 300
/** A bitmap's longer side, at most (px). */
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
  readonly angle?: number
  readonly points?: readonly (readonly number[])[]
}

export interface LodRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** A rendered region: the bitmap (any drawable) and the scene rectangle it covers. */
export interface LodBitmap<B = unknown> {
  readonly image: B
  readonly rect: LodRect
  /** device pixels per scene pixel it was drawn at */
  readonly scale: number
}

/**
 * Whether the pass is on at `zoom` (§8.5): below 0.2; with `sizeAware` (N1-5) below 0.35 on a board of more than
 * LOD_LARGE_LIVE live elements or with more than LOD_LARGE_VISIBLE in view.
 */
export const lodActiveAt = (zoom: number, live = 0, visible = 0, sizeAware = false): boolean =>
  Number.isFinite(zoom) && zoom > 0 && zoom < lodThreshold(live, visible, sizeAware)

/** The zoom below which the pass is on (see lodActiveAt). */
export function lodThreshold(live: number, visible: number, sizeAware = false): number {
  if (!sizeAware) return LOD_ZOOM
  return live > LOD_LARGE_LIVE || visible > LOD_LARGE_VISIBLE ? LOD_ZOOM_LARGE : LOD_ZOOM
}

/** N1-5: the bucket a zoom's bitmaps are drawn for: 0.2 below 0.2 (always, without `sizeAware`), else 0.35. */
export const lodBucketOf = (zoom: number, sizeAware = false): number =>
  !sizeAware || zoom < LOD_ZOOM ? LOD_ZOOM : LOD_ZOOM_LARGE

/**
 * The scale a region of `rect` is rendered at: what its bucket's largest zoom shows on this screen (`dpr` device
 * pixels per CSS pixel), no more than `LOD_MAX_SIDE` on the longer side.
 */
export function lodScale(rect: LodRect, dpr: number, bucket = LOD_ZOOM): number {
  const side = Math.max(1, rect.width, rect.height)
  return Math.max(0.001, Math.min(bucket * Math.max(1, dpr), LOD_MAX_SIDE / side))
}

/** A bitmap's memory: its pixels times 4 bytes. */
export const lodBytesOf = (b: LodBitmap): number =>
  Math.max(1, Math.round(b.rect.width * b.scale)) * Math.max(1, Math.round(b.rect.height * b.scale)) * 4

/** N1-5: an element's axis-aligned scene box (its points' box for a line or arrow; a rotated box's circumcircle). */
export function lodBoxOf(e: LodElement): LodRect {
  let x0 = e.x
  let y0 = e.y
  let x1 = e.x + Math.max(0, e.width)
  let y1 = e.y + Math.max(0, e.height)
  if (Array.isArray(e.points) && e.points.length) {
    x0 = y0 = Number.POSITIVE_INFINITY
    x1 = y1 = Number.NEGATIVE_INFINITY
    for (const p of e.points) {
      const px = e.x + (p[0] ?? 0)
      const py = e.y + (p[1] ?? 0)
      x0 = Math.min(x0, px)
      y0 = Math.min(y0, py)
      x1 = Math.max(x1, px)
      y1 = Math.max(y1, py)
    }
  }
  if (e.angle) {
    const cx = (x0 + x1) / 2
    const cy = (y0 + y1) / 2
    const r = Math.hypot(x1 - x0, y1 - y0) / 2
    return { x: cx - r, y: cy - r, width: 2 * r, height: 2 * r }
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

/** N1-5: the id of a tile region (never an element id: ids have no `#`). */
export const tileId = (cx: number, cy: number): string => `#tile:${cx},${cy}`
export const isTileId = (id: string): boolean => id.startsWith('#tile:')

/** N1-5: the tiles a box meets. */
export function tilesOf(r: LodRect, size = LOD_TILE): string[] {
  if (![r.x, r.y, r.width, r.height].every(Number.isFinite)) return []
  const out: string[] = []
  const cx0 = Math.floor(r.x / size)
  const cy0 = Math.floor(r.y / size)
  const cx1 = Math.floor((r.x + r.width) / size)
  const cy1 = Math.floor((r.y + r.height) / size)
  // a huge element (an arrow across the board) meets at most 64 tiles; past that it stays live (no tiles)
  if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > 64) return []
  for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) out.push(tileId(cx, cy))
  return out
}

export interface LodStats {
  readonly frames: number
  readonly tiles: number
  readonly ready: number
  readonly stale: number
  readonly rendering: number
  readonly busy: number
  readonly culled: number
  readonly bucket: number
  /** bitmaps held, every bucket */
  readonly bitmaps: number
  readonly bytes: number
  readonly evicted: number
  readonly live: number
  /** N1-5: regions in view (setView) not drawn at the current bucket yet (stale or rendering) */
  readonly pendingInView: number
}

interface Drawn<B> {
  readonly bitmap: LodBitmap<B> | null
  readonly bytes: number
  usedAt: number
}

interface Region<B> {
  readonly kind: 'frame' | 'tile'
  /** bumped by every change: a render started at an older version is dropped */
  version: number
  changedAt: number
  rect: LodRect
  /** per bucket: the bitmap (null: nothing drawable) drawn at the current version */
  readonly drawn: Map<number, Drawn<B>>
  /** the bucket being rendered now, or null */
  rendering: number | null
}

const rectOf = (e: LodElement): LodRect => ({ x: e.x, y: e.y, width: e.width, height: e.height })

export class LodModel<B = unknown> {
  /** element id → the frame it belongs to */
  private readonly memberOf = new Map<string, string>()
  /** region id (a frame or a tile) → its members */
  private readonly members = new Map<string, Set<string>>()
  private readonly regions = new Map<string, Region<B>>()
  /** N1-5: loose element → the tiles it meets (a loose label: its container's) */
  private readonly tilesOfEl = new Map<string, readonly string[]>()
  /** N1-5: every live loose element's box (a loose element over a frame stays live: no tile, see placeLoose) */
  private readonly looseBox = new Map<string, LodRect>()
  private readonly liveIds = new Set<string>()
  private busyRegions = new Set<string>()
  /** bound labels: members for the bookkeeping, never culled (the engine draws a label with its container) */
  private readonly labels = new Set<string>()
  private culledCache: Set<string> | null = null
  private bucketNow: number = LOD_ZOOM
  /** N1-5: the scene rectangle in view (setView; null: unknown, every region counts as in view) */
  private view: LodRect | null = null
  /** N1-5: the tiles are drawn (a large board, see setTilesActive); kept in the bookkeeping either way */
  private tilesOn = true
  private bytes = 0
  private evictions = 0
  /** called with every bitmap the model lets go of (replaced, its region gone or stale, evicted, a reset) */
  private readonly onDrop: (bitmap: LodBitmap<B>) => void
  private readonly sizeAware: boolean
  private readonly memoryCap: number
  private readonly tileSize: number

  constructor(
    opts: {
      onDrop?: (bitmap: LodBitmap<B>) => void
      sizeAware?: boolean
      memoryCap?: number
      tileSize?: number
    } = {},
  ) {
    this.onDrop = opts.onDrop ?? (() => {})
    this.sizeAware = opts.sizeAware ?? false
    this.memoryCap = opts.memoryCap ?? LOD_MEMORY_CAP
    this.tileSize = opts.tileSize ?? LOD_TILE
  }

  /** The bucket the reads below answer for (index.ts sets it from the zoom: lodBucketOf). */
  /**
   * N1-5: whether the loose-element tiles are drawn and culled (index.ts: on a large board, the size-aware regime);
   * off, a loose element is the engine's as before wave N, and the tiles are only kept up to date.
   */
  /**
   * N1-5: the scene rectangle in view. Under the memory cap the regions in view come first: a region out of view is
   * rendered only while the bitmaps hold under 3/4 of the cap, and a bitmap of a region in view is never evicted.
   */
  setView(view: LodRect | null): void {
    this.view = view
  }

  setTilesActive(on: boolean): void {
    if (on === this.tilesOn) return
    this.tilesOn = on
    this.culledCache = null
  }

  get tilesActive(): boolean {
    return this.tilesOn
  }

  setBucket(bucket: number): void {
    if (bucket === this.bucketNow) return
    this.bucketNow = bucket
    this.culledCache = null
  }

  get bucket(): number {
    return this.bucketNow
  }

  /** Rebuilds everything from the scene: every region stale and due at once. */
  reset(elements: Iterable<LodElement>): void {
    for (const r of this.regions.values()) this.dropDrawn(r)
    this.memberOf.clear()
    this.labels.clear()
    this.members.clear()
    this.regions.clear()
    this.tilesOfEl.clear()
    this.looseBox.clear()
    this.liveIds.clear()
    this.busyRegions.clear()
    this.culledCache = null
    const all = [...elements]
    const byId = new Map(all.map((e) => [e.id, e]))
    for (const e of all) {
      if (e.isDeleted) continue
      this.liveIds.add(e.id)
      if (e.type === 'frame') this.ensureFrame(e, Number.NEGATIVE_INFINITY)
    }
    for (const e of all) {
      if (e.isDeleted || e.type === 'frame') continue
      const f = this.frameOfElement(e, (id) => byId.get(id))
      if (e.type === 'text' && e.containerId) this.labels.add(e.id)
      if (f && this.regions.has(f)) this.join(e.id, f)
      else this.placeLoose(e, (id) => byId.get(id), Number.NEGATIVE_INFINITY)
    }
  }

  /**
   * Elements `ids` changed (created, updated or deleted) at `now`; `get` reads their current value
   * (undefined or deleted: gone). Marks their regions (old and new) stale.
   */
  changed(ids: Iterable<string>, get: (id: string) => LodElement | undefined, now: number): void {
    const list = [...ids]
    const liveOf = (id: string) => {
      const e = get(id)
      return e && !e.isDeleted ? e : undefined
    }
    // frames first: an element joining a frame created in the same batch finds it
    const rest: string[] = []
    // N1-5: the frame rectangles that changed (old and new): the loose elements over them are placed again
    const moved: LodRect[] = []
    for (const id of list) {
      const live = liveOf(id)
      if (live) this.liveIds.add(id)
      else this.liveIds.delete(id)
      if (live?.type === 'frame') {
        const had = this.regions.get(id)
        if (had) moved.push(had.rect)
        const f = this.ensureFrame(live, now)
        f.rect = rectOf(live)
        moved.push(f.rect)
        this.touch(id, now)
      } else if (!live && this.regions.get(id)?.kind === 'frame') {
        moved.push((this.regions.get(id) as Region<B>).rect)
        this.dropRegion(id)
      } else rest.push(id)
    }
    if (this.sizeAware && moved.length) {
      // (a set of the ids already in `rest`: a frame dragged with thousands of changed children over a large board
      // is one lookup per loose element, not a scan of `rest` each)
      const inRest = new Set(rest)
      for (const [id, box] of [...this.looseBox])
        if (!inRest.has(id) && moved.some((r) => meets(r, box))) {
          inRest.add(id)
          rest.push(id)
        }
    }
    for (const id of rest) {
      const live = liveOf(id)
      const before = this.memberOf.get(id)
      const after = live ? this.frameOfElement(live, get) : null
      if (live?.type === 'text' && live.containerId) this.labels.add(id)
      else this.labels.delete(id)
      if (before) this.touch(before, now)
      if (before && before !== after) this.leave(id, before)
      this.unplaceLoose(id, now)
      if (after && this.regions.has(after)) {
        if (before !== after) this.join(id, after)
        this.touch(after, now)
      } else if (live) this.placeLoose(live, get, now)
      // a container's bound labels go where it goes
      for (const b of live?.boundElements ?? []) {
        if (b.type !== 'text') continue
        this.labels.add(b.id)
        const was = this.memberOf.get(b.id)
        if (was !== (after ?? undefined)) {
          if (was) this.leave(b.id, was)
          if (after && this.regions.has(after)) this.join(b.id, after)
        }
        this.unplaceLoose(b.id, now)
        if (!after || !this.regions.has(after)) {
          const label = get(b.id)
          if (label && !label.isDeleted) this.placeLoose(label, get, now)
        }
      }
    }
  }

  /** Marks every region stale (the theme changed, image files arrived). */
  invalidateAll(now: number): void {
    for (const id of this.regions.keys()) this.touch(id, now)
  }

  /** Marks the regions of `ids` stale (their members' look changed without a document change). */
  invalidateMembers(ids: Iterable<string>, now: number): void {
    const regions = new Set<string>()
    for (const id of ids) for (const r of this.regionsOf(id)) regions.add(r)
    for (const r of regions) this.touch(r, now)
  }

  /** The ids another source moves right now (a peer's drag preview): their regions are drawn live. */
  setBusy(ids: Iterable<string>): void {
    const next = new Set<string>()
    for (const id of ids) for (const r of this.regionsOf(id)) next.add(r)
    if (next.size === this.busyRegions.size && [...next].every((f) => this.busyRegions.has(f))) return
    this.busyRegions = next
    this.culledCache = null
  }

  /** Stale regions (at the current bucket) quiet for `LOD_QUIET_MS` at `now`, `first` ones (in view) first. */
  due(now: number, first?: (rect: LodRect) => boolean): string[] {
    const out: string[] = []
    const headroom = this.bytes < this.memoryCap * 0.75
    for (const [id, r] of this.regions) {
      if (!this.on(r) || this.state(r) !== 'stale' || now - r.changedAt < LOD_QUIET_MS) continue
      // out of view, only with room to spare: it would evict what is in view, then be evicted, in a loop
      if (!headroom && !this.inView(r)) continue
      out.push(id)
    }
    if (!first) return out
    const a = out.filter((id) => first((this.regions.get(id) as Region<B>).rect))
    return [...a, ...out.filter((id) => !a.includes(id))]
  }

  /** The earliest time a stale region becomes due (for the scheduler), or null. */
  nextDue(): number | null {
    let t: number | null = null
    for (const r of this.regions.values()) {
      if (!this.on(r) || this.state(r) !== 'stale') continue
      const at = r.changedAt + LOD_QUIET_MS
      t = t === null ? at : Math.min(t, at)
    }
    return t
  }

  /** A render of region `id` at the current bucket starts: what to draw and the version to hand back to `finish`. */
  start(id: string): {
    version: number
    rect: LodRect
    bucket: number
    kind: 'frame' | 'tile'
    members: readonly string[]
  } | null {
    const r = this.regions.get(id)
    if (!r || this.state(r) !== 'stale') return null
    r.rendering = this.bucketNow
    return {
      version: r.version,
      rect: r.rect,
      bucket: this.bucketNow,
      kind: r.kind,
      members: [...(this.members.get(id) ?? [])],
    }
  }

  /** A render finished: kept when the region did not change meanwhile; true when it was kept. */
  finish(id: string, version: number, bitmap: LodBitmap<B> | null, now = 0): boolean {
    const r = this.regions.get(id)
    if (!r || r.version !== version || r.rendering === null) return false
    const bucket = r.rendering
    r.rendering = null
    const old = r.drawn.get(bucket)
    if (old?.bitmap && old.bitmap !== bitmap) this.release(old)
    else if (old) this.bytes -= old.bytes
    const bytes = bitmap ? lodBytesOf(bitmap) : 0
    r.drawn.set(bucket, { bitmap, bytes, usedAt: now })
    this.bytes += bytes
    if (bucket === this.bucketNow) this.culledCache = null
    this.enforceCap(now)
    return true
  }

  /**
   * The bitmaps to draw at the current bucket: ready, not busy, with a bitmap; `now` marks them used (the LRU).
   * Frames first, then tiles.
   */
  drawable(now?: number): { id: string; bitmap: LodBitmap<B> }[] {
    const frames: { id: string; bitmap: LodBitmap<B> }[] = []
    const tiles: { id: string; bitmap: LodBitmap<B> }[] = []
    for (const [id, r] of this.regions) {
      if (!this.on(r) || this.busyRegions.has(id) || this.state(r) !== 'ready') continue
      const d = r.drawn.get(this.bucketNow)
      if (!d?.bitmap) continue
      if (now !== undefined) d.usedAt = now
      ;(r.kind === 'frame' ? frames : tiles).push({ id, bitmap: d.bitmap })
    }
    return [...frames, ...tiles]
  }

  /**
   * The elements the engine may leave out of its render: the members of every drawable frame, and (N1-5) every
   * loose element whose tiles are all drawable. Never a bound label.
   */
  culled(): ReadonlySet<string> {
    if (this.culledCache) return this.culledCache
    const out = new Set<string>()
    const drawn = new Set(this.drawable().map((d) => d.id))
    for (const id of drawn) {
      const r = this.regions.get(id) as Region<B>
      if (r.kind !== 'frame') continue
      for (const m of this.members.get(id) ?? []) if (!this.labels.has(m)) out.add(m)
    }
    for (const [id, tiles] of this.tilesOfEl)
      if (!this.labels.has(id) && tiles.length && tiles.every((t) => drawn.has(t))) out.add(id)
    this.culledCache = out
    return out
  }

  /** The frame an element belongs to (tests and the change mapping). */
  frameOf(id: string): string | null {
    return this.memberOf.get(id) ?? null
  }

  /** N1-5: the tiles a loose element belongs to (empty for a framed one). */
  tilesOfElement(id: string): readonly string[] {
    return this.tilesOfEl.get(id) ?? []
  }

  /** N1-5: live elements the model knows. */
  liveCount(): number {
    return this.liveIds.size
  }

  /** N1-5: about how many elements are in view: the members of every region that meets `view`. */
  visibleCount(view: LodRect): number {
    let n = 0
    for (const [id, r] of this.regions)
      if (meets(r.rect, view)) n += (this.members.get(id)?.size ?? 0) + (r.kind === 'frame' ? 1 : 0)
    return n
  }

  /** The region rectangles (tests, the layer's evidence). */
  regionRect(id: string): LodRect | null {
    return this.regions.get(id)?.rect ?? null
  }

  stats(): LodStats {
    let ready = 0
    let stale = 0
    let rendering = 0
    let frames = 0
    let tiles = 0
    let bitmaps = 0
    let pendingInView = 0
    for (const r of this.regions.values()) {
      if (r.kind === 'frame') frames++
      else tiles++
      bitmaps += [...r.drawn.values()].filter((d) => d.bitmap).length
      if (!this.on(r)) continue
      const s = this.state(r)
      if (s !== 'ready' && this.inView(r)) pendingInView++
      if (s === 'ready') ready++
      else if (s === 'stale') stale++
      else rendering++
    }
    return {
      frames,
      tiles,
      ready,
      stale,
      rendering,
      busy: this.busyRegions.size,
      culled: this.culled().size,
      bucket: this.bucketNow,
      bitmaps,
      bytes: this.bytes,
      evicted: this.evictions,
      live: this.liveIds.size,
      pendingInView,
    }
  }

  // ---- internals ----

  /** Whether a region meets the view (every region, when the view is unknown). */
  private inView(r: Region<B>): boolean {
    return !this.view || meets(r.rect, this.view)
  }

  /** A region the pass works on now (a tile only while tiles are active). */
  private on(r: Region<B>): boolean {
    return r.kind === 'frame' || this.tilesOn
  }

  private state(r: Region<B>): 'stale' | 'rendering' | 'ready' {
    if (r.rendering === this.bucketNow) return 'rendering'
    return r.drawn.has(this.bucketNow) ? 'ready' : 'stale'
  }

  private frameOfElement(e: LodElement, get: (id: string) => LodElement | undefined): string | null {
    if (e.type === 'text' && e.containerId) {
      const c = get(e.containerId)
      return c && !c.isDeleted ? (c.frameId ?? null) : null
    }
    return e.frameId ?? null
  }

  /** The regions an element belongs to (a frame's own id included). */
  private regionsOf(id: string): string[] {
    if (this.regions.get(id)?.kind === 'frame') return [id]
    const f = this.memberOf.get(id)
    if (f) return [f]
    return [...(this.tilesOfEl.get(id) ?? [])]
  }

  /**
   * N1-5: a loose element (no frame) joins the tiles its box meets (a label: its container's). One over a frame
   * stays live (no tile): a tile's bitmap is drawn above the frames' and would cover their contents.
   */
  private placeLoose(e: LodElement, get: (id: string) => LodElement | undefined, now: number): void {
    if (!this.sizeAware || e.type === 'frame') return
    let box: LodRect = lodBoxOf(e)
    if (e.type === 'text' && e.containerId) {
      const c = get(e.containerId)
      if (c && !c.isDeleted) box = lodBoxOf(c)
    }
    this.looseBox.set(e.id, box)
    for (const r of this.regions.values()) if (r.kind === 'frame' && meets(r.rect, box)) return
    const tiles = tilesOf(box, this.tileSize)
    if (!tiles.length) return
    this.tilesOfEl.set(e.id, tiles)
    for (const t of tiles) {
      this.ensureTile(t, now)
      let set = this.members.get(t)
      if (!set) {
        set = new Set()
        this.members.set(t, set)
      }
      set.add(e.id)
      this.touch(t, now)
    }
  }

  /** N1-5: a loose element leaves its tiles and its box (it changed, joined a frame, or went). */
  private unplaceLoose(id: string, now: number): void {
    this.looseBox.delete(id)
    this.leaveTiles(id, now)
  }

  /** N1-5: a loose element leaves its tiles (an empty tile goes). */
  private leaveTiles(id: string, now: number): void {
    const tiles = this.tilesOfEl.get(id)
    if (!tiles) return
    this.tilesOfEl.delete(id)
    for (const t of tiles) {
      const set = this.members.get(t)
      set?.delete(id)
      if (set && !set.size) this.dropRegion(t)
      else this.touch(t, now)
    }
    this.culledCache = null
  }

  private ensureFrame(e: LodElement, changedAt: number): Region<B> {
    let f = this.regions.get(e.id)
    if (!f) {
      f = { kind: 'frame', version: 0, changedAt, rect: rectOf(e), drawn: new Map(), rendering: null }
      this.regions.set(e.id, f)
      if (!this.members.has(e.id)) this.members.set(e.id, new Set())
      this.culledCache = null
    }
    return f
  }

  private ensureTile(id: string, changedAt: number): Region<B> {
    let t = this.regions.get(id)
    if (!t) {
      const [cx, cy] = id
        .slice('#tile:'.length)
        .split(',')
        .map((n) => Number(n)) as [number, number]
      t = {
        kind: 'tile',
        version: 0,
        changedAt,
        rect: { x: cx * this.tileSize, y: cy * this.tileSize, width: this.tileSize, height: this.tileSize },
        drawn: new Map(),
        rendering: null,
      }
      this.regions.set(id, t)
      this.culledCache = null
    }
    return t
  }

  private dropRegion(id: string): void {
    const r = this.regions.get(id)
    if (r) this.dropDrawn(r)
    this.regions.delete(id)
    for (const m of this.members.get(id) ?? []) {
      if (this.memberOf.get(m) === id) this.memberOf.delete(m)
      const tiles = this.tilesOfEl.get(m)
      if (tiles?.includes(id)) {
        const rest = tiles.filter((t) => t !== id)
        if (rest.length) this.tilesOfEl.set(m, rest)
        else this.tilesOfEl.delete(m)
      }
    }
    this.members.delete(id)
    this.busyRegions.delete(id)
    this.culledCache = null
  }

  private release(d: Drawn<B>): void {
    this.bytes -= d.bytes
    if (d.bitmap) this.onDrop(d.bitmap)
  }

  private dropDrawn(r: Region<B>): void {
    for (const d of r.drawn.values()) this.release(d)
    r.drawn.clear()
  }

  private touch(id: string, now: number): void {
    const r = this.regions.get(id)
    if (!r) return
    r.version++
    r.changedAt = now
    if (r.rendering !== null) r.rendering = null
    if (r.drawn.size) {
      this.dropDrawn(r)
      this.culledCache = null
    }
  }

  /**
   * N1-5: the LRU cap: while the bitmaps hold more than `memoryCap` bytes, the least recently drawn goes (another
   * bucket's first), never one drawn at `now` (the last paint's): its region is stale at that bucket again.
   */
  private enforceCap(now: number): void {
    if (this.bytes <= this.memoryCap) return
    const all: { r: Region<B>; bucket: number; d: Drawn<B>; id: string }[] = []
    // never one of the last paint, nor one of the current bucket in view (it is drawn, or about to be)
    for (const [id, r] of this.regions)
      for (const [bucket, d] of r.drawn)
        if (d.bitmap && d.usedAt < now && !(bucket === this.bucketNow && this.inView(r)))
          all.push({ r, bucket, d, id })
    all.sort((a, b) => {
      const ao = a.bucket === this.bucketNow ? 1 : 0
      const bo = b.bucket === this.bucketNow ? 1 : 0
      return ao !== bo ? ao - bo : a.d.usedAt - b.d.usedAt
    })
    for (const x of all) {
      if (this.bytes <= this.memoryCap) break
      x.r.drawn.delete(x.bucket)
      this.release(x.d)
      this.evictions++
      if (x.bucket === this.bucketNow) this.culledCache = null
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

const meets = (a: LodRect, b: LodRect) =>
  a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y
