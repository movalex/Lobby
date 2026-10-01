import { describe, expect, it } from 'vitest'
import { createHarness, type Harness, type TestClient } from '../testing/harness.ts'
import type { LostDocRecord, OfflineEntry } from '../types.ts'
import { type CoreEvent, DOC_ENTRY_ID, decideLostDocKey } from './engine.ts'
import { createMemoryOfflineStore } from './offline-memory.ts'

// Wave 4c (2C): the verifier V1's sixth re-check (round 6, DB1) of the doc-key clock rule (CONTRACTS_REV 9,
// W4B-1; the client half in wave 4b), against the protocol fake on the manual clock. Each case failed on
// engine/excalidraw 9b65e89.
//
// Two writes of one board-document key within one round trip go out as two pushes built at the same base
// clock (the client clock moves only on changes/welcome/snapshot). The first lands and is acked; the socket
// drops before the second reaches the room; nobody else writes. The rule compared the key's clock with the
// lost write's base alone, so the first write's own landing read as another user's write: the second was
// dropped as superseded, the local value went back, and the page said someone else had changed the setting.
// The element rule survives the same shape through Sent.ahead / effectivePv; the doc rule now has its
// counterpart (inflightDocAhead / ackedDocClock, LostDocRecord.clocks).

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
const KEY = 'tagDef:topic'
const green = { name: 'topic', color: 'green' }
const red = { name: 'topic', color: 'red' }
const blue = { name: 'topic', color: 'blue' }

/** The room with `docClocks` on and the key at `green`, written by `a` and acked (Saved). */
function boardWithGreen(h: Harness, a: TestClient): void {
  h.room.sendDocClocks = true
  h.settle()
  a.core.setDoc({ [KEY]: green })
  h.settle()
  expect(h.room.doc[KEY]).toEqual(green)
  expect(a.core.saveStatus.state).toBe('saved')
}

/**
 * The burst on a slow uplink (400 ms up, 50 ms down): red out at 0 (at the room at 400, its changes and
 * ack back at 450), blue out at 100 on the same base clock (at the room at 500). Returns at 460: red
 * landed and is acked, blue is still on its way up.
 */
function burst(h: Harness, a: TestClient, second: Record<string, unknown> = { [KEY]: blue }): void {
  a.transport.session.upLatencyMs = 400
  const clock0 = h.room.clock
  a.core.setDoc({ [KEY]: red })
  a.core.flush()
  h.clock.advance(100)
  a.core.setDoc(second)
  a.core.flush()
  // both built on the same base: red's changes frame is still on its way down
  expect(
    a.core
      .pushLog()
      .filter((p) => p.doc)
      .slice(-2)
      .map((p) => p.base),
  ).toEqual([clock0, clock0])
  h.clock.advance(360)
  expect(h.room.doc[KEY]).toEqual(red)
  expect(h.room.docClocks.get(KEY)).toBeGreaterThan(clock0)
  expect(a.core.doc().get(KEY)).toEqual(second[KEY])
  expect(a.core.saveStatus.state).toBe('saving')
}

describe('V1 round 6 (DB1): two own writes of one doc key within one round trip, the link breaks between them', () => {
  it('red lands and is acked, blue is lost with the socket, nobody else writes: blue is stored, no "someone else changed it" notice', () => {
    const h = createHarness()
    const a = h.client('alice', { latencyMs: 100 })
    boardWithGreen(h, a)
    const events = supersededEvents(a)
    burst(h, a)
    h.room.cut(a.transport) // blue never arrives
    h.settle()
    expect(h.room.doc[KEY]).toEqual(red)
    a.transport.session.upLatencyMs = null
    reopen(a)
    h.settle()
    // before: the key's clock (red's landing) was above blue's base, so blue read as superseded by another
    // user's write and was dropped; the local value went back to red and the user was told nobody's lie
    expect(events).toEqual([])
    expect(a.logs.filter((l) => l.event === 'lost_doc_superseded')).toEqual([])
    expect(h.room.doc[KEY]).toEqual(blue)
    expect(a.core.doc().get(KEY)).toEqual(blue)
    expect(a.core.saveStatus.state).toBe('saved')
  })

  it('the same across a reload: the queued lost write carries the clock of the own write it was built behind, per key', async () => {
    const h = createHarness()
    const store = createMemoryOfflineStore()
    const a = h.client('alice', { latencyMs: 100, offline: store })
    h.settle()
    await flushMicro() // the (empty) queue is read: Saved may come
    boardWithGreen(h, a)
    const OTHER = 'tagDef:other'
    burst(h, a, { [KEY]: blue, [OTHER]: green })
    a.core.persistNow()
    await flushMicro()
    const entries = structuredClone(store.entries()) as OfflineEntry[]
    a.core.stop()
    h.room.cut(a.transport)
    h.settle()
    const docEntry = entries.find((e) => e.element.id === DOC_ENTRY_ID)
    const lost = docEntry?.lostDoc as LostDocRecord[]
    expect(lost).toHaveLength(1)
    expect(lost[0]?.set).toEqual({ [KEY]: blue, [OTHER]: green })
    expect(lost[0]?.base).toEqual({ [KEY]: red, [OTHER]: null })
    // the push's base, and per key the clock red's landing gave the key (OTHER had no own write ahead)
    expect(lost[0]?.clock).toBe((h.room.docClocks.get(KEY) as number) - 1)
    expect(lost[0]?.clocks).toEqual({ [KEY]: h.room.docClocks.get(KEY) })
    expect(h.room.doc[KEY]).toEqual(red)
    const a2 = h.client('alice', { offline: createMemoryOfflineStore(entries), tab: 'tab1' })
    const events = supersededEvents(a2)
    await flushMicro()
    h.settle()
    await flushMicro()
    h.settle()
    expect(events).toEqual([])
    expect(h.room.doc[KEY]).toEqual(blue)
    expect(h.room.doc[OTHER]).toEqual(green)
    expect(a2.core.doc().get(KEY)).toEqual(blue)
    expect(a2.core.saveStatus.state).toBe('saved')
  })

  it('red lands and is acked, then someone else writes the key, blue is lost: theirs stands and A is told', () => {
    const h = createHarness()
    const a = h.client('alice', { latencyMs: 100 })
    const b = h.client('bob')
    boardWithGreen(h, a)
    const events = supersededEvents(a)
    burst(h, a)
    const teal = { name: 'topic', color: 'teal' }
    b.core.setDoc({ [KEY]: teal })
    h.clock.advance(5) // at the room at once (bob has no latency); its changes to alice would arrive at +50
    expect(h.room.doc[KEY]).toEqual(teal)
    h.room.cut(a.transport) // blue never arrives, nor does teal's changes frame
    h.settle()
    const pushesBefore = a.core.pushLog().filter((p) => p.doc).length
    a.transport.session.upLatencyMs = null
    reopen(a)
    h.settle()
    // the lift stops at this tab's own acked write: the key's clock is past it, so the write is bob's
    expect(h.room.doc[KEY]).toEqual(teal)
    expect(a.core.doc().get(KEY)).toEqual(teal)
    expect(a.core.pushLog().filter((p) => p.doc).length).toBe(pushesBefore)
    expect(events).toEqual([{ kind: 'superseded', id: `doc:${KEY}`, groups: [] }])
    expect(a.core.saveStatus.state).toBe('saved')
  })

  it('control (DB1c): blue written after red is Saved, lost on the way up: goes again, no notice', () => {
    const h = createHarness()
    const a = h.client('alice', { latencyMs: 100 })
    boardWithGreen(h, a)
    const events = supersededEvents(a)
    a.core.setDoc({ [KEY]: red })
    h.settle()
    expect(a.core.saveStatus.state).toBe('saved')
    a.transport.session.upLatencyMs = 400
    a.core.setDoc({ [KEY]: blue })
    a.core.flush()
    h.clock.advance(200)
    h.room.cut(a.transport)
    h.settle()
    expect(h.room.doc[KEY]).toEqual(red)
    a.transport.session.upLatencyMs = null
    reopen(a)
    h.settle()
    expect(events).toEqual([])
    expect(h.room.doc[KEY]).toEqual(blue)
    expect(a.core.saveStatus.state).toBe('saved')
  })

  it('decideLostDocKey with per-key clocks (pure)', () => {
    const r = (value: unknown, base: unknown, clock: number, clocks?: Record<string, number>) => ({
      set: { k: value },
      base: { k: base },
      clock,
      ...(clocks ? { clocks } : {}),
    })
    // the lost write's base lifted to the own write's landing: the key at that clock was written by nobody since
    expect(decideLostDocKey([r('v2', 'v1', 10)], { k: 12 }, 'v1')).toBe(false)
    expect(decideLostDocKey([r('v2', 'v1', 10, { k: 12 })], { k: 12 }, 'v1')).toBe(true)
    // past it: another user's write
    expect(decideLostDocKey([r('v2', 'v1', 10, { k: 12 })], { k: 13 }, 'v1')).toBe(false)
    // another key's lift says nothing about this one
    expect(decideLostDocKey([r('v2', 'v1', 10, { other: 12 })], { k: 12 }, 'v1')).toBe(false)
    // a chain of two lost writes behind the acked one: the latest goes again
    expect(
      decideLostDocKey([r('v2', 'v1', 10, { k: 12 }), r('v3', 'v2', 10, { k: 12 })], { k: 12 }, 'v1'),
    ).toBe(true)
  })
})
