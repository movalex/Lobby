// The spike B verifier V1's re-check probes of beff59d (round 2), adopted as wave-5 regressions (2C):
// pushes and doc writes whose acks were lost, on a reconnect and across a reload, against the real room
// and the real engine core through a frame-dropping proxy. V1_REPS (default 3; V1 ran 20).
import { describe, expect, it } from 'vitest'
import { LobbyEngineCore } from '../../../web/src/canvas/sync/core/engine.ts'
import { createMemoryOfflineStore } from '../../../web/src/canvas/sync/core/offline-memory.ts'
import { bump, createMapScene } from '../../../web/src/canvas/sync/headless/scene.ts'
import { createSocketTransport } from '../../../web/src/canvas/sync/transport/socket.ts'
import type { OfflineEntry, SceneElement } from '../../../web/src/canvas/sync/types.ts'
import { ticketFor } from '../element-room/support/client.ts'
import { rect } from '../element-room/support/elements.ts'
import { newBoardId, useElementHarness } from '../element-room/support/stack.ts'
import { TicketWebSocket } from '../harness/tickets.ts'
import { headless, sleep, startProxy, until, vlog } from './support.ts'

const h = useElementHarness()
const REPS = Number(process.env.V1_REPS ?? 3)

function makeCore(
  syncUrl: string,
  boardId: string,
  user: string,
  tab: string,
  initial: readonly OfflineEntry[],
  now?: () => number,
) {
  const scene = createMapScene()
  const store = createMemoryOfflineStore(initial)
  const base = syncUrl.replace(/^http/, 'ws')
  const transport = createSocketTransport({
    url: async () =>
      `${base}/connect/${boardId}?${new URLSearchParams({ sessionId: tab, ticket: ticketFor(boardId, user) })}`,
    WebSocketImpl: TicketWebSocket,
    backoffMs: [50, 100, 200],
  })
  const core = new LobbyEngineCore({ transport, scene, tab, offline: store, ...(now ? { now } : {}) })
  const rejects: string[] = []
  core.on((e) => {
    if (e.kind === 'reject') rejects.push(`${e.id}:${e.code}`)
  })
  const edit = (fn: (m: Map<string, SceneElement>) => void) => {
    fn(scene.map)
    core.onSceneChange(scene.read())
  }
  return {
    core,
    scene,
    store,
    transport,
    edit,
    rejects,
    start() {
      core.start()
      transport.connect()
    },
    stop() {
      core.stop()
      transport.close(1000, 'reload')
    },
  }
}
const settled = (c: LobbyEngineCore) => c.saveStatus.state === 'saved' || c.saveStatus.state === 'not-saved'

describe('V1r2: ABA after a lost ack (same page, reconnect)', () => {
  it("R1: A recolours X red (ack lost, it landed); B sets it back to the original colour (acked, Saved); A reconnects: B's write is kept", async () => {
    const st = await h.stack()
    const out: { rep: number; stored: string; aPushedAgain: boolean }[] = []
    for (let rep = 0; rep < REPS; rep++) {
      const b = newBoardId()
      const px = await startProxy(st.server.wsUrl)
      const A = headless(px.url, b, 'alice')
      await A.connect()
      const B = await st.client({ boardId: b, user: 'bob' })
      const id = `r${rep}x`
      A.edit((m) => m.set(id, rect(id, { x: 0, y: 0, strokeColor: '#1e1e1e' }) as unknown as SceneElement))
      A.core.flush()
      await A.saved()
      await B.until(() => B.confirmed.has(id), 'B sees X')
      px.dropDown = true
      const before = A.core.pushLog().length
      A.change(id, { strokeColor: '#e03131' })
      A.core.flush()
      await B.until(() => B.confirmed.get(id)?.strokeColor === '#e03131', "B sees A's red")
      const ack = await B.push([
        { k: 'p', id, pv: B.confirmed.get(id)?.version, g: { style: { strokeColor: '#1e1e1e' } } },
      ])
      expect(ack.r[0]?.ok).toBe(true)
      px.cutAll()
      px.dropDown = false
      await sleep(50)
      await A.saved(20_000)
      await sleep(200)
      const snap = await st.snapshot(b)
      const stored = (snap.elements.find((e) => e.id === id) as { strokeColor: string }).strokeColor
      const again = A.core
        .pushLog()
        .slice(before + 1)
        .some((p) => p.ops.some((o) => o.k === 'p' && o.id === id))
      out.push({ rep, stored, aPushedAgain: again })
      await A.close()
      B.close()
      await px.close()
    }
    vlog('R1', JSON.stringify(out))
    const lost = out.filter((o) => o.stored !== '#1e1e1e')
    expect(lost, `B's Saved write overwritten by A's replay in ${lost.length}/${out.length}`).toEqual([])
  }, 600_000)

  it('R2: A deletes X (acked), then undoes it (undelete, ack lost, it landed); B deletes X (acked); A reconnects: X stays deleted', async () => {
    const st = await h.stack()
    const out: { rep: number; deleted: boolean; aPushedAgain: boolean }[] = []
    for (let rep = 0; rep < REPS; rep++) {
      const b = newBoardId()
      const px = await startProxy(st.server.wsUrl)
      const A = headless(px.url, b, 'alice')
      await A.connect()
      const B = await st.client({ boardId: b, user: 'bob' })
      const id = `u${rep}x`
      A.edit((m) => m.set(id, rect(id, { x: 0, y: 0 }) as unknown as SceneElement))
      A.core.flush()
      await A.saved()
      A.change(id, { isDeleted: true })
      A.core.flush()
      await A.saved()
      await B.until(() => B.confirmed.get(id)?.isDeleted === true, 'B sees the delete')
      px.dropDown = true
      const before = A.core.pushLog().length
      A.change(id, { isDeleted: false })
      A.core.flush()
      await B.until(() => B.confirmed.get(id)?.isDeleted === false, "B sees A's undelete")
      const ack = await B.push([
        { k: 'p', id, pv: B.confirmed.get(id)?.version, g: { life: { isDeleted: true } } },
      ])
      expect(ack.r[0]?.ok).toBe(true)
      px.cutAll()
      px.dropDown = false
      await sleep(50)
      await A.saved(20_000)
      await sleep(200)
      const snap = await st.snapshot(b)
      const el = snap.elements.find((e) => e.id === id) as { isDeleted: boolean } | undefined
      const again = A.core
        .pushLog()
        .slice(before + 1)
        .some((p) => p.ops.some((o) => (o.k === 'c' ? o.el.id : o.id) === id))
      out.push({ rep, deleted: el === undefined || !!el.isDeleted, aPushedAgain: again })
      await A.close()
      B.close()
      await px.close()
    }
    vlog('R2', JSON.stringify(out))
    const revived = out.filter((o) => !o.deleted)
    expect(revived, `B's delete undone by A's replay in ${revived.length}/${out.length}`).toEqual([])
  }, 600_000)

  it("R3: A writes a tagDef (ack lost, it landed); B writes the same tagDef key after (acked); A reconnects: B's value is kept", async () => {
    const st = await h.stack()
    const out: { rep: number; stored: unknown; aPushedAgain: boolean }[] = []
    for (let rep = 0; rep < REPS; rep++) {
      const b = newBoardId()
      const px = await startProxy(st.server.wsUrl)
      const A = headless(px.url, b, 'alice')
      await A.connect()
      const B = await st.client({ boardId: b, user: 'bob' })
      const key = `tagDef:topic${rep}`
      px.dropDown = true
      const before = A.core.pushLog().length
      A.core.setDoc({ [key]: { name: `Topic${rep}`, color: 'red' } })
      A.core.flush()
      await sleep(150)
      const ack = await B.push([], { doc: { set: { [key]: { name: `Topic${rep}`, color: 'green' } } } })
      expect(ack.r.length === 0 || ack.r.every((r) => r.ok)).toBe(true)
      px.cutAll()
      px.dropDown = false
      await sleep(50)
      await A.saved(20_000)
      await sleep(300)
      const stored = A.core.doc().get(key)
      const again = A.core
        .pushLog()
        .slice(before + 1)
        .some((p) => !!(p as { doc?: { set?: Record<string, unknown> } }).doc?.set?.[key])
      out.push({ rep, stored, aPushedAgain: again })
      await A.close()
      B.close()
      await px.close()
    }
    vlog('R3', JSON.stringify(out))
    const lost = out.filter((o) => (o.stored as { color?: string } | undefined)?.color !== 'green')
    expect(lost, `B's Saved doc write overwritten in ${lost.length}/${out.length}`).toEqual([])
  }, 600_000)
})

describe('V1r2: a push in flight when the page reloads (the queue keeps it), another user writes before the new page', () => {
  it("R4: A moves X (in flight, it lands, the page closes before the ack); B moves X (acked); the reloaded page: B's write is kept", async () => {
    const st = await h.stack()
    const out: { rep: number; queued: number; stored: number; rejects: string[] }[] = []
    for (let rep = 0; rep < REPS; rep++) {
      const b = newBoardId()
      const px = await startProxy(st.server.wsUrl)
      const tab = `tab-a${rep}`
      const A1 = makeCore(px.url, b, 'alice', tab, [])
      A1.start()
      await until(() => A1.core.saveStatus.state === 'saved' && !!A1.core.sid, 'A1 welcome')
      const B = await st.client({ boardId: b, user: 'bob' })
      const id = `p${rep}x`
      A1.edit((m) => m.set(id, rect(id, { x: 0, y: 0 }) as unknown as SceneElement))
      A1.core.flush()
      await until(() => A1.core.saveStatus.state === 'saved', 'X saved')
      await B.until(() => B.confirmed.has(id), 'B sees X')
      px.dropDown = true
      A1.edit((m) => m.set(id, bump(m.get(id) as SceneElement, { x: 111 })))
      A1.core.flush()
      await B.until(() => B.confirmed.get(id)?.x === 111, "B sees A's move")
      // the page closes (pagehide writes the queue) before the ack
      A1.core.persistNow()
      await sleep(30)
      const entries = (A1.store as unknown as { entries(): readonly OfflineEntry[] }).entries()
      A1.stop()
      await px.close()
      const ack = await B.push([
        { k: 'p', id, pv: B.confirmed.get(id)?.version, g: { pos: { x: 222, y: 0 } } },
      ])
      expect(ack.r[0]?.ok).toBe(true)
      const A2 = makeCore(st.server.url, b, 'alice', tab, entries)
      A2.start()
      await until(() => !!A2.core.sid, 'A2 welcome')
      await sleep(100)
      await until(() => settled(A2.core), 'A2 settles', 20_000)
      await sleep(200)
      const snap = await st.snapshot(b)
      const stored = (snap.elements.find((e) => e.id === id) as { x: number }).x
      out.push({ rep, queued: entries.length, stored, rejects: A2.rejects })
      A2.stop()
      B.close()
    }
    vlog('R4', JSON.stringify(out))
    const lost = out.filter((o) => o.stored !== 222)
    expect(lost, `B's Saved write overwritten by the reloaded page in ${lost.length}/${out.length}`).toEqual(
      [],
    )
  }, 600_000)

  it('R5: A creates M (in flight, it lands, the page closes before the ack); B deletes M (acked); the reloaded page: M stays deleted', async () => {
    const st = await h.stack()
    const out: { rep: number; queued: number; deleted: boolean; rejects: string[] }[] = []
    for (let rep = 0; rep < REPS; rep++) {
      const b = newBoardId()
      const px = await startProxy(st.server.wsUrl)
      const tab = `tab-a${rep}`
      const A1 = makeCore(px.url, b, 'alice', tab, [])
      A1.start()
      await until(() => A1.core.saveStatus.state === 'saved' && !!A1.core.sid, 'A1 welcome')
      const B = await st.client({ boardId: b, user: 'bob' })
      const id = `c${rep}x`
      px.dropDown = true
      A1.edit((m) => m.set(id, rect(id, { x: 5, y: 5 }) as unknown as SceneElement))
      A1.core.flush()
      await B.until(() => B.confirmed.has(id), 'B sees M')
      A1.core.persistNow()
      await sleep(30)
      const entries = (A1.store as unknown as { entries(): readonly OfflineEntry[] }).entries()
      A1.stop()
      await px.close()
      const ack = await B.push([
        { k: 'p', id, pv: B.confirmed.get(id)?.version, g: { life: { isDeleted: true } } },
      ])
      expect(ack.r[0]?.ok).toBe(true)
      const A2 = makeCore(st.server.url, b, 'alice', tab, entries)
      A2.start()
      await until(() => !!A2.core.sid, 'A2 welcome')
      await sleep(100)
      await until(() => settled(A2.core), 'A2 settles', 20_000)
      await sleep(200)
      const snap = await st.snapshot(b)
      const el = snap.elements.find((e) => e.id === id) as { isDeleted: boolean } | undefined
      out.push({
        rep,
        queued: entries.length,
        deleted: el === undefined || !!el.isDeleted,
        rejects: A2.rejects,
      })
      A2.stop()
      B.close()
    }
    vlog('R5', JSON.stringify(out))
    const revived = out.filter((o) => !o.deleted)
    expect(revived, `B's delete undone by the reloaded page in ${revived.length}/${out.length}`).toEqual([])
  }, 600_000)

  it("R6: A edits offline, the page closes; B writes the same group; the page reopens 11 minutes later (client clock): STALE, B's value kept", async () => {
    const st = await h.stack()
    const out: Record<string, unknown>[] = []
    for (let rep = 0; rep < REPS; rep++) {
      const b = newBoardId()
      const px = await startProxy(st.server.wsUrl)
      const tab = `tab-a${rep}`
      let skew = 0
      const now = () => Date.now() + skew
      const A1 = makeCore(px.url, b, 'alice', tab, [], now)
      A1.start()
      await until(() => A1.core.saveStatus.state === 'saved' && !!A1.core.sid, 'A1 welcome')
      const B = await st.client({ boardId: b, user: 'bob' })
      const id = `s${rep}x`
      A1.edit((m) => m.set(id, rect(id, { x: 0, y: 0 }) as unknown as SceneElement))
      A1.core.flush()
      await until(() => A1.core.saveStatus.state === 'saved', 'X saved')
      await B.until(() => B.confirmed.has(id), 'B sees X')
      px.dropUp = true
      px.dropDown = true
      px.cutAll()
      await until(() => A1.core.saveStatus.state === 'offline', 'offline')
      A1.edit((m) => m.set(id, bump(m.get(id) as SceneElement, { x: 111 })))
      A1.core.persistNow()
      await sleep(30)
      const entries = (A1.store as unknown as { entries(): readonly OfflineEntry[] }).entries()
      A1.stop()
      await px.close()
      await B.push([{ k: 'p', id, pv: B.confirmed.get(id)?.version, g: { pos: { x: 222, y: 0 } } }])
      skew = 11 * 60_000
      const A2 = makeCore(st.server.url, b, 'alice', tab, entries, now)
      A2.start()
      await until(() => !!A2.core.sid, 'A2 welcome')
      await sleep(100)
      await until(() => settled(A2.core), 'A2 settles', 20_000)
      await sleep(200)
      const snap = await st.snapshot(b)
      const stored = (snap.elements.find((e) => e.id === id) as { x: number }).x
      const pushes = A2.core.pushLog().flatMap((p) =>
        p.ops.map((o) => ({
          base: p.base,
          off: (o as { off?: number }).off ?? null,
          id: (o as { id?: string }).id,
        })),
      )
      out.push({
        rep,
        queued: entries.length,
        stored,
        rejects: A2.rejects,
        pushes,
        state: A2.core.saveStatus.state,
      })
      A2.stop()
      B.close()
    }
    vlog('R6', JSON.stringify(out))
    const bad = out.filter(
      (o) => o.stored !== 222 || !(o.rejects as string[]).some((r) => r.endsWith(':STALE')),
    )
    expect(
      bad,
      `an old offline edit across a reload overwrote B's newer write in ${bad.length}/${out.length}`,
    ).toEqual([])
  }, 600_000)

  it("R7: A writes a tagDef (in flight, it lands, the page closes); B writes the key (acked); the reloaded page: B's value is kept", async () => {
    const st = await h.stack()
    const out: Record<string, unknown>[] = []
    for (let rep = 0; rep < REPS; rep++) {
      const b = newBoardId()
      const px = await startProxy(st.server.wsUrl)
      const tab = `tab-a${rep}`
      const A1 = makeCore(px.url, b, 'alice', tab, [])
      A1.start()
      await until(() => A1.core.saveStatus.state === 'saved' && !!A1.core.sid, 'A1 welcome')
      const B = await st.client({ boardId: b, user: 'bob' })
      const key = `tagDef:topic${rep}`
      px.dropDown = true
      A1.core.setDoc({ [key]: { name: `Topic${rep}`, color: 'red' } })
      A1.core.flush()
      await sleep(150)
      A1.core.persistNow()
      await sleep(30)
      const entries = (A1.store as unknown as { entries(): readonly OfflineEntry[] }).entries()
      A1.stop()
      await px.close()
      await B.push([], { doc: { set: { [key]: { name: `Topic${rep}`, color: 'green' } } } })
      const A2 = makeCore(st.server.url, b, 'alice', tab, entries)
      A2.start()
      await until(() => !!A2.core.sid, 'A2 welcome')
      await sleep(100)
      await until(() => settled(A2.core), 'A2 settles', 20_000)
      await sleep(300)
      const stored = A2.core.doc().get(key) as { color?: string } | undefined
      out.push({ rep, queued: entries.length, color: stored?.color ?? null })
      A2.stop()
      B.close()
    }
    vlog('R7', JSON.stringify(out))
    const lost = out.filter((o) => o.color !== 'green')
    expect(lost, `B's doc write overwritten by the reloaded page in ${lost.length}/${out.length}`).toEqual([])
  }, 600_000)
})
