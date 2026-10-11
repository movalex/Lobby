// N1-7 (wave N): never push a customData.lobby key the room's revision cannot take. A reaction (`react:<code>:<uid>`,
// REACTIONS_REV 13) queued in a rev-13 page and replayed after a sync rollback to rev 12 shares an op with every other
// dirty group of its note, and the old room refuses that whole op INVALID (the 104c6e0 sync's checkElement on every
// written element). The core leaves such a key out of every push (live flush, offline replay, an adopted queue, a
// lost push's replay), puts the server's value back for it, and holds it until the room's `contracts` frame says
// its revision. The FakeRoom plays the old room (`refuseUnknownKeys`).
import { CONTRACTS_REV, type Op, REACTIONS_REV } from '@draftroom/canvas-schema/protocol'
import { reactionKey } from '@draftroom/canvas-schema/reactions'
import { describe, expect, it } from 'vitest'
import { closePage } from '../testing/cached.ts'
import { note, text } from '../testing/elements.ts'
import { stored } from '../testing/fakeRoom.ts'
import { createHarness, type Harness, type TestClient } from '../testing/harness.ts'
import type { SceneElement, ServerInbound } from '../types.ts'
import { CONTRACTS_WAIT_MS } from './engine.ts'
import { lobbyOf } from './fields.ts'
import { createMemoryOfflineStore } from './offline-memory.ts'

const REACT = reactionKey('up', 'alice')
const seed = () => [
  stored(note('n1', 'a0', { boundElements: [{ id: 't1', type: 'text' }] })),
  stored(text('t1', 'a1', { containerId: 'n1', text: 'old words', originalText: 'old words' })),
]
const ops = (c: TestClient): Op[] => c.core.pushLog().flatMap((p) => [...p.ops])
const carriesReaction = (op: Op): boolean =>
  op.k === 'c'
    ? REACT in lobbyOf(op.el as unknown as SceneElement)
    : !!op.c && Object.keys(op.c).some((k) => k.startsWith('react:'))
const rejects = (c: TestClient) => c.logs.filter((l) => l.event === 'reject' || l.event === 'lost_superseded')
const reopen = (c: TestClient) => (c.transport as unknown as { reopen(): void }).reopen()
const flushMicro = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

/** The note gets alice's reaction and a new colour, its label new words: one local step. */
function reactAndEdit(a: TestClient): void {
  a.edit((m) => {
    const n = m.get('n1') as SceneElement
    m.set('n1', {
      ...n,
      backgroundColor: '#ffc9c9',
      customData: { lobby: { ...lobbyOf(n), [REACT]: true } },
      version: n.version + 1,
      versionNonce: n.versionNonce + 7,
    } as SceneElement)
    const t = m.get('t1') as SceneElement
    m.set('t1', {
      ...t,
      text: 'new words',
      originalText: 'new words',
      version: t.version + 1,
      versionNonce: t.versionNonce + 7,
    } as SceneElement)
  })
}

function room(rev: number): Harness {
  const h = createHarness({ seed: seed() })
  h.room.contractsRev = rev
  h.room.refuseUnknownKeys = true
  return h
}

/** Every reject the core reported (its `reject` and `superseded` events), counted. */
function watchRefusals(c: TestClient): { n: number } {
  const out = { n: 0 }
  c.core.on((e) => {
    if (e.kind === 'reject' || e.kind === 'superseded') out.n++
  })
  return out
}

describe('N1-7: a rev-12 room never gets a key it cannot take', () => {
  it('rev 12, an offline edit and a reaction replayed at the reconnect: the edit commits, the reaction is dropped locally, hash equal, 0 refusals', async () => {
    const h = room(12)
    const a = h.client('alice')
    const refusals = watchRefusals(a)
    h.settle()
    h.room.cut(a.transport)
    h.settle()
    reactAndEdit(a)
    h.settle()
    reopen(a)
    h.settle()
    const n1 = h.room.elements.get('n1') as Record<string, unknown>
    expect(n1.backgroundColor).toBe('#ffc9c9')
    expect(REACT in lobbyOf(n1 as SceneElement)).toBe(false)
    expect(h.room.elements.get('t1')?.text).toBe('new words')
    expect(ops(a).some(carriesReaction)).toBe(false)
    expect(refusals.n).toBe(0)
    expect(rejects(a)).toEqual([])
    // the local value went back to the server's: no reaction on the page either
    expect(REACT in lobbyOf(a.get('n1') as SceneElement)).toBe(false)
    expect(a.core.saveStatus).toMatchObject({ state: 'saved', pending: 0, lastReject: null })
    expect(await a.hash()).toBe(await h.roomHash())
  })

  it('rev 12, the same queue adopted by the next page (a reload): the edit commits, the reaction is dropped, 0 refusals', async () => {
    const h = room(12)
    const store = createMemoryOfflineStore()
    const a = h.client('alice', { offline: store })
    await flushMicro()
    h.settle()
    h.room.cut(a.transport)
    h.settle()
    reactAndEdit(a)
    h.settle()
    await flushMicro()
    closePage(a)
    await flushMicro()
    expect(store.entries().length).toBeGreaterThan(0)
    const b = h.client('alice', { offline: store, tab: 'tab2' })
    const refusals = watchRefusals(b)
    await flushMicro()
    h.settle()
    await flushMicro()
    h.settle()
    const n1 = h.room.elements.get('n1') as Record<string, unknown>
    expect(n1.backgroundColor).toBe('#ffc9c9')
    expect(REACT in lobbyOf(n1 as SceneElement)).toBe(false)
    expect(h.room.elements.get('t1')?.text).toBe('new words')
    expect(ops(b).some(carriesReaction)).toBe(false)
    expect(refusals.n).toBe(0)
    expect(REACT in lobbyOf(b.get('n1') as SceneElement)).toBe(false)
    expect(await b.hash()).toBe(await h.roomHash())
  })

  it('rev 12, a live reaction (online): never sent, the scene goes back to the server’s value at once, Saved', async () => {
    const h = room(12)
    const a = h.client('alice')
    const refusals = watchRefusals(a)
    h.settle()
    reactAndEdit(a)
    h.settle()
    expect(ops(a).some(carriesReaction)).toBe(false)
    expect(h.room.elements.get('n1')?.backgroundColor).toBe('#ffc9c9')
    expect(REACT in lobbyOf(a.get('n1') as SceneElement)).toBe(false)
    expect(refusals.n).toBe(0)
    expect(a.core.saveStatus.state).toBe('saved')
    expect(await a.hash()).toBe(await h.roomHash())
  })

  it('rev 12 after a rollback, a push lost with the socket replays: its edit goes again without the reaction, 0 refusals', async () => {
    const h = room(REACTIONS_REV)
    const a = h.client('alice', { latencyMs: 100 })
    const refusals = watchRefusals(a)
    h.settle()
    reactAndEdit(a)
    // the push is on its way up when the socket goes (never reaches the room)
    h.clock.advance(1)
    a.core.flush()
    h.clock.advance(10)
    expect(a.core.pushLog().length).toBeGreaterThan(0)
    h.room.cut(a.transport)
    h.settle()
    expect(h.room.elements.get('n1')?.backgroundColor).not.toBe('#ffc9c9')
    // the sync rolled back below the reactions' revision
    h.room.contractsRev = 12
    reopen(a)
    h.settle()
    expect(h.room.elements.get('n1')?.backgroundColor).toBe('#ffc9c9')
    expect(REACT in lobbyOf(h.room.elements.get('n1') as SceneElement)).toBe(false)
    expect(h.room.elements.get('t1')?.text).toBe('new words')
    expect(refusals.n).toBe(0)
    expect(REACT in lobbyOf(a.get('n1') as SceneElement)).toBe(false)
    expect(await a.hash()).toBe(await h.roomHash())
  })

  it('rev 12, a create that carries a reaction (an undo’s re-create, a paste): created without it, 0 refusals', async () => {
    const h = room(12)
    const a = h.client('alice')
    const refusals = watchRefusals(a)
    h.settle()
    a.edit((m) => m.set('n2', note('n2', 'a2', { x: 400, customData: { lobby: { [REACT]: true } } })))
    h.settle()
    expect(h.room.elements.has('n2')).toBe(true)
    expect(REACT in lobbyOf(h.room.elements.get('n2') as SceneElement)).toBe(false)
    expect(ops(a).some(carriesReaction)).toBe(false)
    expect(refusals.n).toBe(0)
    expect(REACT in lobbyOf(a.get('n2') as SceneElement)).toBe(false)
    expect(a.core.saveStatus.state).toBe('saved')
    expect(await a.hash()).toBe(await h.roomHash())
  })

  it(`rev ${REACTIONS_REV}: the edit and the reaction both commit`, async () => {
    const h = room(REACTIONS_REV)
    const a = h.client('alice')
    const refusals = watchRefusals(a)
    h.settle()
    h.room.cut(a.transport)
    h.settle()
    reactAndEdit(a)
    h.settle()
    reopen(a)
    h.settle()
    const n1 = h.room.elements.get('n1') as Record<string, unknown>
    expect(n1.backgroundColor).toBe('#ffc9c9')
    expect(lobbyOf(n1 as SceneElement)[REACT]).toBe(true)
    expect(h.room.elements.get('t1')?.text).toBe('new words')
    expect(refusals.n).toBe(0)
    expect(lobbyOf(a.get('n1') as SceneElement)[REACT]).toBe(true)
    expect(await a.hash()).toBe(await h.roomHash())
  })

  it(`a reaction waits for the room's contracts frame, then goes once it says ${REACTIONS_REV} (the reload's first socket)`, async () => {
    const h = room(REACTIONS_REV)
    const store = createMemoryOfflineStore()
    const a = h.client('alice', { offline: store })
    await flushMicro()
    h.settle()
    h.room.cut(a.transport)
    h.settle()
    reactAndEdit(a)
    h.settle()
    await flushMicro()
    closePage(a)
    await flushMicro()
    // the next page's first socket: its welcome's flush goes before the room's `contracts` frame
    const b = h.client('alice', { offline: store, tab: 'tab2' })
    const pushes: { ops: readonly Op[]; rev: string }[] = []
    let contracts = false
    b.core.on((e) => {
      if (e.kind === 'message' && e.message.type === 'contracts') contracts = true
      if (e.kind === 'push') pushes.push({ ops: e.record.ops, rev: contracts ? 'after' : 'before' })
    })
    await flushMicro()
    h.settle()
    await flushMicro()
    h.settle()
    const before = pushes.filter((p) => p.rev === 'before').flatMap((p) => p.ops)
    const after = pushes.filter((p) => p.rev === 'after').flatMap((p) => p.ops)
    expect(before.some((op) => op.k === 'p' && op.id === 'n1' && !!op.g?.style)).toBe(true)
    expect(before.some(carriesReaction), 'nothing of the reaction before the contracts frame').toBe(false)
    expect(after.filter(carriesReaction)).toHaveLength(1)
    expect(lobbyOf(h.room.elements.get('n1') as SceneElement)[REACT]).toBe(true)
    expect(b.core.saveStatus.state).toBe('saved')
    expect(await b.hash()).toBe(await h.roomHash())
  })

  it('a room that never says its revision: the held reaction is dropped once the wait is over, the rest went', async () => {
    const h = createHarness({ seed: seed() })
    // no contracts frame at all (a room before rev 10)
    h.room.contractsRev = null
    const a = h.client('alice')
    h.settle()
    reactAndEdit(a)
    h.settle()
    expect(ops(a).some(carriesReaction)).toBe(false)
    expect(h.room.elements.get('n1')?.backgroundColor).toBe('#ffc9c9')
    expect(REACT in lobbyOf(a.get('n1') as SceneElement)).toBe(false)
    expect(a.core.saveStatus.state).toBe('saved')
    expect(CONTRACTS_REV).toBeLessThan(REACTIONS_REV + 1)
  })
})

// The review of N1-7: the wait for the room's `contracts` frame starts once the welcome's snapshot is installed, not
// at the welcome. A big board's decode (and install) can take longer than CONTRACTS_WAIT_MS; a revision assumed from
// a wait armed at the welcome stripped a reaction queued offline before the frame behind the snapshot said 13.
describe('N1-7: the contracts wait starts at the welcome’s tail (a slow open)', () => {
  it(`the snapshot reaches the core ${CONTRACTS_WAIT_MS + 500} ms after its welcome: the queued reaction waits for the frame, then goes at ${REACTIONS_REV}`, async () => {
    const h = room(REACTIONS_REV)
    const store = createMemoryOfflineStore()
    const a = h.client('alice', { offline: store })
    await flushMicro()
    h.settle()
    h.room.cut(a.transport)
    h.settle()
    reactAndEdit(a)
    h.settle()
    await flushMicro()
    closePage(a)
    await flushMicro()
    // the next page's first socket: its reset welcome at once, the snapshot and every frame behind it (the socket's
    // in-order chain) only after a slow decode
    const b = h.client('alice', { offline: store, tab: 'tab2' })
    const session = (b.transport as unknown as { session: { deliver: ((m: ServerInbound) => void) | null } })
      .session
    const deliver = session.deliver as (m: ServerInbound) => void
    const held: ServerInbound[] = []
    let decoding = false
    session.deliver = (m) => {
      if (m.type === 'snapshot') decoding = true
      if (decoding) held.push(m)
      else deliver(m)
    }
    const refusals = watchRefusals(b)
    await flushMicro()
    h.settle()
    expect(held[0]?.type, 'the snapshot is still decoding').toBe('snapshot')
    expect(
      b.logs.some((l) => l.event === 'key_rev_assumed'),
      'no revision assumed while it decodes',
    ).toBe(false)
    h.clock.advance(CONTRACTS_WAIT_MS + 500)
    expect(b.logs.some((l) => l.event === 'key_rev_assumed')).toBe(false)
    // decoded: the snapshot, its catch-up and the room's contracts frame, in order
    decoding = false
    for (const m of held.splice(0)) deliver(m)
    await flushMicro()
    h.settle()
    await flushMicro()
    h.settle()
    expect(
      b.logs.some((l) => l.event === 'lobby_key_stripped'),
      'the reaction was never stripped',
    ).toBe(false)
    expect(lobbyOf(h.room.elements.get('n1') as SceneElement)[REACT]).toBe(true)
    expect(h.room.elements.get('n1')?.backgroundColor).toBe('#ffc9c9')
    expect(h.room.elements.get('t1')?.text).toBe('new words')
    expect(refusals.n).toBe(0)
    expect(b.core.saveStatus.state).toBe('saved')
    expect(await b.hash()).toBe(await h.roomHash())
  })

  it('a room that sends no contracts frame: the revision is assumed CONTRACTS_WAIT_MS after the tail, not before', async () => {
    const h = createHarness({ seed: seed() })
    h.room.contractsRev = null
    const a = h.client('alice')
    await flushMicro()
    // the welcome and its snapshot (a cold open) at once
    h.clock.advance(1)
    h.clock.advance(1)
    const tailAt = h.clock.now()
    expect(a.logs.some((l) => l.event === 'key_rev_assumed')).toBe(false)
    h.clock.advance(CONTRACTS_WAIT_MS - 10)
    expect(a.logs.some((l) => l.event === 'key_rev_assumed')).toBe(false)
    h.clock.advance(20)
    expect(a.logs.some((l) => l.event === 'key_rev_assumed')).toBe(true)
    expect(h.clock.now() - tailAt).toBeGreaterThanOrEqual(CONTRACTS_WAIT_MS)
  })
})
