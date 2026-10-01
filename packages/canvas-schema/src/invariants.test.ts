/**
 * `checkInvariants` (docs/EXCALIDRAW-MIGRATION.md §2.4.4): one planted violation per code, and a
 * property test over random consistent element graphs (notes with labels, shapes, arrows bound at one or
 * both ends, frames with children, nested groups, tombstones): every consistent graph gives no
 * violation, and each single planted fault gives exactly the expected code.
 */
import { describe, expect, it } from 'vitest'
import type { WireElement } from './elements.ts'
import { indexKeysBetween } from './engine/fractional.ts'
import { checkInvariants, type ViolationCode } from './invariants.ts'

// biome-ignore lint/suspicious/noExplicitAny: plain test elements
type El = Record<string, any>

const base = (id: string, type: string, o: El = {}): El => ({
  id,
  type,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  angle: 0,
  isDeleted: false,
  index: null,
  groupIds: [],
  frameId: null,
  boundElements: null,
  locked: false,
  ...o,
})
const text = (id: string, containerId: string | null, o: El = {}) => base(id, 'text', { containerId, ...o })
const arrow = (id: string, o: El = {}) =>
  base(id, 'arrow', {
    points: [
      [0, 0],
      [10, 0],
    ],
    startBinding: null,
    endBinding: null,
    elbowed: false,
    ...o,
  })
const bindingTo = (id: string) => ({ elementId: id, fixedPoint: [0.5, 0.5], mode: 'orbit' })

/** Assigns increasing keys in array order. */
function keyed(els: El[]): El[] {
  const keys = indexKeysBetween(null, null, els.length)
  return els.map((e, i) => ({ ...e, index: e.index ?? keys[i] }))
}
const codes = (els: El[]) => checkInvariants(els as unknown as WireElement[]).map((v) => v.code)

/** A small consistent board. */
function board(): El[] {
  return keyed([
    base('f1', 'frame', { boundElements: null }),
    base('n1', 'stickynote', {
      frameId: 'f1',
      boundElements: [
        { id: 'n1.t', type: 'text' },
        { id: 'a1', type: 'arrow' },
      ],
    }),
    text('n1.t', 'n1', { frameId: 'f1' }),
    base('r1', 'rectangle', { groupIds: ['g1', 'g2'], boundElements: [{ id: 'a1', type: 'arrow' }] }),
    base('r2', 'rectangle', { groupIds: ['g2'] }),
    arrow('a1', {
      startBinding: bindingTo('n1'),
      endBinding: bindingTo('r1'),
      boundElements: [{ id: 'a1.t', type: 'text' }],
    }),
    text('a1.t', 'a1'),
    text('free', null),
    base('dead', 'rectangle', { isDeleted: true, index: null }),
  ])
}

describe('checkInvariants', () => {
  it('a consistent board has no violation (tombstones are ignored)', () => {
    expect(checkInvariants(board() as unknown as WireElement[])).toEqual([])
  })

  const planted: [string, (b: El[]) => void, ViolationCode][] = [
    [
      'a label whose container is missing',
      (b) => b.push(text('lost', 'nope', { index: 'a9' })),
      'LABEL_CONTAINER_INVALID',
    ],
    ['a label on a frame', (b) => b.push(text('onframe', 'f1', { index: 'a9' })), 'LABEL_CONTAINER_INVALID'],
    [
      'a label whose container is deleted',
      (b) => void Object.assign(b.find((e) => e.id === 'n1') as El, { isDeleted: true }),
      'LABEL_ORPHANED',
    ],
    [
      'a second label for a container',
      (b) => {
        const n = b.find((e) => e.id === 'n1') as El
        n.boundElements = [...n.boundElements, { id: 'n1.t2', type: 'text' }]
        b.push(text('n1.t2', 'n1', { index: 'a9' }))
      },
      'LABEL_NOT_ONE_TO_ONE',
    ],
    [
      'a label below its container',
      (b) => void Object.assign(b.find((e) => e.id === 'n1.t') as El, { index: 'Zz' }),
      'LABEL_ORDER',
    ],
    [
      'a binding to a missing element',
      (b) => void Object.assign(b.find((e) => e.id === 'a1') as El, { endBinding: bindingTo('nope') }),
      'BINDING_TARGET_INVALID',
    ],
    [
      'a target that does not list its arrow',
      (b) => void Object.assign(b.find((e) => e.id === 'r1') as El, { boundElements: null }),
      'BINDING_ASYMMETRIC',
    ],
    [
      'a target listing an arrow not bound to it',
      (b) =>
        void Object.assign(b.find((e) => e.id === 'r2') as El, {
          boundElements: [{ id: 'a1', type: 'arrow' }],
        }),
      'BINDING_ASYMMETRIC',
    ],
    [
      'a frameId naming a rectangle',
      (b) => void Object.assign(b.find((e) => e.id === 'r2') as El, { frameId: 'r1' }),
      'FRAME_INVALID',
    ],
    ['a nested frame', (b) => b.push(base('f2', 'frame', { frameId: 'f1', index: 'a9' })), 'FRAME_INVALID'],
    [
      'a group with two parents',
      (b) => void Object.assign(b.find((e) => e.id === 'r2') as El, { groupIds: ['g1', 'g3'] }),
      'GROUP_NESTING',
    ],
    ['a refused type', (b) => b.push(base('emb', 'embeddable', { index: 'a9' })), 'TYPE_REFUSED'],
    ['a null index', (b) => b.push(base('noidx', 'rectangle', { index: null })), 'INDEX_INVALID'],
    [
      'a shared index',
      (b) =>
        void Object.assign(b.find((e) => e.id === 'r2') as El, {
          index: (b.find((e) => e.id === 'r1') as El).index,
        }),
      'INDEX_DUPLICATE',
    ],
  ]
  for (const [name, plant, code] of planted)
    it(`${name} → ${code}`, () => {
      const b = board()
      plant(b)
      expect(codes(b)).toContain(code)
    })
})

describe('checkInvariants, property test over random graphs', () => {
  let seed = 12345
  const rnd = () => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)] as T

  /** A random consistent board: containers with or without labels, arrows between bindables, frames, groups, tombstones. */
  function randomBoard(): El[] {
    const els: El[] = []
    const frames: El[] = []
    for (let i = 0; i < 1 + Math.floor(rnd() * 2); i++) {
      const f = base(`f${i}`, 'frame')
      frames.push(f)
      els.push(f)
    }
    const bindables: El[] = []
    const n = 3 + Math.floor(rnd() * 8)
    for (let i = 0; i < n; i++) {
      const type = pick(['rectangle', 'ellipse', 'diamond', 'stickynote'])
      const c = base(`c${i}`, type, {
        frameId: rnd() < 0.3 ? pick(frames).id : null,
        groupIds: rnd() < 0.3 ? ['gA', 'gOuter'] : rnd() < 0.2 ? ['gOuter'] : [],
      })
      els.push(c)
      bindables.push(c)
      if (rnd() < 0.5) {
        const t = text(`c${i}.t`, c.id, { frameId: c.frameId })
        c.boundElements = [{ id: t.id, type: 'text' }]
        els.push(t)
      }
    }
    const free = text('freeText', null)
    els.push(free)
    bindables.push(free)
    for (let i = 0; i < Math.floor(rnd() * 6); i++) {
      const s = rnd() < 0.8 ? pick(bindables) : null
      const e = rnd() < 0.8 ? pick(bindables) : null
      const a = arrow(`a${i}`, {
        startBinding: s ? bindingTo(s.id) : null,
        endBinding: e ? bindingTo(e.id) : null,
      })
      for (const t of [s, e])
        if (t && !(t.boundElements ?? []).some((r: El) => r.id === a.id))
          t.boundElements = [...(t.boundElements ?? []), { id: a.id, type: 'arrow' }]
      els.push(a)
    }
    for (let i = 0; i < Math.floor(rnd() * 3); i++)
      els.push(base(`dead${i}`, 'rectangle', { isDeleted: true }))
    // order: containers before their labels
    return keyed(els)
  }

  it('200 random consistent boards: no violation; one planted fault each: its code', () => {
    for (let k = 0; k < 200; k++) {
      const b = randomBoard()
      expect(codes(b)).toEqual([])
      const labels = b.filter((e) => e.type === 'text' && e.containerId)
      const arrows = b.filter((e) => e.type === 'arrow' && (e.startBinding || e.endBinding))
      const fault = pick(['orphan', 'asym', 'order', 'frame'] as const)
      if (fault === 'orphan' && labels.length) {
        const l = pick(labels)
        ;(b.find((e) => e.id === l.containerId) as El).isDeleted = true
        expect(codes(b)).toContain('LABEL_ORPHANED')
      } else if (fault === 'asym' && arrows.length) {
        const a = pick(arrows)
        const t = b.find((e) => e.id === (a.startBinding ?? a.endBinding).elementId) as El
        t.boundElements = (t.boundElements ?? []).filter((r: El) => r.id !== a.id)
        expect(codes(b)).toContain('BINDING_ASYMMETRIC')
      } else if (fault === 'order' && labels.length) {
        const l = pick(labels)
        l.index = 'Zz'
        expect(codes(b)).toContain('LABEL_ORDER')
      } else {
        const c = b.find((e) => e.type === 'rectangle' && !e.isDeleted)
        if (!c) continue
        c.frameId = 'nope'
        expect(codes(b)).toContain('FRAME_INVALID')
      }
    }
  })
})
