/**
 * M6-3 (wave M, PWR-4 phase 2): a page that opens from the board cache resumes from it as a reconnect does. The
 * cached copy seeds the confirmed map and the hello names its clock and epoch; the room answers with the rows
 * since it (a catch-up welcome, no snapshot frame), or, behind its horizon or in another epoch, with the reset
 * path. Every case ends with the client's map hashing equal to the room's (tombstones included) and nothing pushed
 * by a client that changed nothing.
 */
import { hashElements } from '@draftroom/canvas-schema/hash'
import { CONTRACTS_REV, type Welcome } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import { cacheDroppedAtWelcome } from '../adapter/snapshot-cache.ts'
import { createMapScene } from '../headless/scene.ts'
import { closePage, openFromCache, recordOf } from '../testing/cached.ts'
import { rect } from '../testing/elements.ts'
import { stored } from '../testing/fakeRoom.ts'
import { createHarness, type Harness } from '../testing/harness.ts'
import { LobbyEngineCore } from './engine.ts'
import { createMemoryOfflineStore } from './offline-memory.ts'

const flushMicro = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/** alice's board (n1..n3), her page's record of it, and her page closed; then bob changes it while she is away. */
function staleCache() {
  const h = createHarness({
    seed: [
      stored(rect('n1', 'a0', { x: 10 })),
      stored(rect('n2', 'a1', { x: 20 })),
      stored(rect('n3', 'a2')),
    ],
  })
  h.room.contractsRev = CONTRACTS_REV
  const a = h.client('alice')
  h.settle()
  a.change('n3', { y: 3 })
  h.settle()
  const record = recordOf(a)
  closePage(a)
  const b = h.client('bob', { tab: 'tb' })
  h.settle()
  b.change('n1', { x: 999 })
  b.change('n2', { isDeleted: true })
  b.edit((m) => m.set('n4', rect('n4', 'a3', { x: 40 })))
  h.settle()
  return { h, record, b }
}

const welcomeOf = (p: { got(): unknown[] }) =>
  p.got().find((m) => (m as { type?: string }).type === 'welcome') as Welcome | undefined
const snapshots = (p: { got(): unknown[] }) =>
  p.got().filter((m) => (m as { type?: string }).type === 'snapshot')

async function expectServerCopy(h: Harness, p: ReturnType<typeof openFromCache>) {
  expect(await hashElements(p.core.elements().values())).toBe(await h.roomHash())
  for (const [id, el] of h.room.elements) expect(p.scene.map.get(id), id).toEqual(el)
  expect([...p.scene.map.keys()].sort()).toEqual([...h.room.elements.keys()].sort())
}

describe('M6-3: resuming from the cache', () => {
  it('a stale cache then a catch-up: the hello names the copy, the welcome is a catch-up (no snapshot), the map is the server hash', async () => {
    const { h, record } = staleCache()
    const p = openFromCache(h, record, { resume: true })
    expect(p.started).toBe(true)
    // painted at once, before any frame
    expect(p.scene.map.get('n1')?.x).toBe(10)
    h.settle()
    expect(p.sent().find((m) => m.type === 'hello')).toMatchObject({ since: record.clock, epoch: 'epoch1' })
    const w = welcomeOf(p)
    expect(w?.reset).toBe(false)
    // only the rows changed while the page was closed
    expect((w?.catchUp ?? []).map((op) => (op.k === 'c' ? op.el.id : op.id)).sort()).toEqual([
      'n1',
      'n2',
      'n4',
    ])
    expect(snapshots(p)).toHaveLength(0)
    expect(p.core.resumeOutcome).toBe('catch-up')
    expect(p.logs.map((l) => l.event)).toContain('cache_resume')
    await expectServerCopy(h, p)
    expect(p.pushes()).toBe(0)
    expect(p.core.saveStatus.state).toBe('saved')
    expect(cacheDroppedAtWelcome(record, w as Welcome, p.core.resumeOutcome)).toBe(false)
  })

  it('a horizon miss (tombstones purged past the copy) takes the existing reset path, and converges', async () => {
    const { h, record } = staleCache()
    h.room.horizon = record.clock + 1
    const p = openFromCache(h, record, { resume: true })
    h.settle()
    expect(p.sent().find((m) => m.type === 'hello')).toMatchObject({ since: record.clock })
    expect(welcomeOf(p)?.reset).toBe(true)
    expect(snapshots(p)).toHaveLength(1)
    expect(p.core.resumeOutcome).toBe('reset')
    await expectServerCopy(h, p)
    expect(p.pushes()).toBe(0)
  })

  it('an epoch change (a restore) takes the reset path and drops the cache; what the restored board lacks leaves the scene', async () => {
    const { h, record } = staleCache()
    // the board is restored: another epoch, and n3 is not in it
    h.room.epoch = 'epoch2'
    h.room.elements.delete('n3')
    const p = openFromCache(h, record, { resume: true })
    expect(p.scene.map.has('n3')).toBe(true)
    h.settle()
    const w = welcomeOf(p) as Welcome
    expect(w.reset).toBe(true)
    expect(p.core.resumeOutcome).toBe('epoch')
    expect(cacheDroppedAtWelcome(record, w, p.core.resumeOutcome)).toBe(true)
    expect(p.scene.map.has('n3')).toBe(false)
    await expectServerCopy(h, p)
    expect(p.pushes()).toBe(0)
  })

  it('paint only (RESUME_FROM_CACHE off, or a copy that is not exact): the hello says since 0, the room sends its snapshot', async () => {
    const { h, record } = staleCache()
    const p = openFromCache(h, record, { resume: false })
    h.settle()
    expect(p.sent().find((m) => m.type === 'hello')).toMatchObject({ since: 0, epoch: null })
    expect(welcomeOf(p)?.reset).toBe(true)
    expect(p.core.resumeOutcome).toBeNull()
    await expectServerCopy(h, p)
    expect(p.pushes()).toBe(0)
  })

  it('a reconnect after a resumed open resumes from the live clock, not the cached one', async () => {
    const { h, record, b } = staleCache()
    const p = openFromCache(h, record, { resume: true })
    h.settle()
    const live = p.core.clock
    expect(live).toBeGreaterThan(record.clock)
    h.room.cut(p.transport)
    h.settle()
    b.change('n4', { x: 41 })
    h.settle()
    ;(p.transport as unknown as { reopen(): void }).reopen()
    h.settle()
    const hellos = p.sent().filter((m) => m.type === 'hello')
    expect(hellos.at(-1)).toMatchObject({ since: live, epoch: 'epoch1' })
    await expectServerCopy(h, p)
  })

  it("the closed page's unsent change (its offline queue) is adopted after the catch-up and lands", async () => {
    const h = createHarness({ seed: [stored(rect('n1', 'a0', { x: 10 })), stored(rect('n2', 'a1'))] })
    h.room.contractsRev = CONTRACTS_REV
    const offline = createMemoryOfflineStore()
    const a = h.client('alice', { offline })
    await flushMicro()
    h.settle()
    a.change('n2', { y: 2 })
    h.settle()
    const record = recordOf(a)
    // a move made with no socket: queued, never pushed; then the page closes
    h.room.cut(a.transport)
    h.settle()
    a.change('n1', { x: 55 })
    h.settle()
    await flushMicro()
    closePage(a)
    await flushMicro()
    const b = h.client('bob', { tab: 'tb' })
    h.settle()
    b.change('n2', { x: 222 })
    h.settle()
    const p = openFromCache(h, record, { resume: true, offline })
    await flushMicro()
    h.settle()
    await flushMicro()
    h.settle()
    expect(p.core.resumeOutcome).toBe('catch-up')
    expect(h.room.elements.get('n1')?.x, 'the queued move went out').toBe(55)
    expect(h.room.elements.get('n2')?.x, "bob's write stands").toBe(222)
    expect(p.core.saveStatus.state).toBe('saved')
    await expectServerCopy(h, p)
  })

  it('a resumed page edits as any page does after its welcome', async () => {
    const { h, record } = staleCache()
    const p = openFromCache(h, record, { resume: true })
    h.settle()
    const el = p.scene.map.get('n4')
    if (!el) throw new Error('no n4')
    p.scene.map.set('n4', { ...el, x: 444, version: el.version + 1, versionNonce: 4242 })
    p.core.onSceneChange(p.scene.read())
    h.settle()
    expect(h.room.elements.get('n4')?.x).toBe(444)
    expect(p.pushes()).toBe(1)
    await expectServerCopy(h, p)
  })

  it('startFromCache refuses after start, on a scene that is not empty, and for an empty copy', () => {
    const { h, record } = staleCache()
    const busy = createMapScene()
    busy.map.set('x', rect('x', 'a0') as never)
    const t = h.room.connect({ uid: 'alice', tab: 't9' })
    const core = new LobbyEngineCore({
      transport: t,
      scene: busy,
      tab: 't9',
      now: h.clock.now,
      setTimer: h.clock.setTimer,
      clearTimer: h.clock.clearTimer,
    })
    expect(core.startFromCache(record, { resume: true })).toBe(false)
    expect(busy.map.size).toBe(1)
    const empty = createMapScene()
    const core2 = new LobbyEngineCore({
      transport: h.room.connect({ uid: 'alice', tab: 't8' }),
      scene: empty,
      tab: 't8',
    })
    expect(core2.startFromCache({ ...record, elements: [] }, { resume: true })).toBe(false)
    core2.start()
    expect(core2.startFromCache(record, { resume: true })).toBe(false)
    expect(empty.map.size).toBe(0)
    core.stop()
    core2.stop()
  })
})
