// 3a's styles part (./styles.ts): which fields a selection shares, and what `apply` writes (one transact,
// only where a field applies, labels where the rules say so). Text layout needs a browser canvas, so the
// text fields' relayout is checked by the e2e spec (e2e/excalidraw/canvas-ux-toolbar.spec.ts); here only
// that they are routed to the label.
import { installServerTextMetrics } from '@draftroom/canvas-schema/engine'
import { describe, expect, it } from 'vitest'
import type { CanvasElement } from '../../port.ts'
import { createFeatureRegistries } from '../registries.ts'
import { createStylesPart, noteSizeWrites, stylesOf } from './styles.ts'

const el = (id: string, type: string, extra: Record<string, unknown> = {}): CanvasElement =>
  ({
    id,
    type,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    angle: 0,
    strokeColor: '#1d1d1d',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    roundness: null,
    groupIds: [],
    frameId: null,
    locked: false,
    isDeleted: false,
    version: 1,
    versionNonce: 1,
    index: 'a0',
    boundElements: null,
    ...extra,
  }) as unknown as CanvasElement

function scene() {
  const els = new Map<string, CanvasElement>([
    ['r1', el('r1', 'rectangle', { strokeColor: '#4465e9' })],
    ['r2', el('r2', 'rectangle', { strokeColor: '#e03131', roundness: { type: 3 } })],
    ['a1', el('a1', 'arrow', { startArrowhead: null, endArrowhead: 'arrow' })],
    [
      'n1',
      el('n1', 'stickynote', { backgroundColor: '#f8e48f', boundElements: [{ id: 'l1', type: 'text' }] }),
    ],
    [
      'l1',
      el('l1', 'text', {
        containerId: 'n1',
        fontFamily: 6,
        fontSize: 18,
        baseFontSize: 22,
        textAlign: 'center',
        verticalAlign: 'middle',
      }),
    ],
    [
      't1',
      el('t1', 'text', {
        containerId: null,
        fontFamily: 5,
        fontSize: 24,
        textAlign: 'left',
        verticalAlign: 'top',
      }),
    ],
  ])
  return els
}

function fakeCanvas(els: Map<string, CanvasElement>, selection: string[]) {
  const writes: { label: string; ops: [string, Record<string, unknown>][] }[] = []
  const next: Record<string, unknown>[] = []
  const canvas = {
    get: (id: string) => els.get(id),
    items: () => [...els.values()],
    get selection() {
      return selection
    },
    readOnly: () => false,
    editingId: () => null,
    leaseHolder: () => null,
    engine: null,
    styles: { setNext: (p: Record<string, unknown>) => void next.push(p) },
    transact: (label: string, fn: (tx: { update(id: string, p: Record<string, unknown>): void }) => void) => {
      const ops: [string, Record<string, unknown>][] = []
      fn({ update: (id, p) => void ops.push([id, p]) })
      writes.push({ label, ops })
    },
  }
  const part = createStylesPart({
    port: null as never,
    registries: createFeatureRegistries(),
    self: () => canvas as never,
  })
  return { part, writes, next }
}

describe('stylesOf', () => {
  it('reports a shared value, mixed, and nothing for a field no element has', () => {
    const els = scene()
    const get = (id: string) => els.get(id)
    const two = stylesOf([els.get('r1'), els.get('r2')] as CanvasElement[], get)
    expect(two.strokeColor).toBe('mixed')
    expect(two.fillStyle).toBe('solid')
    expect(two.roundness).toBe('mixed')
    expect(two.startArrowhead).toBeUndefined()
    expect(two.fontFamily).toBeUndefined()
  })

  it('reads a container’s text fields on its label, a note label’s size as its base size', () => {
    const els = scene()
    const s = stylesOf([els.get('n1')] as CanvasElement[], (id) => els.get(id))
    expect(s).toMatchObject({ fontFamily: 6, fontSize: 22, textAlign: 'center', verticalAlign: 'middle' })
    expect(s.backgroundColor).toBe('#f8e48f')
    // a free text has no vertical alignment of its own; a bound label is never read twice
    const t = stylesOf([els.get('t1'), els.get('l1')] as CanvasElement[], (id) => els.get(id))
    expect(t.verticalAlign).toBeUndefined()
    expect(t.fontFamily).toBe(5)
  })
})

describe('apply', () => {
  it('writes each field only where it applies, in one transact, and sets the next style', () => {
    const { part, writes, next } = fakeCanvas(scene(), ['r1', 'a1', 'n1'])
    part.apply({ fillStyle: 'hachure', endArrowhead: 'triangle', opacity: 50 })
    expect(writes).toHaveLength(1)
    const ops = Object.fromEntries(writes[0]?.ops ?? [])
    expect(ops.r1).toEqual({ fillStyle: 'hachure', opacity: 50 })
    expect(ops.a1).toEqual({ endArrowhead: 'triangle', opacity: 50 })
    // the note fades with its label; a note takes no fill style
    expect(ops.n1).toEqual({ opacity: 50 })
    expect(ops.l1).toEqual({ opacity: 50 })
    expect(next).toEqual([{ fillStyle: 'hachure', endArrowhead: 'triangle', opacity: 50 }])
  })

  it('a note and its label keep one ink; roundness maps to the engine’s kinds; nothing to change writes nothing', () => {
    const { part, writes } = fakeCanvas(scene(), ['n1', 'r1', 'a1'])
    part.apply({ strokeColor: '#1b2330', roundness: 'round' })
    const ops = Object.fromEntries(writes[0]?.ops ?? [])
    expect(ops.n1).toEqual({ strokeColor: '#1b2330' })
    expect(ops.l1).toEqual({ strokeColor: '#1b2330' })
    expect(ops.r1).toEqual({ strokeColor: '#1b2330', roundness: { type: 3 } })
    expect(ops.a1).toEqual({ strokeColor: '#1b2330', roundness: { type: 2 } })
    const again = fakeCanvas(scene(), ['r1'])
    again.part.apply({ strokeColor: '#4465e9' })
    expect(again.writes).toHaveLength(0)
  })

  it('a selected label counts as its container; an elbow switch is never written to an existing arrow', () => {
    const { part, writes, next } = fakeCanvas(scene(), ['l1', 'a1'])
    part.apply({ elbowed: true, backgroundColor: '#a6d8f3' })
    const ops = Object.fromEntries(writes[0]?.ops ?? [])
    expect(ops.n1).toEqual({ backgroundColor: '#a6d8f3' })
    expect(ops.a1).toBeUndefined()
    expect(next[0]).toMatchObject({ elbowed: true })
  })
})

describe('P-011: noteSizeWrites (a note’s Size is the note’s)', () => {
  installServerTextMetrics()
  const note = el('n', 'stickynote', {
    width: 200,
    height: 200,
    baseHeight: 200,
    backgroundColor: '#f8e48f',
    boundElements: [{ id: 'n.t', type: 'text' }],
  })
  const label = el('n.t', 'text', {
    x: 20,
    y: 80,
    width: 160,
    height: 28,
    text: 'Hero film idea',
    originalText: 'Hero film idea',
    fontSize: 22,
    baseFontSize: 22,
    fontFamily: 6,
    lineHeight: 1.25,
    textAlign: 'center',
    verticalAlign: 'middle',
    containerId: 'n',
    autoResize: true,
  })

  it('makes the note `side` square from its top-left corner, its words’ ceiling `fontSize`, laid out in it', () => {
    const w = noteSizeWrites([note, label], ['n'], 400, 44)
    const n = w.get('n') ?? {}
    expect(n).toMatchObject({ width: 400, baseHeight: 400 })
    expect((n.height as number | undefined) ?? 400).toBeGreaterThanOrEqual(400)
    expect(n.x ?? 0).toBe(0)
    expect(n.y ?? 0).toBe(0)
    const t = w.get('n.t') ?? {}
    expect(t.baseFontSize).toBe(44)
    // the words are laid out again inside the bigger note
    expect(typeof t.x === 'number' && typeof t.width === 'number' && t.x + t.width <= 400).toBe(true)
  })

  it('only notes: a rectangle or a label alone is left as it is', () => {
    expect(noteSizeWrites([note, label, el('r', 'rectangle')], ['r'], 400, 44).size).toBe(0)
  })
})
