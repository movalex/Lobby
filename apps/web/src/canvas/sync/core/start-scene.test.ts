/**
 * DEF-GAPS-1 (the gap pass, wave C; fixed in wave D, D2): after an archive the owner's open tab said "Change
 * not saved: you can only view this board" with nothing changed, and a fresh open of an archived board did
 * the same in most opens.
 *
 * Root cause (the frames of both tabs, recorded in a browser against e2e gaps-board-status's flow): a ticket
 * with another role makes the board page start a NEW session, a new engine core, on the SAME Excalidraw
 * instance, whose scene still holds the previous core's copies. The new core's first scan (the welcome's own
 * `syncLive`) took each of them for a local create. Behind a reset snapshot from the room's 5 s cache, older
 * than them (their rows follow as the catch-up `changes`), the first flush pushed creates of the server's own
 * elements at base 0: a read-only room refused them READ_ONLY. On a writable board the same remount pushed
 * creates the room answered `create_exists`; behind a fresh snapshot, a copy older than the server's (another
 * user wrote while the page was between its sessions) went back as a patch over that later write. Here a
 * second core starts on the first one's scene, as the page does.
 */
import { hashElements } from '@draftroom/canvas-schema/hash'
import { describe, expect, it } from 'vitest'
import { bump } from '../headless/scene.ts'
import { openFromCache, recordOf } from '../testing/cached.ts'
import { rect } from '../testing/elements.ts'
import { stored } from '../testing/fakeRoom.ts'
import { createHarness, type Harness, type TestClient } from '../testing/harness.ts'
import type { OfflineQueueStore } from '../types.ts'
import { type CoreEvent, LobbyEngineCore } from './engine.ts'
import { createMemoryOfflineStore } from './offline-memory.ts'

const flushMicro = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

interface Started {
  readonly core: LobbyEngineCore
  readonly transport: ReturnType<Harness['room']['connect']>
  readonly events: CoreEvent[]
  readonly logs: string[]
  pushes(): number
}

/** The page disposes `a`'s session: its core writes its offline queue and stops, its socket closes. */
function detach(a: TestClient): void {
  a.core.persistNow()
  a.core.stop()
  a.transport.close(1000, 'page closed')
}

/**
 * A new session's core on `a`'s scene (the same engine instance), on a new socket; `beforeOpen` runs after
 * its start, before any frame of the socket arrives.
 */
function startOn(
  h: Harness,
  a: TestClient,
  o: { readonly?: boolean; offline?: OfflineQueueStore; beforeOpen?: (core: LobbyEngineCore) => void } = {},
): Started {
  const transport = h.room.connect({ uid: a.name, tab: 'tab1', readonly: o.readonly })
  const events: CoreEvent[] = []
  const logs: string[] = []
  const core = new LobbyEngineCore({
    transport,
    scene: a.scene,
    tab: 'tab1',
    offline: o.offline,
    now: h.clock.now,
    setTimer: h.clock.setTimer,
    clearTimer: h.clock.clearTimer,
    log: (event) => logs.push(event),
  })
  core.on((e) => events.push(e))
  core.start()
  o.beforeOpen?.(core)
  return {
    core,
    transport,
    events,
    logs,
    pushes: () => transport.session.received.filter((m) => m.type === 'push').length,
  }
}

/** alice's board with two notes she made a moment ago; `cacheMs`: the room's reset-snapshot cache */
function board(cacheMs = 5000): { h: Harness; a: TestClient } {
  const h = createHarness({ seed: [] })
  h.room.snapshotCacheMs = cacheMs
  h.room.contractsRev = 11
  const a = h.client('alice')
  h.settle()
  a.edit((m) => {
    m.set('n1', rect('n1', 'a0', { x: 10 }))
    m.set('n2', rect('n2', 'a1', { x: 20 }))
  })
  h.settle()
  expect(a.core.saveStatus.state).toBe('saved')
  return { h, a }
}

describe('DEF-GAPS-1: a core started on another core’s scene never takes it for its own writes', () => {
  it('archived (read-only), a cached reset snapshot older than the notes: nothing pushed, Saved, no "Change not saved"', async () => {
    const { h, a } = board()
    detach(a)
    const r = startOn(h, a, { readonly: true })
    h.settle()
    expect(r.core.readonly).toBe(true)
    expect(r.pushes(), 'nothing sent').toBe(0)
    expect(r.events.filter((e) => e.kind === 'reject')).toEqual([])
    expect(r.core.saveStatus).toMatchObject({ state: 'saved', pending: 0, lastReject: null })
    // the scene is the server's, exactly
    expect(a.scene.map.get('n1')).toEqual(h.room.elements.get('n1'))
    expect(a.scene.map.get('n2')).toEqual(h.room.elements.get('n2'))
    expect(await hashElements(r.core.elements().values())).toBe(await h.roomHash())
  })

  for (const [what, cacheMs] of [
    ['a fresh reset snapshot', 0],
    ['a cached reset snapshot older than the notes', 5000],
  ] as const)
    it(`writable, ${what}: another user's write made while the page was between sessions stands; nothing is pushed`, async () => {
      const { h, a } = board(cacheMs)
      detach(a)
      // bob moves n1 while alice's page has no session: her scene keeps the older copy
      const b = h.client('bob', { tab: 'tab2' })
      h.settle()
      b.change('n1', { x: 999 })
      h.settle()
      expect(a.scene.map.get('n1')?.x).toBe(10)
      const r = startOn(h, a)
      h.settle()
      expect(r.pushes(), 'nothing sent (no create of the server’s ids, no patch from the old copy)').toBe(0)
      expect(r.logs).not.toContain('create_exists')
      expect(h.room.elements.get('n1')?.x, "bob's move stands").toBe(999)
      expect(a.scene.map.get('n1')?.x).toBe(999)
      expect(r.core.saveStatus.state).toBe('saved')
      expect(await hashElements(r.core.elements().values())).toBe(await h.roomHash())
    })

  it('a write of one of those copies before the first welcome (a re-measure) is not taken for a change either', () => {
    const { h, a } = board()
    detach(a)
    const r = startOn(h, a, {
      readonly: true,
      beforeOpen: (core) => {
        a.scene.map.set('n2', bump(a.scene.map.get('n2') as never, { width: 101 }))
        core.onSceneChange(a.scene.read())
      },
    })
    h.settle()
    expect(r.pushes()).toBe(0)
    expect(r.core.saveStatus).toMatchObject({ state: 'saved', lastReject: null })
    expect(a.scene.map.get('n2')).toEqual(h.room.elements.get('n2'))
  })

  it('an element created after the new core started is still a local create, and lands', () => {
    const { h, a } = board()
    detach(a)
    const r = startOn(h, a, {
      beforeOpen: (core) => {
        a.scene.map.set('n3', rect('n3', 'a2', { x: 30 }))
        core.onSceneChange(a.scene.read())
      },
    })
    h.settle()
    expect(r.pushes()).toBe(1)
    expect(h.room.elements.get('n3')?.x).toBe(30)
    expect(r.core.saveStatus.state).toBe('saved')
  })

  it("the previous core's unsaved change reaches the new one through the offline queue, and lands", async () => {
    const h = createHarness({ seed: [stored(rect('n1', 'a0', { x: 10 }))] })
    h.room.snapshotCacheMs = 5000
    const offline = createMemoryOfflineStore()
    const a = h.client('alice', { offline })
    await flushMicro()
    h.settle()
    // a move made with no socket: queued, never pushed
    h.room.cut(a.transport)
    h.settle()
    a.change('n1', { x: 55 })
    h.settle()
    await flushMicro()
    expect(h.room.elements.get('n1')?.x).toBe(10)
    detach(a)
    const r = startOn(h, a, { offline })
    await flushMicro()
    h.settle()
    await flushMicro()
    h.settle()
    expect(h.room.elements.get('n1')?.x, 'the queued move went out from the new core').toBe(55)
    expect(r.pushes()).toBe(1)
    expect(r.core.saveStatus.state).toBe('saved')
  })
})

/**
 * M6-2 (wave M, PWR-4): a new page paints this device's cached copy into its empty scene before its core starts
 * (`startFromCache`): the same rule as another core's copies. Its first welcome rebuilds the scene from the server's
 * state in one apply, so the cached paint then the welcome yields exactly the welcome's scene, whatever changed
 * while the page was closed (moved, deleted, created, or gone from a restored board).
 */
describe("M6-2: the cached paint, then the welcome, is exactly the welcome's scene", () => {
  for (const resume of [false, true])
    it(`${resume ? 'with the resume (a catch-up welcome)' : 'paint only (a reset snapshot)'}`, async () => {
      const { h, a } = board(0)
      a.change('n2', { y: 2 })
      h.settle()
      const record = recordOf(a)
      detach(a)
      const b = h.client('bob', { tab: 'tab2' })
      h.settle()
      b.change('n1', { x: 999 })
      b.change('n2', { isDeleted: true })
      b.edit((m) => m.set('n3', rect('n3', 'a2', { x: 30 })))
      h.settle()
      const p = openFromCache(h, record, { resume, tab: 'tab3' })
      // the paint: exactly the cached copies, before any frame
      expect([...p.scene.map.keys()].sort()).toEqual(['n1', 'n2'])
      expect(p.scene.map.get('n1')?.x).toBe(10)
      expect(p.scene.map.get('n2')?.isDeleted).toBe(false)
      h.settle()
      // the welcome's scene: the server's copies, version and nonce included, and nothing else
      expect([...p.scene.map.keys()].sort()).toEqual([...h.room.elements.keys()].sort())
      for (const [id, el] of h.room.elements) expect(p.scene.map.get(id), id).toEqual(el)
      expect(await hashElements(p.core.elements().values())).toBe(await h.roomHash())
      expect(p.pushes()).toBe(0)
      expect(p.core.showingCachedCopy).toBe(false)
    })

  it('an element the cached copy has and the server does not (a restored board) leaves the scene at the welcome', async () => {
    const { h, a } = board(0)
    const record = recordOf(a)
    detach(a)
    h.room.elements.delete('n2')
    h.room.epoch = 'epoch2'
    const p = openFromCache(h, record, { resume: true, tab: 'tab3' })
    expect(p.scene.map.has('n2')).toBe(true)
    expect(p.core.showingCachedCopy).toBe(true)
    h.settle()
    expect(p.scene.map.has('n2')).toBe(false)
    expect(await hashElements(p.core.elements().values())).toBe(await h.roomHash())
    expect(p.pushes()).toBe(0)
  })
})
