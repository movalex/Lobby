// 3b's level-of-detail bookkeeping (./model.ts): frame membership, staleness, the quiet period, dropped
// renders, busy frames and what may be culled. Node only.
import { describe, expect, it } from 'vitest'
import {
  LOD_LARGE_LIVE,
  LOD_LARGE_VISIBLE,
  LOD_MAX_SIDE,
  LOD_QUIET_MS,
  LOD_ZOOM,
  LOD_ZOOM_LARGE,
  type LodBitmap,
  type LodElement,
  LodModel,
  lodActiveAt,
  lodBucketOf,
  lodScale,
  lodThreshold,
} from './model.ts'

type El = LodElement & { boundElements?: { id: string; type: string }[] }

const frame = (id: string, x = 0, y = 0, width = 1000, height = 800): El => ({
  id,
  type: 'frame',
  x,
  y,
  width,
  height,
})
const note = (id: string, frameId: string | null, label = `${id}-l`): El => ({
  id,
  type: 'stickynote',
  frameId,
  x: 10,
  y: 10,
  width: 200,
  height: 200,
  boundElements: [{ id: label, type: 'text' }],
})
const labelOf = (id: string, containerId: string): El => ({
  id,
  type: 'text',
  containerId,
  frameId: null,
  x: 20,
  y: 20,
  width: 100,
  height: 30,
})

const bitmap = (rect = { x: 0, y: 0, width: 1000, height: 800 }): LodBitmap<string> => ({
  image: 'png',
  rect,
  scale: 0.25,
})

/** A scene the model reads through `get`, with helpers to change it. */
function scene(initial: El[]) {
  const map = new Map(initial.map((e) => [e.id, e]))
  return {
    map,
    all: () => [...map.values()],
    get: (id: string) => map.get(id),
    set(e: El) {
      map.set(e.id, e)
    },
    delete(id: string) {
      const e = map.get(id)
      if (e) map.set(id, { ...e, isDeleted: true })
    },
  }
}

/** Renders every due frame at `now` (the model's schedule, without a browser). */
function renderDue(m: LodModel<string>, now: number) {
  for (const id of m.due(now)) {
    const job = m.start(id)
    if (job) m.finish(id, job.version, bitmap(job.rect))
  }
}

describe('when the pass is on', () => {
  it('below zoom 0.2 only', () => {
    expect(LOD_ZOOM).toBe(0.2)
    expect(lodActiveAt(0.054)).toBe(true)
    expect(lodActiveAt(0.1999)).toBe(true)
    expect(lodActiveAt(0.2)).toBe(false)
    expect(lodActiveAt(1)).toBe(false)
    expect(lodActiveAt(0)).toBe(false)
    expect(lodActiveAt(Number.NaN)).toBe(false)
  })

  it('renders at the largest LOD zoom times the device pixel ratio, capped on the longer side', () => {
    expect(lodScale({ x: 0, y: 0, width: 3000, height: 2000 }, 1.25)).toBeCloseTo(0.25)
    expect(lodScale({ x: 0, y: 0, width: 3000, height: 2000 }, 1)).toBeCloseTo(0.2)
    const huge = { x: 0, y: 0, width: 40_000, height: 1000 }
    expect(lodScale(huge, 2)).toBeCloseTo(LOD_MAX_SIDE / 40_000)
  })
})

describe('the model', () => {
  const setup = () => {
    const s = scene([
      frame('F1'),
      frame('F2', 2000),
      note('N1', 'F1'),
      labelOf('N1-l', 'N1'),
      note('N2', 'F2'),
      labelOf('N2-l', 'N2'),
      note('LOOSE', null),
      labelOf('LOOSE-l', 'LOOSE'),
    ])
    const m = new LodModel<string>()
    m.reset(s.all())
    return { s, m }
  }

  it('indexes members (labels through their container), every frame due at once, nothing culled before a render', () => {
    const { m } = setup()
    expect(m.frameOf('N1')).toBe('F1')
    expect(m.frameOf('N1-l')).toBe('F1')
    expect(m.frameOf('LOOSE')).toBeNull()
    expect(m.stats()).toMatchObject({ frames: 2, stale: 2, ready: 0, culled: 0 })
    expect(m.due(0).sort()).toEqual(['F1', 'F2'])
  })

  it('culls the members of rendered frames, never their labels, never loose elements', () => {
    const { m } = setup()
    renderDue(m, 0)
    expect([...m.culled()].sort()).toEqual(['N1', 'N2'])
    expect(
      m
        .drawable()
        .map((d) => d.id)
        .sort(),
    ).toEqual(['F1', 'F2'])
  })

  it('a change makes its frame live at once and due once quiet; a render finishing after another change is dropped', () => {
    const { s, m } = setup()
    renderDue(m, 0)
    s.set({ ...note('N1', 'F1'), x: 300 })
    m.changed(['N1'], s.get, 1000)
    expect([...m.culled()]).toEqual(['N2'])
    expect(m.due(1000 + LOD_QUIET_MS - 1)).toEqual([])
    expect(m.nextDue()).toBe(1000 + LOD_QUIET_MS)
    expect(m.due(1000 + LOD_QUIET_MS)).toEqual(['F1'])
    const job = m.start('F1')
    expect(job).not.toBeNull()
    // typed again while the bitmap was being drawn
    m.changed(['N1-l'], s.get, 1200)
    expect(m.finish('F1', job?.version ?? -1, bitmap())).toBe(false)
    expect(m.stats().stale).toBe(1)
    renderDue(m, 1200 + LOD_QUIET_MS)
    expect([...m.culled()].sort()).toEqual(['N1', 'N2'])
  })

  it('a note dragged out of a frame leaves the old bitmap stale and is loose; into another frame, both are stale', () => {
    const { s, m } = setup()
    renderDue(m, 0)
    s.set(note('N1', null))
    m.changed(['N1'], s.get, 10)
    expect(m.frameOf('N1')).toBeNull()
    expect(m.frameOf('N1-l')).toBeNull()
    expect(m.stats().stale).toBe(1)
    renderDue(m, 10 + LOD_QUIET_MS)
    expect([...m.culled()]).toEqual(['N2'])
    s.set(note('N2', 'F1'))
    m.changed(['N2'], s.get, 1000)
    expect(m.stats().stale).toBe(2)
    expect(m.frameOf('N2')).toBe('F1')
    expect(m.frameOf('N2-l')).toBe('F1')
  })

  it('a frame moved, renamed or deleted: its bitmap is stale or gone; its members stay or become loose', () => {
    const { s, m } = setup()
    renderDue(m, 0)
    s.set(frame('F1', 50, 50))
    m.changed(['F1'], s.get, 5)
    expect(m.due(5)).toEqual([])
    renderDue(m, 5 + LOD_QUIET_MS)
    expect(m.drawable().find((d) => d.id === 'F1')?.bitmap.rect).toMatchObject({ x: 50, y: 50 })
    s.delete('F2')
    m.changed(['F2'], s.get, 10)
    expect(m.stats().frames).toBe(1)
    expect(m.frameOf('N2')).toBeNull()
  })

  it('a frame and its children created in one batch (children listed first) are indexed', () => {
    const { s, m } = setup()
    s.set(note('N3', 'F3'))
    s.set(labelOf('N3-l', 'N3'))
    s.set(frame('F3', 5000))
    m.changed(['N3', 'N3-l', 'F3'], s.get, 0)
    expect(m.frameOf('N3')).toBe('F3')
    renderDue(m, LOD_QUIET_MS)
    expect(m.culled().has('N3')).toBe(true)
  })

  it('busy frames (a peer drags one of their members) are drawn live, and culled again after', () => {
    const { m } = setup()
    renderDue(m, 0)
    m.setBusy(['N2'])
    expect([...m.culled()]).toEqual(['N1'])
    expect(m.drawable().map((d) => d.id)).toEqual(['F1'])
    m.setBusy([])
    expect([...m.culled()].sort()).toEqual(['N1', 'N2'])
  })

  it('a look change without a document change (a collapse, an image arriving, the theme) re-renders', () => {
    const { m } = setup()
    renderDue(m, 0)
    m.invalidateMembers(['N2-l'], 100)
    expect(m.stats().stale).toBe(1)
    m.invalidateAll(200)
    expect(m.stats().stale).toBe(2)
  })

  it('a render with nothing to draw leaves the frame live (not culled) until it changes', () => {
    const { m } = setup()
    const job = m.start('F1')
    expect(job).not.toBeNull()
    expect(m.finish('F1', job?.version ?? -1, null)).toBe(true)
    expect(m.culled().has('N1')).toBe(false)
    expect(m.stats().ready).toBe(1)
  })
})

describe('the bitmaps the model lets go of', () => {
  it('are handed to onDrop when replaced, when their frame goes and on a reset', () => {
    const dropped: string[] = []
    const m = new LodModel<string>({ onDrop: (b) => dropped.push(b.image) })
    const s = scene([frame('F1'), frame('F2', 2000), note('N1', 'F1')])
    m.reset(s.all())
    const draw = (id: string, image: string) => {
      const job = m.start(id)
      if (job) m.finish(id, job.version, { image, rect: job.rect, scale: 1 })
    }
    draw('F1', 'a')
    draw('F2', 'b')
    m.changed(['N1'], s.get, 0)
    draw('F1', 'a2')
    expect(dropped).toEqual(['a'])
    s.delete('F2')
    m.changed(['F2'], s.get, 1)
    expect(dropped).toEqual(['a', 'b'])
    m.reset([])
    expect(dropped).toEqual(['a', 'b', 'a2'])
  })
})

// N1-5 (wave N, PERF-5): the pass scales with the board's size.
describe('N1-5: the size-aware thresholds and zoom buckets', () => {
  it('turns on below 0.2 up to 1,500 live elements, below 0.35 above that or with more than 3,000 in view', () => {
    expect(LOD_ZOOM_LARGE).toBe(0.35)
    expect(LOD_LARGE_LIVE).toBe(1_500)
    expect(LOD_LARGE_VISIBLE).toBe(3_000)
    expect(lodThreshold(1_500, 0, true)).toBe(0.2)
    expect(lodThreshold(1_501, 0, true)).toBe(0.35)
    expect(lodThreshold(100, 3_001, true)).toBe(0.35)
    expect(lodThreshold(100, 3_000, true)).toBe(0.2)
    expect(lodActiveAt(0.25, 1_500, 0, true)).toBe(false)
    expect(lodActiveAt(0.25, 10_000, 0, true)).toBe(true)
    expect(lodActiveAt(0.3499, 10_000, 0, true)).toBe(true)
    expect(lodActiveAt(0.35, 10_000, 0, true)).toBe(false)
    expect(lodActiveAt(0.1, 10, 0, true)).toBe(true)
    // without SIZE_AWARE_LOD: 0.2 whatever the board (the pass before wave N)
    expect(lodThreshold(10_000, 10_000, false)).toBe(0.2)
    expect(lodActiveAt(0.25, 10_000, 10_000)).toBe(false)
  })

  it('two buckets (0.2 and 0.35): a bucket’s bitmaps are drawn at its zoom times the device pixel ratio', () => {
    expect(lodBucketOf(0.05, true)).toBe(0.2)
    expect(lodBucketOf(0.1999, true)).toBe(0.2)
    expect(lodBucketOf(0.2, true)).toBe(0.35)
    expect(lodBucketOf(0.34, true)).toBe(0.35)
    expect(lodBucketOf(0.3, false)).toBe(0.2)
    const r = { x: 0, y: 0, width: 3000, height: 2000 }
    expect(lodScale(r, 1, 0.35)).toBeCloseTo(0.35)
    expect(lodScale(r, 1.25, 0.35)).toBeCloseTo(0.4375)
    expect(lodScale(r, 1.25, 0.2)).toBeCloseTo(0.25)
  })

  it('a frame keeps a bitmap per bucket: zooming back reuses it; a change lets every bucket’s go', () => {
    const dropped: string[] = []
    const s = scene([frame('F1'), note('N1', 'F1'), labelOf('N1-l', 'N1')])
    const m = new LodModel<string>({ sizeAware: true, onDrop: (b) => dropped.push(b.image) })
    m.reset(s.all())
    const draw = (image: string) => {
      const job = m.start('F1')
      if (job) m.finish('F1', job.version, { image, rect: job.rect, scale: job.bucket }, 1)
      return job
    }
    expect(draw('at-0.2')?.bucket).toBe(0.2)
    expect([...m.culled()]).toEqual(['N1'])
    m.setBucket(0.35)
    // not drawn at this bucket yet: live, due
    expect(m.culled().size).toBe(0)
    expect(m.due(0)).toEqual(['F1'])
    expect(draw('at-0.35')?.bucket).toBe(0.35)
    expect(m.drawable().map((d) => d.bitmap.image)).toEqual(['at-0.35'])
    m.setBucket(0.2)
    // back: the 0.2 bitmap is still there, nothing to render
    expect(m.drawable().map((d) => d.bitmap.image)).toEqual(['at-0.2'])
    expect(m.due(0)).toEqual([])
    expect(m.stats()).toMatchObject({ bitmaps: 2, bucket: 0.2 })
    s.set({ ...note('N1', 'F1'), x: 99 })
    m.changed(['N1'], s.get, 10)
    expect(dropped.sort()).toEqual(['at-0.2', 'at-0.35'])
    expect(m.stats()).toMatchObject({ bitmaps: 0, bytes: 0 })
  })
})
