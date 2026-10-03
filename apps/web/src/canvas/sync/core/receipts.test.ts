import type { ClientMessage } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import { rect } from '../testing/elements.ts'
import { stored } from '../testing/fakeRoom.ts'
import { createHarness, type Harness, type TestClient } from '../testing/harness.ts'
import type { OfflineEntry } from '../types.ts'
import {
  CONTRACTS_WAIT_MS,
  type CoreEvent,
  decideLostDocByReceipt,
  decideLostElement,
  RECEIPTS_WAIT_MS,
} from './engine.ts'
import { createMemoryOfflineStore } from './offline-memory.ts'

// W5-ENG-2 (wave C, C2; CONTRACTS_REV 11): push receipts. The last lost-edit paths V1's re-checks left
// (W5-ENGINE.md §5-6; EXCALIDRAW-CONTRACTS.md §12 W5-ENG-2, W4C-2C-1): a push that never reached the room
// while two or more other writes landed was read as superseded (the server's copy stood, the change was
// lost); a doc write whose first of two writes landed with its ack lost (DB2) the same. With receipts the
// core asks the room which lost pushes landed and decides each one exactly. Against the protocol fake on
// the manual clock: `contractsRev` 11 is a rev-11 room, null a room before rev 10, 10 a rev-10 room.

const reopen = (c: TestClient) => (c.transport as unknown as { reopen(): void }).reopen()
const flushMicro = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}
const superseded = (c: TestClient): CoreEvent[] => {
  const events: CoreEvent[] = []
  c.core.on((e) => {
    if (e.kind === 'superseded') events.push(e)
  })
  return events
}
/** What `c` sent the room (parsed by the fake). */
const sentBy = (c: TestClient): ClientMessage[] => c.transport.session.received
const pushesOf = (c: TestClient) =>
  sentBy(c).filter((m): m is Extract<ClientMessage, { type: 'push' }> => m.type === 'push')
const queriesOf = (c: TestClient) =>
  sentBy(c).filter((m): m is Extract<ClientMessage, { type: 'receipts' }> => m.type === 'receipts')

/** A rev-11 room with x at 0; alice (100 ms of latency) and bob. */
function board(rev: number | null = 11): { h: Harness; a: TestClient; b: TestClient } {
  const h = createHarness({ seed: [stored(rect('x', 'a0', { x: 0 })), stored(rect('y', 'a1', { x: 300 }))] })
  h.room.contractsRev = rev
  h.room.sendDocClocks = true
  const a = h.client('alice', { latencyMs: 100 })
  const b = h.client('bob')
  h.settle()
  return { h, a, b }
}

/** Alice's move of x goes out and never reaches the room; bob writes x twice meanwhile. */
function neverArrivedTwoOthers(h: Harness, a: TestClient, b: TestClient): void {
  a.change('x', { x: 111 })
  h.clock.advance(60) // out; the room would read it at +50 ms
  h.room.cut(a.transport) // it never arrives
  h.settle()
  b.change('x', { x: 222 })
  h.settle()
  b.change('x', { x: 333 })
  h.settle()
}

describe('W5-ENG-2: a lost push decided by its receipt', () => {
  it('a push that never arrived, two other writes meanwhile: replayed as an offline change (no "superseded")', async () => {
    const { h, a, b } = board()
    const events = superseded(a)
    neverArrivedTwoOthers(h, a, b)
    reopen(a)
    h.settle()
    // before rev 11 (and on a rev-10 room, below): the server copy stood and the person was told
    expect(events).toEqual([])
    expect(h.room.elements.get('x')?.x).toBe(111)
    expect(a.get('x')?.x).toBe(111)
    // the lost push carried a receipt id, which the new socket asked about
    expect(queriesOf(a)).toHaveLength(1)
    expect(queriesOf(a)[0]?.ids).toHaveLength(1)
    expect(queriesOf(a)[0]?.ids[0]).toMatch(/^[a-z0-9]+\.\d+$/)
    expect(a.core.saveStatus.state).toBe('saved')
    expect(await a.hash()).toBe(await h.roomHash())
  })

  it('the same on a rev-10 room: no receipt id, no query, decided by counting as before (the server copy stands, told)', async () => {
    const { h, a, b } = board(10)
    const events = superseded(a)
    neverArrivedTwoOthers(h, a, b)
    reopen(a)
    h.settle()
    expect(pushesOf(a).every((p) => p.rid === undefined)).toBe(true)
    expect(queriesOf(a)).toEqual([])
    expect(h.room.elements.get('x')?.x).toBe(333)
    expect(events).toEqual([{ kind: 'superseded', id: 'x', groups: ['pos'] }])
    expect(a.core.saveStatus.state).toBe('saved')
  })

  it('a push that landed with its ack lost, two other writes after: the server copy stands, the person is told', () => {
    const { h, a, b } = board()
    const events = superseded(a)
    a.change('x', { x: 111 })
    h.clock.advance(60)
    h.clock.advance(60) // committed at +50 ms, its ack on the wire
    h.room.cut(a.transport)
    h.settle()
    expect(h.room.elements.get('x')?.x).toBe(111)
    b.change('x', { x: 222 })
    h.settle()
    b.change('x', { x: 333 })
    h.settle()
    const before = pushesOf(a).length
    reopen(a)
    h.settle()
    expect(pushesOf(a).length, 'nothing sent again').toBe(before)
    expect(h.room.elements.get('x')?.x).toBe(333)
    expect(events).toEqual([{ kind: 'superseded', id: 'x', groups: ['pos'] }])
  })

  it('a push that landed with its ack lost and nobody wrote after: kept, no notice, nothing sent again', async () => {
    const { h, a } = board()
    const events = superseded(a)
    a.change('x', { x: 111 })
    h.clock.advance(120)
    h.room.cut(a.transport)
    h.settle()
    const before = pushesOf(a).length
    reopen(a)
    h.settle()
    expect(pushesOf(a).length).toBe(before)
    expect(events).toEqual([])
    expect(a.get('x')?.x).toBe(111)
    expect(a.core.saveStatus.state).toBe('saved')
    expect(await a.hash()).toBe(await h.roomHash())
  })

  it('the room never answers: after RECEIPTS_WAIT_MS the lost push is decided by counting, as before', () => {
    const { h, a, b } = board()
    h.room.dropReceiptQueries = true
    const events = superseded(a)
    neverArrivedTwoOthers(h, a, b)
    reopen(a)
    h.clock.advance(100)
    // held: in flight for Saved, its value kept in the scene meanwhile
    expect(a.core.saveStatus.state).toBe('saving')
    expect(a.get('x')?.x).toBe(111)
    h.clock.advance(RECEIPTS_WAIT_MS)
    h.settle()
    expect(h.room.elements.get('x')?.x).toBe(333)
    expect(events).toEqual([{ kind: 'superseded', id: 'x', groups: ['pos'] }])
    expect(a.core.saveStatus.state).toBe('saved')
  })

  it('a receipt the room may have trimmed (its push older than the answer`s `from`) says nothing: counting decides', () => {
    const { h, a, b } = board()
    const events = superseded(a)
    neverArrivedTwoOthers(h, a, b)
    h.room.receiptsFrom = h.room.clock + 1
    reopen(a)
    h.settle()
    expect(h.room.elements.get('x')?.x).toBe(333)
    expect(events).toEqual([{ kind: 'superseded', id: 'x', groups: ['pos'] }])
  })

  it('across a reload: the queued lost push keeps its receipt id; the reloaded page asks and replays it', async () => {
    const { h, a, b } = board()
    const store = createMemoryOfflineStore()
    const a1 = h.client('alice', { latencyMs: 100, offline: store, tab: 'tab9' })
    h.settle()
    a.core.stop()
    a1.change('x', { x: 111 })
    h.clock.advance(60)
    a1.core.persistNow()
    await flushMicro()
    const entries = structuredClone(store.entries()) as OfflineEntry[]
    expect(entries.flatMap((e) => e.lost ?? []).map((l) => l.rid)[0]).toMatch(/\./)
    a1.core.stop()
    h.room.cut(a1.transport) // the push never arrives; the page is gone
    h.settle()
    b.change('x', { x: 222 })
    h.settle()
    b.change('x', { x: 333 })
    h.settle()
    const a2 = h.client('alice', { offline: createMemoryOfflineStore(entries), tab: 'tab9' })
    const events = superseded(a2)
    await flushMicro()
    h.settle()
    await flushMicro()
    h.settle()
    expect(queriesOf(a2)).toHaveLength(1)
    expect(h.room.elements.get('x')?.x).toBe(111)
    expect(events).toEqual([])
    expect(a2.core.saveStatus.state).toBe('saved')
  })

  it('behind a cached reset snapshot: the lost push waits for both the catch-up and the answer', async () => {
    const { h, a, b } = board()
    h.room.snapshotCacheMs = 5_000
    const events = superseded(a)
    neverArrivedTwoOthers(h, a, b)
    // a reset (another epoch is not needed: since 0 makes the fake reset) with a cached snapshot
    ;(a.core as unknown as { epoch: string | null }).epoch = null
    reopen(a)
    h.settle()
    expect(a.core.welcome?.reset).toBe(true)
    expect(a.logs.filter((l) => l.event === 'lost_held').at(-1)?.detail).toMatchObject({
      receipts: 'contracts',
    })
    expect(a.logs.some((l) => l.event === 'receipts_asked')).toBe(true)
    expect(events).toEqual([])
    expect(h.room.elements.get('x')?.x).toBe(111)
    expect(a.core.saveStatus.state).toBe('saved')
    expect(await a.hash()).toBe(await h.roomHash())
  })
})

describe('W5-ENG-2: a lost board-document write decided by its receipt (DB2)', () => {
  const KEY = 'tagDef:topic'
  const red = { name: 'topic', color: 'red' }
  const blue = { name: 'topic', color: 'blue' }

  it('the first of two writes landed with its ack lost, the second never arrived: the second goes again, no notice', () => {
    const { h, a } = board()
    const events = superseded(a)
    a.transport.session.upLatencyMs = 400
    a.core.setDoc({ [KEY]: red })
    a.core.flush()
    h.clock.advance(100)
    a.core.setDoc({ [KEY]: blue })
    a.core.flush()
    h.clock.advance(320) // red reached the room at 400 ms; its ack (back at 450) is lost; blue still on its way
    expect(h.room.doc[KEY]).toEqual(red)
    h.room.cut(a.transport)
    h.settle()
    expect(h.room.doc[KEY]).toEqual(red)
    a.transport.session.upLatencyMs = null
    reopen(a)
    h.settle()
    // before (the residual of W4C-2C-1): red's own landing read as another user's write: blue was dropped
    // and the person told someone else had changed the setting
    expect(events).toEqual([])
    expect(h.room.doc[KEY]).toEqual(blue)
    expect(a.core.doc().get(KEY)).toEqual(blue)
    expect(a.core.saveStatus.state).toBe('saved')
  })

  it('the same on a rev-10 room keeps the documented residual (superseded, told)', () => {
    const { h, a } = board(10)
    const events = superseded(a)
    a.transport.session.upLatencyMs = 400
    a.core.setDoc({ [KEY]: red })
    a.core.flush()
    h.clock.advance(100)
    a.core.setDoc({ [KEY]: blue })
    a.core.flush()
    h.clock.advance(320)
    h.room.cut(a.transport)
    h.settle()
    a.transport.session.upLatencyMs = null
    reopen(a)
    h.settle()
    expect(h.room.doc[KEY]).toEqual(red)
    expect(events).toEqual([{ kind: 'superseded', id: `doc:${KEY}`, groups: [] }])
  })

  it('decideLostDocByReceipt (pure)', () => {
    expect(decideLostDocByReceipt(false, 9)).toBe('again')
    expect(decideLostDocByReceipt(7, 7)).toBe('quiet')
    expect(decideLostDocByReceipt(7, 9)).toBe('superseded')
    expect(decideLostDocByReceipt(7, undefined)).toBe('superseded')
  })
})

describe('W5-ENG-2: stale tabs and rooms (deploy order, cached bundles)', () => {
  it('a room before rev 10 (no contracts frame): no receipt id, no query', () => {
    const { h, a, b } = board(null)
    neverArrivedTwoOthers(h, a, b)
    reopen(a)
    h.settle()
    expect(pushesOf(a).every((p) => p.rid === undefined)).toBe(true)
    expect(queriesOf(a)).toEqual([])
    expect(a.core.saveStatus.state).toBe('saved')
  })

  it('a reconnect to an older room (rev 11, then rev 10): the held push is decided by counting, nothing refused is sent', () => {
    const { h, a, b } = board(11)
    const events = superseded(a)
    neverArrivedTwoOthers(h, a, b)
    // the sync deploy is rolled back meanwhile: the new socket's room speaks rev 10
    h.room.contractsRev = 10
    reopen(a)
    h.settle()
    expect(queriesOf(a)).toEqual([])
    // the replays and the later pushes carry no receipt id (a rev-10 room refuses one)
    const after = pushesOf(a).slice(1)
    expect(after.every((p) => p.rid === undefined)).toBe(true)
    expect(events).toEqual([{ kind: 'superseded', id: 'x', groups: ['pos'] }])
    a.change('y', { x: 9 })
    h.settle()
    expect(pushesOf(a).at(-1)?.rid).toBeUndefined()
    expect(h.room.elements.get('y')?.x).toBe(9)
  })

  it('pushes sent before the contracts frame of a socket carry no receipt id; after it, every one does', () => {
    const { h, a } = board(11)
    a.change('x', { x: 5 })
    h.settle()
    expect(pushesOf(a).at(-1)?.rid).toMatch(/\./)
    const rids = new Set(pushesOf(a).map((p) => p.rid))
    a.change('x', { x: 6 })
    h.settle()
    expect(rids.has(pushesOf(a).at(-1)?.rid)).toBe(false)
  })
})

describe('decideLostElement with fates (pure)', () => {
  const base = rect('x', 'a0', { x: 0, version: 3 }) as never
  const at = (x: number, version: number) => ({ ...(base as object), x, version }) as never
  const part = (x: number, landed?: boolean) => ({
    p: { src: 's1', ...(landed !== undefined ? { landed } : {}) },
    s: { groups: new Set(['pos'] as const), el: at(x, 4), create: false, ref: base, pv: 3 },
  })
  it('never landed: goes again whatever the server copy holds', () => {
    const d = decideLostElement([part(111, false)], at(333, 5), new Set())
    expect([...d.again]).toEqual(['pos'])
    expect(d.superseded).toEqual([])
  })
  it('landed and written after by someone: superseded; landed and nobody wrote after: quiet', () => {
    expect(decideLostElement([part(111, true)], at(333, 6), new Set()).superseded).toEqual(['pos'])
    const quiet = decideLostElement([part(111, true)], at(112, 4), new Set())
    expect([...quiet.again]).toEqual([])
    expect(quiet.superseded).toEqual([])
  })
  it('a known fate narrows the counting rule (unknown last write, known first)', () => {
    // two lost pushes; the first never landed (known), the second unknown; one other write since
    const list = [part(100, false), { ...part(111), s: { ...part(111).s, el: at(111, 5) } }]
    const d = decideLostElement(list, at(222, 4), new Set())
    expect([...d.again]).toEqual(['pos'])
  })
})

describe('wave D2: a reconnect’s first flush waits for its socket’s contracts frame (receipt ids on the replays)', () => {
  /** Holds `c`'s next `contracts` frames until the returned function lets them through. */
  function holdContracts(c: TestClient): () => void {
    const s = c.transport.session
    const deliver = s.deliver
    const held: Parameters<NonNullable<typeof deliver>>[0][] = []
    s.deliver = (m) => {
      if (m.type === 'contracts') held.push(m)
      else deliver?.(m)
    }
    return () => {
      s.deliver = deliver
      for (const m of held.splice(0)) deliver?.(m)
    }
  }

  it('a change made with no socket goes out after the reconnect with a receipt id (before: none)', () => {
    const { h, a } = board()
    h.room.cut(a.transport)
    h.settle()
    a.change('x', { x: 77 })
    h.settle()
    const before = pushesOf(a).length
    reopen(a)
    h.settle()
    const after = pushesOf(a).slice(before)
    expect(after).toHaveLength(1)
    expect(after[0]?.rid).toMatch(/\./)
    expect(h.room.elements.get('x')?.x).toBe(77)
    expect(a.core.saveStatus.state).toBe('saved')
  })

  it('nothing goes out between the welcome and the contracts frame; a release made meanwhile goes behind the push, once', () => {
    const { h, a } = board()
    const lease = a.core.leaseConnect(() => {})
    lease.send({ type: 'lease.acquire', req: 1, id: 'x' })
    h.settle()
    expect(a.core.leaseState().held).toEqual(['x'])
    h.room.cut(a.transport)
    h.settle()
    // the room keeps a lease through its TTL across a reconnect; this fake drops it with the socket
    h.room.leases.set('x', { sid: 'alice:tab1', uid: 'alice', name: 'alice' })
    a.change('x', { x: 5 })
    h.settle()
    const release = holdContracts(a)
    const before = sentBy(a).length
    reopen(a)
    // stepped, not settled: settling would run the wait out (CONTRACTS_WAIT_MS)
    h.clock.advance(300)
    const types = () =>
      sentBy(a)
        .slice(before)
        .map((m) => m.type)
    expect(a.core.welcome, 'welcomed').not.toBeNull()
    expect(a.core.leaseState().held).toEqual(['x'])
    expect(types()).toEqual(['hello'])
    expect(a.core.saveStatus.state).toBe('saving')
    lease.send({ type: 'lease.release', id: 'x' })
    h.clock.advance(300)
    expect(types(), 'the release waits too').toEqual(['hello'])
    release()
    h.settle()
    const out = sentBy(a).slice(before)
    expect(types()).toEqual(['hello', 'push', 'lease.release'])
    expect((out[1] as { rid?: string }).rid).toMatch(/^[a-z0-9]+\.\d+$/)
    expect(h.room.elements.get('x')?.x).toBe(5)
    expect(h.room.leases.has('x')).toBe(false)
    expect(a.core.saveStatus.state).toBe('saved')
  })

  it('the socket closes while it waits: the queued release is not sent; the next welcome releases what the room still names', () => {
    const { h, a } = board()
    const lease = a.core.leaseConnect(() => {})
    lease.send({ type: 'lease.acquire', req: 1, id: 'x' })
    h.settle()
    h.room.cut(a.transport)
    h.settle()
    h.room.leases.set('x', { sid: 'alice:tab1', uid: 'alice', name: 'alice' })
    const s = a.transport.session
    const deliver = s.deliver
    holdContracts(a)
    const first = sentBy(a).length
    reopen(a)
    h.clock.advance(300)
    lease.send({ type: 'lease.release', id: 'x' })
    h.clock.advance(300)
    h.room.cut(a.transport)
    s.deliver = deliver // the held frame went with the socket
    h.settle()
    expect(
      sentBy(a)
        .slice(first)
        .map((m) => m.type),
      'nothing but the hello on that socket',
    ).toEqual(['hello'])
    h.room.leases.set('x', { sid: 'alice:tab1', uid: 'alice', name: 'alice' })
    const before = sentBy(a).length
    reopen(a)
    h.settle()
    expect(
      sentBy(a)
        .slice(before)
        .map((m) => m.type),
    ).toEqual(['hello', 'lease.release'])
    expect(h.room.leases.has('x')).toBe(false)
  })

  it('a room that sends no contracts frame any more: the flush goes after CONTRACTS_WAIT_MS without receipt ids; the next reconnect does not wait', () => {
    const { h, a } = board()
    h.room.cut(a.transport)
    h.settle()
    h.room.contractsRev = null // rolled back past rev 10
    a.change('x', { x: 6 })
    h.settle()
    const before = pushesOf(a).length
    reopen(a)
    h.clock.advance(300)
    expect(a.core.welcome).not.toBeNull()
    expect(pushesOf(a).length, 'waiting').toBe(before)
    h.clock.advance(CONTRACTS_WAIT_MS)
    h.settle()
    expect(
      pushesOf(a)
        .slice(before)
        .map((p) => p.rid),
    ).toEqual([undefined])
    expect(a.logs.some((l) => l.event === 'contracts_wait_timeout')).toBe(true)
    expect(h.room.elements.get('x')?.x).toBe(6)
    h.room.cut(a.transport)
    h.settle()
    a.change('x', { x: 7 })
    h.settle()
    const n = pushesOf(a).length
    reopen(a)
    h.clock.advance(300)
    expect(pushesOf(a).length, 'sent at once').toBe(n + 1)
  })
})
