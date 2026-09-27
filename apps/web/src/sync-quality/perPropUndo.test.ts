// The pure 3-way replay merge, ported from the verified spike harness (docs/research/undo-per-prop.md
// §4.3). The installed module (replay gate, remote-write trackers) is covered by the two-browser
// e2e in e2e/tests/conflicts.spec.ts.
import type { RecordsDiff, TLRecord } from 'tldraw'
import { describe, expect, it } from 'vitest'
import { changedPaths, type MergeContext, mergeReplayDiff } from './perPropUndo.ts'

type Rec = Record<string, unknown> & { id: string; typeName: string }
type Over = Partial<Rec> & { props?: Record<string, unknown> }

const shape = (id: string, over: Over = {}): Rec => ({
  id,
  typeName: 'shape',
  type: 'geo',
  x: 0,
  y: 0,
  rotation: 0,
  index: 'a1',
  parentId: 'page:page',
  isLocked: false,
  opacity: 1,
  meta: {},
  ...over,
  props: { w: 10, h: 10, color: 'black', ...(over.props ?? {}) },
})
const binding = (id: string, fromId: string, toId: string): Rec => ({
  id,
  typeName: 'binding',
  type: 'arrow',
  fromId,
  toId,
  meta: {},
  props: { terminal: 'end' },
})
const page: Rec = { id: 'page:page', typeName: 'page', name: 'Page 1', index: 'a1', meta: {} }

function ctx(
  records: Rec[],
  opts: {
    remote?: Record<string, string[]>
    deletedRemotely?: string[]
    lock?: MergeContext['isFieldLocked']
  } = {},
): MergeContext {
  const byId = new Map(records.map((r) => [r.id, r]))
  return {
    get: (id) => byId.get(id),
    isDocumentType: (t) => ['shape', 'binding', 'page', 'document', 'asset'].includes(t),
    remoteFields: (id) => (opts.remote?.[id] ? new Set(opts.remote[id]) : undefined),
    deletedRemotely: (id) => (opts.deletedRemotely ?? []).includes(id),
    childIds: (id) => records.filter((r) => r.typeName === 'shape' && r.parentId === id).map((r) => r.id),
    isFieldLocked: opts.lock,
  }
}

interface LooseDiff {
  added: Record<string, Rec>
  updated: Record<string, [Rec, Rec]>
  removed: Record<string, Rec>
}
const empty = (): LooseDiff => ({ added: {}, updated: {}, removed: {} })
const merge = (d: LooseDiff, c: MergeContext) => {
  const out = mergeReplayDiff(d as unknown as RecordsDiff<TLRecord>, c)
  return { diff: out.diff as unknown as LooseDiff, report: out.report }
}
const after = (d: LooseDiff, id: string) => {
  const pair = d.updated[id]
  if (!pair) throw new Error(`${id} is not updated`)
  return pair[1] as Rec & { props: Record<string, unknown> }
}

describe('mergeReplayDiff (per-property undo)', () => {
  it('reverts only the fields the entry changed and keeps a remote prop', () => {
    const d = empty()
    d.updated['shape:x'] = [shape('shape:x', { x: 100 }), shape('shape:x', { x: 0 })]
    const { diff, report } = merge(d, ctx([page, shape('shape:x', { x: 100, props: { color: 'red' } })]))
    expect(after(diff, 'shape:x').x).toBe(0)
    expect(after(diff, 'shape:x').props.color).toBe('red')
    expect(report).toEqual({ applied: 1, skipped: [], noop: false })
  })

  it('leaves a field someone else changed since, and reports a no-op step', () => {
    const d = empty()
    d.updated['shape:x'] = [shape('shape:x', { x: 100 }), shape('shape:x', { x: 0 })]
    const { diff, report } = merge(d, ctx([page, shape('shape:x', { x: 300 })]))
    expect(diff.updated['shape:x']).toBeUndefined()
    expect(report.noop).toBe(true)
    expect(report.skipped[0]?.reason).toBe('changed')
  })

  it('never resurrects a record someone else deleted', () => {
    const d = empty()
    d.updated['shape:x'] = [shape('shape:x', { x: 100 }), shape('shape:x', { x: 0 })]
    const { diff, report } = merge(d, ctx([page]))
    expect(Object.keys(diff.updated)).toEqual([])
    expect(Object.keys(diff.added)).toEqual([])
    expect(report.skipped[0]?.reason).toBe('deleted')
  })

  it('conflation guard: an equal value whose last write was remote is left alone', () => {
    const d = empty()
    d.updated['shape:x'] = [shape('shape:x', { x: 300, props: { color: 'red' } }), shape('shape:x', { x: 0 })]
    const cur = shape('shape:x', { x: 300, props: { color: 'red' } })
    const { diff } = merge(d, ctx([page, cur], { remote: { 'shape:x': ['props.color'] } }))
    expect(after(diff, 'shape:x').x).toBe(0)
    expect(after(diff, 'shape:x').props.color).toBe('red')
  })

  it('spatial unit: parentId is reverted together with x/y even if x changed since', () => {
    const g = shape('shape:g', { type: 'group' })
    const d = empty()
    d.updated['shape:c'] = [
      shape('shape:c', { parentId: 'shape:g', x: 5 }),
      shape('shape:c', { parentId: 'page:page', x: 105 }),
    ]
    const { diff } = merge(d, ctx([page, g, shape('shape:c', { parentId: 'shape:g', x: 45 })]))
    expect(after(diff, 'shape:c').parentId).toBe('page:page')
    expect(after(diff, 'shape:c').x).toBe(105)
  })

  it('spatial unit: reparented by someone else since, so all spatial fields stay and other props apply', () => {
    const d = empty()
    d.updated['shape:c'] = [
      shape('shape:c', { parentId: 'shape:g', x: 5, props: { color: 'blue' } }),
      shape('shape:c', { parentId: 'page:page', x: 105 }),
    ]
    const f = shape('shape:f', { type: 'frame' })
    const { diff, report } = merge(
      d,
      ctx([page, f, shape('shape:c', { parentId: 'shape:f', x: 7, props: { color: 'blue' } })]),
    )
    expect(after(diff, 'shape:c').parentId).toBe('shape:f')
    expect(after(diff, 'shape:c').x).toBe(7)
    expect(after(diff, 'shape:c').props.color).toBe('black')
    expect(report.skipped.some((s) => s.reason === 'changed' && s.paths?.includes('parentId'))).toBe(true)
  })

  it('re-add cascade: a group whose parent frame is gone drops, with its children and bindings', () => {
    const d = empty()
    d.added['shape:grp'] = shape('shape:grp', { type: 'group', parentId: 'shape:frame' })
    d.added['shape:k'] = shape('shape:k', { parentId: 'shape:grp' })
    d.added['binding:b'] = binding('binding:b', 'shape:arrow', 'shape:k')
    const { diff, report } = merge(d, ctx([page, shape('shape:arrow', { type: 'arrow' })]))
    expect(Object.keys(diff.added)).toEqual([])
    expect(report.skipped.filter((s) => s.reason === 'orphan')).toHaveLength(3)
  })

  it('drops a binding re-add to a missing arrow but keeps the shape re-add', () => {
    const d = empty()
    d.added['shape:g2'] = shape('shape:g2')
    d.added['binding:b'] = binding('binding:b', 'shape:arrow', 'shape:g2')
    const { diff } = merge(d, ctx([page]))
    expect(Object.keys(diff.added)).toEqual(['shape:g2'])
  })

  it('drops a binding update that would point at a shape this replay removes', () => {
    const d = empty()
    d.removed['shape:g2'] = shape('shape:g2')
    d.updated['binding:b'] = [
      binding('binding:b', 'shape:arrow', 'shape:g3'),
      binding('binding:b', 'shape:arrow', 'shape:g2'),
    ]
    const recs = [
      page,
      shape('shape:arrow', { type: 'arrow' }),
      shape('shape:g2'),
      shape('shape:g3'),
      binding('binding:b', 'shape:arrow', 'shape:g3'),
    ]
    const { diff, report } = merge(d, ctx(recs))
    expect(diff.updated['binding:b']).toBeUndefined()
    expect(report.skipped.some((s) => s.id === 'binding:b' && s.reason === 'orphan')).toBe(true)
  })

  it('keeps a container that now holds someone else’s shape', () => {
    const d = empty()
    d.removed['shape:f'] = shape('shape:f', { type: 'frame' })
    const { diff, report } = merge(
      d,
      ctx([page, shape('shape:f', { type: 'frame' }), shape('shape:s', { parentId: 'shape:f' })]),
    )
    expect(Object.keys(diff.removed)).toEqual([])
    expect(report.skipped[0]?.reason).toBe('has-foreign-children')
  })

  it('removes a container whose children all leave in the same replay (undo group)', () => {
    const d = empty()
    d.removed['shape:g'] = shape('shape:g', { type: 'group' })
    d.updated['shape:c'] = [
      shape('shape:c', { parentId: 'shape:g' }),
      shape('shape:c', { parentId: 'page:page' }),
    ]
    const { diff } = merge(
      d,
      ctx([page, shape('shape:g', { type: 'group' }), shape('shape:c', { parentId: 'shape:g' })]),
    )
    expect(Object.keys(diff.removed)).toEqual(['shape:g'])
    expect(after(diff, 'shape:c').parentId).toBe('page:page')
  })

  it('skips re-adding a record someone else deleted (redo of your own create)', () => {
    const d = empty()
    d.added['shape:x'] = shape('shape:x')
    const { diff, report } = merge(d, ctx([page], { deletedRemotely: ['shape:x'] }))
    expect(Object.keys(diff.added)).toEqual([])
    expect(report.skipped[0]?.reason).toBe('deleted')
  })

  it('skips a locked field and applies the rest', () => {
    const rt = (s: string) => ({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: s }] }],
    })
    const d = empty()
    d.updated['shape:n'] = [
      shape('shape:n', { x: 400, props: { richText: rt('A') } }),
      shape('shape:n', { x: 100, props: { richText: rt('') } }),
    ]
    const cur = shape('shape:n', { x: 400, props: { richText: rt('A') } })
    const { diff, report } = merge(d, ctx([page, cur], { lock: (_r, p) => p === 'props.richText' }))
    expect(after(diff, 'shape:n').x).toBe(100)
    expect(after(diff, 'shape:n').props.richText).toEqual(rt('A'))
    expect(report.skipped[0]?.reason).toBe('locked')
  })

  it('filters the selection of shapes that will not exist out of instance_page_state', () => {
    const ps = (sel: string[]): Rec => ({
      id: 'instance_page_state:page:page',
      typeName: 'instance_page_state',
      pageId: 'page:page',
      selectedShapeIds: sel,
      hintingShapeIds: [],
      erasingShapeIds: [],
      editingShapeId: null,
      croppingShapeId: null,
      focusedGroupId: null,
      hoveredShapeId: null,
      meta: {},
    })
    const d = empty()
    d.updated[ps([]).id] = [ps([]), ps(['shape:gone', 'shape:here'])]
    const { diff } = merge(d, ctx([page, shape('shape:here')]))
    expect(after(diff, ps([]).id).selectedShapeIds).toEqual(['shape:here'])
  })

  it('compares fields at sync-wire granularity (top level, props.*, meta.*)', () => {
    expect(
      changedPaths(
        shape('shape:a', { x: 1, meta: { a: 1 }, props: { color: 'red' } }),
        shape('shape:a', { x: 2, meta: { a: 1, b: 2 }, props: { color: 'blue' } }),
      ).sort(),
    ).toEqual(['meta.b', 'props.color', 'x'])
  })
})
