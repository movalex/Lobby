import { describe, expect, it } from 'vitest'
import type { HistEl, Scene } from './diff.ts'
import { LobbyHistory, rekeysKeepingPaintOrder } from './stack.ts'

// Wave B follow-up: `keepsPaintOrder` scanned every live element for every index-only change, so a mass
// re-key that kept the paint order (a paste, an engine re-key of a big board) was quadratic: 5,000 elements
// 686 ms, 20,000 elements 15.5 s on the main thread, a frozen tab. All of them are judged in one sorted pass.

const el = (id: string, o: Record<string, unknown> = {}, version = 1): HistEl =>
  ({ id, type: 'rectangle', isDeleted: false, x: 0, y: 0, version, versionNonce: version, ...o }) as HistEl

/** The engine's `compareIndexThenId`, with a key that is not a string sorting first. */
const paintCmp = (ia: unknown, a: string, ib: unknown, b: string): number => {
  const x = typeof ia === 'string' ? ia : ''
  const y = typeof ib === 'string' ? ib : ''
  if (x !== y) return x < y ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * The pairwise check this replaced, as the oracle: whether `id`'s new `index` leaves it where it was among
 * the live elements (every other live element on the same side of it with the previous keys as with the
 * keys now). O(n) per element.
 */
function pairwiseKeeps(
  id: string,
  before: unknown,
  scene: Scene,
  prevIndex: ReadonlyMap<string, unknown>,
): boolean {
  const e = scene.get(id)
  if (!e) return false
  if (e.isDeleted) return true
  for (const [other, o] of scene) {
    if (other === id || o.isDeleted) continue
    const was = prevIndex.has(other) ? prevIndex.get(other) : o.index
    if (Math.sign(paintCmp(was, other, before, id)) !== Math.sign(paintCmp(o.index, other, e.index, id)))
      return false
  }
  return true
}

/** a small deterministic generator (mulberry32) */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pad = (i: number, w = 6) => String(i).padStart(w, '0')

describe('rekeysKeepingPaintOrder: the sorted pass judges every candidate as the pairwise check did', () => {
  it('random scenes: re-keys, reorders, ties, deleted and new elements, other changes', () => {
    const rand = rng(20261003)
    let kept = 0
    let rejected = 0
    for (let round = 0; round < 600; round++) {
      const n = 1 + Math.floor(rand() * 14)
      // previous boundary: keys from a small alphabet, so ties (broken by id) are common
      const keys = ['a0', 'a1', 'a2', 'a3', 'a4', 'a5']
      const prev = new Map<string, HistEl>()
      for (let i = 0; i < n; i++) {
        const id = `e${pad(i, 2)}`
        const index = rand() < 0.1 ? undefined : (keys[Math.floor(rand() * keys.length)] as string)
        prev.set(id, el(id, { index, isDeleted: rand() < 0.15 }))
      }
      // now: each element is untouched, re-keyed (to any key), deleted or brought back; some are new
      const scene = new Map<string, HistEl>()
      const prevIndex = new Map<string, unknown>()
      const candidates = new Map<string, unknown>()
      for (const [id, p] of prev) {
        const roll = rand()
        if (roll < 0.35) {
          scene.set(id, p)
          continue
        }
        prevIndex.set(id, p.index)
        if (roll < 0.8) {
          // an index-only change: a key kept in order (nudged) or any other key
          const nudged = typeof p.index === 'string' && rand() < 0.5 ? `${p.index}V` : undefined
          const index = nudged ?? (keys[Math.floor(rand() * keys.length)] as string)
          scene.set(id, el(id, { ...p, index, version: 2, versionNonce: 2 }))
          candidates.set(id, p.index)
        } else {
          // another change of the element (not a candidate): it still sits in `prevIndex`
          scene.set(id, el(id, { ...p, x: 9, isDeleted: rand() < 0.3, version: 2, versionNonce: 2 }))
        }
      }
      for (let i = 0; i < Math.floor(rand() * 3); i++) {
        const id = `n${i}`
        scene.set(id, el(id, { index: keys[Math.floor(rand() * keys.length)] as string }))
      }
      const got = rekeysKeepingPaintOrder(candidates, scene, prevIndex)
      for (const [id, before] of candidates) {
        const want = pairwiseKeeps(id, before, scene, prevIndex)
        expect(got.has(id), `round ${round}, ${id}`).toBe(want)
        if (want) kept++
        else rejected++
      }
      // only candidates are ever returned
      for (const id of got) expect(candidates.has(id)).toBe(true)
    }
    // the generator reaches both outcomes
    expect(kept).toBeGreaterThan(100)
    expect(rejected).toBeGreaterThan(100)
  })

  it('a candidate the scene lacks is not kept; a deleted one always is', () => {
    const scene: Scene = new Map([
      ['A', el('A', { index: 'a0' })],
      ['D', el('D', { index: 'a9', isDeleted: true })],
    ])
    const got = rekeysKeepingPaintOrder(
      new Map<string, unknown>([
        ['D', 'a1'],
        ['gone', 'a2'],
      ]),
      scene,
      new Map([['D', 'a1']]),
    )
    expect([...got]).toEqual(['D'])
  })
})

describe('a mass re-key that keeps the paint order (CR-3D-4) is linear', () => {
  /** n elements at keys a000000..; the scene after the engine re-keyed every one of them where it was */
  function bigScene(n: number) {
    const before = new Map<string, HistEl>()
    const after = new Map<string, HistEl>()
    for (let i = 0; i < n; i++) {
      const id = `e${pad(i)}`
      before.set(id, el(id, { index: `a${pad(i)}` }))
      after.set(id, el(id, { index: `a${pad(i)}V` }, 2))
    }
    return { before, after }
  }

  it('5,000 elements: no step, every key folded into lastLocal', () => {
    const { before, after } = bigScene(5000)
    const h = new LobbyHistory()
    h.reset(before)
    const t0 = performance.now()
    expect(h.record(after)).toBeNull()
    const ms = performance.now() - t0
    expect(h.undoSize).toBe(0)
    expect(h.lastLocalOf('e004999')?.index).toBe('a004999V')
    // 686 ms before, about 35 ms now on this machine (a bound is on the 20,000 case, where a quadratic scan shows)
    expect(ms).toBeLessThan(1500)
  })

  it('20,000 elements: no step, and nowhere near the 15 s of the pairwise scan', () => {
    const { before, after } = bigScene(20_000)
    const h = new LobbyHistory()
    h.reset(before)
    const t0 = performance.now()
    expect(h.record(after)).toBeNull()
    const ms = performance.now() - t0
    expect(h.undoSize).toBe(0)
    expect(h.lastLocalOf('e019999')?.index).toBe('a019999V')
    // 15.5 s before; now a clone per element and the judge (about 110 ms here in all): a generous bound
    expect(ms).toBeLessThan(1500)
  })

  it('the judge alone: 20,000 candidates in scene order and shuffled, a few ms to tens of ms', () => {
    const { before, after } = bigScene(20_000)
    const prevIndex = new Map([...before].map(([id, e]) => [id, e.index]))
    const candidates = new Map(prevIndex)
    const rand = rng(7)
    const shuffled = [...after]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      const t = shuffled[i] as [string, HistEl]
      shuffled[i] = shuffled[j] as [string, HistEl]
      shuffled[j] = t
    }
    for (const scene of [after, new Map(shuffled)]) {
      const t0 = performance.now()
      expect(rekeysKeepingPaintOrder(candidates, scene, prevIndex).size).toBe(20_000)
      expect(performance.now() - t0).toBeLessThan(750)
    }
    // one moved to the top among them: it and everything it passed are reorders, the rest is as before
    const moved = new Map(after)
    moved.set('e000000', el('e000000', { index: 'b' }, 3))
    const kept = rekeysKeepingPaintOrder(candidates, moved, prevIndex)
    expect(kept.has('e000000')).toBe(false)
    expect(kept.size).toBe(0)
  })

  it('20,000 elements re-keyed with 200 steps on the stack: the steps take the new keys in one walk', () => {
    const { before } = bigScene(20_000)
    const h = new LobbyHistory()
    h.reset(before)
    // 200 earlier steps: the first five bring an element to the top (they hold an `index` the re-key must
    // fold into), the rest move one element each
    let version = 1
    const live = new Map(before)
    for (let s = 0; s < 200; s++) {
      const id = `e${pad(s * 7)}`
      const cur = live.get(id) as HistEl
      version++
      live.set(
        id,
        el(id, {
          ...cur,
          ...(s < 5 ? { index: `b${pad(s)}` } : { x: s + 1 }),
          version,
          versionNonce: version,
        }),
      )
      expect(h.record(live)).not.toBeNull()
    }
    expect(h.undoSize).toBe(200)
    // the engine re-keys every element where it is (a new version each)
    const rekeyed = new Map<string, HistEl>()
    for (const [id, e] of live) {
      const v = (e.version ?? 1) + 1
      rekeyed.set(id, el(id, { ...e, index: `${e.index as string}V`, version: v, versionNonce: v }))
    }
    const t0 = performance.now()
    expect(h.record(rekeyed)).toBeNull()
    const ms = performance.now() - t0
    expect(h.undoSize).toBe(200)
    expect(ms).toBeLessThan(1500)
    // the entries that held an `index` hold the new key on the side the scene is on
    for (let s = 0; s < 5; s++)
      expect(h.undoEntries[s]?.changes.get(`e${pad(s * 7)}`)?.fields.index?.after).toBe(`b${pad(s)}V`)
    // every undo applies against the re-keyed scene (none is skipped as changed since)
    for (let s = 199; s >= 0; s--) {
      const u = h.undo(rekeyed)
      expect(u?.kept, `step ${s}`).toBe(0)
      expect(u?.patches.size).toBe(1)
      for (const [id, patch] of u?.patches ?? []) {
        const cur = rekeyed.get(id) as HistEl
        const v = (cur.version ?? 1) + 1
        rekeyed.set(id, el(id, { ...cur, ...patch, version: v, versionNonce: v }))
      }
    }
    expect(rekeyed.get('e000000')?.index).toBe('a000000')
    expect(rekeyed.get(`e${pad(7 * 150)}`)?.x).toBe(0)
  })

  it('a reorder among the re-keys is still a step, and the others fold', () => {
    // A, L, B: L is brought to the top (passes B) while A is re-keyed where it is
    const before: Scene = new Map([
      ['A', el('A', { index: 'a0' })],
      ['L', el('L', { index: 'a1' })],
      ['B', el('B', { index: 'a2' })],
    ])
    const h = new LobbyHistory()
    h.reset(before)
    const after = new Map<string, HistEl>([
      ['A', el('A', { index: 'a0V' }, 2)],
      ['L', el('L', { index: 'a3' }, 2)],
      ['B', el('B', { index: 'a2' })],
    ])
    const entry = h.record(after)
    expect([...(entry?.changes.keys() ?? [])].sort()).toEqual(['L'])
    expect(entry?.changes.get('L')?.fields.index).toEqual({ before: 'a1', after: 'a3' })
    expect(h.lastLocalOf('A')?.index).toBe('a0V')
  })
})
