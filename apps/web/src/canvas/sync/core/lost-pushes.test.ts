import type { Op, PatchOp } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import { rect } from '../testing/elements.ts'
import { stored } from '../testing/fakeRoom.ts'
import { createHarness, type Harness, type TestClient } from '../testing/harness.ts'
import type { OfflineEntry, SceneElement } from '../types.ts'
import { DOC_ENTRY_ID, decideLostElement, type LostPart } from './engine.ts'
import { createMemoryOfflineStore } from './offline-memory.ts'

// Wave 5 (2C): the spike B verifier V1's re-check of beff59d. Pushes and board-document writes whose acks
// were lost, with the socket (a reconnect) or with the page (a reload, a closed tab: the offline queue),
// against the protocol fake on the manual clock. Each case failed on engine/excalidraw f336ae4.

const ops = (c: TestClient): Op[] => c.core.pushLog().flatMap((p) => [...p.ops])
const patchesOf = (c: TestClient, id: string): PatchOp[] =>
  ops(c).filter((o): o is PatchOp => o.k === 'p' && o.id === id)
const reopen = (c: TestClient) => (c.transport as unknown as { reopen(): void }).reopen()
const flushMicro = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

/** A with 100 ms of latency: the push reaches the room 50 ms after it is sent, its ack 50 ms after that. */
function lostAck(h: Harness, a: TestClient, edit: () => void): void {
  edit()
  h.clock.advance(60) // the coalesced push goes out
  h.clock.advance(60) // the room committed it (50 ms), its ack is on the wire
  h.room.cut(a.transport) // the ack is lost with the socket
  h.settle()
}

/** The page closes (pagehide writes the queue) with `edit`'s push committed and its ack still on the wire. */
async function closeBeforeAck(
  h: Harness,
  a: TestClient,
  store: ReturnType<typeof createMemoryOfflineStore>,
  edit: () => void,
): Promise<OfflineEntry[]> {
  edit()
  h.clock.advance(60)
  h.clock.advance(60)
  a.core.persistNow()
  await flushMicro()
  const entries = structuredClone(store.entries()) as OfflineEntry[]
  a.core.stop()
  h.room.cut(a.transport)
  h.settle()
  return entries
}

/** The same tab after a reload (or another tab adopting a closed tab's queue): a fresh core on the queue. */
async function reload(h: Harness, entries: OfflineEntry[], tab = 'tab1'): Promise<TestClient> {
  const a2 = h.client('alice', { offline: createMemoryOfflineStore(entries), tab })
  await flushMicro()
  h.settle()
  await flushMicro()
  h.settle()
  return a2
}

describe('V1 re-check, same page: the lost-ack rule counts writes, not only values', () => {
  it("ABA (R1): A's recolour landed, its ack lost; B sets the colour back: after the reconnect B's write stays", async () => {
    const h = createHarness({ seed: [stored(rect('x', 'a0', { strokeColor: '#1e1e1e' }))] })
    const a = h.client('alice', { latencyMs: 100 })
    const b = h.client('bob')
    h.settle()
    lostAck(h, a, () => a.change('x', { strokeColor: '#e03131' }))
    expect(h.room.elements.get('x')?.strokeColor).toBe('#e03131')
    b.change('x', { strokeColor: '#1e1e1e' })
    h.settle()
    const before = patchesOf(a, 'x').length
    reopen(a)
    h.settle()
    expect(patchesOf(a, 'x').length).toBe(before)
    expect(h.room.elements.get('x')?.strokeColor).toBe('#1e1e1e')
    expect(a.get('x')?.strokeColor).toBe('#1e1e1e')
    expect(a.core.saveStatus.state).toBe('saved')
    expect(await a.hash()).toBe(await h.roomHash())
  })

  it("ABA (R2): A's undelete landed, its ack lost; B deletes it again: after the reconnect it stays deleted", async () => {
    const h = createHarness({ seed: [stored(rect('x', 'a0'))] })
    const a = h.client('alice', { latencyMs: 100 })
    const b = h.client('bob')
    h.settle()
    a.change('x', { isDeleted: true })
    h.settle()
    lostAck(h, a, () => a.change('x', { isDeleted: false }))
    expect(h.room.elements.get('x')?.isDeleted).toBe(false)
    b.change('x', { isDeleted: true })
    h.settle()
    reopen(a)
    h.settle()
    expect(h.room.elements.get('x')?.isDeleted).toBe(true)
    expect(a.core.saveStatus.state).toBe('saved')
  })

  it("never landed (R8): A's move never reached the room; B moves it once meanwhile: A's move is replayed (the later arrival wins, as offline)", async () => {
    const h = createHarness({
      seed: [stored(rect('x', 'a0', { x: 0 })), stored(rect('y', 'a1', { x: 300 }))],
    })
    const a = h.client('alice', { latencyMs: 100 })
    const b = h.client('bob')
    h.settle()
    a.change('x', { x: 111 })
    a.change('y', { strokeColor: '#e03131' })
    h.clock.advance(60) // out; the room would read it at +50 ms
    h.room.cut(a.transport) // it never arrives
    h.settle()
    b.change('x', { x: 222 })
    h.settle()
    expect(h.room.elements.get('x')?.x).toBe(222)
    reopen(a)
    h.settle()
    expect(h.room.elements.get('x')?.x).toBe(111)
    expect(h.room.elements.get('y')?.strokeColor).toBe('#e03131')
    expect(a.core.saveStatus.state).toBe('saved')
    expect(await a.hash()).toBe(await h.roomHash())
  })

  it("a lost doc write that landed (R3): B writes the key after it; the reconnect keeps B's value", () => {
    const h = createHarness()
    const a = h.client('alice', { latencyMs: 100 })
    const b = h.client('bob')
    h.settle()
    // a doc write goes out at once: committed at +50 ms, its ack lost with the socket at +60
    a.core.setDoc({ 'tagDef:topic': { name: 'topic', color: 'red' } })
    h.clock.advance(60)
    h.room.cut(a.transport)
    h.settle()
    expect(h.room.doc['tagDef:topic']).toEqual({ name: 'topic', color: 'red' })
    b.core.setDoc({ 'tagDef:topic': { name: 'topic', color: 'green' } })
    h.settle()
    reopen(a)
    h.settle()
    expect(h.room.doc['tagDef:topic']).toEqual({ name: 'topic', color: 'green' })
    expect(a.core.doc().get('tagDef:topic')).toEqual({ name: 'topic', color: 'green' })
    expect(a.core.pushLog().filter((p) => p.doc).length).toBe(1)
    expect(a.core.saveStatus.state).toBe('saved')
  })

  it('a lost doc write that never arrived goes again', () => {
    const h = createHarness()
    const a = h.client('alice', { latencyMs: 100 })
    h.settle()
    a.core.setDoc({ 'tagDef:topic': { name: 'topic', color: 'red' } }) // out at once
    h.clock.advance(20) // the room would read it at +50 ms
    h.room.cut(a.transport)
    h.settle()
    expect(h.room.doc['tagDef:topic']).toBeUndefined()
    reopen(a)
    h.settle()
    expect(h.room.doc['tagDef:topic']).toEqual({ name: 'topic', color: 'red' })
    expect(a.core.saveStatus.state).toBe('saved')
  })
})

describe('V1 re-check, a reload or a closed tab with pushes out: the queue keeps them as lost pushes', () => {
  it("R4: A's move landed, the page closed before its ack; B moves it after; the reloaded page keeps B's move", async () => {
    const h = createHarness({ seed: [stored(rect('x', 'a0', { x: 0 }))] })
    const store = createMemoryOfflineStore()
    const a = h.client('alice', { latencyMs: 100, offline: store })
    const b = h.client('bob')
    h.settle()
    await flushMicro()
    const entries = await closeBeforeAck(h, a, store, () => a.change('x', { x: 111 }))
    expect(h.room.elements.get('x')?.x).toBe(111)
    expect(entries.find((e) => e.element.id === 'x')?.lost?.length).toBe(1)
    b.change('x', { x: 222 })
    h.settle()
    const a2 = await reload(h, entries)
    expect(patchesOf(a2, 'x')).toEqual([])
    expect(h.room.elements.get('x')?.x).toBe(222)
    expect(a2.get('x')?.x).toBe(222)
    expect(a2.core.saveStatus.state).toBe('saved')
    expect(await a2.hash()).toBe(await h.roomHash())
  })

  it('R4 in a new tab: a closed tab’s queue adopted by another tab decides the same way', async () => {
    const h = createHarness({ seed: [stored(rect('x', 'a0', { x: 0 }))] })
    const store = createMemoryOfflineStore()
    const a = h.client('alice', { latencyMs: 100, offline: store })
    const b = h.client('bob')
    h.settle()
    await flushMicro()
    const entries = await closeBeforeAck(h, a, store, () => a.change('x', { x: 111 }))
    b.change('x', { x: 222 })
    h.settle()
    const a2 = await reload(h, entries, 'tab2')
    expect(patchesOf(a2, 'x')).toEqual([])
    expect(h.room.elements.get('x')?.x).toBe(222)
    expect(a2.core.saveStatus.state).toBe('saved')
  })

  it('R5: A’s create landed, the page closed before its ack; B deletes it; the reloaded page does not revive it', async () => {
    const h = createHarness({ seed: [stored(rect('r1', 'a0'))] })
    const store = createMemoryOfflineStore()
    const a = h.client('alice', { latencyMs: 100, offline: store })
    const b = h.client('bob')
    h.settle()
    await flushMicro()
    const entries = await closeBeforeAck(h, a, store, () =>
      a.edit((m) => m.set('m', rect('m', 'a5', { x: 5 }))),
    )
    expect(h.room.elements.get('m')?.isDeleted).toBe(false)
    b.change('m', { isDeleted: true })
    h.settle()
    const a2 = await reload(h, entries)
    expect(ops(a2).filter((o) => (o.k === 'c' ? o.el.id : o.id) === 'm')).toEqual([])
    expect(h.room.elements.get('m')?.isDeleted).toBe(true)
    expect(a2.core.saveStatus.state).toBe('saved')
  })

  it('a push that never reached the room before the page closed is replayed by the reloaded page', async () => {
    const h = createHarness({ seed: [stored(rect('x', 'a0', { x: 0 }))] })
    const store = createMemoryOfflineStore()
    const a = h.client('alice', { latencyMs: 100, offline: store })
    h.settle()
    await flushMicro()
    a.change('x', { x: 111 })
    h.clock.advance(60) // out, not arrived
    a.core.persistNow()
    await flushMicro()
    const entries = structuredClone(store.entries()) as OfflineEntry[]
    a.core.stop()
    h.room.cut(a.transport)
    h.settle()
    expect(h.room.elements.get('x')?.x).toBe(0)
    const a2 = await reload(h, entries)
    expect(h.room.elements.get('x')?.x).toBe(111)
    expect(a2.core.saveStatus.state).toBe('saved')
  })

  it('a new create that never reached the room is created by the reloaded page', async () => {
    const h = createHarness()
    const store = createMemoryOfflineStore()
    const a = h.client('alice', { latencyMs: 100, offline: store })
    h.settle()
    await flushMicro()
    a.edit((m) => m.set('m', rect('m', 'a5', { x: 5 })))
    h.clock.advance(60)
    a.core.persistNow()
    await flushMicro()
    const entries = structuredClone(store.entries()) as OfflineEntry[]
    a.core.stop()
    h.room.cut(a.transport)
    h.settle()
    expect(h.room.elements.has('m')).toBe(false)
    const a2 = await reload(h, entries)
    expect(h.room.elements.get('m')?.x).toBe(5)
    expect(a2.core.saveStatus.state).toBe('saved')
  })

  it("R7: A's tagDef landed, the page closed before its ack; B writes the key; the reloaded page keeps B's value", async () => {
    const h = createHarness()
    const store = createMemoryOfflineStore()
    const a = h.client('alice', { latencyMs: 100, offline: store })
    const b = h.client('bob')
    h.settle()
    await flushMicro()
    // a doc write goes out at once: committed at +50 ms, its ack still on the wire at +60
    a.core.setDoc({ 'tagDef:topic': { name: 'topic', color: 'red' } })
    h.clock.advance(60)
    expect(h.room.doc['tagDef:topic']).toEqual({ name: 'topic', color: 'red' })
    a.core.persistNow()
    await flushMicro()
    const entries = structuredClone(store.entries()) as OfflineEntry[]
    a.core.stop()
    h.room.cut(a.transport)
    h.settle()
    const docEntry = entries.find((e) => e.element.id === DOC_ENTRY_ID)
    expect(docEntry?.lostDoc?.length).toBe(1)
    b.core.setDoc({ 'tagDef:topic': { name: 'topic', color: 'green' } })
    h.settle()
    const a2 = await reload(h, entries)
    expect(h.room.doc['tagDef:topic']).toEqual({ name: 'topic', color: 'green' })
    expect(a2.core.pushLog().filter((p) => p.doc)).toEqual([])
    expect(a2.core.saveStatus.state).toBe('saved')
  })

  it('an unsent doc write in the queue still goes (only the ones that were out are decided)', async () => {
    const h = createHarness()
    const store = createMemoryOfflineStore()
    const a = h.client('alice', { offline: store })
    h.settle()
    await flushMicro()
    h.room.cut(a.transport)
    h.settle()
    a.core.setDoc({ 'tagDef:later': { name: 'later', color: 'blue' } })
    a.core.persistNow()
    await flushMicro()
    const entries = structuredClone(store.entries()) as OfflineEntry[]
    a.core.stop()
    await reload(h, entries)
    expect(h.room.doc['tagDef:later']).toEqual({ name: 'later', color: 'blue' })
  })
})

describe('decideLostElement (pure)', () => {
  const el = (o: Record<string, unknown>) => ({ ...rect('x', 'a0'), ...o }) as SceneElement
  const part = (o: Partial<LostPart['s']> & { el: SceneElement }, src = 's1'): LostPart => ({
    p: { src },
    s: { groups: new Set(['pos']), create: false, ...o },
  })
  const base = el({ x: 0, version: 5 })
  it('no write since the base: nothing landed, it goes again', () => {
    const d = decideLostElement([part({ el: el({ x: 1 }), ref: base, pv: 5 })], base, new Set())
    expect([...d.again]).toEqual(['pos'])
  })
  it('one write since that is not ours: ours never landed, it goes again', () => {
    const d = decideLostElement(
      [part({ el: el({ x: 1 }), ref: base, pv: 5 })],
      el({ x: 2, version: 6 }),
      new Set(),
    )
    expect([...d.again]).toEqual(['pos'])
  })
  it('two writes since, the server not at our value: the server copy stands', () => {
    const d = decideLostElement(
      [part({ el: el({ x: 1 }), ref: base, pv: 5 })],
      el({ x: 0, version: 7 }),
      new Set(),
    )
    expect([...d.again]).toEqual([])
    expect(d.superseded).toEqual(['pos'])
  })
  it('the server at our value: landed', () => {
    const d = decideLostElement(
      [part({ el: el({ x: 1 }), ref: base, pv: 5 })],
      el({ x: 1, version: 9 }),
      new Set(),
    )
    expect([...d.again]).toEqual([])
    expect(d.superseded).toEqual([])
  })
  it('two lost pushes, one write since at the first value: the second goes again', () => {
    const d = decideLostElement(
      [part({ el: el({ x: 1 }), ref: base, pv: 5 }), part({ el: el({ x: 2 }), ref: el({ x: 1 }), pv: 5 })],
      el({ x: 1, version: 6 }),
      new Set(),
    )
    expect([...d.again]).toEqual(['pos'])
  })
  it('pushes of two sockets: not decidable, the server copy stands', () => {
    const d = decideLostElement(
      [part({ el: el({ x: 1 }), ref: base, pv: 5 }, 'a'), part({ el: el({ x: 2 }), ref: base, pv: 5 }, 'b')],
      el({ x: 3, version: 6 }),
      new Set(),
    )
    expect(d.superseded).toEqual(['pos'])
  })
  it('a group changed again since is a new change, not a lost one', () => {
    const d = decideLostElement([part({ el: el({ x: 1 }), ref: base, pv: 5 })], base, new Set(['pos']))
    expect([...d.again]).toEqual([])
    expect(d.superseded).toEqual([])
  })
  it('a create the server has not: goes again whole; one it has, deleted by someone: stays', () => {
    const c = part({ el: el({ x: 1 }), create: true, groups: new Set(['pos', 'life']) })
    expect(decideLostElement([c], undefined, new Set()).recreate).toBe(true)
    const gone = decideLostElement([c], el({ isDeleted: true, version: 3 }), new Set())
    expect(gone.recreate).toBe(false)
    expect([...gone.again]).toEqual([])
  })
})

describe('DEF-3F-1 (3b F2): a join within 5 s of a board-document write', () => {
  it('gets the document as the welcome has it, not as the cached reset snapshot had it', async () => {
    const h = createHarness()
    h.room.snapshotCacheMs = 5_000
    const c = h.client('carol') // her join caches the reset snapshot (and its document) now
    h.settle()
    const a = h.client('alice')
    h.settle()
    a.core.setDoc({ 'session:hideAuthors': true })
    h.settle()
    expect(h.room.doc['session:hideAuthors']).toBe(true)
    // within the cache's 5 s: bob's reset is served from the cached snapshot
    const b = h.client('bob', { tab: 'tab2' })
    h.settle()
    expect(b.core.doc().get('session:hideAuthors')).toBe(true)
    expect(b.core.docValues()['session:hideAuthors']).toBe(true)
    expect(c.core.doc().get('session:hideAuthors')).toBe(true)
  })
})

describe('W5-02 (CONTRACTS_REV 7): tombstones arrive redacted', () => {
  it("a tab that held the element keeps its content under the server's redacted tombstone, and converges", async () => {
    const h = createHarness({ seed: [stored(rect('x', 'a0', { x: 40, y: 60, strokeColor: '#e03131' }))] })
    h.room.redactTombstones = true
    const a = h.client('alice')
    const b = h.client('bob')
    h.settle()
    // bob is away when alice deletes it: his reconnect's catch-up brings the row, redacted
    h.room.cut(b.transport)
    h.settle()
    a.change('x', { isDeleted: true })
    h.settle()
    reopen(b)
    h.settle()
    const kept = b.core.confirmed('x')
    expect(kept?.isDeleted).toBe(true)
    expect(kept?.x).toBe(40)
    expect(kept?.strokeColor).toBe('#e03131')
    expect(await b.hash()).toBe(await h.roomHash())
    // a fresh page (nothing held) takes the redacted form as it is
    const c = h.client('carol', { tab: 'tab3' })
    h.settle()
    expect(c.core.confirmed('x')?.x).toBe(0)
    expect(await c.hash()).toBe(await h.roomHash())
  })
})

describe('the queue follows a push out (no pagehide: a crash, a killed tab)', () => {
  it('a push sent and committed, the page gone with no pagehide: the queue holds it as lost, B’s later write stays', async () => {
    const h = createHarness({ seed: [stored(rect('x', 'a0', { x: 0 }))] })
    const store = createMemoryOfflineStore()
    const a = h.client('alice', { latencyMs: 100, offline: store })
    const b = h.client('bob')
    h.settle()
    await flushMicro()
    a.change('x', { x: 111 })
    h.clock.advance(60) // out
    h.clock.advance(60) // committed; ack on the wire
    await flushMicro()
    // no persistNow: what the queue holds is what the core wrote on its own
    const entries = structuredClone(store.entries()) as OfflineEntry[]
    expect(entries.find((e) => e.element.id === 'x')?.lost?.length).toBe(1)
    a.core.stop()
    h.room.cut(a.transport)
    h.settle()
    b.change('x', { x: 222 })
    h.settle()
    const a2 = await reload(h, entries)
    expect(patchesOf(a2, 'x')).toEqual([])
    expect(h.room.elements.get('x')?.x).toBe(222)
  })
})

describe("V1 re-check round 3: this tab's own pushes acked before the cut are not other users' writes", () => {
  it('a nudge lost behind two own nudges that landed goes again when nobody else wrote (L0, L1)', () => {
    const h = createHarness({ seed: [stored(rect('x', 'a0', { x: 0 }))] })
    const a = h.client('alice', { latencyMs: 100 })
    h.settle()
    a.change('x', { x: 10 })
    h.clock.advance(60) // p1 out at 60 (the room reads it at 110, its ack arrives at 160)
    a.change('x', { x: 20 })
    a.core.flush() // p2 out at 60 too, behind p1
    h.clock.advance(60)
    a.change('x', { x: 30 })
    a.core.flush() // p3 out at 120: built behind p1 and p2 (pv lags their two bumps), on the wire until 170
    h.clock.advance(45) // 165: both acks arrived, p3 not yet at the room
    expect(h.room.elements.get('x')?.x).toBe(20)
    expect(a.core.saveStatus.state).toBe('saving')
    h.room.cut(a.transport) // p3 is lost with the socket
    h.settle()
    reopen(a)
    h.settle()
    // before: n = 2 writes since pv, k = 1 lost push: "ours landed" was possible, the move was superseded
    expect(a.logs.filter((l) => l.event === 'lost_superseded')).toEqual([])
    expect(h.room.elements.get('x')?.x).toBe(30)
    expect(a.get('x')?.x).toBe(30)
    expect(a.core.saveStatus.state).toBe('saved')
  })

  it('a lost recolour behind an own landed move, with one other write to another group (L3): the recolour goes again', () => {
    const h = createHarness({ seed: [stored(rect('x', 'a0', { x: 0, strokeColor: '#1e1e1e' }))] })
    const a = h.client('alice', { latencyMs: 100 })
    const b = h.client('bob')
    h.settle()
    a.change('x', { x: 10 })
    h.clock.advance(60) // p1 (the move) out at 60
    a.change('x', { strokeColor: '#e03131' })
    a.core.flush() // p2 (a first recolour) out behind p1
    h.clock.advance(60)
    a.change('x', { strokeColor: '#2f9e44' })
    a.core.flush() // p3 (the recolour that matters) out at 120, built behind p1 and p2
    h.clock.advance(45) // 165: p1 and p2 acked, p3 still on the wire
    expect(h.room.elements.get('x')?.strokeColor).toBe('#e03131')
    h.room.cut(a.transport) // p3 never arrives
    h.settle()
    b.change('x', { width: 250 }) // one other write, to another group
    h.settle()
    reopen(a)
    h.settle()
    // before: the two own bumps plus B's made three "other writes"; "ours landed" was possible, the colour
    // was superseded and lost. Now only B's write counts, and it did not touch the colour
    expect(a.logs.filter((l) => l.event === 'lost_superseded')).toEqual([])
    expect(h.room.elements.get('x')?.strokeColor).toBe('#2f9e44')
    expect(h.room.elements.get('x')?.width).toBe(250)
    expect(a.core.saveStatus.state).toBe('saved')
  })

  it('a lost push the server copy cannot decide (two other writes meanwhile) is reported, not dropped silently', () => {
    const h = createHarness({ seed: [stored(rect('x', 'a0', { x: 0 }))] })
    const a = h.client('alice', { latencyMs: 100 })
    const b = h.client('bob')
    h.settle()
    const events: unknown[] = []
    a.core.on((e) => {
      if (e.kind === 'superseded') events.push(e)
    })
    a.change('x', { x: 111 })
    h.clock.advance(60)
    h.room.cut(a.transport) // never arrives
    h.settle()
    b.change('x', { x: 222 })
    h.settle()
    b.change('x', { x: 333 })
    h.settle()
    reopen(a)
    h.settle()
    expect(h.room.elements.get('x')?.x).toBe(333)
    expect(events).toEqual([{ kind: 'superseded', id: 'x', groups: ['pos'] }])
    expect(a.core.saveStatus.state).toBe('saved')
  })
})
