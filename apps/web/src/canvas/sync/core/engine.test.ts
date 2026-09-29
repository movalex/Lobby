import type { Op, PatchOp } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import { bump } from '../headless/scene.ts'
import { arrow, binding, note, rect, text } from '../testing/elements.ts'
import { stored } from '../testing/fakeRoom.ts'
import { createHarness, type TestClient } from '../testing/harness.ts'

// The engine core against the protocol fake (docs/EXCALIDRAW-MIGRATION.md §2.5, §6.1). Every frame goes
// through the manual clock, so each test decides the order.

const ops = (c: TestClient): Op[] => c.core.pushLog().flatMap((p) => [...p.ops])
const patchOf = (c: TestClient, id: string): PatchOp[] =>
  ops(c).filter((o): o is PatchOp => o.k === 'p' && o.id === id)

describe('engine core: welcome, pushes, acks, Saved (§2.5)', () => {
  it('a joiner applies the reset snapshot and pushes nothing (receiving-only, E-rules)', async () => {
    const h = createHarness({ seed: [stored(rect('r1', 'a0')), stored(note('n1', 'a1'))] })
    const a = h.client('alice')
    h.settle()
    expect(a.core.welcome?.sid).toBe('alice:tab1')
    expect([...a.scene.map.keys()].sort()).toEqual(['n1', 'r1'])
    expect(a.core.pushLog()).toHaveLength(0)
    expect(a.core.saveStatus.state).toBe('saved')
    expect(await a.hash()).toBe(await h.roomHash())
  })

  it('a move pushes the pos group only, once; Saved only after the ack; then the scene holds the server copy', async () => {
    const h = createHarness({ seed: [stored(rect('r1', 'a0'))] })
    const a = h.client('alice', { latencyMs: 100 })
    const b = h.client('bob')
    h.settle()
    const states: string[] = []
    a.core.onSaveStatus((s) => states.push(s.state))
    a.change('r1', { x: 40, y: 30 })
    expect(a.core.saveStatus.state).toBe('saving')
    h.clock.advance(60) // the 50 ms coalescing window
    expect(ops(a)).toHaveLength(1)
    const op = ops(a)[0] as PatchOp
    expect(op.g).toEqual({ pos: { x: 40, y: 30 } })
    expect(a.core.saveStatus.state).toBe('saving') // sent, no ack yet
    h.settle()
    expect(states.at(-1)).toBe('saved')
    expect(states.indexOf('saved')).toBe(states.length - 1)
    expect(b.get('r1')?.x).toBe(40)
    expect(b.core.pushLog()).toHaveLength(0)
    expect(await a.hash()).toBe(await h.roomHash())
    expect(await b.hash()).toBe(await h.roomHash())
    const inScene = a.get('r1')
    expect(inScene?.version).toBe(h.room.elements.get('r1')?.version)
    expect(inScene?.versionNonce).toBe(h.room.elements.get('r1')?.versionNonce)
  })

  it('two edits within 50 ms are one push; a gesture pushes once at its end', () => {
    const h = createHarness({ seed: [stored(rect('r1', 'a0')), stored(rect('r2', 'a1'))] })
    const a = h.client('alice')
    h.settle()
    a.change('r1', { strokeColor: '#ff0000' })
    h.clock.advance(20)
    a.change('r2', { strokeColor: '#00ff00' })
    h.clock.advance(60)
    expect(a.core.pushLog()).toHaveLength(1)
    expect(a.core.pushLog()[0]?.ops).toHaveLength(2)
    h.settle()
    // a drag: nothing while it runs, one push at pointer-up
    const drag = { dragging: true, selectedElementIds: ['r1'] }
    for (let i = 1; i <= 5; i++) {
      a.change('r1', { x: i * 10 }, drag)
      h.clock.advance(100)
    }
    expect(a.core.pushLog()).toHaveLength(1)
    a.gesture()
    h.clock.advance(1)
    expect(a.core.pushLog()).toHaveLength(2)
    expect((a.core.pushLog()[1]?.ops[0] as PatchOp | undefined)?.g).toEqual({ pos: { x: 50, y: 0 } })
  })

  it('a remote change to another group is applied and never pushed back; the local dirty group survives', async () => {
    const h = createHarness({ seed: [stored(rect('r1', 'a0'))] })
    const a = h.client('alice')
    const b = h.client('bob')
    h.settle()
    a.change('r1', { strokeColor: '#ff0000' }) // A recolours (dirty, not sent yet)
    b.change('r1', { x: 300 }) // B moves
    h.clock.advance(60)
    h.settle()
    expect(a.get('r1')?.x).toBe(300)
    expect(a.get('r1')?.strokeColor).toBe('#ff0000')
    expect(b.get('r1')?.strokeColor).toBe('#ff0000')
    // A pushed only its colour, B only its move
    expect(patchOf(a, 'r1').map((o) => Object.keys(o.g ?? {}))).toEqual([['style']])
    expect(patchOf(b, 'r1').map((o) => Object.keys(o.g ?? {}))).toEqual([['pos']])
    expect(await a.hash()).toBe(await h.roomHash())
    expect(await b.hash()).toBe(await h.roomHash())
  })

  it('same group, concurrent: the later commit wins everywhere, nobody re-pushes', async () => {
    const h = createHarness({ seed: [stored(rect('r1', 'a0'))] })
    const a = h.client('alice', { latencyMs: 20 })
    const b = h.client('bob', { latencyMs: 60 })
    h.settle()
    a.change('r1', { x: 111 })
    b.change('r1', { x: 222 })
    h.clock.advance(55)
    h.settle()
    const x = h.room.elements.get('r1')?.x
    expect(a.get('r1')?.x).toBe(x)
    expect(b.get('r1')?.x).toBe(x)
    expect(a.core.pushLog()).toHaveLength(1)
    expect(b.core.pushLog()).toHaveLength(1)
    expect(await a.hash()).toBe(await h.roomHash())
  })

  it('a value in flight is not sent again when another group changes before the ack', () => {
    const h = createHarness({ seed: [stored(rect('r1', 'a0'))] })
    const a = h.client('alice', { latencyMs: 300 })
    h.settle()
    a.change('r1', { strokeColor: '#ff0000' })
    h.clock.advance(60) // push 1 out, no ack for 300 ms
    a.change('r1', { x: 5 })
    h.clock.advance(60) // push 2
    const second = a.core.pushLog()[1]?.ops[0] as PatchOp
    expect(Object.keys(second.g ?? {})).toEqual(['pos'])
    h.settle()
    expect(a.core.saveStatus.state).toBe('saved')
  })

  it('a create is sent whole once; its ack makes it a server element (version from the server)', async () => {
    const h = createHarness()
    const a = h.client('alice')
    const b = h.client('bob')
    h.settle()
    a.edit((m) => m.set('r9', rect('r9', 'a5', { x: 10 })))
    h.clock.advance(60)
    expect(ops(a)).toEqual([expect.objectContaining({ k: 'c' })])
    h.settle()
    expect(b.get('r9')?.x).toBe(10)
    expect(a.get('r9')?.version).toBe(h.room.elements.get('r9')?.version)
    expect(await a.hash()).toBe(await h.roomHash())
    // a later patch builds on the server version
    a.change('r9', { y: 7 })
    h.settle()
    expect(patchOf(a, 'r9')[0]?.pv).toBe(2)
  })

  it('a no-op version bump (a keyup re-bind, a font load) is reset to the server copy and never pushed', async () => {
    const h = createHarness({ seed: [stored(rect('r1', 'a0'))] })
    const a = h.client('alice')
    h.settle()
    a.edit((m) => m.set('r1', bump(m.get('r1') as never)))
    h.settle()
    expect(a.core.pushLog()).toHaveLength(0)
    expect(a.get('r1')?.version).toBe(h.room.elements.get('r1')?.version)
    expect(await a.hash()).toBe(await h.roomHash())
  })

  it('status and a local file suffix are local-only (E1, E9)', () => {
    const img = stored({
      ...rect('i1', 'a0'),
      type: 'image',
      fileId: 'ver_0123456789abcdef',
      status: 'saved',
      scale: [1, 1],
      crop: null,
    })
    const h = createHarness({ seed: [img] })
    const a = h.client('alice')
    h.settle()
    a.change('i1', { status: 'error' })
    a.change('i1', { fileId: 'ver_0123456789abcdef@thumb' })
    h.settle()
    expect(a.core.pushLog()).toHaveLength(0)
  })

  it('a vanished never-pushed id is dropped; a vanished confirmed id comes back (§2.5.2)', () => {
    const h = createHarness({ seed: [stored(rect('r1', 'a0'))] })
    const a = h.client('alice')
    h.settle()
    a.gesture({ newElementId: 'fd1' })
    a.edit((m) => m.set('fd1', rect('fd1', 'a1')), { newElementId: 'fd1' })
    a.edit((m) => m.delete('fd1')) // a short touch stroke: Excalidraw drops it from the array
    a.edit((m) => m.delete('r1')) // a confirmed element vanishing is not a delete
    h.settle()
    expect(a.core.pushLog()).toHaveLength(0)
    expect(a.scene.map.has('r1')).toBe(true)
    expect(a.scene.map.has('fd1')).toBe(false)
  })

  it('an index collision with a confirmed element re-keys only the own unacknowledged element (E2)', () => {
    const h = createHarness({ seed: [stored(rect('r1', 'a0'))] })
    const a = h.client('alice', { latencyMs: 400 })
    const b = h.client('bob')
    h.settle()
    // both create at the top of the order with the same key; B's lands first
    a.edit((m) => m.set('ra', rect('ra', 'a1')))
    b.edit((m) => m.set('rb', rect('rb', 'a1')))
    h.clock.advance(60)
    h.clock.advance(200) // B's create is committed and reaches A; A's is still in flight
    const rbStored = h.room.elements.get('rb')
    expect(a.get('rb')?.index).toBe('a1')
    expect(a.get('rb')?.version).toBe(rbStored?.version) // the confirmed element is untouched
    expect(a.get('ra')?.index).not.toBe('a1') // A's own unacknowledged element was re-keyed locally
    expect(a.logs.filter((l) => l.event === 'echo_suspect')).toEqual([])
    h.settle()
    expect(ops(a).filter((o) => (o.k === 'p' ? o.id : o.el.id) === 'rb')).toEqual([])
  })
})

describe('engine core: derived arrow changes (§2.5.2, E10, §2.9.4 rule 7)', () => {
  const seed = () => [
    stored(
      rect('x', 'a0', { x: 0, y: 0, width: 100, height: 100, boundElements: [{ id: 'ar', type: 'arrow' }] }),
    ),
    stored(
      arrow('ar', 'a1', {
        x: 100,
        y: 50,
        points: [
          [0, 0],
          [200, 0],
        ],
        startBinding: binding('x', [1, 0.5]),
      }),
    ),
  ]

  it("B's resize of the target: the local follow of the start-bound arrow is derived, never pushed", async () => {
    const h = createHarness({ seed: seed() })
    const b = h.client('bob')
    h.settle()
    const resize = { resizing: true, resizingElementId: 'x', selectedElementIds: ['x'] }
    b.edit((m) => {
      m.set('x', bump(m.get('x') as never, { width: 140 }))
      // Excalidraw's updateBoundElements: the bound start moves, the free end stays
      m.set(
        'ar',
        bump(m.get('ar') as never, {
          x: 140,
          points: [
            [0, 0],
            [160, 0],
          ],
          width: 160,
        }),
      )
    }, resize)
    expect(b.core.isDerivedHeld('ar')).toBe(true)
    b.gesture()
    h.clock.advance(1)
    const pushed = ops(b).map((o) => (o.k === 'p' ? o.id : o.el.id))
    expect(pushed).toEqual(['x'])
    // the fake does not re-snap; the server's re-snap arrives as its own write
    h.settle()
    h.room.serverWrite('ar', {
      x: 140,
      points: [
        [0, 0],
        [160, 0],
      ],
      width: 160,
    })
    h.settle()
    expect(b.core.isDerivedHeld('ar')).toBe(false)
    expect(await b.hash()).toBe(await h.roomHash())
  })

  it('a derived change with nothing of this client behind it is reset in the scan that finds it', () => {
    const h = createHarness({ seed: seed() })
    const b = h.client('bob')
    h.settle()
    const before = b.get('ar')
    // e.g. the holder's editor re-running updateBoundElements after a remote change that needs no re-fit
    b.edit((m) =>
      m.set(
        'ar',
        bump(m.get('ar') as never, {
          x: 100.2,
          points: [
            [0, 0],
            [199.8, 0],
          ],
          width: 199.8,
        }),
      ),
    )
    expect(b.core.isDerivedHeld('ar')).toBe(false)
    expect(b.get('ar')?.x).toBe(before?.x)
    expect(b.get('ar')?.version).toBe(before?.version)
    h.settle()
    expect(b.core.pushLog()).toHaveLength(0)
  })

  it("the user's own free-end drag is pushed as the whole path unit", () => {
    const h = createHarness({ seed: seed() })
    const c = h.client('carol')
    h.settle()
    c.change(
      'ar',
      {
        points: [
          [0, 0],
          [205, 50],
        ],
        width: 205,
        height: 50,
      },
      { editingLinear: true, selectedLinearElementId: 'ar' },
    )
    c.gesture()
    h.clock.advance(1)
    const op = patchOf(c, 'ar')[0] as PatchOp
    expect(Object.keys(op.g ?? {})).toEqual(['path'])
    expect(Object.keys(op.g?.path ?? {}).sort()).toEqual(
      ['angle', 'elbowed', 'height', 'points', 'width', 'x', 'y'].sort(),
    )
  })

  it("a dirty, unpushed change to the target keeps the arrow's derived change held (typing between pushes)", () => {
    const h = createHarness({ seed: seed() })
    const b = h.client('bob', { latencyMs: 100 })
    h.settle()
    b.edit((m) => {
      m.set('x', bump(m.get('x') as never, { height: 140 }))
      // the follow: the bound start moves down 20, the free end stays at (300, 50)
      m.set(
        'ar',
        bump(m.get('ar') as never, {
          y: 70,
          points: [
            [0, 0],
            [200, -20],
          ],
          height: 20,
        }),
      )
    })
    expect(b.core.isDerivedHeld('ar')).toBe(true) // x is dirty: held, not reset
    h.clock.advance(60) // x pushed, in flight
    expect(b.core.isDerivedHeld('ar')).toBe(true)
    h.settle() // ack of x: nothing pending any more, and the fake did not re-snap: reset
    expect(b.core.isDerivedHeld('ar')).toBe(false)
    expect(b.get('ar')?.y).toBe(50)
    expect(ops(b).map((o) => (o.k === 'p' ? o.id : o.el.id))).toEqual(['x'])
  })
})

describe('engine core: the text lease gate (§2.9.2, §2.9.4)', () => {
  const seedNote = () => [
    stored(note('n1', 'a0', { boundElements: [{ id: 'n1.t', type: 'text' }] })),
    stored(
      text('n1.t', 'a1', { containerId: 'n1', x: 20, y: 80, textAlign: 'center', verticalAlign: 'middle' }),
    ),
  ]

  it('typing waits for the grant (0 ops before it), then goes out as text + layout; the container fit as `fit`', () => {
    const h = createHarness({ seed: seedNote() })
    const a = h.client('alice', { latencyMs: 100 })
    h.settle()
    const lease: { messages: unknown[] } = { messages: [] }
    const t = a.core.leaseConnect((m) => lease.messages.push(m))
    t.send({ type: 'lease.acquire', req: 1, id: 'n1' })
    const editing = { editingTextElementId: 'n1.t' }
    a.change('n1.t', { originalText: 'memo!', text: 'memo!', width: 66 }, editing)
    a.change('n1', { height: 240 }, editing)
    h.clock.advance(40) // the acquire is still out
    expect(ops(a)).toHaveLength(0)
    h.settle()
    expect(lease.messages[0]).toEqual({ type: 'lease.grant', req: 1, id: 'n1', ttlMs: 10_000 })
    const label = patchOf(a, 'n1.t')[0] as PatchOp
    expect(Object.keys(label.g ?? {}).sort()).toEqual(['layout', 'text'])
    const container = patchOf(a, 'n1')[0] as PatchOp
    expect(container.fit).toEqual({ height: 240 })
    expect(container.g).toBeUndefined()
    expect(h.room.elements.get('n1')?.height).toBe(240)
  })

  it('a deny resets the local text, layout and fit from the server copy, pushing nothing', async () => {
    const h = createHarness({ seed: seedNote() })
    const a = h.client('alice')
    const b = h.client('bob')
    h.settle()
    b.core.leaseConnect(() => {}).send({ type: 'lease.acquire', req: 1, id: 'n1' })
    h.settle()
    const t = a.core.leaseConnect(() => {})
    t.send({ type: 'lease.acquire', req: 7, id: 'n1' })
    const editing = { editingTextElementId: 'n1.t' }
    a.change('n1.t', { originalText: 'stale copy', text: 'stale copy' }, editing)
    h.settle()
    a.gesture()
    h.settle()
    expect(a.core.pushLog()).toHaveLength(0)
    expect(a.get('n1.t')?.originalText).toBe('memo')
    expect(await a.hash()).toBe(await h.roomHash())
  })

  it("the release goes out after the editor's final push (the session's FIFO)", () => {
    const h = createHarness({ seed: seedNote() })
    const a = h.client('alice')
    h.settle()
    const t = a.core.leaseConnect(() => {})
    t.send({ type: 'lease.acquire', req: 1, id: 'n1' })
    h.settle()
    a.change('n1.t', { originalText: 'final', text: 'final' }, { editingTextElementId: 'n1.t' })
    a.gesture() // the editor closed
    t.send({ type: 'lease.release', id: 'n1' })
    h.settle()
    const sent = a.transport.session.received.map((m) => m.type)
    expect(sent.slice(-2)).toEqual(['push', 'lease.release'])
    expect(h.room.elements.get('n1.t')?.originalText).toBe('final')
    expect(h.room.leases.has('n1')).toBe(false)
  })
})

describe('engine core: rejects, retries, offline (§2.4.2, §2.5.6)', () => {
  it('UNAVAILABLE is retried until it lands; Saved only after success (D4)', () => {
    const h = createHarness({ seed: [stored(rect('r1', 'a0'))] })
    const a = h.client('alice')
    h.settle()
    h.room.failNext = 2
    const states: string[] = []
    a.core.onSaveStatus((s) => states.push(s.state))
    a.change('r1', { x: 9 })
    h.settle()
    expect(h.room.elements.get('r1')?.x).toBe(9)
    expect(a.core.pushLog().length).toBe(3)
    expect(states.filter((s) => s === 'saved')).toHaveLength(1)
    expect(states.at(-1)).toBe('saved')
  })

  it('edits made offline show Offline, replay with `off` after the reconnect, then Saved (D2, D5)', async () => {
    const h = createHarness({ seed: [stored(rect('r1', 'a0'))] })
    const a = h.client('alice')
    h.settle()
    h.room.cut(a.transport)
    h.settle()
    a.change('r1', { x: 77 })
    h.clock.advance(5_000)
    expect(a.core.saveStatus.state).toBe('offline')
    expect(a.core.saveStatus.offlineChanges).toBe(1)
    expect(a.core.pushLog()).toHaveLength(0)
    ;(a.transport as unknown as { reopen(): void }).reopen()
    h.settle()
    const op = patchOf(a, 'r1')[0] as PatchOp
    expect(op.off).toBeGreaterThanOrEqual(5_000)
    expect(h.room.elements.get('r1')?.x).toBe(77)
    expect(a.core.saveStatus.state).toBe('saved')
    expect(await a.hash()).toBe(await h.roomHash())
  })
})

describe('engine core: an editor opened without a grant (§2.9.2 guard step 3)', () => {
  const seedNote = () => [
    stored(note('n1', 'a0', { boundElements: [{ id: 'n1.t', type: 'text' }] })),
    stored(text('n1.t', 'a1', { containerId: 'n1', x: 20, y: 80 })),
  ]

  it('the open-time re-measure of a guard-caught editor is never pushed, and goes back when it closes ungranted', async () => {
    const h = createHarness({ seed: seedNote() })
    const a = h.client('alice')
    h.settle()
    // Excalidraw opened the editor (P5) and re-measured the label before Lobby's acquire went out
    a.change('n1.t', { x: 21.5, width: 61 }, { editingTextElementId: 'n1.t' })
    h.clock.advance(1000)
    expect(a.core.pushLog()).toHaveLength(0)
    // the guard closed it (another request was in flight): no grant ever came
    a.gesture()
    h.settle()
    expect(a.core.pushLog()).toHaveLength(0)
    expect(a.get('n1.t')?.x).toBe(20)
    expect(await a.hash()).toBe(await h.roomHash())
  })

  it('the same change is pushed once the guard gets the grant', () => {
    const h = createHarness({ seed: seedNote() })
    const a = h.client('alice', { latencyMs: 100 })
    h.settle()
    const editing = { editingTextElementId: 'n1.t' }
    a.change('n1.t', { x: 21.5, width: 61 }, editing)
    a.core.leaseConnect(() => {}).send({ type: 'lease.acquire', req: 1, id: 'n1' })
    h.clock.advance(30)
    expect(a.core.pushLog()).toHaveLength(0)
    h.settle()
    expect(patchOf(a, 'n1.t').map((o) => Object.keys(o.g ?? {}))).toEqual([['layout']])
  })
})
