// 3b's render seam (./cull.ts): the culled ids join the board overrides' snapshot without replacing any of
// its entries, the engine API is otherwise forwarded, and the pass learns what the overrides move. Node only.
import type { ElementRenderOverrides, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { describe, expect, it } from 'vitest'
import { createLodTarget, LOD_CULL_OFFSET, mergeCulled, splitSnapshot } from './cull.ts'
import { LOD_QUIET_MS, LOD_TILE, type LodElement, LodModel, lodBytesOf, lodScale, tileId } from './model.ts'

const snap = (entries: [string, { opacity?: number; offset?: { x: number; y: number } }][]) =>
  new Map(entries) as ElementRenderOverrides

describe('mergeCulled', () => {
  it('adds a far render offset for each culled id the snapshot does not name', () => {
    const out = mergeCulled(snap([['drag', { offset: { x: 5, y: 0 } }]]), new Set(['a', 'drag']))
    expect(out?.get('a')).toEqual({ offset: LOD_CULL_OFFSET })
    expect(out?.get('drag')).toEqual({ offset: { x: 5, y: 0 } })
  })

  it('is the snapshot itself (or null) when nothing is culled', () => {
    const s = snap([['x', { opacity: 0 }]])
    expect(mergeCulled(s, new Set())).toBe(s)
    expect(mergeCulled(null, new Set())).toBeNull()
    expect(mergeCulled(new Map(), new Set())).toBeNull()
  })

  it('splits a snapshot into what it moves and what it fades', () => {
    const { moved, opacity } = splitSnapshot(
      snap([
        ['m', { offset: { x: 1, y: 2 } }],
        ['z', { offset: { x: 0, y: 0 } }],
        ['h', { opacity: 0 }],
      ]),
    )
    expect([...moved]).toEqual(['m'])
    expect([...opacity]).toEqual([['h', 0]])
  })
})

describe('createLodTarget', () => {
  const fakeApi = () => {
    const submitted: (ElementRenderOverrides | null)[] = []
    const api = {
      isDestroyed: false,
      getAppState: () => ({ zoom: { value: 0.1 } }),
      setElementRenderOverrides: (o: ElementRenderOverrides | null) => submitted.push(o),
    } as unknown as ExcalidrawImperativeAPI
    return { api, submitted }
  }

  it('forwards the engine API and merges every snapshot the board overrides submit', () => {
    const { api, submitted } = fakeApi()
    const t = createLodTarget(api)
    expect(t.api.getAppState()).toEqual({ zoom: { value: 0.1 } })
    t.setCulled(new Set(['n1', 'n2']))
    expect([...(submitted.at(-1)?.keys() ?? [])].sort()).toEqual(['n1', 'n2'])
    // RenderOverrides submits a drag preview of n1: its entry wins, n2 stays culled
    t.api.setElementRenderOverrides(snap([['n1', { offset: { x: 10, y: 0 } }]]))
    expect(submitted.at(-1)?.get('n1')).toEqual({ offset: { x: 10, y: 0 } })
    expect(submitted.at(-1)?.get('n2')).toEqual({ offset: LOD_CULL_OFFSET })
    expect([...t.moved()]).toEqual(['n1'])
    // the preview ends; nothing culled: the engine gets null
    t.api.setElementRenderOverrides(null)
    t.setCulled(null)
    expect(submitted.at(-1)).toBeNull()
  })

  it('skips a culled set equal to the last one, and names the ids whose opacity changed', () => {
    const { api, submitted } = fakeApi()
    const t = createLodTarget(api)
    const changes: string[][] = []
    t.onSnapshot((c) => changes.push([...c].sort()))
    t.setCulled(new Set(['a']))
    const n = submitted.length
    t.setCulled(new Set(['a']))
    expect(submitted.length).toBe(n)
    t.api.setElementRenderOverrides(snap([['h', { opacity: 0 }]]))
    t.api.setElementRenderOverrides(snap([['h', { opacity: 0 }]]))
    t.api.setElementRenderOverrides(null)
    expect(changes).toEqual([['h'], [], ['h']])
  })
})

// N1-5 (wave N, PERF-5): loose elements in 2,048-px tiles, staleness after a peer's edit, and the 96 MB LRU cap. What
// the model says may be culled goes through mergeCulled (the one render seam), as for frames.
describe('N1-5: tiles, staleness and the memory cap', () => {
  type El = LodElement
  const rect = (id: string, x: number, y: number, w = 200, h = 140): El => ({
    id,
    type: 'rectangle',
    frameId: null,
    x,
    y,
    width: w,
    height: h,
  })
  const frame = (id: string, x: number, y: number, w = 1000, h = 800): El => ({
    id,
    type: 'frame',
    x,
    y,
    width: w,
    height: h,
  })
  const note = (id: string, frameId: string): El => ({
    id,
    type: 'stickynote',
    frameId,
    x: 10,
    y: 10,
    width: 200,
    height: 200,
  })
  function scene(initial: El[]) {
    const map = new Map(initial.map((e) => [e.id, e]))
    return {
      map,
      all: () => [...map.values()],
      get: (id: string) => map.get(id),
      set: (e: El) => map.set(e.id, e),
    }
  }
  const renderDue = (m: LodModel<string>, now: number) => {
    for (const id of m.due(now)) {
      const job = m.start(id)
      if (job)
        m.finish(
          id,
          job.version,
          { image: id, rect: job.rect, scale: lodScale(job.rect, 1, job.bucket) },
          now,
        )
    }
  }

  it('loose elements join the tiles their box meets; one is culled only while every tile it meets is drawn', () => {
    const s = scene([
      rect('a', 100, 100),
      // across the line between tiles (0,0) and (1,0)
      rect('b', LOD_TILE - 50, 100),
      rect('c', 3 * LOD_TILE + 10, 10),
    ])
    const m = new LodModel<string>({ sizeAware: true })
    m.reset(s.all())
    expect(m.tilesOfElement('a')).toEqual([tileId(0, 0)])
    expect(m.tilesOfElement('b')).toEqual([tileId(0, 0), tileId(1, 0)])
    expect(m.stats()).toMatchObject({ frames: 0, tiles: 3 })
    expect(m.regionRect(tileId(1, 0))).toEqual({ x: LOD_TILE, y: 0, width: LOD_TILE, height: LOD_TILE })
    // one tile drawn: a is culled; b also needs (1,0)
    const job = m.start(tileId(0, 0))
    expect(job?.kind).toBe('tile')
    expect([...(job?.members ?? [])].sort()).toEqual(['a', 'b'])
    m.finish(tileId(0, 0), job?.version ?? -1, { image: 't00', rect: rect('x', 0, 0), scale: 0.2 })
    expect([...m.culled()]).toEqual(['a'])
    renderDue(m, 0)
    expect([...m.culled()].sort()).toEqual(['a', 'b', 'c'])
    // the render seam culls them as it culls frame members
    const merged = mergeCulled(null, m.culled())
    expect([...(merged?.keys() ?? [])].sort()).toEqual(['a', 'b', 'c'])
    expect(merged?.get('b')).toEqual({ offset: LOD_CULL_OFFSET })
  })

  it('tiles inactive (a small board): loose elements stay the engine’s, no tile is due, stats count frames only', () => {
    const s = scene([frame('F1', 0, 0), note('N1', 'F1'), rect('a', 5000, 5000)])
    const m = new LodModel<string>({ sizeAware: true })
    m.reset(s.all())
    m.setTilesActive(false)
    expect(m.tilesOfElement('a')).toHaveLength(1)
    expect(m.due(0)).toEqual(['F1'])
    renderDue(m, 0)
    expect([...m.culled()]).toEqual(['N1'])
    expect(m.stats()).toMatchObject({ frames: 1, tiles: 1, ready: 1, stale: 0 })
    m.setTilesActive(true)
    expect(m.due(0)).toEqual([tileId(2, 2)])
  })

  it('a loose element over a frame stays live (no tile: a tile is drawn above the frames)', () => {
    const s = scene([frame('F1', 0, 0), note('N1', 'F1'), rect('over', 900, 700), rect('away', 5000, 5000)])
    const m = new LodModel<string>({ sizeAware: true })
    m.reset(s.all())
    expect(m.tilesOfElement('over')).toEqual([])
    expect(m.tilesOfElement('away')).toHaveLength(1)
    renderDue(m, 0)
    expect([...m.culled()].sort()).toEqual(['N1', 'away'])
    // the frame moves away: the element is tiled again
    s.set(frame('F1', 20_000, 0))
    m.changed(['F1'], s.get, 5)
    expect(m.tilesOfElement('over')).toHaveLength(1)
  })

  it("a peer's edit makes its tile stale: drawn live at once (not culled), re-rendered once quiet", () => {
    const s = scene([rect('a', 100, 100), rect('b', 400, 100), rect('c', 5000, 100)])
    const m = new LodModel<string>({ sizeAware: true })
    m.reset(s.all())
    renderDue(m, 0)
    expect([...m.culled()].sort()).toEqual(['a', 'b', 'c'])
    // another user's change arrives (a remote apply reaches the pass as a change batch)
    s.set({ ...rect('a', 100, 100), width: 300 })
    m.changed(['a'], s.get, 1_000)
    expect([...m.culled()]).toEqual(['c'])
    expect(m.drawable(1_000).map((d) => d.id)).toEqual([tileId(2, 0)])
    expect(m.due(1_000 + LOD_QUIET_MS - 1)).toEqual([])
    expect(m.due(1_000 + LOD_QUIET_MS)).toEqual([tileId(0, 0)])
    // moved to another tile: both are stale
    renderDue(m, 1_000 + LOD_QUIET_MS)
    s.set(rect('b', 5_100, 100))
    m.changed(['b'], s.get, 2_000)
    expect(m.tilesOfElement('b')).toEqual([tileId(2, 0)])
    expect(m.stats().stale).toBe(2)
    // gone: a tile goes when it is empty
    s.set({ ...rect('c', 5000, 100), isDeleted: true })
    s.set({ ...rect('b', 5_100, 100), isDeleted: true })
    m.changed(['b', 'c'], s.get, 3_000)
    expect(m.regionRect(tileId(2, 0))).toBeNull()
  })

  it("the LRU cap: past it the least recently drawn bitmap goes (another bucket's first), never one of the last paint", () => {
    const dropped: string[] = []
    const s = scene([rect('a', 10, 10), rect('b', LOD_TILE + 10, 10), rect('c', 2 * LOD_TILE + 10, 10)])
    // each bitmap 100 x 100 px at scale 1: 40 kB; a cap of 80 kB holds two
    expect(lodBytesOf({ image: 'x', rect: { x: 0, y: 0, width: 100, height: 100 }, scale: 1 })).toBe(40_000)
    const m = new LodModel<string>({
      sizeAware: true,
      memoryCap: 80_000,
      onDrop: (b) => dropped.push(b.image),
    })
    m.reset(s.all())
    const draw = (id: string, at: number, image: string, bucket = 0.2) => {
      m.setBucket(bucket)
      const job = m.start(id)
      if (job)
        m.finish(id, job.version, { image, rect: { ...job.rect, width: 100, height: 100 }, scale: 1 }, at)
    }
    draw(tileId(0, 0), 1, 'a@0.2')
    draw(tileId(1, 0), 2, 'b@0.2')
    // a bitmap at the other bucket: over the cap, the oldest (a, at 0.2) goes
    draw(tileId(2, 0), 3, 'c@0.35', 0.35)
    expect(dropped).toEqual(['a@0.2'])
    // back at 0.2: b is drawn by the paint at 10; c's 0.2 bitmap then evicts the other bucket's (c@0.35) first
    m.setBucket(0.2)
    m.drawable(10)
    draw(tileId(2, 0), 10, 'c@0.2')
    expect(dropped).toEqual(['a@0.2', 'c@0.35'])
    expect(m.stats()).toMatchObject({ bitmaps: 2, bytes: 80_000, evicted: 2 })
    expect(
      m
        .drawable(11)
        .map((d) => d.bitmap.image)
        .sort(),
    ).toEqual(['b@0.2', 'c@0.2'])
    // only tile (0,0) in view now: a (evicted) is stale at 0.2 again and due (in view), and its new bitmap evicts one
    // of the bitmaps out of view (b and c, both drawn at 11), never one in view
    m.setView({ x: 0, y: 0, width: 100, height: 100 })
    expect(m.stats().pendingInView).toBe(1)
    expect(m.due(20)).toEqual([tileId(0, 0)])
    draw(tileId(0, 0), 20, 'a2@0.2')
    expect(dropped).toHaveLength(3)
    expect(m.stats().bytes).toBeLessThanOrEqual(80_000)
    expect(m.drawable(21).map((d) => d.bitmap.image)).toContain('a2@0.2')
    expect(m.stats().pendingInView).toBe(0)
    // with no room to spare, a stale region out of view is not rendered (it would evict, then be evicted, in a loop)
    expect(m.due(30)).toEqual([])
  })

  it('a bitmap in view is never evicted, even past the cap; out of view ones go first', () => {
    const dropped: string[] = []
    const s = scene([rect('a', 10, 10), rect('b', LOD_TILE + 10, 10), rect('c', 2 * LOD_TILE + 10, 10)])
    const m = new LodModel<string>({
      sizeAware: true,
      memoryCap: 40_000,
      onDrop: (b) => dropped.push(b.image),
    })
    m.reset(s.all())
    // tiles (0,0) and (1,0) in view
    m.setView({ x: 0, y: 0, width: LOD_TILE + 100, height: 100 })
    const draw = (id: string, at: number, image: string) => {
      const job = m.start(id)
      if (job)
        m.finish(id, job.version, { image, rect: { ...job.rect, width: 100, height: 100 }, scale: 1 }, at)
    }
    // headroom first: c (out of view) is rendered while there is room
    expect(m.due(0).slice(0, 2).sort()).toEqual([tileId(0, 0), tileId(1, 0)].sort())
    draw(tileId(2, 0), 1, 'c')
    draw(tileId(0, 0), 2, 'a')
    // over the cap: c (out of view) goes, a (in view) stays
    expect(dropped).toEqual(['c'])
    draw(tileId(1, 0), 3, 'b')
    // both in view: past the cap, nothing in view is evicted
    expect(dropped).toEqual(['c'])
    expect(m.stats().bytes).toBe(80_000)
    expect(m.stats().pendingInView).toBe(0)
  })
})
