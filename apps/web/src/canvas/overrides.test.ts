import { newElement } from '@excalidraw/element'
import type { ExcalidrawElement } from '@excalidraw/element/types'
import type { AppState, ElementRenderOverrides } from '@excalidraw/excalidraw/types'
import { describe, expect, it } from 'vitest'
import {
  elementAtScenePoint,
  expandHidden,
  mergeRenderOverrides,
  type OverrideElementInfo,
  RenderOverrides,
  sameOverrides,
} from './overrides.ts'

const el = (id: string, extra: Partial<OverrideElementInfo> = {}): OverrideElementInfo => ({
  id,
  type: 'rectangle',
  ...extra,
})

describe('mergeRenderOverrides', () => {
  it('merges drag offsets (most recent source wins) and hidden opacity', () => {
    const drags = new Map([
      [
        'bob',
        new Map([
          ['a', { x: 10, y: 0 }],
          ['b', { x: 5, y: 5 }],
        ]),
      ],
      ['carol', new Map([['a', { x: 0, y: 20 }]])],
    ])
    const m = mergeRenderOverrides({ drags, hidden: new Set(['b', 'c']) })
    expect(m.get('a')).toEqual({ offset: { x: 0, y: 20 } })
    expect(m.get('b')).toEqual({ offset: { x: 5, y: 5 }, opacity: 0 })
    expect(m.get('c')).toEqual({ opacity: 0 })
  })
  it('drops zero and non-finite offsets', () => {
    const drags = new Map([
      [
        'bob',
        new Map([
          ['a', { x: 0, y: 0 }],
          ['b', { x: Number.NaN, y: 1 }],
        ]),
      ],
    ])
    expect(mergeRenderOverrides({ drags, hidden: new Set() }).size).toBe(0)
  })
})

describe('sameOverrides', () => {
  it('compares ids, opacity and offsets', () => {
    const a: ElementRenderOverrides = new Map([['x', { opacity: 0 }]])
    expect(sameOverrides(a, new Map([['x', { opacity: 0 }]]))).toBe(true)
    expect(sameOverrides(a, new Map([['x', { opacity: 0, offset: { x: 0, y: 0 } }]]))).toBe(false)
    expect(sameOverrides(a, new Map([['y', { opacity: 0 }]]))).toBe(false)
    expect(sameOverrides(new Map(), new Map())).toBe(true)
  })
})

describe('expandHidden', () => {
  it('adds bound labels of hidden containers, and children (with labels) of hidden frames', () => {
    const scene = [
      el('note', {
        type: 'stickynote',
        boundElements: [
          { id: 'label', type: 'text' },
          { id: 'arrow', type: 'arrow' },
        ],
      }),
      el('label', { type: 'text', containerId: 'note' }),
      el('frame', { type: 'frame' }),
      el('child', { frameId: 'frame', boundElements: [{ id: 'childLabel', type: 'text' }] }),
      el('childLabel', { type: 'text', containerId: 'child', frameId: 'frame' }),
      el('gone', { isDeleted: true }),
      el('other'),
    ]
    expect([...expandHidden(['note', 'frame', 'gone'], scene)].sort()).toEqual([
      'child',
      'childLabel',
      'frame',
      'label',
      'note',
    ])
  })
})

describe('RenderOverrides', () => {
  const setup = () => {
    const submitted: (ElementRenderOverrides | null)[] = []
    const queue: (() => void)[] = []
    const scene = [
      el('n', { boundElements: [{ id: 'l', type: 'text' }] }),
      el('l', { type: 'text', containerId: 'n' }),
    ]
    const o = new RenderOverrides(
      { setElementRenderOverrides: (x) => submitted.push(x) },
      { elements: () => scene, schedule: (f) => queue.push(f) },
    )
    const run = () => {
      for (const f of queue.splice(0)) f()
    }
    return { o, submitted, run }
  }

  it('coalesces changes into one submit and skips an unchanged snapshot', () => {
    const { o, submitted, run } = setup()
    o.setDrag('bob', new Map([['n', { x: 3, y: 4 }]]))
    o.setHidden('collapse', ['n'])
    run()
    expect(submitted).toHaveLength(1)
    expect([...(submitted[0] ?? new Map()).entries()]).toEqual([
      ['n', { offset: { x: 3, y: 4 }, opacity: 0 }],
      ['l', { opacity: 0 }],
    ])
    o.refresh()
    run()
    expect(submitted).toHaveLength(1)
    expect(o.stats).toEqual({ submits: 1, skipped: 1 })
  })

  it('reports why a press must be blocked: hidden (labels too), or moved by a peer', () => {
    const { o, run } = setup()
    o.setHidden('collapse', ['n'])
    o.setDrag('bob', new Map([['x', { x: 1, y: 0 }]]))
    run()
    expect(o.blockReason('l')).toEqual({ kind: 'hidden' })
    expect(o.blockReason('x')).toEqual({ kind: 'moving', source: 'bob' })
    expect(o.blockReason('y')).toBeNull()
    o.clearDragFor(['x'])
    run()
    expect(o.blockReason('x')).toBeNull()
  })

  it('clearing everything submits null (the engine clears its snapshot)', () => {
    const { o, submitted, run } = setup()
    o.setHidden('collapse', ['n'])
    run()
    o.setHidden('collapse', null)
    run()
    expect(submitted.at(-1)).toBeNull()
  })
})

describe('elementAtScenePoint (the guard sees what Excalidraw would pick)', () => {
  const appState = {
    zoom: { value: 1 },
    frameRendering: { enabled: true, clip: true, name: true, outline: true },
  } as unknown as Pick<AppState, 'zoom' | 'frameRendering'>
  const rect = (id: string, x: number, y: number, extra: Record<string, unknown> = {}) =>
    ({
      ...newElement({
        type: 'rectangle',
        x,
        y,
        width: 100,
        height: 100,
        backgroundColor: '#ffdf6b',
        fillStyle: 'solid',
      }),
      id,
      ...extra,
    }) as ExcalidrawElement

  it('picks the topmost filled shape under the point, skips locked and deleted ones', () => {
    const a = rect('a', 0, 0)
    const b = rect('b', 50, 50)
    expect(elementAtScenePoint([a, b], appState, 75, 75)?.id).toBe('b')
    expect(elementAtScenePoint([a, b], appState, 25, 25)?.id).toBe('a')
    expect(elementAtScenePoint([a, { ...b, locked: true } as ExcalidrawElement], appState, 75, 75)?.id).toBe(
      'a',
    )
    expect(
      elementAtScenePoint([a, { ...b, isDeleted: true } as ExcalidrawElement], appState, 75, 75)?.id,
    ).toBe('a')
    expect(elementAtScenePoint([a, b], appState, 400, 400)).toBeNull()
  })

  it('a bound label is never picked itself: its container is', () => {
    const c = rect('c', 0, 0, { boundElements: [{ id: 't', type: 'text' }] })
    // a text element built by hand (newTextElement measures with a DOM canvas; tests run in Node)
    const t = {
      ...rect('t', 10, 40),
      type: 'text',
      containerId: 'c',
      text: 'hi',
      originalText: 'hi',
      fontSize: 20,
      fontFamily: 6,
      textAlign: 'left',
      verticalAlign: 'top',
      lineHeight: 1.25,
      autoResize: true,
      width: 20,
      height: 25,
    } as unknown as ExcalidrawElement
    expect(elementAtScenePoint([c, t], appState, 20, 45)?.id).toBe('c')
  })
})

describe('render-only sources (wave 5, 2C): CR 3b-5 culling and D1 preview arrows', () => {
  const setup = () => {
    const submitted: (ElementRenderOverrides | null)[] = []
    let pending: (() => void) | null = null
    const o = new RenderOverrides(
      { setElementRenderOverrides: (x) => submitted.push(x) },
      { elements: () => [el('a'), el('b'), el('c')], schedule: (f) => (pending = f) },
    )
    const run = () => {
      const f = pending
      pending = null
      f?.()
    }
    return { o, submitted, run }
  }

  it('culled ids are moved far out of view, render-only: never hidden, never blocked; a drag or a collapse keeps its entry', () => {
    const { o, submitted, run } = setup()
    o.setCulled('lod', new Set(['a', 'b', 'c']))
    o.setDrag('bob', new Map([['b', { x: 10, y: 0 }]]))
    o.setHidden('mindmap', ['c'])
    run()
    const snap = submitted.at(-1) as ElementRenderOverrides
    expect(snap.get('a')).toEqual({ offset: { x: 1e9, y: 1e9 } })
    expect(snap.get('b')).toEqual({ offset: { x: 10, y: 0 } })
    expect(snap.get('c')).toEqual({ opacity: 0 })
    expect(o.isHidden('a')).toBe(false)
    expect(o.blockReason('a')).toBeNull()
    expect([...o.movedIds()]).toEqual(['b'])
    o.setCulled('lod', null)
    run()
    expect((submitted.at(-1) as ElementRenderOverrides).has('a')).toBe(false)
  })

  it('an unchanged cull set submits nothing', () => {
    const { o, submitted, run } = setup()
    o.setCulled('lod', new Set(['a']))
    run()
    const n = submitted.length
    o.setCulled('lod', new Set(['a']))
    run()
    expect(submitted.length).toBe(n)
  })

  it('a preview-hidden arrow draws invisible and counts as moving (by its source), not as hidden', () => {
    const { o, submitted, run } = setup()
    o.setPreviewHidden('bob:t', ['a'])
    run()
    expect((submitted.at(-1) as ElementRenderOverrides).get('a')).toEqual({ opacity: 0 })
    expect(o.isHidden('a')).toBe(false)
    expect(o.blockReason('a')).toEqual({ kind: 'moving', source: 'bob:t' })
    expect(o.hasDrags()).toBe(true)
    o.setPreviewHidden('bob:t', null)
    run()
    expect(submitted.at(-1)).toBeNull()
  })

  it('submit listeners hear every snapshot', () => {
    const { o, run } = setup()
    const heard: number[] = []
    o.onSubmit((s) => heard.push(s.size))
    o.setCulled('lod', new Set(['a', 'b']))
    run()
    o.setHidden('x', ['c'])
    run()
    expect(heard).toEqual([2, 3])
  })
})
