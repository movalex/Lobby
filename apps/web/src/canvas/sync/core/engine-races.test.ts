import type { Op, PatchOp, ServerMessage } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import { UndoController } from '../../history/controller.ts'
import { bump } from '../headless/scene.ts'
import { note, rect, text } from '../testing/elements.ts'
import { stored } from '../testing/fakeRoom.ts'
import { createHarness, type TestClient } from '../testing/harness.ts'
import type { OfflineEntry } from '../types.ts'
import { createMemoryOfflineStore } from './offline-memory.ts'

// Spike B part 3 (O2): the races wave 2 and spike B's M3 pass found in the engine core, each pinned
// deterministically on the protocol fake with the manual clock.
//
// Excalidraw installs a write in its scene at once (`updateScene`, `mutateElement`), but reports it through
// `onChange` only after React commits. In the harness that is a write to `scene.map` with no
// `core.onSceneChange` yet; the late `onChange` comes when the test calls it.

const ops = (c: TestClient): Op[] => c.core.pushLog().flatMap((p) => [...p.ops])
const creates = (c: TestClient, id: string) => ops(c).filter((o) => o.k === 'c' && o.el.id === id)
const patchOf = (c: TestClient, id: string): PatchOp[] =>
  ops(c).filter((o): o is PatchOp => o.k === 'p' && o.id === id)
/** Excalidraw's onChange, late (after the React commit that follows the write). */
const lateOnChange = (c: TestClient) => c.core.onSceneChange(c.scene.read())
const savedStates = (c: TestClient) => {
  const out: string[] = []
  c.core.onSaveStatus((s) => out.push(s.state))
  return out
}

describe('engine core: a local write the core has not scanned yet is never lost (B7, B9, wave 2 burst)', () => {
  it('a create in the scene before its onChange survives a `changes` frame that lands first; pushed once, stored, Saved after its ack', async () => {
    const h = createHarness({ seed: [stored(rect('r1', 'a0'))] })
    const a = h.client('alice')
    const b = h.client('bob')
    h.settle()
    const states = savedStates(a)
    a.scene.map.set('r9', rect('r9', 'a5', { x: 10 })) // CanvasPort.transact: updateScene, no onChange yet
    // Saved is never shown while a local change is in the scene and not pushed
    expect(a.core.saveStatus.state).not.toBe('saved')
    b.change('r1', { x: 300 })
    h.settle() // B's push, the room's `changes` to A before A's onChange, then whatever A does
    expect(a.get('r9')?.x).toBe(10)
    lateOnChange(a)
    h.settle()
    expect(a.get('r9')?.x).toBe(10)
    expect(a.get('r1')?.x).toBe(300)
    expect(creates(a, 'r9')).toHaveLength(1)
    expect(h.room.elements.get('r9')?.x).toBe(10)
    expect(b.get('r9')?.x).toBe(10)
    expect(states.at(-1)).toBe('saved')
    expect(states.filter((s) => s === 'saved')).toHaveLength(1)
    expect(await a.hash()).toBe(await h.roomHash())
  })

  it('a create in the scene before its onChange survives the ack of an earlier push', async () => {
    const h = createHarness({ seed: [stored(rect('r1', 'a0'))] })
    const a = h.client('alice', { latencyMs: 100 })
    h.settle()
    a.change('r1', { x: 5 })
    h.clock.advance(60) // pushed at 50 ms; its changes and ack arrive at 150 ms
    a.scene.map.set('r9', rect('r9', 'a5', { x: 20 }))
    h.clock.advance(120) // the frames land before any onChange
    expect(a.get('r9')?.x).toBe(20)
    expect(a.core.saveStatus.state).not.toBe('saved')
    lateOnChange(a)
    h.settle()
    expect(creates(a, 'r9')).toHaveLength(1)
    expect(h.room.elements.get('r9')?.x).toBe(20)
    expect(h.room.elements.get('r1')?.x).toBe(5)
    expect(a.core.saveStatus.state).toBe('saved')
    expect(await a.hash()).toBe(await h.roomHash())
  })

  it('an edit installed as a new object (transact, undo) survives a remote apply before its onChange', async () => {
    const h = createHarness({ seed: [stored(rect('r1', 'a0')), stored(rect('r2', 'a1'))] })
    const a = h.client('alice')
    const b = h.client('bob')
    h.settle()
    a.scene.map.set('r1', bump(a.get('r1') as never, { x: 77 }))
    b.change('r2', { strokeColor: '#e03131' })
    h.settle()
    expect(a.get('r1')?.x).toBe(77)
    lateOnChange(a)
    h.settle()
    expect(h.room.elements.get('r1')?.x).toBe(77)
    expect(patchOf(a, 'r1').map((o) => o.g)).toEqual([{ pos: { x: 77, y: 0 } }])
    expect(await a.hash()).toBe(await h.roomHash())
    expect(await b.hash()).toBe(await h.roomHash())
  })

  it('an in-place edit (mutateElement) before its onChange is pushed, not silently marked as seen (B9: nothing pushed, Saved)', async () => {
    const h = createHarness({ seed: [stored(rect('r1', 'a0')), stored(rect('r2', 'a1'))] })
    const a = h.client('alice')
    const b = h.client('bob')
    h.settle()
    const el = a.get('r1') as unknown as Record<string, unknown>
    el.x = 55
    el.version = (el.version as number) + 1
    el.versionNonce = 424_242
    b.change('r2', { x: 400 })
    h.settle()
    lateOnChange(a)
    h.settle()
    expect(h.room.elements.get('r1')?.x).toBe(55)
    expect(b.get('r1')?.x).toBe(55)
    expect(a.core.saveStatus.state).toBe('saved')
    expect(await a.hash()).toBe(await h.roomHash())
  })

  it('a create made offline and not scanned yet survives the reconnect welcome, and is pushed', async () => {
    const h = createHarness({ seed: [stored(rect('r1', 'a0'))] })
    const a = h.client('alice')
    h.settle()
    h.room.cut(a.transport)
    h.settle()
    a.scene.map.set('r9', rect('r9', 'a5', { x: 30 }))
    ;(a.transport as unknown as { reopen(): void }).reopen()
    h.settle()
    expect(a.get('r9')?.x).toBe(30)
    lateOnChange(a)
    h.settle()
    expect(h.room.elements.get('r9')?.x).toBe(30)
    expect(a.core.saveStatus.state).toBe('saved')
    expect(await a.hash()).toBe(await h.roomHash())
  })

  it('a burst of creates, each answered by a remote frame before its onChange: none is lost (the M3 probe, 40 of them)', async () => {
    const h = createHarness({ seed: [stored(rect('r1', 'a0'))] })
    const a = h.client('alice', { latencyMs: 30 })
    const b = h.client('bob', { latencyMs: 10 })
    h.settle()
    const ids: string[] = []
    for (let i = 0; i < 40; i++) {
      const id = `c${i}`
      ids.push(id)
      a.scene.map.set(id, rect(id, `a${(10 + i).toString(36)}`, { x: i * 10 }))
      b.change('r1', { x: i })
      h.clock.advance(20) // B's frame lands; A's onChange for this create only comes afterwards
      lateOnChange(a)
      h.clock.advance(7)
    }
    h.settle()
    for (const id of ids) expect(h.room.elements.get(id), id).toBeDefined()
    expect(a.core.saveStatus.state).toBe('saved')
    expect(await a.hash()).toBe(await h.roomHash())
  })
})

describe('engine core: a remote change held back by a gesture is not pushed back at its end (wave 2 drag-recolour)', () => {
  it("B recolours X while A drags it: A's pointer-up pushes her move only; B's colour is kept everywhere", async () => {
    const h = createHarness({ seed: [stored(rect('X', 'a0', { strokeColor: '#1e1e1e' }))] })
    const a = h.client('alice')
    const b = h.client('bob')
    h.settle()
    const drag = { dragging: true, selectedElementIds: ['X'] }
    a.change('X', { x: 40 }, drag)
    b.change('X', { strokeColor: '#e03131' })
    h.settle()
    // held back while A drags (§2.5.4)
    expect(a.get('X')?.strokeColor).toBe('#1e1e1e')
    a.change('X', { x: 120 }, drag)
    h.settle()
    a.gesture() // pointer-up
    h.settle()
    expect(patchOf(a, 'X').map((o) => Object.keys(o.g ?? {}))).toEqual([['pos']])
    expect(h.room.elements.get('X')?.strokeColor).toBe('#e03131')
    expect(h.room.elements.get('X')?.x).toBe(120)
    for (const c of [a, b]) {
      expect(c.get('X')?.strokeColor).toBe('#e03131')
      expect(c.get('X')?.x).toBe(120)
      expect(await c.hash()).toBe(await h.roomHash())
    }
  })

  it("...and A's undo of the drag moves X back and keeps B's colour (collab-conflicts, wave 2)", async () => {
    const h = createHarness({ seed: [stored(rect('X', 'a0', { strokeColor: '#1e1e1e' }))] })
    const a = h.client('alice')
    const b = h.client('bob')
    h.settle()
    const undo = new UndoController({ core: a.core, scene: a.scene, bump })
    const drag = { dragging: true, selectedElementIds: ['X'] }
    a.change('X', { x: 40 }, drag)
    b.change('X', { strokeColor: '#e03131' })
    h.settle()
    a.change('X', { x: 120 }, drag)
    a.gesture()
    undo.boundary() // the page's step boundary after the gesture's last scan
    h.settle()
    expect(undo.undo()?.kept).toBe(0)
    h.settle()
    for (const c of [a, b]) {
      expect(c.get('X')?.x).toBe(0)
      expect(c.get('X')?.strokeColor).toBe('#e03131')
    }
    expect(h.room.elements.get('X')?.strokeColor).toBe('#e03131')
    expect(await a.hash()).toBe(await h.roomHash())
  })

  it('B resizes X while A drags it: both kept (the size is not A’s to push back)', async () => {
    const h = createHarness({ seed: [stored(rect('X', 'a0'))] })
    const a = h.client('alice')
    const b = h.client('bob')
    h.settle()
    const drag = { dragging: true, selectedElementIds: ['X'] }
    a.change('X', { x: 40 }, drag)
    b.change('X', { width: 300, height: 50 })
    h.settle()
    a.change('X', { x: 90 }, drag)
    a.gesture()
    h.settle()
    expect(h.room.elements.get('X')).toMatchObject({ x: 90, width: 300, height: 50 })
    expect(a.get('X')).toMatchObject({ x: 90, width: 300, height: 50 })
    expect(await a.hash()).toBe(await h.roomHash())
  })

  it('B moves X while A drags it: A’s drag (the later write) wins, as before', async () => {
    const h = createHarness({ seed: [stored(rect('X', 'a0'))] })
    const a = h.client('alice')
    const b = h.client('bob')
    h.settle()
    const drag = { dragging: true, selectedElementIds: ['X'] }
    a.change('X', { x: 40 }, drag)
    b.change('X', { x: 500, y: 500 })
    h.settle()
    a.change('X', { x: 90, y: 7 }, drag)
    a.gesture()
    h.settle()
    expect(h.room.elements.get('X')).toMatchObject({ x: 90, y: 7 })
    expect(b.get('X')).toMatchObject({ x: 90, y: 7 })
    expect(await a.hash()).toBe(await h.roomHash())
  })
})

describe('engine core: the offline queue is written as soon as a change is known (wave 2: offline-9)', () => {
  it('an edit made offline is in the store before any timer runs (a reload at once finds it)', async () => {
    const store = createMemoryOfflineStore()
    const h = createHarness({ seed: [stored(rect('r1', 'a0'))] })
    const a = h.client('alice', { offline: store })
    h.settle()
    h.room.cut(a.transport)
    h.settle()
    await Promise.resolve()
    a.change('r1', { x: 91 })
    // no clock advance: the store already holds it (the reload comes before any 100 ms timer)
    await Promise.resolve()
    expect(store.entries().map((e) => [e.element.id, (e.element as { x?: number }).x])).toEqual([['r1', 91]])
    a.change('r1', { x: 92 })
    await Promise.resolve()
    expect(store.entries().map((e) => (e.element as { x?: number }).x)).toEqual([92])
    // a reloaded page (a new core on the same store) replays it
    const h2 = createHarness({ seed: [stored(rect('r1', 'a0'))] })
    const a2 = h2.client('alice', { offline: createMemoryOfflineStore(store.entries() as OfflineEntry[]) })
    await Promise.resolve()
    h2.settle()
    await Promise.resolve()
    h2.settle()
    expect(h2.room.elements.get('r1')?.x).toBe(92)
    expect(a2.core.saveStatus.state).toBe('saved')
  })

  it('a create not scanned yet is queued by persistNow (on pagehide), before its onChange', async () => {
    const store = createMemoryOfflineStore()
    const h = createHarness({ seed: [stored(rect('r1', 'a0'))] })
    const a = h.client('alice', { offline: store })
    h.settle()
    h.room.cut(a.transport)
    h.settle()
    a.scene.map.set('r9', rect('r9', 'a5', { x: 3 })) // installed, no onChange yet: the page hides now
    a.core.persistNow()
    await Promise.resolve()
    expect(store.entries().map((e) => e.element.id)).toEqual(['r9'])
    expect(store.entries()[0]?.groups).toContain('create')
  })
})

describe('engine core: an offline queue loaded after the welcome is installed and pushed (D7)', () => {
  it('the queue a reloaded page loads after its welcome (a Web Lock wait) is in the scene, pushed, and survives a scan', async () => {
    const store = createMemoryOfflineStore()
    const h = createHarness({ seed: [stored(rect('r1', 'a0'))] })
    const a = h.client('alice', { offline: store })
    h.settle()
    await Promise.resolve()
    a.change('r1', { x: 91 })
    a.edit((m) => m.set('c1', rect('c1', 'a5', { x: 5 })))
    await Promise.resolve()
    const entries = store.entries() as OfflineEntry[]
    expect(entries.map((e) => e.element.id)).toEqual(['r1', 'c1'])
    // the reloaded page: its queue loads only after the welcome (the old page still held the tab's lock)
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const late = {
      load: async () => {
        await gate
        return structuredClone(entries)
      },
      save: async () => {},
      clear: async () => {},
    }
    const h2 = createHarness({ seed: [stored(rect('r1', 'a0'))] })
    const a2 = h2.client('alice', { latencyMs: 200, offline: late })
    h2.settle()
    expect(a2.core.welcome).not.toBeNull()
    release()
    for (let i = 0; i < 5; i++) await Promise.resolve()
    // installed in the scene at once, not only in the core's view
    expect(a2.get('r1')?.x).toBe(91)
    expect(a2.get('c1')?.x).toBe(5)
    lateOnChange(a2) // Excalidraw's onChange before the push's ack: nothing is undone
    h2.settle()
    expect(h2.room.elements.get('r1')?.x).toBe(91)
    expect(h2.room.elements.get('c1')?.x).toBe(5)
    expect(a2.core.saveStatus.state).toBe('saved')
    expect(await a2.hash()).toBe(await h2.roomHash())
  })
})

describe('engine core: a stale reset snapshot does not drop queued edits (D7, the room caches its snapshot 5 s)', () => {
  it('an edit of an element created after the cached snapshot waits for the catch-up behind it, then is pushed', async () => {
    const h = createHarness({ seed: [stored(rect('r1', 'a0'))] })
    h.room.snapshotCacheMs = 5000
    const store = createMemoryOfflineStore()
    const a = h.client('alice', { offline: store }) // its reset welcome caches the snapshot (no r9)
    h.settle()
    await Promise.resolve()
    a.edit((m) => m.set('r9', rect('r9', 'a5', { x: 10 })))
    h.settle() // r9 created and acked
    await Promise.resolve()
    a.change('r9', { x: 77 }) // then the reload, before any push
    await Promise.resolve()
    expect(store.entries().map((e) => [e.element.id, e.groups])).toEqual([['r9', ['pos']]])
    // the reloaded page: the room serves its cached snapshot (without r9), then r9 as `changes`
    const a2 = h.client('alice', {
      tab: 'tab1',
      offline: createMemoryOfflineStore(store.entries() as OfflineEntry[]),
    })
    await Promise.resolve()
    h.settle()
    await Promise.resolve()
    h.settle()
    expect(a2.logs.map((l) => l.event)).toContain('catch_up_settled')
    expect(h.room.elements.get('r9')?.x).toBe(77)
    expect(a2.get('r9')?.x).toBe(77)
    expect(a2.core.saveStatus.state).toBe('saved')
    expect(await a2.hash()).toBe(await h.roomHash())
  })

  it('a queued edit of an element the server does not have is dropped once no catch-up brings it; Saved only then', async () => {
    const h = createHarness({ seed: [stored(rect('r1', 'a0'))] })
    const ghost = {
      element: { ...rect('ghost', 'a5', { x: 3 }), version: 4 },
      groups: ['pos'],
      base: 99,
      queuedAt: 1,
    }
    const a = h.client('alice', { offline: createMemoryOfflineStore([ghost as never]) })
    await Promise.resolve()
    h.clock.advance(10)
    await Promise.resolve()
    h.clock.advance(10)
    expect(a.core.saveStatus.state).toBe('saving') // waiting: nothing claims Saved
    h.clock.advance(3500)
    expect(a.logs.map((l) => l.event)).toContain('catch_up_gone')
    expect(a.get('ghost')).toBeUndefined()
    expect(a.core.saveStatus.state).toBe('saved')
    expect(a.core.pushLog()).toHaveLength(0)
  })
})

describe("engine core: a server message is applied before it is reported (2C's request)", () => {
  it('roster, lease table and doc are up to date when the message event fires', () => {
    const h = createHarness({
      seed: [
        stored(note('n1', 'a0', { boundElements: [{ id: 'n1.t', type: 'text' }] })),
        stored(text('n1.t', 'a1', { containerId: 'n1' })),
      ],
    })
    const a = h.client('alice')
    h.settle()
    const seen: string[] = []
    a.core.on((e) => {
      if (e.kind !== 'message') return
      const m = e.message as ServerMessage
      if (m.type === 'roster') seen.push(`roster ${a.core.roster().has('bob:tab1')}`)
      if (m.type === 'lease') seen.push(`lease ${a.core.leaseHolders().get('n1')?.sid ?? null}`)
      if (m.type === 'changes' && m.doc)
        seen.push(`doc ${String(a.core.doc().get('startView') !== undefined)}`)
      if (m.type === 'changes' && m.ops.length)
        seen.push(`changes ${(a.core.confirmed('n1') as { x?: number } | undefined)?.x}`)
    })
    const b = h.client('bob')
    h.settle()
    // the room's roster event for bob (the protocol fake sends none of its own)
    a.transport.session.deliver?.({
      type: 'roster',
      events: [
        {
          k: 'join',
          p: { sid: 'bob:tab1', uid: 'bob', name: 'bob', color: '#000', role: 'editor', guest: false },
        },
      ],
    })
    b.core.leaseConnect(() => {}).send({ type: 'lease.acquire', req: 1, id: 'n1' })
    h.settle()
    b.change('n1', { x: 12 })
    h.settle()
    b.core.setDoc({ startView: { x: 0, y: 0, zoom: 1 } })
    h.settle()
    expect(seen).toEqual(['roster true', 'lease bob:tab1', 'changes 12', 'doc true'])
  })
})
