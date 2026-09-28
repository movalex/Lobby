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
