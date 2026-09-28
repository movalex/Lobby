/**
 * Spike check A8 (plan §8.2): the index pre-pass. First reproduces probe1 (Excalidraw re-keys the later
 * of two colliding elements in place and bumps its version), then proves that with the pre-pass no
 * confirmed element changes version, through the same `Scene.replaceAllElements` that `updateScene`
 * calls (excalidraw `dist/dev/index.js:43825-43846` → element `index.js:19079-19085`).
 */
import {
  newElement,
  newTextElement,
  Scene,
  setCustomTextMetricsProvider,
  syncInvalidIndices,
  validateFractionalIndices,
} from '@excalidraw/element'
import { generateNKeysBetween } from '@excalidraw/fractional-indexing'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  assertConfirmedUntouched,
  compareIndexThenId,
  confirmedVersionChanges,
  confirmedVersions,
  EchoSuspectError,
  indexPrePass,
  isValidKey,
} from './index-keys.ts'

type El = {
  id: string
  type: string
  index: string | null
  version: number
  versionNonce: number
  isDeleted: boolean
  containerId?: string | null
  boundElements?: { id: string; type: string }[] | null
}

const base = {
  x: 0,
  y: 0,
  width: 40,
  height: 40,
  strokeColor: '#1e1e1e',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeWidth: 1,
  strokeStyle: 'solid',
  roughness: 0,
  opacity: 100,
  groupIds: [],
  frameId: null,
  roundness: null,
  link: null,
  locked: false,
} as const

const rect = (id: string, index: string | null, extra: Partial<El> = {}): El =>
  ({
    ...newElement({ ...base, type: 'rectangle', id } as never),
    index,
    version: 3,
    ...extra,
  }) as unknown as El

const label = (id: string, containerId: string, index: string | null): El =>
  ({
    ...newTextElement({ ...base, id, text: 'hi', containerId } as never),
    index,
    version: 2,
  }) as unknown as El

/** what `updateScene({ elements })` does to the array: `Scene.replaceAllElements` (mutates in place) */
const applyLikeUpdateScene = (elements: readonly El[]) => {
  const copies = elements.map((e) => ({ ...e }))
  const scene = new Scene()
  scene.replaceAllElements(copies as never)
  return scene.getElementsIncludingDeleted() as unknown as El[]
}

beforeAll(() => {
  // `Scene.replaceAllElements` reads `window?.DEBUG_FRACTIONAL_INDICES` on its first call per minute
  // (element index.js:18947-18958): with no `window` global at all that is a ReferenceError in Node. A
  // browser has `window` and no flag, so the validator does not run there; an empty object matches it.
  ;(globalThis as { window?: unknown }).window ??= {}
  // Node has no canvas: labels only need some width here (the real server provider is canvas-schema's)
  setCustomTextMetricsProvider({ getLineWidth: (text: string) => text.length * 10 } as never)
})

const sorted = (els: El[]) => [...els].sort(compareIndexThenId)

describe('A8: reproduce probe1 (Excalidraw re-keys the later colliding element and bumps its version)', () => {
  it('syncInvalidIndices: B (second a1) becomes a new key with version +1; A untouched', () => {
    const a = rect('A', 'a1')
    const b = rect('B', 'a1')
    const c = rect('C', 'a2')
    const va = a.version
    const vb = b.version
    syncInvalidIndices([a, b, c] as never)
    expect(a.index).toBe('a1')
    expect(a.version).toBe(va)
    expect(b.index).not.toBe('a1')
    expect((b.index ?? '') > 'a1' && (b.index ?? '') < 'a2').toBe(true)
    expect(b.version).toBe(vb + 1)
  })

  it('Scene.replaceAllElements (the updateScene path) does the same', () => {
    const out = applyLikeUpdateScene([rect('A', 'a1'), rect('B', 'a1'), rect('C', 'a2')])
    const b = out.find((e) => e.id === 'B')
    expect(b?.index).toBe('a1V')
    expect(b?.version).toBe(4)
  })

  it('the echo: my new X (a1) sorts before confirmed c2 (a1), so c2 is re-keyed; the dev assertion fires', () => {
    const confirmed = [rect('c1', 'a0'), rect('c2', 'a1'), rect('c3', 'a2')]
    const input = sorted([...confirmed, rect('X0', 'a1', { version: 1 })])
    expect(input.map((e) => e.id)).toEqual(['c1', 'X0', 'c2', 'c3'])
    const before = confirmedVersions(input, (e) => e.id !== 'X0')
    const after = applyLikeUpdateScene(input)
    expect(confirmedVersionChanges(before, after)).toEqual([{ id: 'c2', from: 3, to: 4 }])
    expect(() => assertConfirmedUntouched(before, after)).toThrow(EchoSuspectError)
  })
})

describe('A8: Lobby pre-pass keeps confirmed elements untouched', () => {
  const run = (input: El[], own: (e: El) => boolean, inFlight?: (e: El) => boolean) => {
    const pre = indexPrePass(input, { isOwnUnacked: own, isInFlight: inFlight })
    const before = confirmedVersions(pre.elements, (e) => !own(e))
    const after = applyLikeUpdateScene(pre.elements)
    // the assertion stays silent, and Excalidraw's own validator (dev mode throws) accepts the array
    assertConfirmedUntouched(before, after)
    validateFractionalIndices(pre.elements as never, {
      shouldThrow: true,
      includeBoundTextValidation: true,
      ignoreLogs: true,
    })
    // updateScene changed nothing at all, own elements included
    for (const e of pre.elements) expect(after.find((a) => a.id === e.id)?.index).toBe(e.index)
    return pre
  }

  it('re-keys my colliding element strictly between its confirmed neighbours', () => {
    const pre = run(
      [rect('c1', 'a0'), rect('c2', 'a1'), rect('c3', 'a2'), rect('X0', 'a1', { version: 1 })],
      (e) => e.id === 'X0',
    )
    expect(pre.rekeys).toEqual([{ id: 'X0', from: 'a1', to: 'a1V', reason: 'collision', inFlight: false }])
    expect(pre.elements.map((e) => e.id)).toEqual(['c1', 'c2', 'X0', 'c3'])
    expect(pre.confirmedConflicts).toEqual([])
  })

  it('a collision with a tombstone is resolved on my side too', () => {
    const pre = run(
      [rect('c1', 'a0'), rect('d1', 'a1', { isDeleted: true }), rect('X0', 'a1')],
      (e) => e.id === 'X0',
    )
    expect(pre.rekeys[0]?.id).toBe('X0')
    expect(pre.elements.find((e) => e.id === 'd1')?.index).toBe('a1')
  })

  it('null and invalid keys on my elements are assigned at the top', () => {
    const pre = run([rect('c1', 'a0'), rect('c2', 'a1'), rect('X1', null), rect('X2', 'zz!')], (e) =>
      e.id.startsWith('X'),
    )
    expect(pre.rekeys.map((r) => [r.id, r.reason])).toEqual([
      ['X1', 'invalid'],
      ['X2', 'invalid'],
    ])
    expect(pre.elements.map((e) => e.id)).toEqual(['c1', 'c2', 'X1', 'X2'])
  })

  it('my new label that sorts before its confirmed container is moved just above it (E3)', () => {
    const container = rect('c2', 'a1', { boundElements: [{ id: 'L', type: 'text' }] })
    const pre = run(
      [rect('c1', 'a0'), container, rect('c3', 'a2'), label('L', 'c2', 'a0V')],
      (e) => e.id === 'L',
    )
    expect(pre.rekeys).toEqual([{ id: 'L', from: 'a0V', to: 'a1V', reason: 'label-order', inFlight: false }])
    expect(pre.elements.map((e) => e.id)).toEqual(['c1', 'c2', 'L', 'c3'])
  })

  it('reports whether a re-keyed element is already in flight (that re-key stays local)', () => {
    const pre = run(
      [rect('c1', 'a1'), rect('X0', 'a1'), rect('X1', 'a1')],
      (e) => e.id.startsWith('X'),
      (e) => e.id === 'X1',
    )
    expect(pre.rekeys.map((r) => [r.id, r.inFlight])).toEqual([
      ['X0', false],
      ['X1', true],
    ])
  })

  it('50 concurrent creates at the top by each of two users: the receiver re-keys only its own 50', () => {
    const top = 'a5'
    const keys = generateNKeysBetween(top, null, 50)
    const confirmed = [rect('top0', top), ...keys.map((k, i) => rect(`A${String(i).padStart(2, '0')}`, k))]
    const mine = keys.map((k, i) => rect(`b${String(i).padStart(2, '0')}`, k, { version: 1 }))
    const pre = run([...confirmed, ...mine], (e) => e.id.startsWith('b'))
    expect(pre.rekeys).toHaveLength(50)
    expect(new Set(pre.elements.map((e) => e.index)).size).toBe(101)
    // my 50 keep their relative order
    const mineOut = pre.elements.filter((e) => e.id.startsWith('b')).map((e) => e.id)
    expect(mineOut).toEqual(mine.map((e) => e.id))
  })

  it('does nothing when nothing collides', () => {
    const pre = run([rect('c1', 'a0'), rect('X0', 'a0V'), rect('c2', 'a1')], (e) => e.id === 'X0')
    expect(pre.rekeys).toEqual([])
  })

  it('flags confirmed elements that collide with each other (server invariant broken) without touching them', () => {
    const pre = indexPrePass([rect('c1', 'a1'), rect('c2', 'a1')], { isOwnUnacked: () => false })
    expect(pre.confirmedConflicts).toEqual(['c2'])
    expect(pre.rekeys).toEqual([])
  })

  it('property: 600 random scenes, the assertion never fires and every key is valid and unique', () => {
    let seed = 7
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (let round = 0; round < 600; round++) {
      const n = 1 + Math.floor(rnd() * 25)
      const keys = generateNKeysBetween(null, null, n)
      const confirmed = keys.map((k, i) => rect(`c${round}_${i}`, k, { isDeleted: rnd() < 0.15 }))
      const m = 1 + Math.floor(rnd() * 8)
      const mine: El[] = []
      for (let j = 0; j < m; j++) {
        const pick = rnd()
        const k =
          pick < 0.5
            ? (keys[Math.floor(rnd() * keys.length)] ?? null) // collide
            : pick < 0.7
              ? null
              : pick < 0.8
                ? '!bad'
                : `${keys[keys.length - 1]}V` // above the top
        mine.push(rect(`${rnd() < 0.5 ? 'M' : 'm'}${round}_${j}`, k, { version: 1 }))
      }
      // sometimes one of mine is a label of a confirmed container, keyed below it
      if (rnd() < 0.3 && confirmed.length > 1) {
        const ci = 1 + Math.floor(rnd() * (confirmed.length - 1))
        const c = confirmed[ci] as El
        if (!c.isDeleted) {
          confirmed[ci] = { ...c, boundElements: [{ id: `L${round}`, type: 'text' }] }
          mine.push(label(`L${round}`, c.id, keys[ci - 1] ?? null))
        }
      }
      const input = [...confirmed, ...mine].sort(() => rnd() - 0.5)
      const own = new Set(mine.map((e) => e.id))
      const pre = run(input, (e) => own.has(e.id))
      expect(pre.elements.every((e) => isValidKey(e.index))).toBe(true)
      expect(new Set(pre.elements.map((e) => e.index)).size).toBe(pre.elements.length)
      for (const c of confirmed) expect(pre.elements.find((e) => e.id === c.id)?.index).toBe(c.index)
    }
  })

  it('cost at 20,000 confirmed elements and 20 of mine', () => {
    const keys = generateNKeysBetween(null, null, 20_000)
    const confirmed = keys.map((k, i) => ({
      id: `c${i}`,
      type: 'rectangle',
      index: k,
      version: 3,
      versionNonce: 1,
      isDeleted: false,
    }))
    const mine = Array.from({ length: 20 }, (_, i) => ({
      id: `X${i}`,
      type: 'rectangle',
      index: keys[keys.length - 1 - i] ?? null,
      version: 1,
      versionNonce: 1,
      isDeleted: false,
    }))
    const input = [...confirmed, ...mine]
    const t0 = performance.now()
    const pre = indexPrePass(input, { isOwnUnacked: (e) => e.id.startsWith('X') })
    const ms = performance.now() - t0
    expect(pre.rekeys).toHaveLength(20)
    console.info(`A8 pre-pass at 20,020 elements: ${ms.toFixed(1)} ms`)
    expect(ms).toBeLessThan(500)
  })
})
