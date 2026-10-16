import { describe, expect, it } from 'vitest'
import type { CanvasElement, ItemKind } from '../api/lobby-canvas.ts'
import { bind, duplicate, duplicateLobbyData, group, reorder, setFrame, type TxView, ungroup } from './tx.ts'

type El = Record<string, unknown> & { id: string }

function el(id: string, over: Partial<El> = {}): El {
  return {
    id,
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    angle: 0,
    groupIds: [],
    frameId: null,
    locked: false,
    isDeleted: false,
    version: 1,
    versionNonce: 1,
    index: null,
    boundElements: null,
    ...over,
  }
}

/** An in-memory scene: writes apply at once, creates append on top. */
function scene(els: El[]) {
  const map = new Map<string, El>(els.map((e) => [e.id, structuredClone(e)]))
  const order = els.map((e) => e.id)
  const created: { kind: ItemKind; props: Record<string, unknown> }[] = []
  let n = 0
  const view: TxView = {
    get: (id) => map.get(id) as unknown as CanvasElement | undefined,
    items: () =>
      order
        .map((id) => map.get(id) as El)
        .filter((e) => !e.isDeleted)
        .sort((a, b) => String(a.index ?? '').localeCompare(String(b.index ?? '')))
        .map((e) => e as unknown as CanvasElement),
    update(id, patch) {
      const cur = map.get(id)
      if (!cur) throw new Error(`no ${id}`)
      map.set(id, { ...cur, ...patch })
    },
    create(kind, props) {
      created.push({ kind, props: { ...props } })
      const id = String(props.id ?? `new${++n}`)
      map.set(id, el(id, { ...props, type: kind === 'note' ? 'stickynote' : kind }))
      order.push(id)
      return id
    },
    newId: () => `id${++n}`,
  }
  return { view, map, created }
}

describe('reorder', () => {
  const base = () => scene([el('a', { index: 'a0' }), el('b', { index: 'a1' }), el('c', { index: 'a2' })])

  it('front and back keep the relative order and pass every other element', () => {
    const s = base()
    reorder(s.view, ['a'], 'front')
    expect(s.view.items().map((e) => e.id)).toEqual(['b', 'c', 'a'])
    reorder(s.view, ['c'], 'back')
    expect(s.view.items().map((e) => e.id)).toEqual(['c', 'b', 'a'])
  })

  it('forward and backward step past one element; at the edge nothing moves', () => {
    const s = base()
    reorder(s.view, ['a'], 'forward')
    expect(s.view.items().map((e) => e.id)).toEqual(['b', 'a', 'c'])
    reorder(s.view, ['c'], 'backward')
    expect(s.view.items().map((e) => e.id)).toEqual(['b', 'c', 'a'])
    expect(reorder(s.view, ['a'], 'forward').size).toBe(0)
  })

  it('a label moves with its container', () => {
    const s = scene([
      el('n', { type: 'stickynote', index: 'a0', boundElements: [{ id: 'l', type: 'text' }] }),
      el('l', { type: 'text', containerId: 'n', index: 'a1' }),
      el('x', { index: 'a2' }),
    ])
    const out = reorder(s.view, ['n'], 'front')
    expect([...out.keys()]).toEqual(['n', 'l'])
    expect(s.view.items().map((e) => e.id)).toEqual(['x', 'n', 'l'])
  })
})

describe('groups and frames', () => {
  it('group adds one outermost group to the elements and their labels; ungroup removes it', () => {
    const s = scene([
      el('a', { groupIds: ['inner'], boundElements: [{ id: 'al', type: 'text' }] }),
      el('al', { type: 'text', containerId: 'a', groupIds: ['inner'] }),
      el('b'),
    ])
    const gid = group(s.view, ['a', 'b'])
    expect(s.map.get('a')?.groupIds).toEqual(['inner', gid])
    expect(s.map.get('al')?.groupIds).toEqual(['inner', gid])
    expect(s.map.get('b')?.groupIds).toEqual([gid])
    ungroup(s.view, ['b'])
    expect(s.map.get('a')?.groupIds).toEqual(['inner'])
    expect(s.map.get('b')?.groupIds).toEqual([])
  })

  it('setFrame moves the element and its label, never a frame', () => {
    const s = scene([
      el('f', { type: 'frame' }),
      el('a', { boundElements: [{ id: 'al', type: 'text' }] }),
      el('al', { type: 'text', containerId: 'a' }),
    ])
    setFrame(s.view, ['a', 'f'], 'f')
    expect(s.map.get('a')?.frameId).toBe('f')
    expect(s.map.get('al')?.frameId).toBe('f')
    expect(s.map.get('f')?.frameId).toBe(null)
  })
})

describe('bind', () => {
  it('binds an end with a fixed point on the target, lists the arrow on it, and unbinds', () => {
    const s = scene([
      el('t', { x: 100, y: 100, width: 100, height: 100 }),
      el('arr', {
        type: 'arrow',
        x: 0,
        y: 0,
        points: [
          [0, 0],
          [150, 150],
        ],
        startBinding: null,
        endBinding: null,
      }),
    ])
    bind(s.view, 'arr', 'end', 't')
    expect(s.map.get('arr')?.endBinding).toEqual({ elementId: 't', fixedPoint: [0.5, 0.5], mode: 'orbit' })
    expect(s.map.get('t')?.boundElements).toEqual([{ id: 'arr', type: 'arrow' }])
    bind(s.view, 'arr', 'end', null)
    expect(s.map.get('arr')?.endBinding).toBe(null)
    expect(s.map.get('t')?.boundElements).toEqual([])
  })

  it('refuses what is not an arrow', () => {
    const s = scene([el('a')])
    expect(() => bind(s.view, 'a', 'start', null)).toThrow(/not an arrow/)
  })
})

describe('duplicate', () => {
  it('copies elements with offsets, new groups, followed frame and bindings, and labels', () => {
    const s = scene([
      el('f', { type: 'frame', x: 0, y: 0, width: 500, height: 500, index: 'a0' }),
      el('a', {
        frameId: 'f',
        groupIds: ['g1'],
        index: 'a1',
        boundElements: [
          { id: 'al', type: 'text' },
          { id: 'arr', type: 'arrow' },
        ],
      }),
      el('al', { type: 'text', containerId: 'a', frameId: 'f', groupIds: ['g1'], text: 'hi', index: 'a2' }),
      el('arr', {
        type: 'arrow',
        index: 'a3',
        points: [
          [0, 0],
          [10, 10],
        ],
        startBinding: { elementId: 'a', fixedPoint: [0.5, 0.5], mode: 'orbit' },
        endBinding: { elementId: 'elsewhere', fixedPoint: [0, 0], mode: 'orbit' },
      }),
    ])
    const map = duplicate(s.view, ['f', 'arr'], { x: 10, y: 20 }, [])
    expect([...map.keys()].sort()).toEqual(['a', 'arr', 'f'])
    const fa = s.map.get(map.get('a') as string)
    expect(fa?.x).toBe(10)
    expect(fa?.y).toBe(20)
    expect(fa?.frameId).toBe(map.get('f'))
    expect(fa?.groupIds).not.toEqual(['g1'])
    expect((fa?.groupIds as string[] | undefined)?.length).toBe(1)
    const copyArrow = s.map.get(map.get('arr') as string)
    expect((copyArrow?.startBinding as { elementId: string } | undefined)?.elementId).toBe(map.get('a'))
    expect(copyArrow?.endBinding).toBe(null)
    // the copied shape got a copied label and lists the copied arrow
    const labelRef = (fa?.boundElements as { id: string; type: string }[] | undefined)?.find(
      (b) => b.type === 'text',
    )
    expect(labelRef).toBeDefined()
    expect(s.map.get(labelRef?.id as string)?.containerId).toBe(map.get('a'))
    expect(fa?.boundElements).toContainEqual({ id: map.get('arr'), type: 'arrow' })
  })

  it('a note is re-created with its words (the creation footer stays off)', () => {
    const s = scene([
      el('n', {
        type: 'stickynote',
        backgroundColor: '#f8e48f',
        boundElements: [{ id: 'nl', type: 'text' }],
      }),
      el('nl', { type: 'text', containerId: 'n', originalText: 'Idea' }),
    ])
    duplicate(s.view, ['n'], { x: 5, y: 5 }, [])
    const note = s.created.find((c) => c.kind === 'note')
    expect(note?.props.text).toBe('Idea')
    expect(note?.props.backgroundColor).toBe('#f8e48f')
  })
})

describe('duplicateLobbyData', () => {
  it('follows the canvas-schema rules unless a feature handler decides', () => {
    const out = duplicateLobbyData(
      {
        'tag:x': { name: 'X', color: 'red' },
        'plusOne:usr_1': 1,
        ai: { by: 'x' },
        present: { index: 3, hidden: true },
        mindmap: { root: 'a' },
        bogus: 1,
      },
      new Map([['a', 'a2']]),
      [{ id: 'mindmap', match: 'exact', onDuplicate: (v) => ({ ...(v as object), relinked: true }) }],
    )
    expect(out).toEqual({
      'tag:x': { name: 'X', color: 'red' },
      present: { hidden: true },
      mindmap: { root: 'a', relinked: true },
    })
    expect(duplicateLobbyData(undefined, new Map(), [])).toBeUndefined()
  })

  it('wave T: relink-keep points a panel at a copied head and keeps it otherwise; card keys are kept', () => {
    const lobby = { 'sb:of': 'h1', 'sb:pos': 'a0', 'card:status': 'todo' }
    expect(duplicateLobbyData(lobby, new Map([['h1', 'h2']]), [])).toEqual({ ...lobby, 'sb:of': 'h2' })
    expect(duplicateLobbyData(lobby, new Map(), [])).toEqual(lobby)
    const head = { 'sb:head': { aspect: '16:9', audio: 'a1' } }
    expect(duplicateLobbyData(head, new Map([['a1', 'a2']]), [])).toEqual({
      'sb:head': { aspect: '16:9', audio: 'a2' },
    })
  })
})
