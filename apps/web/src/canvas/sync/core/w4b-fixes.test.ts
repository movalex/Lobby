import { describe, expect, it } from 'vitest'
import { arrow, binding, rect } from '../testing/elements.ts'
import { stored } from '../testing/fakeRoom.ts'
import { createHarness, type Harness, type TestClient } from '../testing/harness.ts'
import type { OfflineEntry } from '../types.ts'
import { type CoreEvent, DOC_ENTRY_ID, decideLostDocKey, docClockOf } from './engine.ts'
import { createMemoryOfflineStore } from './offline-memory.ts'

// Wave 4b (2C): the verifier V1's fourth re-check of the lost-push rule (6f2452a), against the protocol
// fake on the manual clock. Each case failed on engine/excalidraw 747d41d.
//
//  - L7: the server's DERIVED writes (a bound arrow re-snapped when its target moves, room/fit.ts rule 7)
//    bump the arrow's version with no op of this tab's. `Sent.ahead` listed only the pushes carrying the
//    element, so those bumps counted as other users' writes: a recolour of the arrow lost behind two moves
//    of its box read as "superseded", was dropped, and the page told the user someone else had changed it.
//  - R9, the doc-key ABA: a board-document key has no version, so after A's lost-but-landed write B's
//    write of the old value back read as "did not land" and A's reconnect overwrote it. CR-W5-FIX-2: the
//    welcome's per-key clock (`docClocks`, CONTRACTS_REV 9); this is the client half.
//  - W5-02's consumer side for the deleting tab: a redacted tombstone of an element this tab deleted keeps
//    the content this tab holds, so an undo after a reconnect revives it whole.

const reopen = (c: TestClient) => (c.transport as unknown as { reopen(): void }).reopen()
const flushMicro = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}
const supersededEvents = (c: TestClient): CoreEvent[] => {
  const events: CoreEvent[] = []
  c.core.on((e) => {
    if (e.kind === 'superseded') events.push(e)
  })
  return events
}

/** A box with an arrow bound to it; the fake re-snaps the arrow (a derived `path` write) on every move. */
function boundArrowBoard(): Harness {
  const h = createHarness({
    seed: [
      stored(rect('x', 'a0', { x: 0, boundElements: [{ id: 'ar', type: 'arrow' }] })),
      stored(
        arrow('ar', 'a1', { x: 100, y: 50, startBinding: binding('x', [1, 0.5]), strokeColor: '#1e1e1e' }),
      ),
    ],
  })
  h.room.derive.set('x', ['ar'])
  return h
}

describe("V1 re-check round 4 (L7): the server's derived writes are not other users' writes", () => {
  it('a recolour of a bound arrow lost behind two own moves of its box goes again, with no "someone else changed it" notice', () => {
    const h = boundArrowBoard()
    const a = h.client('alice', { latencyMs: 100 })
    h.settle()
    const events = supersededEvents(a)
    a.change('x', { x: 10 })
    h.clock.advance(60) // p1 (a move) out at 60: the room reads it at 110 and re-snaps the arrow (v2)
    a.change('x', { x: 20 })
    a.core.flush() // p2 (a second move) out at 60 too: the arrow's v3
    h.clock.advance(60)
    a.change('ar', { strokeColor: '#e03131' })
    a.core.flush() // p3 (the recolour) out at 120: built on the arrow at v1, behind p1 and p2
    h.clock.advance(45) // 165: both acks (with the arrow's derived rows) arrived, p3 not yet at the room
    expect(h.room.elements.get('ar')?.version).toBe(3)
    expect(h.room.elements.get('ar')?.strokeColor).toBe('#1e1e1e')
    expect(a.core.saveStatus.state).toBe('saving')
    h.room.cut(a.transport) // p3 never arrives
    h.settle()
    reopen(a)
    h.settle()
    // before: n = 2 writes since pv (the two derived bumps), k = 1 lost push: "ours landed, someone wrote
    // after" was possible, the recolour was dropped as superseded and the user told nobody's lie
    expect(events).toEqual([])
    expect(a.logs.filter((l) => l.event === 'lost_superseded')).toEqual([])
    expect(h.room.elements.get('ar')?.strokeColor).toBe('#e03131')
    expect(a.get('ar')?.strokeColor).toBe('#e03131')
    expect(a.core.saveStatus.state).toBe('saved')
  })

  it('the same recolour, landed with its ack lost: kept, no notice, Saved', async () => {
    const h = boundArrowBoard()
    const a = h.client('alice', { latencyMs: 100 })
    h.settle()
    const events = supersededEvents(a)
    a.change('x', { x: 10 })
    h.clock.advance(60)
    a.change('x', { x: 20 })
    a.core.flush()
    h.clock.advance(60)
    a.change('ar', { strokeColor: '#e03131' })
    a.core.flush() // p3 out at 120, at the room at 170, its ack would arrive at 220
    h.clock.advance(60) // 180: p3 committed, its ack on the wire
    expect(h.room.elements.get('ar')?.strokeColor).toBe('#e03131')
    h.room.cut(a.transport)
    h.settle()
    reopen(a)
    h.settle()
    expect(events).toEqual([])
    expect(h.room.elements.get('ar')?.strokeColor).toBe('#e03131')
    expect(a.get('ar')?.strokeColor).toBe('#e03131')
    expect(a.core.saveStatus.state).toBe('saved')
    expect(await a.hash()).toBe(await h.roomHash())
  })

  it('control (L7c): the recolour built after the derived rows arrived decides the same way', () => {
    const h = boundArrowBoard()
    const a = h.client('alice', { latencyMs: 100 })
    h.settle()
    const events = supersededEvents(a)
    a.change('x', { x: 10 })
    h.settle()
    a.change('x', { x: 20 })
    h.settle()
    expect(a.core.confirmed('ar')?.version).toBe(3)
    a.change('ar', { strokeColor: '#e03131' })
    h.clock.advance(60)
    h.room.cut(a.transport)
    h.settle()
    reopen(a)
    h.settle()
    expect(events).toEqual([])
    expect(h.room.elements.get('ar')?.strokeColor).toBe('#e03131')
    expect(a.core.saveStatus.state).toBe('saved')
  })
})

describe('CR-W5-FIX-2, the client half: the doc-key ABA with the welcome’s per-key clock', () => {
  const KEY = 'tagDef:topic'
  const blue = { name: 'topic', color: 'blue' }
  const red = { name: 'topic', color: 'red' }

  /** The room with `docClocks` on and the key at `blue`, written by alice and acked (Saved). */
  function boardWithBlue(h: Harness, a: TestClient): void {
    h.room.sendDocClocks = true
    h.settle()
    a.core.setDoc({ [KEY]: blue })
    h.settle()
    expect(h.room.doc[KEY]).toEqual(blue)
    expect(a.core.saveStatus.state).toBe('saved')
  }

  it("R9: A's write landed, its ack lost; B sets the old value back: after the reconnect B's write stays and A is told", () => {
    const h = createHarness()
    h.room.sendDocClocks = true
    const a = h.client('alice', { latencyMs: 100 })
    const b = h.client('bob')
    boardWithBlue(h, a)
    const events = supersededEvents(a)
    a.core.setDoc({ [KEY]: red })
    h.clock.advance(60) // committed at +50, the ack still on the wire
    h.room.cut(a.transport)
    h.settle()
    expect(h.room.doc[KEY]).toEqual(red)
    b.core.setDoc({ [KEY]: blue })
    h.settle()
    const pushesBefore = a.core.pushLog().filter((p) => p.doc).length
    reopen(a)
    h.settle()
    // before: the server at the value A's write replaced read as "did not land" and red went again
    expect(h.room.doc[KEY]).toEqual(blue)
    expect(a.core.doc().get(KEY)).toEqual(blue)
    expect(a.core.pushLog().filter((p) => p.doc).length).toBe(pushesBefore)
    expect(a.logs.filter((l) => l.event === 'lost_doc_superseded').map((l) => l.detail)).toEqual([
      { key: KEY },
    ])
    expect(events).toEqual([{ kind: 'superseded', id: `doc:${KEY}`, groups: [] }])
    expect(a.core.saveStatus.state).toBe('saved')
  })

  it('R9 across a reload: the queued lost write carries its base clock and decides the same way', async () => {
    const h = createHarness()
    h.room.sendDocClocks = true
    const store = createMemoryOfflineStore()
    const a = h.client('alice', { latencyMs: 100, offline: store })
    const b = h.client('bob')
    h.settle()
    await flushMicro() // the (empty) queue is read: Saved may come
    a.core.setDoc({ [KEY]: blue })
    h.settle()
    expect(h.room.doc[KEY]).toEqual(blue)
    expect(a.core.saveStatus.state).toBe('saved')
    a.core.setDoc({ [KEY]: red })
    h.clock.advance(60)
    a.core.persistNow()
    await flushMicro()
    const entries = structuredClone(store.entries()) as OfflineEntry[]
    a.core.stop()
    h.room.cut(a.transport)
    h.settle()
    const docEntry = entries.find((e) => e.element.id === DOC_ENTRY_ID)
    expect(docEntry?.lostDoc?.map((r) => typeof r.clock)).toEqual(['number'])
    b.core.setDoc({ [KEY]: blue })
    h.settle()
    const a2 = h.client('alice', { offline: createMemoryOfflineStore(entries), tab: 'tab1' })
    await flushMicro()
    h.settle()
    await flushMicro()
    h.settle()
    expect(h.room.doc[KEY]).toEqual(blue)
    expect(a2.core.pushLog().filter((p) => p.doc)).toEqual([])
    expect(a2.core.saveStatus.state).toBe('saved')
  })

  it('a write that never reached the room, with nobody writing the key since, still goes again', () => {
    const h = createHarness()
    h.room.sendDocClocks = true
    const a = h.client('alice', { latencyMs: 100 })
    boardWithBlue(h, a)
    const events = supersededEvents(a)
    a.core.setDoc({ [KEY]: red })
    h.clock.advance(30) // on the wire, not at the room (it would arrive at +50)
    h.room.cut(a.transport)
    h.settle()
    expect(h.room.doc[KEY]).toEqual(blue)
    reopen(a)
    h.settle()
    expect(h.room.doc[KEY]).toEqual(red)
    expect(events).toEqual([])
    expect(a.core.saveStatus.state).toBe('saved')
  })

  it('a write that never reached the room while someone else wrote the key: theirs stands (as before), and A is told', () => {
    const h = createHarness()
    h.room.sendDocClocks = true
    const a = h.client('alice', { latencyMs: 100 })
    const b = h.client('bob')
    boardWithBlue(h, a)
    const events = supersededEvents(a)
    a.core.setDoc({ [KEY]: red })
    h.clock.advance(30)
    h.room.cut(a.transport)
    h.settle()
    const green = { name: 'topic', color: 'green' }
    b.core.setDoc({ [KEY]: green })
    h.settle()
    reopen(a)
    h.settle()
    expect(h.room.doc[KEY]).toEqual(green)
    expect(events).toEqual([{ kind: 'superseded', id: `doc:${KEY}`, groups: [] }])
    expect(a.core.saveStatus.state).toBe('saved')
  })

  it('without the clock in the welcome (an older room) the decision counts values alone, as before', () => {
    const h = createHarness()
    const a = h.client('alice', { latencyMs: 100 })
    const b = h.client('bob')
    h.settle()
    a.core.setDoc({ [KEY]: blue })
    h.settle()
    a.core.setDoc({ [KEY]: red })
    h.clock.advance(60)
    h.room.cut(a.transport)
    h.settle()
    b.core.setDoc({ [KEY]: blue })
    h.settle()
    reopen(a)
    h.settle()
    expect(h.room.doc[KEY]).toEqual(red) // the ABA, accepted until the room sends docClocks
  })

  it('decideLostDocKey and docClockOf (pure)', () => {
    const r = (value: unknown, base: unknown, clock?: number) => ({
      set: { k: value },
      base: { k: base },
      ...(clock !== undefined ? { clock } : {}),
    })
    // with the clock: the key written past every lost base is someone's later write
    expect(decideLostDocKey([r('v1', 'v0', 10)], { k: 12 }, 'v0')).toBe(false)
    expect(decideLostDocKey([r('v1', 'v0', 10)], { k: 10 }, 'v0')).toBe(true)
    expect(decideLostDocKey([r('v1', 'v0', 10)], {}, 'v0')).toBe(true)
    // a chain: the second write's base past the key's clock means it did not land
    expect(decideLostDocKey([r('v1', 'v0', 10), r('v2', 'v1', 14)], { k: 12 }, 'v1')).toBe(true)
    expect(decideLostDocKey([r('v1', 'v0', 10), r('v2', 'v1', 11)], { k: 12 }, 'v1')).toBe(false)
    // no clock: the server at a value the chain started from or passed through
    expect(decideLostDocKey([r('v1', 'v0')], null, 'v0')).toBe(true)
    expect(decideLostDocKey([r('v1', 'v0'), r('v2', 'v1')], null, 'v1')).toBe(true)
    expect(decideLostDocKey([r('v1', 'v0')], null, 'other')).toBe(false)
    // a record without its clock (an older queue) falls back to values
    expect(decideLostDocKey([r('v1', 'v0')], { k: 12 }, 'v0')).toBe(true)
    const w = (docClocks: unknown) => ({ docClocks }) as never
    expect(docClockOf(w(undefined))).toBeNull()
    expect(docClockOf(w([1]))).toBeNull()
    expect(docClockOf(w({ a: 3, b: 'x', c: Number.NaN }))).toEqual({ a: 3 })
  })
})

describe('W5-02 (CONTRACTS_REV 7), the deleting tab: a redacted tombstone keeps the content it holds', () => {
  it('alice deletes, the ack is lost, the catch-up brings the tombstone redacted: her undo revives the element whole', async () => {
    const h = createHarness({
      seed: [stored(rect('x', 'a0', { x: 40, y: 60, strokeColor: '#e03131', width: 120 }))],
    })
    h.room.redactTombstones = true
    const a = h.client('alice', { latencyMs: 100 })
    const b = h.client('bob')
    h.settle()
    a.change('x', { isDeleted: true })
    h.clock.advance(60)
    h.clock.advance(60) // committed, the ack on the wire
    h.room.cut(a.transport)
    h.settle()
    expect(h.room.elements.get('x')?.isDeleted).toBe(true)
    reopen(a)
    h.settle()
    const kept = a.core.confirmed('x')
    expect(kept?.isDeleted).toBe(true)
    expect(kept?.x).toBe(40)
    expect(kept?.strokeColor).toBe('#e03131')
    expect(a.get('x')?.strokeColor).toBe('#e03131')
    expect(await a.hash()).toBe(await h.roomHash())
    // the undo: the element comes back where it was, with its words and colour, on every tab
    a.change('x', { isDeleted: false })
    h.settle()
    expect(h.room.elements.get('x')).toMatchObject({
      isDeleted: false,
      x: 40,
      width: 120,
      strokeColor: '#e03131',
    })
    expect(a.get('x')).toMatchObject({ isDeleted: false, x: 40, strokeColor: '#e03131' })
    expect(b.get('x')).toMatchObject({ isDeleted: false, x: 40, strokeColor: '#e03131' })
    expect(await a.hash()).toBe(await h.roomHash())
    expect(a.core.saveStatus.state).toBe('saved')
  })
})
