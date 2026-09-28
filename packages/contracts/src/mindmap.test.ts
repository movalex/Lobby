import { describe, expect, it } from 'vitest'
import { MINDMAP_EDGE_META_KEY, MINDMAP_META_KEY, readEdgeMeta, readTopicMeta } from './mindmap.ts'

const meta = (m: unknown) => ({ [MINDMAP_META_KEY]: m })
const good = { rootId: 'shape:root', parentId: 'shape:p', side: 'left', collapsed: false }

describe('readTopicMeta', () => {
  it('accepts a valid topic and a valid root', () => {
    expect(readTopicMeta('shape:c', meta(good))).toEqual(good)
    expect(
      readTopicMeta(
        'shape:root',
        meta({ rootId: 'shape:root', parentId: null, side: 'right', collapsed: true }),
      ),
    ).toMatchObject({ parentId: null, collapsed: true })
  })

  it('ignores extra keys (forward compatible)', () => {
    expect(readTopicMeta('shape:c', meta({ ...good, extra: 1 }))).toEqual(good)
  })

  it('is null for shapes without it, or with anything malformed', () => {
    expect(readTopicMeta('shape:c', {})).toBeNull()
    expect(readTopicMeta('shape:c', null)).toBeNull()
    expect(readTopicMeta('shape:c', [])).toBeNull()
    for (const bad of [
      null,
      'x',
      { ...good, side: 'up' },
      { ...good, collapsed: 'yes' },
      { ...good, rootId: 'page:1' },
      { ...good, parentId: 'shape:has space' },
      { ...good, parentId: `shape:${'a'.repeat(200)}` },
      { ...good, rootId: undefined },
    ]) {
      expect(readTopicMeta('shape:c', meta(bad))).toBeNull()
    }
  })

  it('refuses a root that names another root, a topic that is its own parent, and a child claiming to be the root', () => {
    expect(readTopicMeta('shape:a', meta({ ...good, parentId: null }))).toBeNull()
    expect(readTopicMeta('shape:p', meta(good))).toBeNull()
    expect(readTopicMeta('shape:root', meta(good))).toBeNull()
  })
})

describe('readEdgeMeta', () => {
  it('accepts a line and refuses malformed ones and self-loops', () => {
    const e = { rootId: 'shape:r', parentId: 'shape:p', childId: 'shape:c' }
    expect(readEdgeMeta({ [MINDMAP_EDGE_META_KEY]: e })).toEqual(e)
    expect(readEdgeMeta({})).toBeNull()
    expect(readEdgeMeta({ [MINDMAP_EDGE_META_KEY]: { ...e, childId: 'shape:p' } })).toBeNull()
    expect(readEdgeMeta({ [MINDMAP_EDGE_META_KEY]: { ...e, childId: 42 } })).toBeNull()
  })
})
