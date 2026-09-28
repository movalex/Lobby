import { MINDMAP_EDGE_META_KEY, MINDMAP_META_KEY } from '@draftroom/contracts'
import type { Editor, TLShape } from 'tldraw'
import { describe, expect, it } from 'vitest'
import { hiddenByCollapse, mindmapShapeVisibility } from './visibility.ts'

const R = 'shape:root'

function geo(id: string, parentId: string | null, collapsed = false, rootId = R): TLShape {
  return {
    id,
    type: 'geo',
    meta: { [MINDMAP_META_KEY]: { rootId, parentId, side: 'right', collapsed } },
  } as unknown as TLShape
}
const edge = (id: string, parentId: string, childId: string) =>
  ({
    id,
    type: 'arrow',
    meta: { [MINDMAP_EDGE_META_KEY]: { rootId: R, parentId, childId } },
  }) as unknown as TLShape

function board(shapes: TLShape[]) {
  const byId = new Map(shapes.map((s) => [s.id as string, s]))
  return { getShape: (id: string) => byId.get(id) } as unknown as Editor
}

describe('collapsed branches are hidden (tldraw getShapeVisibility)', () => {
  const shapes = [
    geo(R, null),
    geo('shape:a', R, true),
    geo('shape:a1', 'shape:a'),
    geo('shape:a11', 'shape:a1'),
    geo('shape:b', R),
    edge('shape:e-a1', 'shape:a', 'shape:a1'),
    edge('shape:e-b', R, 'shape:b'),
  ]
  const ed = board(shapes)
  const vis = (id: string) => mindmapShapeVisibility(shapes.find((s) => s.id === id) as TLShape, ed)

  it('hides everything under a collapsed topic, and the lines to it, but not the topic itself', () => {
    expect(vis('shape:a')).toBeUndefined()
    expect(vis('shape:a1')).toBe('hidden')
    expect(vis('shape:a11')).toBe('hidden')
    expect(vis('shape:e-a1')).toBe('hidden')
    expect(vis('shape:b')).toBeUndefined()
    expect(vis('shape:e-b')).toBeUndefined()
  })

  it('leaves other shapes alone (the fast path: no mind-map meta)', () => {
    const note = { id: 'shape:n', type: 'note', meta: {} } as unknown as TLShape
    expect(mindmapShapeVisibility(note, ed)).toBeUndefined()
  })

  it('a map whose central topic is gone hides nothing (its topics are plain shapes again)', () => {
    const orphaned = board(shapes.filter((s) => s.id !== R))
    expect(hiddenByCollapse(orphaned, shapes[2] as TLShape)).toBe(false)
  })

  it('a topic whose parent is gone hangs from the central topic: hidden only if that is collapsed', () => {
    const lost = geo('shape:lost', 'shape:deleted')
    expect(hiddenByCollapse(board([geo(R, null), lost]), lost)).toBe(false)
    expect(hiddenByCollapse(board([geo(R, null, true), lost]), lost)).toBe(true)
  })

  it('stops on a parent loop', () => {
    const x = geo('shape:x', 'shape:y')
    const y = geo('shape:y', 'shape:x')
    expect(hiddenByCollapse(board([geo(R, null), x, y]), x)).toBe(false)
  })

  it('ignores invalid meta', () => {
    const bad = {
      id: 'shape:bad',
      type: 'geo',
      meta: { [MINDMAP_META_KEY]: { rootId: R } },
    } as unknown as TLShape
    expect(mindmapShapeVisibility(bad, ed)).toBeUndefined()
  })
})
