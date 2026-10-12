// N1-4 (wave N, PERF-3c): a cold open's large snapshot is installed in chunks, one per frame. Each chunk hands the
// adapter the cumulative array in index order (NEVER); the first holds every frame and the elements in view; a
// container and its labels are never split. Until the last chunk scene changes are not scanned, nothing is pushed,
// the save state is not connected, and every server frame waits behind the apply in arrival order. A socket that
// goes mid-apply leaves no partial baseline: the next hello asks for everything again.
import { hashElements } from '@draftroom/canvas-schema/hash'
import { CONTRACTS_REV } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import { type CachedPage, openFromCache } from '../testing/cached.ts'
import { arrow, binding, frame, note, rect, text } from '../testing/elements.ts'
import { stored } from '../testing/fakeRoom.ts'
import { createHarness, type Harness } from '../testing/harness.ts'
import type { ChunkScheduler, SceneElement } from '../types.ts'
import { IDLE_GESTURE } from '../types.ts'
import type { CoreEvent } from './engine.ts'

/** Frames on demand: `step()` runs the next one (the board page's requestAnimationFrame). */
function frames(o: { threshold?: number; size?: number; first?: ChunkScheduler['first'] } = {}) {
  const queue = new Map<number, () => void>()
  let n = 0
  const s: ChunkScheduler & { step(): boolean; run(): number; readonly pending: number } = {
    threshold: o.threshold ?? 20,
    size: o.size ?? 7,
    frame(fn) {
      const id = ++n
      queue.set(id, fn)
      return id
    },
    cancel(h) {
      queue.delete(h as number)
    },
    ...(o.first ? { first: o.first } : {}),
    step() {
      const next = queue.entries().next()
      if (next.done) return false
      queue.delete(next.value[0])
      next.value[1]()
      return true
    },
    run() {
      let k = 0
      while (s.step()) k++
      return k
    },
    get pending() {
      return queue.size
    },
  }
  return s
}

function rng(seed: number): () => number {
  let x = seed >>> 0
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0
    return x / 2 ** 32
  }
}

/** A random board: frames with notes (and their labels) inside, loose shapes, bound arrows, a few tombstones. */
function randomBoard(seed: number): SceneElement[] {
  const r = rng(seed)
  const out: SceneElement[] = []
  let i = 0
  const key = () => `a${(i++).toString(36).padStart(4, '0')}`
  const frames = 1 + Math.floor(r() * 4)
  for (let f = 0; f < frames; f++) {
    out.push(stored(frame(`f${f}`, key(), { x: f * 1000, y: 0, width: 900, height: 900 })))
    const notes = 2 + Math.floor(r() * 8)
    for (let k = 0; k < notes; k++) {
      const id = `f${f}n${k}`
      out.push(
        stored(
          note(id, key(), {
            x: f * 1000 + 20 + k * 30,
            y: 40 + k * 20,
            frameId: `f${f}`,
            boundElements: [{ id: `${id}.t`, type: 'text' }],
          }),
        ),
      )
      out.push(stored(text(`${id}.t`, key(), { containerId: id, text: `n ${k}`, originalText: `n ${k}` })))
    }
  }
  const loose = 5 + Math.floor(r() * 30)
  for (let k = 0; k < loose; k++)
    out.push(
      stored(
        rect(`r${k}`, key(), { x: Math.floor(r() * 5000) - 1000, y: 1000 + k * 50, isDeleted: r() < 0.1 }),
      ),
    )
  const arrows = Math.floor(r() * 6)
  for (let k = 0; k < arrows; k++)
    out.push(
      stored(
        arrow(`ar${k}`, key(), {
          startBinding: binding(`r${k % loose}`, [1, 0.5]),
          endBinding: null,
        }),
      ),
    )
  return out
}

/** A cold open of the room's board on a new page, with or without chunks. */
function coldOpen(h: Harness, chunks?: ChunkScheduler, tab = 'cold'): CachedPage {
  return openFromCache(h, null, { tab, ...(chunks ? { chunks } : {}) })
}

const order = (p: CachedPage) => [...p.scene.map.values()].map((e) => e.id)

describe('N1-4: a cold open of a large board in chunks', () => {
  it('50 random boards: chunked and one-shot applies give the same final scene and hash', async () => {
    for (let seed = 1; seed <= 50; seed++) {
      const h = createHarness({ seed: randomBoard(seed) })
      h.room.contractsRev = CONTRACTS_REV
      const f = frames({ threshold: 10, size: 1 + (seed % 9) })
      const one = coldOpen(h, undefined, 'one')
      const chunked = coldOpen(h, f, 'chunked')
      h.settle()
      f.run()
      h.settle()
      const total = h.room.elements.size
      if (total > 10)
        expect(
          chunked.logs.some((l) => l.event === 'chunked_apply'),
          `seed ${seed}`,
        ).toBe(true)
      expect(order(chunked), `seed ${seed}: the same array`).toEqual(order(one))
      expect([...chunked.scene.map.values()], `seed ${seed}: the same elements`).toEqual([
        ...one.scene.map.values(),
      ])
      const room = await h.roomHash()
      expect(await hashElements(chunked.core.elements().values()), `seed ${seed}`).toBe(room)
      expect(await hashElements(one.core.elements().values()), `seed ${seed}`).toBe(room)
      expect(chunked.pushes() + one.pushes(), `seed ${seed}: receive-only`).toBe(0)
      expect(chunked.core.saveStatus.state, `seed ${seed}`).toBe('saved')
    }
  })

  it('every chunk is the cumulative array in index order; the first holds the frames and the elements in view; a label rides with its container', () => {
    const h = createHarness({ seed: randomBoard(7) })
    h.room.contractsRev = CONTRACTS_REV
    const inView = new Set(['r3', 'r4', 'f0n1'])
    const f = frames({ threshold: 10, size: 5, first: () => inView })
    const p = coldOpen(h, f)
    const arrays: string[][] = []
    const apply = p.scene.apply.bind(p.scene)
    ;(p.scene as { apply: typeof apply }).apply = (els) => {
      arrays.push(els.map((e) => e.id))
      apply(els)
    }
    h.settle()
    f.run()
    h.settle()
    expect(arrays.length).toBeGreaterThan(2)
    const finalOrder = arrays.at(-1) as string[]
    const pos = new Map(finalOrder.map((id, k) => [id, k]))
    for (const [k, a] of arrays.entries()) {
      // index order (a subsequence of the final array) and cumulative
      const ps = a.map((id) => pos.get(id) as number)
      expect(ps, `chunk ${k} in index order`).toEqual([...ps].sort((x, y) => x - y))
      if (k > 0) for (const id of arrays[k - 1] as string[]) expect(a).toContain(id)
      // a label is never without its container
      for (const id of a) if (id.endsWith('.t')) expect(a).toContain(id.slice(0, -2))
    }
    const first = arrays[0] as string[]
    for (const id of finalOrder) if (id.startsWith('f') && !id.includes('n')) expect(first).toContain(id)
    for (const id of inView) expect(first).toContain(id)
    expect(first).toContain('f0n1.t')
  })

  it('a pointer gesture during the chunks starts nothing and pushes nothing; the save state is not Saved until the last chunk', async () => {
    const h = createHarness({ seed: randomBoard(3) })
    h.room.contractsRev = CONTRACTS_REV
    const bob = h.client('bob', { tab: 'tb' })
    h.settle()
    const f = frames({ threshold: 10, size: 4 })
    const p = coldOpen(h, f)
    h.settle()
    expect(f.pending).toBe(1)
    // wave N.1: the first chunk too goes in at the next frame, not in the task that read the snapshot
    expect(p.scene.map.size).toBe(0)
    f.step()
    expect(f.pending).toBe(1)
    expect(p.core.saveStatus.state).not.toBe('saved')
    expect(p.core.cacheContent()).toBeNull()
    // a drag on an element of the first chunk (a frame) while the rest arrives: the canvas is read-only meanwhile
    // (the board page's interaction), so the pointer moves nothing; the core never takes the gesture up
    const id = [...p.scene.map.keys()][0] as string
    expect(id).toBeDefined()
    p.scene.gesture = { ...IDLE_GESTURE, dragging: true, selectedElementIds: [id] }
    p.core.onSceneChange(p.scene.read())
    f.step()
    p.core.onSceneChange(p.scene.read())
    // another user moves that element meanwhile: no gesture holds it back once the chunks are in
    bob.change(id, { x: 333 })
    h.settle()
    p.core.flush()
    expect(p.pushes()).toBe(0)
    f.run()
    expect(p.scene.map.get(id)?.x).toBe(333)
    // (a scene write made during the chunks is the core's to replace: the last chunk installs the whole array)
    p.scene.gesture = IDLE_GESTURE
    p.core.onSceneChange(p.scene.read())
    h.settle()
    expect(p.pushes()).toBe(0)
    expect(await hashElements(p.core.elements().values())).toBe(await h.roomHash())
    expect(p.core.saveStatus.state).toBe('saved')
  })

  it('a changes frame arriving mid-apply lands after the last chunk, in order; the welcome is reported after the last chunk', async () => {
    const h = createHarness({ seed: randomBoard(11) })
    h.room.contractsRev = CONTRACTS_REV
    const bob = h.client('bob', { tab: 'tb' })
    h.settle()
    const f = frames({ threshold: 10, size: 4 })
    const p = coldOpen(h, f)
    h.settle()
    expect(f.pending).toBe(1)
    bob.change('r1', { x: 777 })
    h.settle()
    bob.change('r2', { x: 778 })
    h.settle()
    // still waiting: the frames are queued behind the apply
    expect(p.core.confirmed('r1')?.x).not.toBe(777)
    expect(p.events.filter((e) => e.kind === 'welcome')).toHaveLength(0)
    f.run()
    expect(p.core.confirmed('r1')?.x).toBe(777)
    expect(p.scene.map.get('r1')?.x).toBe(777)
    expect(p.scene.map.get('r2')?.x).toBe(778)
    const kinds = p.events
      .filter((e) => e.kind === 'applying' || e.kind === 'welcome' || e.kind === 'message')
      .map((e: CoreEvent) =>
        e.kind === 'message'
          ? `message:${e.message.type}`
          : e.kind === 'applying'
            ? `applying:${e.on}`
            : e.kind,
      )
    const off = kinds.indexOf('applying:false')
    expect(off).toBeGreaterThan(0)
    expect(kinds[off + 1]).toBe('welcome')
    // the frames that waited, in the order they came: the room's contracts frame, then bob's two changes
    expect(kinds.slice(off + 2)).toEqual(['message:contracts', 'message:changes', 'message:changes'])
    expect(await hashElements(p.core.elements().values())).toBe(await h.roomHash())
    expect(p.pushes()).toBe(0)
  })

  it('a disconnect mid-apply leaves no partial baseline: the next hello says since 0 and the welcome resets', async () => {
    const h = createHarness({ seed: randomBoard(5) })
    h.room.contractsRev = CONTRACTS_REV
    const f = frames({ threshold: 10, size: 3 })
    const p = coldOpen(h, f)
    h.settle()
    f.step()
    expect(f.pending).toBe(1)
    h.room.cut(p.transport)
    h.settle()
    expect(f.pending, 'the chunks stop with the socket').toBe(0)
    expect(p.events.some((e) => e.kind === 'applying' && !e.on && e.aborted)).toBe(true)
    expect(p.events.filter((e) => e.kind === 'welcome')).toHaveLength(0)
    expect(p.core.epoch).toBeNull()
    ;(p.transport as unknown as { reopen(): void }).reopen()
    h.settle()
    f.run()
    h.settle()
    const hellos = p.sent().filter((m) => m.type === 'hello')
    expect(hellos).toHaveLength(2)
    expect(hellos[1]).toMatchObject({ since: 0, epoch: null })
    expect(p.core.welcome?.reset).toBe(true)
    expect(await hashElements(p.core.elements().values())).toBe(await h.roomHash())
    expect([...p.scene.map.keys()].sort()).toEqual([...h.room.elements.keys()].sort())
    expect(p.pushes()).toBe(0)
  })

  it('wave N.1: the snapshot task installs nothing; the welcome comes at the frame after the last chunk, which holds the whole board', () => {
    const h = createHarness({ seed: randomBoard(13) })
    h.room.contractsRev = CONTRACTS_REV
    const f = frames({ threshold: 10, size: 6 })
    const p = coldOpen(h, f)
    const applies: number[] = []
    const apply = p.scene.apply.bind(p.scene)
    ;(p.scene as { apply: typeof apply }).apply = (els) => {
      applies.push(els.length)
      apply(els)
    }
    h.settle()
    expect(applies).toEqual([])
    const welcomes = () => p.events.filter((e) => e.kind === 'welcome').length
    // the chunks, one per frame, until one installs the whole board
    while (applies.at(-1) !== h.room.elements.size) {
      expect(f.step()).toBe(true)
      expect(welcomes()).toBe(0)
    }
    expect(f.pending).toBe(1)
    expect(p.core.saveStatus.state).not.toBe('saved')
    f.step()
    expect(welcomes()).toBe(1)
    expect(p.core.saveStatus.state).toBe('saved')
    expect(f.pending).toBe(0)
  })

  it('at or under the threshold (or with no scheduler) the snapshot goes in one apply, as before', () => {
    const h = createHarness({ seed: randomBoard(2) })
    h.room.contractsRev = CONTRACTS_REV
    const f = frames({ threshold: 1_000, size: 4 })
    const p = coldOpen(h, f)
    h.settle()
    expect(f.pending).toBe(0)
    expect(p.logs.some((l) => l.event === 'chunked_apply')).toBe(false)
    expect(p.scene.map.size).toBe(h.room.elements.size)
  })
})

// Wave N.1: undo during a chunked install: no step while the core installs (the boundary skips its pass), every chunk
// taken in, and after the welcome nothing is undoable; a change made then is one step.
describe('N1-4, wave N.1: undo on a chunked cold open', () => {
  it('records nothing during the chunks and nothing at the welcome; the first change after it is one step', async () => {
    const { UndoController } = await import('../../history/controller.ts')
    const { bump } = await import('../headless/scene.ts')
    const h = createHarness({ seed: randomBoard(17) })
    h.room.contractsRev = CONTRACTS_REV
    const f = frames({ threshold: 10, size: 5 })
    const p = coldOpen(h, f)
    const undo = new UndoController({ core: p.core, scene: p.scene, bump })
    h.settle()
    while (f.pending) {
      expect(p.core.installing).toBe(true)
      expect(undo.boundary()).toBeNull()
      f.step()
    }
    h.settle()
    expect(p.core.installing).toBe(false)
    expect(undo.boundary()).toBeNull()
    expect(undo.history.undoSize).toBe(0)
    const id = [...p.scene.map.values()].find((e) => e.type === 'rectangle' && !e.isDeleted)?.id as string
    const x = p.scene.map.get(id)?.x
    p.scene.apply([...p.scene.map.values()].map((e) => (e.id === id ? bump(e, { x: 4242 }) : e)))
    p.core.onSceneChange(p.scene.read())
    expect(undo.boundary()).not.toBeNull()
    expect(undo.history.undoSize).toBe(1)
    expect(undo.undo()).not.toBeNull()
    expect(p.scene.map.get(id)?.x).toBe(x)
  })
})
