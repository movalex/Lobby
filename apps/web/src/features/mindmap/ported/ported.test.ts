// The pure parts of the ported mind map (./meta.ts, ./tree-index.ts, ./text-fit.ts, ./geometry.ts, the key
// queue of ./keyboard.ts and ./draft.ts against a fake canvas). The browser paths are the e2e specs
// e2e/excalidraw/mindmap-*.spec.ts.
import { describe, expect, it } from 'vitest'
import type { CanvasElement } from '../../../canvas/api/index.ts'
import { Draft } from './draft.ts'
import { elbowLine, sameLine } from './geometry.ts'
import { enqueue, queuedOf, textAfter } from './keyboard.ts'
import {
  clearTopicPatch,
  edgeMetaOf,
  hasMindmapData,
  isTopicType,
  rawTopicValue,
  topicMetaOf,
  topicPatch,
} from './meta.ts'
import { centredLabelAt, fitTopic, wrapText } from './text-fit.ts'
import { TreeIndex } from './tree-index.ts'

const el = (id: string, type: string, lobby?: Record<string, unknown>, more: Record<string, unknown> = {}) =>
  ({
    id,
    type,
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    angle: 0,
    isDeleted: false,
    customData: lobby ? { lobby } : undefined,
    ...more,
  }) as unknown as CanvasElement

const root = (id: string, collapsed = false) =>
  el(id, 'rectangle', { mindmap: { rootId: id, parentId: null, side: 'right', collapsed } })
const child = (id: string, rootId: string, parentId: string, side = 'right', collapsed = false) =>
  el(id, 'rectangle', { mindmap: { rootId, parentId, side, collapsed } })
const edge = (id: string, rootId: string, parentId: string, childId: string) =>
  el(id, 'arrow', { mindmapEdge: { rootId, parentId, childId } })

describe('meta: topic and edge values are validated, never trusted', () => {
  it('reads a root and a child', () => {
    expect(topicMetaOf(root('r'))).toEqual({ rootId: 'r', parentId: null, side: 'right', collapsed: false })
    expect(topicMetaOf(child('c', 'r', 'r', 'left'))?.side).toBe('left')
  })
  it('refuses self-roots, self-parents, bad sides, labels and deleted elements', () => {
    expect(
      topicMetaOf(
        el('x', 'rectangle', { mindmap: { rootId: 'y', parentId: null, side: 'right', collapsed: false } }),
      ),
    ).toBeNull()
    expect(topicMetaOf(child('c', 'r', 'c'))).toBeNull()
    expect(topicMetaOf(child('c', 'c', 'r'))).toBeNull()
    expect(
      topicMetaOf(
        el('c', 'rectangle', { mindmap: { rootId: 'r', parentId: 'r', side: 'up', collapsed: false } }),
      ),
    ).toBeNull()
    expect(
      topicMetaOf(
        el(
          't',
          'text',
          { mindmap: { rootId: 't', parentId: null, side: 'right', collapsed: false } },
          { containerId: 'r' },
        ),
      ),
    ).toBeNull()
    expect(
      topicMetaOf(
        el(
          'r',
          'rectangle',
          { mindmap: { rootId: 'r', parentId: null, side: 'right', collapsed: false } },
          { isDeleted: true },
        ),
      ),
    ).toBeNull()
    expect(
      topicMetaOf(
        el('a', 'arrow', { mindmap: { rootId: 'a', parentId: null, side: 'right', collapsed: false } }),
      ),
    ).toBeNull()
  })
  it('a copy keeps its original ids until rewritten: rawTopicValue reads it, topicMetaOf does not', () => {
    const copy = child('copy', 'r', 'copy') // its own id as parent: the original's value on a copy of the parent
    expect(topicMetaOf(copy)).toBeNull()
    expect(rawTopicValue(copy)).toEqual({ rootId: 'r', parentId: 'copy', side: 'right', collapsed: false })
  })
  it('topic types, edges and the patches', () => {
    expect(isTopicType({ type: 'stickynote' })).toBe(true)
    expect(isTopicType({ type: 'text', containerId: 'x' })).toBe(false)
    expect(isTopicType({ type: 'freedraw' })).toBe(false)
    expect(edgeMetaOf(edge('e', 'r', 'r', 'c'))).toEqual({ rootId: 'r', parentId: 'r', childId: 'c' })
    expect(edgeMetaOf(edge('e', 'r', 'c', 'c'))).toBeNull()
    expect(
      edgeMetaOf(el('e', 'rectangle', { mindmapEdge: { rootId: 'r', parentId: 'r', childId: 'c' } })),
    ).toBeNull()
    expect(hasMindmapData(edge('e', 'r', 'r', 'c'))).toBe(true)
    expect(hasMindmapData(el('n', 'stickynote', { alt: 'x' }))).toBe(false)
    expect(topicPatch({ rootId: 'r', parentId: null, side: 'right', collapsed: true })).toEqual({
      customData: { lobby: { mindmap: { rootId: 'r', parentId: null, side: 'right', collapsed: true } } },
    })
    expect(clearTopicPatch()).toEqual({ customData: { lobby: { mindmap: null } } })
  })
})

describe('TreeIndex: structure only, bumped when it changes', () => {
  it('indexes roots, children, edges and collapsed topics; counts descendants', () => {
    const ix = new TreeIndex()
    expect(
      ix.rebuild([
        root('r'),
        child('a', 'r', 'r'),
        child('b', 'r', 'a', 'right', true),
        child('c', 'r', 'b'),
        edge('e', 'r', 'r', 'a'),
        el('n', 'stickynote'),
      ]),
    ).toBe(true)
    expect([...(ix.byRoot.get('r') ?? [])].sort()).toEqual(['a', 'b', 'c', 'r'])
    expect(ix.rootOf('c')).toBe('r')
    expect(ix.rootOfAny('e')).toBe('r')
    expect(ix.collapsed.has('b')).toBe(true)
    expect(ix.descendantCount('r')).toBe(3)
    expect(ix.descendantCount('b')).toBe(1)
    expect(ix.rootOf('n')).toBeNull()
  })
  it('a move or a text edit does not bump; a structure change does; a deletion forgets', () => {
    const ix = new TreeIndex()
    ix.rebuild([root('r'), child('a', 'r', 'r')])
    const v = ix.version.get()
    expect(ix.put({ ...child('a', 'r', 'r'), x: 500 } as CanvasElement)).toBe(false)
    expect(ix.version.get()).toBe(v)
    expect(ix.put(child('a', 'r', 'r', 'left'))).toBe(true)
    expect(ix.version.get()).toBe(v + 1)
    expect(ix.put(undefined, 'a')).toBe(true)
    expect(ix.topics.has('a')).toBe(false)
    expect(ix.children.get('r')).toBeUndefined()
    // a full rescan drops what is gone
    ix.rebuild([])
    expect(ix.topics.size).toBe(0)
  })
  it('a loop in stored parents is cut', () => {
    const ix = new TreeIndex()
    ix.rebuild([root('r'), child('a', 'r', 'b'), child('b', 'r', 'a')])
    expect(ix.descendantCount('a')).toBe(1)
  })
})

describe('text fit: the width follows the text within the level, labels wrap and centre', () => {
  // 10 px per character, 20 px per line
  const measure = (text: string) => {
    const lines = text.split('\n')
    return { width: Math.max(...lines.map((l) => l.length * 10)), height: lines.length * 20 }
  }
  const width = (s: string) => s.length * 10
  it('wraps greedily, breaking words longer than a line', () => {
    expect(wrapText('one two three', 75, width)).toBe('one two\nthree')
    expect(wrapText('abcdefghij', 40, width)).toBe('abcd\nefgh\nij')
    expect(wrapText('keep\nbreaks', 1000, width)).toBe('keep\nbreaks')
  })
  it('an empty topic takes the minimum; a long one stops at the maximum and grows down', () => {
    const range = { minW: 120, maxW: 280, minH: 56 }
    expect(fitTopic('  ', 18, range, measure)).toEqual({ width: 120, height: 56, label: null })
    const short = fitTopic('Hi', 18, range, measure)
    expect(short.width).toBe(120)
    const long = fitTopic('a fairly long topic name that wraps', 18, range, measure)
    expect(long.width).toBe(280)
    expect(long.label?.text.split('\n').length).toBeGreaterThan(1)
    expect(long.height).toBeGreaterThanOrEqual((long.label?.height ?? 0) + 10)
    expect(centredLabelAt({ x: 0, y: 0, width: 200, height: 100 }, { width: 50, height: 20 })).toEqual({
      x: 75,
      y: 40,
    })
  })
})

describe('geometry: the elbow line from a parent side to its child', () => {
  const parent = { x: 0, y: 0, w: 200, h: 80 }
  it('a straight line when the ends are level, an elbow otherwise; mirrored on the left', () => {
    const level = elbowLine(parent, { x: 300, y: 20, w: 100, h: 40 }, 'right')
    expect(level).toEqual({
      x: 200,
      y: 40,
      width: 100,
      height: 0,
      points: [
        [0, 0],
        [100, 0],
      ],
    })
    const down = elbowLine(parent, { x: 300, y: 100, w: 100, h: 40 }, 'right')
    expect(down.points).toEqual([
      [0, 0],
      [50, 0],
      [50, 80],
      [100, 80],
    ])
    const left = elbowLine(parent, { x: -200, y: 100, w: 100, h: 40 }, 'left')
    expect(left.x).toBe(0)
    expect(left.points[3]).toEqual([-100, 80])
    expect(
      sameLine(
        {
          x: 200.2,
          y: 40,
          points: [
            [0, 0],
            [100.3, 0],
          ],
        },
        level,
      ),
    ).toBe(true)
    expect(
      sameLine(
        {
          x: 200,
          y: 40,
          points: [
            [0, 0],
            [90, 0],
          ],
        },
        level,
      ),
    ).toBe(false)
  })
})

describe('key queue: what is typed while a new topic editor opens', () => {
  const key = (k: string, mods: Partial<Record<'shift' | 'ctrl' | 'meta' | 'alt', boolean>> = {}) => ({
    key: k,
    shift: false,
    ctrl: false,
    meta: false,
    alt: false,
    ...mods,
  })
  it('printable keys queue as text, Tab/Enter/Escape as intents, shortcuts not at all', () => {
    expect(queuedOf(key('a'))).toEqual({ kind: 'text', text: 'a' })
    expect(queuedOf(key('Tab'))).toEqual({ kind: 'key', intent: 'child' })
    expect(queuedOf(key('Tab', { shift: true }))).toEqual({ kind: 'key', intent: 'promote' })
    expect(queuedOf(key('Enter'))).toEqual({ kind: 'key', intent: 'sibling' })
    expect(queuedOf(key('Enter', { shift: true }))).toEqual({ kind: 'text', text: '\n' })
    expect(queuedOf(key('Escape'))).toEqual({ kind: 'key', intent: 'escape' })
    expect(queuedOf(key('Backspace'))).toBe('backspace')
    expect(queuedOf(key('z', { ctrl: true }))).toBeNull()
    expect(queuedOf(key('Shift'))).toBeNull()
    // AltGr (Ctrl+Alt) types characters
    expect(queuedOf(key('@', { ctrl: true, alt: true }))).toEqual({ kind: 'text', text: '@' })
  })
  it('text runs merge; Backspace takes back the last character, or reaches past the queue', () => {
    const q: Parameters<typeof enqueue>[0] = []
    for (const c of 'Hel') enqueue(q, { kind: 'text', text: c })
    enqueue(q, 'backspace')
    enqueue(q, { kind: 'key', intent: 'child' })
    expect(q).toEqual([
      { kind: 'text', text: 'He' },
      { kind: 'key', intent: 'child' },
    ])
    const empty: Parameters<typeof enqueue>[0] = []
    enqueue(empty, 'backspace')
    expect(empty).toEqual([{ kind: 'text', text: '\b' }])
  })
  it('the text a topic ends with: fresh starts empty, append continues, the placeholder is replaced', () => {
    expect(textAfter('old', 'fresh', 'New')).toBe('New')
    expect(textAfter('Old', 'append', ' more')).toBe('Old more')
    expect(textAfter('Old', 'append', '\b\bn')).toBe('On')
    expect(textAfter('Central topic', 'placeholder', 'Plan')).toBe('Plan')
    expect(textAfter('Central topic', 'placeholder', '\bPlan')).toBe('Plan')
    expect(textAfter('Central topic', 'placeholder', '')).toBe('Central topic')
  })
})

describe('Draft: reads its own writes, commits one step, folds writes to new elements into their creation', () => {
  function fakeCanvas(initial: CanvasElement[]) {
    const store = new Map(initial.map((e) => [e.id, e]))
    const calls: { label: string; opts?: unknown; ops: unknown[] }[] = []
    return {
      calls,
      get: (id: string) => store.get(id),
      items: () => [...store.values()],
      transact<T>(label: string, fn: (tx: never) => T, opts?: unknown): T {
        const ops: unknown[] = []
        const tx = {
          create: (kind: string, props: unknown) => ops.push(['create', kind, props]),
          update: (id: string, patch: unknown) => ops.push(['update', id, patch]),
          delete: (id: string) => ops.push(['delete', id]),
        }
        const out = fn(tx as never)
        calls.push({ label, ...(opts ? { opts } : {}), ops })
        return out
      },
    }
  }
  it('an unchanged write records nothing, so a tidy layout commits nothing', () => {
    const c = fakeCanvas([el('a', 'rectangle')])
    const d = new Draft(c as never)
    d.update('a', { x: 0, y: 0 })
    expect(d.empty).toBe(true)
    expect(d.commit('noop')).toBe(false)
    expect(c.calls).toEqual([])
  })
  it('customData.lobby merges per key; a move takes the bound label along; delete takes the label', () => {
    const c = fakeCanvas([
      el('a', 'rectangle', { alt: 'x' }, { boundElements: [{ id: 't', type: 'text' }] }),
      el('t', 'text', undefined, { containerId: 'a', x: 10, y: 10 }),
    ])
    const d = new Draft(c as never)
    d.update('a', {
      customData: { lobby: { mindmap: { rootId: 'a', parentId: null, side: 'right', collapsed: false } } },
    })
    expect(d.get('a')?.customData?.lobby).toEqual({
      alt: 'x',
      mindmap: { rootId: 'a', parentId: null, side: 'right', collapsed: false },
    })
    d.move('a', 50, 20)
    expect([d.get('t')?.x, d.get('t')?.y]).toEqual([60, 30])
    d.delete('a')
    expect(d.items().map((e) => e.id)).toEqual([])
    d.commit('edit')
    expect(c.calls).toHaveLength(1)
    expect(c.calls[0]?.ops).toContainEqual(['delete', 'a'])
  })
  it('a created element carries its later writes in its creation props (CR-3D-1); a label by its alignment point; bindings in a joined second step', () => {
    const c = fakeCanvas([el('p', 'rectangle', undefined, { x: 0, y: 0, width: 200, height: 80 })])
    const d = new Draft(c as never)
    const box = d.create('rectangle', { id: 'n', x: 0, y: 0, width: 100, height: 40 })
    d.move(box, 300, 100)
    d.create('text', {
      id: 'l',
      text: 'Hi',
      textAlign: 'center',
      verticalAlign: 'middle',
      containerId: 'n',
      x: 310,
      y: 110,
      width: 80,
      height: 20,
    })
    const line = d.create('arrow', {
      id: 'e',
      x: 200,
      y: 40,
      points: [
        [0, 0],
        [100, 80],
      ],
    })
    d.bind(line, 'start', 'p')
    d.bind(line, 'end', box)
    expect(d.get(box)?.x).toBe(300)
    d.commit('add topic', { joinPrevious: true })
    expect(c.calls).toHaveLength(2)
    const [first, second] = c.calls
    expect(first?.opts).toEqual({ joinPrevious: true })
    const creates = (first?.ops ?? []).filter((o) => (o as unknown[])[0] === 'create') as [
      string,
      string,
      Record<string, unknown>,
    ][]
    expect(creates.map((o) => o[2].id)).toEqual(['n', 'l', 'e'])
    expect(creates[0]?.[2]).toMatchObject({ x: 300, y: 100, boundElements: [{ id: 'e', type: 'arrow' }] })
    // centre/middle: the creation gets the centre, the engine measures the size
    expect(creates[1]?.[2]).toMatchObject({ x: 350, y: 120 })
    expect(creates[1]?.[2]).not.toHaveProperty('width')
    expect(creates[2]?.[2]).not.toHaveProperty('startBinding')
    // the existing parent lists the arrow through a plain update
    expect(first?.ops).toContainEqual(['update', 'p', { boundElements: [{ id: 'e', type: 'arrow' }] }])
    expect(second?.opts).toEqual({ joinPrevious: true })
    expect(second?.ops).toEqual([
      [
        'update',
        'e',
        {
          startBinding: { elementId: 'p', fixedPoint: [1, 0.5], mode: 'orbit' },
          endBinding: { elementId: 'n', fixedPoint: [0, 0.5], mode: 'orbit' },
        },
      ],
    ])
  })
})
