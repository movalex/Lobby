import { CONTRACTS_REV, type Op, type PatchOp } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import { frame } from '../testing/elements.ts'
import { stored } from '../testing/fakeRoom.ts'
import { createHarness, type Harness, type TestClient } from '../testing/harness.ts'
import type { OfflineEntry, SceneElement } from '../types.ts'
import { createMemoryOfflineStore } from './offline-memory.ts'

// Wave L compat refix, round 1 (the rev-11 hold, an offline queue across the deploy). A tab of the deployed web
// (437b4e7, rev 11) writes `present` whole, as {index, skip}, and has never heard of `mins`. The room keeps the
// stored minutes for a write from a rev-11 SOCKET (lobbyWriteOf), but a queue that page left in IndexedDB is
// adopted after a reload by the rev-12 web, whose core read it as its own and sent it on a rev-12 socket: the
// room wrote `present` whole and the frame's planned minutes were gone for everyone, with Saved showing. Now
// the core stamps its queue with its revision (OfflineEntry.rev, LostPushRecord.rev) and gives a queued value
// from an older page (no rev: every 437b4e7 queue) the fields its revision could not know from the server copy,
// as the room does for an older socket. Each case failed before the fix.

const ops = (c: TestClient): Op[] => c.core.pushLog().flatMap((p) => [...p.ops])
const patchesOf = (c: TestClient, id: string): PatchOp[] =>
  ops(c).filter((o): o is PatchOp => o.k === 'p' && o.id === id)
const flushMicro = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}
const lobbyOf = (el: unknown) =>
  ((el as { customData?: { lobby?: Record<string, unknown> } } | undefined)?.customData?.lobby ??
    {}) as Record<string, unknown>
const withPresent = (el: SceneElement, present: unknown): SceneElement => {
  const cd = { ...((el as { customData?: Record<string, unknown> }).customData ?? {}) }
  const lobby = { ...lobbyOf(el) }
  if (present === undefined) delete lobby.present
  else lobby.present = present
  return { ...el, customData: { ...cd, lobby }, version: el.version + 1 } as SceneElement
}

/** The queue as the 437b4e7 core writes it: the same shape, with no writer revision anywhere. */
const as437b4e7 = (entries: readonly OfflineEntry[]): OfflineEntry[] =>
  (structuredClone(entries) as (OfflineEntry & { rev?: number })[]).map(({ rev: _rev, ...e }) => ({
    ...e,
    ...(e.lost ? { lost: e.lost.map(({ rev: _r, ...r }) => r as (typeof e.lost)[number]) } : {}),
  })) as OfflineEntry[]

async function reload(h: Harness, entries: OfflineEntry[], tab = 'tab1'): Promise<TestClient> {
  const a2 = h.client('bob', { offline: createMemoryOfflineStore(entries), tab })
  for (let i = 0; i < 3; i++) {
    await flushMicro()
    h.settle()
  }
  return a2
}

const seed = () => [stored(frame('f1', 'a0', { customData: { lobby: { present: { index: 0, mins: 7 } } } }))]

describe('an offline queue a rev-11 page left, taken over by this page after a reload', () => {
  it("an offline reorder (437b4e7's present {index: 2}) keeps the frame's planned minutes", async () => {
    const h = createHarness({ seed: seed() })
    const store = createMemoryOfflineStore()
    const bob = h.client('bob', { offline: store })
    h.settle()
    expect(lobbyOf(bob.get('f1')).present).toEqual({ index: 0, mins: 7 })
    h.room.cut(bob.transport)
    h.settle()
    // 437b4e7's Frames panel (presentWith) writes `present` whole, without the minutes it never knew
    bob.edit((m) => m.set('f1', withPresent(m.get('f1') as SceneElement, { index: 2 })))
    bob.core.persistNow()
    await flushMicro()
    const entries = as437b4e7(store.entries())
    expect(entries.map((e) => [e.element.id, e.groups])).toEqual([['f1', ['c:present']]])
    bob.core.stop()
    const bob2 = await reload(h, entries)
    const sent = patchesOf(bob2, 'f1').map((p) => p.c?.present)
    expect(sent).toEqual([{ index: 2, mins: 7 }])
    expect(lobbyOf(h.room.elements.get('f1')).present).toEqual({ index: 2, mins: 7 })
    expect(lobbyOf(bob2.get('f1')).present).toEqual({ index: 2, mins: 7 })
    expect(bob2.core.saveStatus.state).toBe('saved')
    expect(await bob2.hash()).toBe(await h.roomHash())
  })

  it('an offline removal of present (437b4e7 clears index and skip) keeps the minutes', async () => {
    const h = createHarness({ seed: seed() })
    const store = createMemoryOfflineStore()
    const bob = h.client('bob', { offline: store })
    h.settle()
    h.room.cut(bob.transport)
    h.settle()
    bob.edit((m) => m.set('f1', withPresent(m.get('f1') as SceneElement, undefined)))
    bob.core.persistNow()
    await flushMicro()
    const entries = as437b4e7(store.entries())
    bob.core.stop()
    const bob2 = await reload(h, entries)
    expect(patchesOf(bob2, 'f1').map((p) => p.c?.present)).toEqual([{ mins: 7 }])
    expect(lobbyOf(h.room.elements.get('f1')).present).toEqual({ mins: 7 })
  })

  it('a push that was out at the close (a lost record of the old page) is replayed with the minutes', async () => {
    const h = createHarness({ seed: seed() })
    const store = createMemoryOfflineStore()
    const bob = h.client('bob', { offline: store, latencyMs: 100 })
    h.settle()
    bob.edit((m) => m.set('f1', withPresent(m.get('f1') as SceneElement, { index: 2 })))
    h.clock.advance(60) // the push is out; the room would read it at +50 ms
    bob.core.persistNow()
    await flushMicro()
    const entries = as437b4e7(store.entries())
    expect(entries[0]?.lost?.length).toBe(1)
    bob.core.stop()
    h.room.cut(bob.transport) // it never arrives
    h.settle()
    expect(lobbyOf(h.room.elements.get('f1')).present).toEqual({ index: 0, mins: 7 })
    const bob2 = await reload(h, entries)
    expect(patchesOf(bob2, 'f1').map((p) => p.c?.present)).toEqual([{ index: 2, mins: 7 }])
    expect(lobbyOf(h.room.elements.get('f1')).present).toEqual({ index: 2, mins: 7 })
    expect(bob2.core.saveStatus.state).toBe('saved')
  })

  it('behind a reset snapshot older than the frame (its catch-up follows): the minutes are still kept', async () => {
    // the room caches a reset snapshot for 5 s: one made before f1 existed lacks it, and f1 comes after the
    // welcome, in the catch-up; the queued value waits for it and must be completed against it then
    const h = createHarness()
    h.room.snapshotCacheMs = 5_000
    const alice = h.client('alice', { tab: 'tab-a' })
    h.settle()
    alice.edit((m) =>
      m.set('f1', frame('f1', 'a0', { customData: { lobby: { present: { index: 0, mins: 7 } } } })),
    )
    h.clock.advance(100)
    h.settle()
    expect(lobbyOf(h.room.elements.get('f1')).present).toEqual({ index: 0, mins: 7 })
    const store = createMemoryOfflineStore()
    const bob = h.client('bob', { offline: store })
    h.settle()
    expect(lobbyOf(bob.get('f1')).present).toEqual({ index: 0, mins: 7 })
    h.room.cut(bob.transport)
    h.settle()
    bob.edit((m) => m.set('f1', withPresent(m.get('f1') as SceneElement, { index: 2 })))
    bob.core.persistNow()
    await flushMicro()
    const entries = as437b4e7(store.entries())
    bob.core.stop()
    const bob2 = await reload(h, entries)
    expect(bob2.logs.some((l) => l.event === 'catch_up_wait')).toBe(true)
    expect(patchesOf(bob2, 'f1').map((p) => p.c?.present)).toEqual([{ index: 2, mins: 7 }])
    expect(lobbyOf(h.room.elements.get('f1')).present).toEqual({ index: 2, mins: 7 })
    expect(lobbyOf(bob2.get('f1')).present).toEqual({ index: 2, mins: 7 })
    expect(bob2.core.saveStatus.state).toBe('saved')
  })

  it('an older record that had landed is completed once only: a later rev-12 removal of the minutes on this page stands', async () => {
    const h = createHarness({ seed: seed() })
    const store = createMemoryOfflineStore()
    const bob = h.client('bob', { offline: store, latencyMs: 100 })
    const alice = h.client('alice', { tab: 'tab-a' })
    h.settle()
    // the old page's push lands (in this fake room, as written) and its ack is lost with the page
    bob.edit((m) => m.set('f1', withPresent(m.get('f1') as SceneElement, { index: 2 })))
    h.clock.advance(60)
    h.clock.advance(60)
    bob.core.persistNow()
    await flushMicro()
    const entries = as437b4e7(store.entries())
    expect(entries[0]?.lost?.length).toBe(1)
    bob.core.stop()
    h.room.cut(bob.transport)
    h.settle()
    const bob2 = await reload(h, entries)
    expect(patchesOf(bob2, 'f1')).toEqual([]) // it landed: nothing goes again
    // alice (rev 12) plans 9 minutes; then bob, on this web and offline, removes them
    alice.change('f1', { customData: { lobby: { present: { index: 2, mins: 9 } } } })
    h.settle()
    expect(lobbyOf(bob2.get('f1')).present).toEqual({ index: 2, mins: 9 })
    h.room.cut(bob2.transport)
    h.settle()
    bob2.edit((m) => m.set('f1', withPresent(m.get('f1') as SceneElement, { index: 2 })))
    ;(bob2.transport as unknown as { reopen(): void }).reopen()
    h.settle()
    expect(patchesOf(bob2, 'f1').map((p) => p.c?.present)).toEqual([{ index: 2 }])
    expect(lobbyOf(h.room.elements.get('f1')).present).toEqual({ index: 2 })
  })

  it("this page's own queue (rev 12) is sent as written: a rev-12 value without the minutes clears them", async () => {
    const h = createHarness({ seed: seed() })
    const store = createMemoryOfflineStore()
    const bob = h.client('bob', { offline: store })
    h.settle()
    h.room.cut(bob.transport)
    h.settle()
    bob.edit((m) => m.set('f1', withPresent(m.get('f1') as SceneElement, { index: 2 })))
    bob.core.persistNow()
    await flushMicro()
    const entries = structuredClone(store.entries()) as OfflineEntry[]
    expect(entries.map((e) => (e as { rev?: number }).rev)).toEqual([CONTRACTS_REV])
    bob.core.stop()
    const bob2 = await reload(h, entries)
    expect(patchesOf(bob2, 'f1').map((p) => p.c?.present)).toEqual([{ index: 2 }])
    expect(lobbyOf(h.room.elements.get('f1')).present).toEqual({ index: 2 })
  })
})

// Wave L compat refix, round 2: an older page's queued CREATE (a frame it made offline and placed in the
// presentation order). Its marker (olderCopies) was kept after this page's create of it was acked, so a later
// rev-12 change of this page's own was completed as the old page's: the removal of the minutes undone, Saved.
describe("an older page's offline create, taken over by this page: the create's ack ends the older copy", () => {
  /** bob's 437b4e7 tab, offline, makes frame f2 at index 3; this page takes the queue over; bob plans 5 min. */
  async function createdThenPlanned() {
    const h = createHarness({ seed: [] })
    const store = createMemoryOfflineStore()
    const bob = h.client('bob', { offline: store })
    h.settle()
    h.room.cut(bob.transport)
    h.settle()
    bob.edit((m) => m.set('f2', frame('f2', 'a1', { customData: { lobby: { present: { index: 3 } } } })))
    bob.core.persistNow()
    await flushMicro()
    const entries = as437b4e7(store.entries())
    expect(entries.map((e) => e.groups.includes('create') && e.groups.includes('c:present'))).toEqual([true])
    bob.core.stop()
    const store2 = createMemoryOfflineStore(entries)
    const bob2 = h.client('bob', { offline: store2, tab: 'tab1' })
    for (let i = 0; i < 3; i++) {
      await flushMicro()
      h.settle()
    }
    expect(lobbyOf(h.room.elements.get('f2')).present).toEqual({ index: 3 })
    bob2.edit((m) => m.set('f2', withPresent(m.get('f2') as SceneElement, { index: 3, mins: 5 })))
    h.settle()
    expect(lobbyOf(h.room.elements.get('f2')).present).toEqual({ index: 3, mins: 5 })
    return { h, bob2, store2 }
  }

  it('a later rev-12 removal of the minutes, made offline on this page, is sent after the reconnect', async () => {
    const { h, bob2 } = await createdThenPlanned()
    h.room.cut(bob2.transport)
    h.settle()
    bob2.edit((m) => m.set('f2', withPresent(m.get('f2') as SceneElement, { index: 3 })))
    ;(bob2.transport as unknown as { reopen(): void }).reopen()
    h.settle()
    expect(patchesOf(bob2, 'f2').map((p) => p.c?.present)).toEqual([{ index: 3, mins: 5 }, { index: 3 }])
    expect(lobbyOf(h.room.elements.get('f2')).present).toEqual({ index: 3 })
    expect(lobbyOf(bob2.get('f2')).present).toEqual({ index: 3 })
    expect(bob2.core.saveStatus.state).toBe('saved')
  })

  it('or this page closes with the removal unsent: its queue entry is stamped with its own revision', async () => {
    const { h, bob2, store2 } = await createdThenPlanned()
    h.room.cut(bob2.transport)
    h.settle()
    bob2.edit((m) => m.set('f2', withPresent(m.get('f2') as SceneElement, { index: 3 })))
    bob2.core.persistNow()
    await flushMicro()
    const again = structuredClone(store2.entries()) as OfflineEntry[]
    expect(again.map((e) => [e.element.id, (e as { rev?: number }).rev])).toEqual([['f2', CONTRACTS_REV]])
    bob2.core.stop()
    const bob3 = await reload(h, again, 'tab1')
    expect(patchesOf(bob3, 'f2').map((p) => p.c?.present)).toEqual([{ index: 3 }])
    expect(lobbyOf(h.room.elements.get('f2')).present).toEqual({ index: 3 })
  })
})
