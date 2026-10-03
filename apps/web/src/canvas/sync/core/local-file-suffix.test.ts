import { describe, expect, it } from 'vitest'
import { rect } from '../testing/elements.ts'
import { stored } from '../testing/fakeRoom.ts'
import { createHarness, type Harness, type TestClient } from '../testing/harness.ts'
import type { OfflineEntry } from '../types.ts'
import { createMemoryOfflineStore } from './offline-memory.ts'

// CR-W5-3G-3 (W5-13, wave A): the derivative swap's LOCAL fileId (`ver_X@display`, canvas/files/swap.ts)
// against the engine core's rebuilds. Before, every rebuild of a clean image (the swap's own no-op
// version bump, a remote move, an ack, a reconnect) put the scene back on the server's `ver_X`, so a
// zoomed-in image fell back to its 512 px thumb within a frame and the swap stalled. The suffix is local
// only (E9): no push, no offline queue entry and no stored element may ever carry it.

const V = 'ver_0123456789abcdef'
const V2 = 'ver_fedcba9876543210'
const DISPLAY = `${V}@display`

const image = (id: string, index: string, fileId = V) =>
  stored({ ...rect(id, index), type: 'image', fileId, status: 'saved', scale: [1, 1], crop: null })

const reopen = (c: TestClient) => (c.transport as unknown as { reopen(): void }).reopen()
const flushMicro = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

/** Every place a local suffix must never reach: the pushes, the room's stored copies, the queue. */
function expectNoSuffix(h: Harness, c: TestClient, queue?: readonly OfflineEntry[]): void {
  expect(JSON.stringify(c.core.pushLog())).not.toMatch(/@(display|thumb)/)
  expect(JSON.stringify(h.room.snapshot())).not.toMatch(/@(display|thumb)/)
  if (queue) expect(JSON.stringify(queue)).not.toMatch(/@(display|thumb)/)
}

/** The swap's switch, as files.ts applies it: a new element copy (version + 1), no undo step, no push. */
const upgrade = (c: TestClient, id = 'i1') => c.change(id, { fileId: DISPLAY })

describe('the local derivative suffix survives the core (CR-W5-3G-3, E9)', () => {
  it('the swap’s switch sticks: the scene keeps @display at the server’s version; nothing is pushed', async () => {
    const h = createHarness({ seed: [image('i1', 'a0')] })
    const a = h.client('alice')
    h.settle()
    upgrade(a)
    expect(a.get('i1')?.fileId).toBe(DISPLAY)
    h.settle()
    expect(a.get('i1')?.fileId).toBe(DISPLAY)
    // clean: the scene's copy is the server's (version and nonce), with only the local suffix
    expect(a.get('i1')?.version).toBe(h.room.elements.get('i1')?.version)
    expect(a.get('i1')?.versionNonce).toBe(h.room.elements.get('i1')?.versionNonce)
    expect(a.core.pushLog()).toHaveLength(0)
    expect(a.core.saveStatus.state).toBe('saved')
    expect(await a.hash()).toBe(await h.roomHash())
  })

  it('a second tab moves the upgraded image: the move lands, the suffix stays', async () => {
    const h = createHarness({ seed: [image('i1', 'a0')] })
    const a = h.client('alice')
    const b = h.client('bob')
    h.settle()
    upgrade(a)
    h.settle()
    b.change('i1', { x: 240, y: 80 })
    h.settle()
    expect(a.get('i1')).toMatchObject({ x: 240, y: 80, fileId: DISPLAY })
    expect(a.core.pushLog()).toHaveLength(0)
    expect(await a.hash()).toBe(await h.roomHash())
    expectNoSuffix(h, a)
  })

  it('its own move while upgraded pushes pos only (the wire file id), and the scene stays on @display', async () => {
    const h = createHarness({ seed: [image('i1', 'a0')] })
    const a = h.client('alice', { latencyMs: 100 })
    const b = h.client('bob')
    h.settle()
    upgrade(a)
    h.settle()
    a.change('i1', { x: 30 })
    expect(a.get('i1')?.fileId).toBe(DISPLAY)
    h.clock.advance(60) // the coalesced push goes out
    expect(a.get('i1')?.fileId).toBe(DISPLAY)
    h.settle() // committed, acked
    const ops = a.core.pushLog().flatMap((p) => [...p.ops])
    expect(ops).toEqual([expect.objectContaining({ k: 'p', id: 'i1', g: { pos: expect.anything() } })])
    expect(a.get('i1')).toMatchObject({ x: 30, fileId: DISPLAY })
    expect(b.get('i1')).toMatchObject({ x: 30, fileId: V })
    expect(a.core.saveStatus.state).toBe('saved')
    expect(await a.hash()).toBe(await h.roomHash())
    expectNoSuffix(h, a)
  })

  it('a replace by someone else (another wire file) takes the server’s file: the suffix goes', () => {
    const h = createHarness({ seed: [image('i1', 'a0')] })
    const a = h.client('alice')
    const b = h.client('bob')
    h.settle()
    upgrade(a)
    h.settle()
    b.change('i1', { fileId: V2 })
    h.settle()
    expect(a.get('i1')?.fileId).toBe(V2)
  })

  it('a remote crop drops it in the same apply: a crop is in the thumb’s pixels (CR-W5-3G-2)', () => {
    const h = createHarness({ seed: [image('i1', 'a0')] })
    const a = h.client('alice')
    const b = h.client('bob')
    h.settle()
    upgrade(a)
    h.settle()
    const crop = { x: 0, y: 0, width: 256, height: 144, naturalWidth: 512, naturalHeight: 288 }
    b.change('i1', { crop })
    h.settle()
    expect(a.get('i1')).toMatchObject({ crop, fileId: V })
  })

  it('a reconnect (welcome and reset snapshot) keeps it', async () => {
    const h = createHarness({ seed: [image('i1', 'a0')] })
    const a = h.client('alice')
    h.settle()
    upgrade(a)
    h.settle()
    h.room.cut(a.transport)
    h.settle()
    reopen(a)
    h.settle()
    expect(a.get('i1')?.fileId).toBe(DISPLAY)
    expect(await a.hash()).toBe(await h.roomHash())
  })

  it('offline: the queue never holds @display (the queued element, its lost pushes); the replay pushes the wire id', async () => {
    const h = createHarness({ seed: [image('i1', 'a0'), image('i2', 'a1')] })
    const store = createMemoryOfflineStore()
    const a = h.client('alice', { latencyMs: 100, offline: store })
    h.settle()
    await flushMicro()
    upgrade(a, 'i1')
    upgrade(a, 'i2')
    h.settle()
    // i2's move is out when the socket goes (a lost push); i1 is moved with no socket (a queued edit)
    a.change('i2', { y: 55 })
    h.clock.advance(60)
    h.room.cut(a.transport)
    h.settle()
    a.change('i1', { x: 70 })
    a.core.persistNow()
    await flushMicro()
    const queue = structuredClone(store.entries()) as OfflineEntry[]
    expect(queue.map((e) => e.element.id).sort()).toEqual(['i1', 'i2'])
    expect(queue.find((e) => e.element.id === 'i2')?.lost?.length).toBeGreaterThan(0)
    expect(a.get('i1')?.fileId).toBe(DISPLAY)
    expect(a.get('i2')?.fileId).toBe(DISPLAY)
    expectNoSuffix(h, a, queue)
    // the reconnect replays: the room gets the move with the wire id; the scene keeps the suffix
    reopen(a)
    h.settle()
    await flushMicro()
    h.settle()
    expect(h.room.elements.get('i1')).toMatchObject({ x: 70, fileId: V })
    expect(a.get('i1')).toMatchObject({ x: 70, fileId: DISPLAY })
    expectNoSuffix(h, a, store.entries())
  })

  it('a reload adopts the queue on the thumb (the wire id), and replays the edit', async () => {
    const h = createHarness({ seed: [image('i1', 'a0')] })
    const store = createMemoryOfflineStore()
    const a = h.client('alice', { offline: store })
    h.settle()
    await flushMicro()
    upgrade(a)
    h.settle()
    h.room.cut(a.transport)
    h.settle()
    a.change('i1', { x: 90 })
    a.core.persistNow()
    await flushMicro()
    const queue = structuredClone(store.entries()) as OfflineEntry[]
    a.core.stop()
    expectNoSuffix(h, a, queue)
    const a2 = h.client('alice', { offline: createMemoryOfflineStore(queue) })
    await flushMicro()
    h.settle()
    await flushMicro()
    h.settle()
    expect(a2.get('i1')).toMatchObject({ x: 90, fileId: V })
    expect(h.room.elements.get('i1')).toMatchObject({ x: 90, fileId: V })
    expectNoSuffix(h, a2)
  })
})
