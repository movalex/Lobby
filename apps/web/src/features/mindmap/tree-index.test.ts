import { MINDMAP_EDGE_META_KEY, MINDMAP_META_KEY } from '@draftroom/contracts'
import type { TLShape, TLShapeId } from 'tldraw'
import { describe, expect, it } from 'vitest'
import { hasMindmapMeta, TreeIndex } from './tree-index.ts'

const R = 'shape:root' as TLShapeId
const topic = (id: string, parentId: string | null, collapsed = false, type = 'geo'): TLShape =>
  ({
    id,
    type,
    x: 0,
    y: 0,
    meta: { [MINDMAP_META_KEY]: { rootId: R, parentId, side: 'right', collapsed } },
  }) as unknown as TLShape
const line = (id: string, parentId: string, childId: string): TLShape =>
  ({
    id,
    type: 'arrow',
    meta: { [MINDMAP_EDGE_META_KEY]: { rootId: R, parentId, childId } },
  }) as unknown as TLShape

describe('TreeIndex', () => {
  it('indexes topics and lines by map, parent and child', () => {
    const ix = new TreeIndex()
    ix.put(topic(R, null))
    ix.put(topic('shape:a', R, true))
    ix.put(topic('shape:a1', 'shape:a'))
    ix.put(line('shape:l', 'shape:a', 'shape:a1'))
    expect([...(ix.byRoot.get(R) ?? [])].sort()).toEqual([R, 'shape:a', 'shape:a1'].sort())
    expect([...(ix.edgesByChild.get('shape:a1') ?? [])]).toEqual(['shape:l'])
    expect([...ix.collapsed]).toEqual(['shape:a'])
    expect(ix.descendantCount('shape:a' as TLShapeId)).toBe(1)
    expect(ix.descendantCount(R)).toBe(2)
    expect(ix.rootOf('shape:a1' as TLShapeId)).toBe(R)
  })

  it('bumps its version on structure changes only', () => {
    const ix = new TreeIndex()
    const v = () => ix.version.get()
    expect(ix.put(topic(R, null))).toBe(true)
    const v1 = v()
    // Same meta (a move or a text edit): no change.
    expect(ix.put({ ...topic(R, null), x: 99 } as TLShape)).toBe(false)
    expect(v()).toBe(v1)
    expect(ix.put(topic(R, null, true))).toBe(true)
    expect(v()).toBe(v1 + 1)
    expect(ix.collapsed.has(R)).toBe(true)
    // A shape without mind-map meta was never indexed: nothing to do.
    expect(ix.put({ id: 'shape:n', type: 'note', meta: {} } as unknown as TLShape)).toBe(false)
    expect(ix.remove('shape:n' as TLShapeId)).toBe(false)
    expect(ix.remove(R)).toBe(true)
    expect(ix.byRoot.size).toBe(0)
    expect(ix.collapsed.size).toBe(0)
  })

  it('a topic whose meta turns invalid, or whose type cannot be a topic, is dropped', () => {
    const ix = new TreeIndex()
    ix.put(topic('shape:a', R))
    expect(ix.topics.has('shape:a' as TLShapeId)).toBe(true)
    ix.put({ ...topic('shape:a', R), meta: { [MINDMAP_META_KEY]: { rootId: R } } } as unknown as TLShape)
    expect(ix.topics.has('shape:a' as TLShapeId)).toBe(false)
    ix.put(topic('shape:f', R, false, 'frame'))
    expect(ix.topics.has('shape:f' as TLShapeId)).toBe(false)
  })

  it('the per-change pre-check is a property lookup', () => {
    expect(hasMindmapMeta({ meta: {} } as unknown as TLShape)).toBe(false)
    expect(hasMindmapMeta(topic('shape:a', R))).toBe(true)
    expect(hasMindmapMeta(line('shape:l', R, 'shape:a'))).toBe(true)
  })
})
