import type { TLRecord } from 'tldraw'
import { describe, expect, it } from 'vitest'
import { presentationOrder } from './deps.ts'
import {
  autoOrderPatches,
  type FrameMetaLike,
  hasManualOrder,
  isSkipped,
  type MetaPatch,
  mergeMeta,
  moveItem,
  presentationIndexPatches,
  skipPatch,
} from './frame-order.ts'

const frame = (id: string, x: number, y: number, meta: Record<string, unknown> = {}) =>
  ({
    id: `shape:${id}`,
    typeName: 'shape',
    type: 'frame',
    parentId: 'page:page',
    index: 'a1',
    x,
    y,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta,
    props: { w: 400, h: 300, name: id.toUpperCase(), color: 'black' },
  }) as unknown as TLRecord

const metaOf = (records: TLRecord[]): FrameMetaLike[] =>
  records.map((r) => ({ id: r.id, meta: (r as { meta: Record<string, unknown> }).meta }))

/** Applies patches the way the editor does (shallow meta merge), then asks board-ops for the order. */
function apply(records: TLRecord[], patches: MetaPatch[]) {
  const byId = new Map(patches.map((p) => [p.id, p]))
  return records.map((r) =>
    byId.has(r.id)
      ? ({ ...r, meta: mergeMeta((r as { meta: Record<string, unknown> }).meta, byId.get(r.id)) } as TLRecord)
      : r,
  )
}
const order = (records: TLRecord[]) => presentationOrder(records, 'page:page' as never).map((f) => f.name)

describe('moveItem', () => {
  it('moves within bounds', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
    expect(moveItem(['a', 'b', 'c'], 1, 99)).toEqual(['a', 'c', 'b'])
    expect(moveItem(['a', 'b'], 5, 0)).toEqual(['a', 'b'])
  })
})

describe('reorder → presentation order', () => {
  // Reading order: A B (top row), C (second row).
  const records = [frame('a', 0, 0), frame('b', 600, 0), frame('c', 0, 500, { note: 'keep me' })]

  it('dragging writes presentationIndex on every frame and board-ops follows it', () => {
    expect(order(records)).toEqual(['A', 'B', 'C'])
    const ids = presentationOrder(records, 'page:page' as never).map((f) => f.id as string)
    const patches = presentationIndexPatches(moveItem(ids, 2, 0), metaOf(records)) // drag C to the top
    expect(patches).toHaveLength(3)
    const next = apply(records, patches)
    expect(order(next)).toEqual(['C', 'A', 'B'])
    // other meta survives the merge
    expect((next[2] as { meta: object }).meta).toEqual({ note: 'keep me', presentationIndex: 0 })
  })

  it('only patches frames whose index changes', () => {
    const explicit = [
      frame('a', 0, 0, { presentationIndex: 0 }),
      frame('b', 600, 0, { presentationIndex: 1 }),
    ]
    expect(presentationIndexPatches(['shape:a', 'shape:b'], metaOf(explicit))).toEqual([])
    expect(presentationIndexPatches(['shape:b', 'shape:a'], metaOf(explicit))).toHaveLength(2)
  })

  it('Auto-order clears explicit indexes so the order follows the layout again', () => {
    const custom = [
      frame('a', 0, 0, { presentationIndex: 2 }),
      frame('b', 600, 0, { presentationIndex: 0 }),
      frame('c', 0, 500, { presentationIndex: 1, presentationSkip: true }),
    ]
    expect(order(custom)).toEqual(['B', 'C', 'A'])
    expect(hasManualOrder(metaOf(custom))).toBe(true)
    const next = apply(custom, autoOrderPatches(metaOf(custom)))
    expect(order(next)).toEqual(['A', 'B', 'C'])
    expect(hasManualOrder(metaOf(next))).toBe(false)
    // the skip flag is not touched by auto-order
    expect(isSkipped((next[2] as { meta: Record<string, unknown> }).meta)).toBe(true)
    expect(autoOrderPatches(metaOf(next))).toEqual([])
  })

  it('a reorder after Auto-order becomes explicit again', () => {
    const next = apply(records, autoOrderPatches(metaOf(records)))
    const ids = presentationOrder(next, 'page:page' as never).map((f) => f.id as string)
    expect(order(apply(next, presentationIndexPatches(moveItem(ids, 0, 2), metaOf(next))))).toEqual([
      'B',
      'C',
      'A',
    ])
  })
})

describe('skip in presentation', () => {
  it('sets and clears presentationSkip without touching other meta', () => {
    const f = { id: 'shape:a', meta: { presentationIndex: 3 } }
    const on = skipPatch(f, true)
    expect(on).toEqual({ id: 'shape:a', meta: { presentationSkip: true } })
    const merged = mergeMeta(f.meta, on ?? undefined)
    expect(merged).toEqual({ presentationIndex: 3, presentationSkip: true })
    expect(isSkipped(merged)).toBe(true)
    const off = skipPatch({ id: f.id, meta: merged }, false)
    expect(isSkipped(mergeMeta(merged, off ?? undefined))).toBe(false)
    expect(skipPatch(f, false)).toBeNull()
  })
})
