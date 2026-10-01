import type { Op, PatchOp } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import { arrow, rect } from '../testing/elements.ts'
import { stored } from '../testing/fakeRoom.ts'
import { createHarness, type TestClient } from '../testing/harness.ts'
import type { OfflineEntry } from '../types.ts'
import { createMemoryOfflineStore } from './offline-memory.ts'

// Regressions for the spike B verifier V1's engine-core defects (part-3 round), against the protocol fake
// on the manual clock. Each failed on 37bdfa9 and passes with the fix it names (engine.ts unless noted).

const ops = (c: TestClient): Op[] => c.core.pushLog().flatMap((p) => [...p.ops])
const patchesOf = (c: TestClient, id: string): PatchOp[] =>
  ops(c).filter((o): o is PatchOp => o.k === 'p' && o.id === id)
const reopen = (c: TestClient) => (c.transport as unknown as { reopen(): void }).reopen()
/** A with 100 ms of latency: a push reaches the room 50 ms after it is sent, its ack 50 ms after that. */
function lostAck(h: ReturnType<typeof createHarness>, a: TestClient, edit: () => void): void {
  edit()
  h.clock.advance(60) // the coalesced push goes out
  h.clock.advance(60) // the room committed it (50 ms), its ack is on the wire
  h.room.cut(a.transport) // the ack is lost with the socket
  h.settle()
}

describe('V1 N3: a push whose ack was lost is not replayed over what landed after it', () => {
  it("A's push committed, its ack lost; B then writes the same field: after the reconnect B's value stays", async () => {
    const h = createHarness({ seed: [stored(rect('r1', 'a0', { x: 0 }))] })
    const a = h.client('alice', { latencyMs: 100 })
    const b = h.client('bob')
    h.settle()
    lostAck(h, a, () => a.change('r1', { x: 111 }))
    expect(h.room.elements.get('r1')?.x).toBe(111)
    b.change('r1', { x: 222 })
    h.settle()
    expect(h.room.elements.get('r1')?.x).toBe(222)
    const before = patchesOf(a, 'r1').length
    reopen(a)
    h.settle()
    expect(patchesOf(a, 'r1').length).toBe(before) // nothing replayed
    expect(h.room.elements.get('r1')?.x).toBe(222)
    expect(a.get('r1')?.x).toBe(222)
    expect(a.core.saveStatus.state).toBe('saved')
    expect(await a.hash()).toBe(await h.roomHash())
  })

  it("A's create committed, its ack lost; B deletes it: after the reconnect it stays deleted", async () => {
    const h = createHarness({ seed: [stored(rect('r1', 'a0'))] })
    const a = h.client('alice', { latencyMs: 100 })
    const b = h.client('bob')
    h.settle()
    lostAck(h, a, () => a.edit((m) => m.set('m1', rect('m1', 'a5', { x: 5 }))))
    expect(h.room.elements.get('m1')?.isDeleted).toBe(false)
    b.change('m1', { isDeleted: true })
    h.settle()
    reopen(a)
    h.settle()
    expect(h.room.elements.get('m1')?.isDeleted).toBe(true)
    expect(a.get('m1')?.isDeleted ?? true).toBe(true)
    expect(a.core.saveStatus.state).toBe('saved')
    expect(await a.hash()).toBe(await h.roomHash())
  })

  it('behind a reset snapshot (cached, older than the commit) the decision waits for its catch-up: B’s later write stays', async () => {
    const h = createHarness({ seed: [stored(rect('r1', 'a0', { x: 0 }))] })
    h.room.snapshotCacheMs = 5_000
    const a = h.client('alice', { latencyMs: 100 })
    const b = h.client('bob')
    const c = h.client('carol') // her join caches the reset snapshot before A's write
    h.settle()
    lostAck(h, a, () => a.change('r1', { x: 111 }))
    b.change('r1', { x: 222 })
    h.settle()
    h.room.horizon = h.room.clock // A's `since` is below it: a reset, served from the stale cache
    reopen(a)
    h.settle()
    expect(a.logs.some((l) => l.event === 'lost_held')).toBe(true)
    expect(h.room.elements.get('r1')?.x).toBe(222)
    expect(a.get('r1')?.x).toBe(222)
    expect(a.core.saveStatus.state).toBe('saved')
    expect(await a.hash()).toBe(await h.roomHash())
    expect(c.core.pushLog()).toHaveLength(0)
  })

  it('a push lost BEFORE it reached the room is replayed (the control): its value lands', async () => {
    const h = createHarness({ seed: [stored(rect('r1', 'a0', { x: 0 }))] })
    const a = h.client('alice', { latencyMs: 100 })
    h.settle()
    a.change('r1', { x: 111 })
    h.clock.advance(60) // sent; the room would read it at +50 ms
    h.room.cut(a.transport)
    h.settle()
    expect(h.room.elements.get('r1')?.x).toBe(0)
    reopen(a)
    h.settle()
    expect(h.room.elements.get('r1')?.x).toBe(111)
    expect(a.core.saveStatus.state).toBe('saved')
  })

  it('two lost pushes of one field, the first committed: the second (not landed) goes again', async () => {
    const h = createHarness({ seed: [stored(rect('r1', 'a0', { x: 0 }))] })
    const a = h.client('alice', { latencyMs: 100 })
    h.settle()
    a.change('r1', { x: 111 })
    h.clock.advance(60) // push 1 out
    a.change('r1', { x: 150 })
    h.clock.advance(55) // push 1 committed; push 2 out
    h.room.cut(a.transport) // push 2 never reaches the room
    h.settle()
    expect(h.room.elements.get('r1')?.x).toBe(111)
    reopen(a)
    h.settle()
    expect(h.room.elements.get('r1')?.x).toBe(150)
    expect(a.core.saveStatus.state).toBe('saved')
  })
})

describe('V1 N17: an offline replay goes out on the clock it was made on, with its age', () => {
  it('an edit made offline 11 minutes ago: `off` is its age and the push base is the clock before the cut, also for an element created in this session', () => {
    const h = createHarness({ seed: [stored(rect('r1', 'a0'))] })
    const a = h.client('alice')
    const b = h.client('bob')
    h.settle()
    // an element A created in this session (its create acked), then B's element
    a.edit((m) => m.set('mine', rect('mine', 'a5')))
    h.settle()
    const clockAtCut = a.core.clock
    h.room.cut(a.transport)
    h.settle()
    a.change('r1', { x: 111 })
    a.change('mine', { x: 77 })
    b.change('r1', { x: 222 })
    h.settle()
    h.clock.advance(11 * 60_000)
    reopen(a)
    h.settle()
    for (const id of ['r1', 'mine']) {
      const push = a.core.pushLog().find((p) => p.ops.some((o) => o.k === 'p' && o.id === id && o.g?.pos))
      expect(push, id).toBeDefined()
      const op = push?.ops.find((o) => o.k === 'p' && o.id === id) as PatchOp
      expect(op.off, id).toBeGreaterThanOrEqual(11 * 60_000)
      expect(push?.base, id).toBe(clockAtCut)
    }
  })
})

describe('V1 N18: a dirty group overtaken by the same remote value', () => {
  it('A recolours X; B makes the same recolour first: A pushes nothing and holds the server copy exactly', async () => {
    const h = createHarness({ seed: [stored(rect('x1', 'a0'))] })
    const a = h.client('alice')
    h.settle()
    a.change('x1', { strokeColor: '#e03131' }) // coalescing: not sent yet
    // another session's identical recolour lands before A's flush
    h.room.serverWrite('x1', { strokeColor: '#e03131' })
    h.clock.advance(1)
    expect(patchesOf(a, 'x1')).toHaveLength(0)
    h.settle()
    expect(patchesOf(a, 'x1')).toHaveLength(0)
    const conf = h.room.elements.get('x1')
    expect(a.get('x1')?.version).toBe(conf?.version)
    expect(a.get('x1')?.versionNonce).toBe(conf?.versionNonce)
    expect(a.core.saveStatus.state).toBe('saved')
    expect(await a.hash()).toBe(await h.roomHash())
  })
})

describe('V1 N8: board-document writes are in the offline queue', () => {
  it('a tagDef written offline survives a reload and goes before the element that uses it', async () => {
    const store = createMemoryOfflineStore()
    const h = createHarness({ seed: [stored(rect('n1', 'a0'))] })
    const a = h.client('alice', { offline: store })
    h.settle()
    h.room.cut(a.transport)
    h.settle()
    await Promise.resolve()
    a.core.setDoc({ 'tagDef:urgent': { name: 'urgent', color: 'violet' } })
    a.change('n1', { customData: { lobby: { 'tag:urgent': { name: 'urgent', color: 'violet' } } } })
    await Promise.resolve()
    const saved = store.entries() as OfflineEntry[]
    expect(saved.some((e) => e.groups.includes('doc'))).toBe(true)
    // the reloaded page
    const h2 = createHarness({ seed: [stored(rect('n1', 'a0'))] })
    const a2 = h2.client('alice', { offline: createMemoryOfflineStore(saved) })
    await Promise.resolve()
    h2.settle()
    await Promise.resolve()
    h2.settle()
    expect(h2.room.doc['tagDef:urgent']).toEqual({ name: 'urgent', color: 'violet' })
    const first = a2.core.pushLog()[0]
    expect(first?.doc?.set['tagDef:urgent']).toBeDefined()
    expect(first?.ops.some((o) => o.k === 'p' && o.id === 'n1')).toBe(true)
    expect(a2.core.saveStatus.state).toBe('saved')
  })
})

describe('V1 N20 and P1: Saved waits for what is not on the server yet', () => {
  it('a reloaded page is not Saved before the previous page’s queue is loaded', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const inner = createMemoryOfflineStore()
    const slow = {
      ...inner,
      load: async () => {
        await gate
        return inner.load()
      },
    }
    const h = createHarness({ seed: [stored(rect('r1', 'a0'))] })
    const a = h.client('alice', { offline: slow })
    h.settle()
    expect(a.core.welcome).not.toBeNull()
    expect(a.core.saveStatus.state).not.toBe('saved')
    release()
    for (let i = 0; i < 10; i++) await Promise.resolve()
    h.settle()
    expect(a.core.saveStatus.state).toBe('saved')
  })

  it('a queue not read yet keeps Saved away but is no offline change (A11Y-14, CR-3I-6)', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const inner = createMemoryOfflineStore()
    const slow = {
      ...inner,
      load: async () => {
        await gate
        return inner.load()
      },
    }
    const h = createHarness({ seed: [stored(rect('r1', 'a0'))] })
    const a = h.client('alice', { offline: slow })
    // before the welcome: offline, but nothing of this tab is known to be waiting (the page shows
    // "Connecting…", not "Offline — 1 change", so its announcer has no recovery to speak afterwards)
    expect(a.core.saveStatus.state).toBe('offline')
    expect(a.core.saveStatus.offlineChanges).toBe(0)
    h.settle()
    expect(a.core.saveStatus.state).not.toBe('saved')
    expect(a.core.saveStatus.offlineChanges).toBe(0)
    release()
    for (let i = 0; i < 10; i++) await Promise.resolve()
    h.settle()
    expect(a.core.saveStatus.state).toBe('saved')
  })

  it('keys buffered in an editor that waits for its lease keep Saved away (holdSaved)', () => {
    const h = createHarness({ seed: [stored(rect('r1', 'a0'))] })
    const a = h.client('alice')
    h.settle()
    expect(a.core.saveStatus.state).toBe('saved')
    a.core.holdSaved('editor-buffer', true)
    expect(a.core.saveStatus.state).not.toBe('saved')
    a.core.holdSaved('editor-buffer', false)
    expect(a.core.saveStatus.state).toBe('saved')
  })
})

describe('V1 N7: lease messages a failed batch never answered', () => {
  it('an acquire with no answer when the socket goes is asked again after the welcome, with its request number', () => {
    const h = createHarness({ seed: [stored(rect('r1', 'a0'))] })
    const a = h.client('alice', { latencyMs: 100 })
    h.settle()
    const answers: string[] = []
    const lease = a.core.leaseConnect((m) => answers.push(m.type))
    lease.send({ type: 'lease.acquire', req: 7, id: 'r1' })
    h.clock.advance(10) // sent, not answered yet
    h.room.cut(a.transport)
    h.settle()
    reopen(a)
    h.settle()
    const acquires = a.transport.session.received.filter((m) => m.type === 'lease.acquire')
    expect(acquires.map((m) => (m as { req: number }).req)).toEqual([7])
    expect(answers).toContain('lease.grant')
    expect(a.core.leaseState().held).toEqual(['r1'])
  })

  it('a lease the welcome names this tab for, which it released meanwhile, is released after the pushes', () => {
    const h = createHarness({ seed: [stored(rect('r1', 'a0'))] })
    const a = h.client('alice')
    h.settle()
    const lease = a.core.leaseConnect(() => {})
    lease.send({ type: 'lease.acquire', req: 1, id: 'r1' })
    h.settle()
    h.room.cut(a.transport)
    h.settle()
    lease.send({ type: 'lease.release', id: 'r1' }) // offline: not sent
    a.change('r1', { x: 5 })
    // the server still names alice (its release never arrived)
    h.room.leases.set('r1', { sid: 'alice:tab1', uid: 'alice', name: 'alice' })
    reopen(a)
    h.settle()
    const after = a.transport.session.received
    const pushAt = after.findLastIndex((m) => m.type === 'push')
    const releaseAt = after.findIndex((m) => m.type === 'lease.release')
    expect(pushAt).toBeGreaterThanOrEqual(0)
    expect(releaseAt).toBeGreaterThan(pushAt)
    expect(h.room.leases.has('r1')).toBe(false)
  })
})

describe('V1 B3 L10 6: an arrow bound to nothing has no derived change', () => {
  it("an unbound elbow arrow's local route (its ends kept) is pushed, not held as derived", () => {
    const h = createHarness({ seed: [] })
    const a = h.client('alice')
    h.settle()
    a.edit((m) =>
      m.set(
        'e1',
        arrow('e1', 'a0', {
          elbowed: true,
          points: [
            [0, 0],
            [340, 410],
          ],
          width: 340,
          height: 410,
          fixedSegments: [],
          startIsSpecial: false,
          endIsSpecial: false,
        }),
      ),
    )
    h.settle()
    a.change('e1', {
      points: [
        [0, 0],
        [0, 205],
        [340, 205],
        [340, 410],
      ],
    })
    h.settle()
    expect(a.core.isDerivedHeld('e1')).toBe(false)
    expect((h.room.elements.get('e1')?.points as unknown[] | undefined)?.length).toBe(4)
    expect(a.core.saveStatus.state).toBe('saved')
  })
})
