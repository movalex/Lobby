// The spike B verifier V1's probe (part-3 round), adopted as a regression (V1_REPS, default 3; V1 ran 20): 20 repetitions each, against the REAL sync server process
// (O1's room) and O2's headless client (the real engine core). Run:
//   pnpm exec vitest run apps/sync/test/verifier-v1 --project sync
import { describe, expect, it } from 'vitest'
import type { SceneElement } from '../../../web/src/canvas/sync/types.ts'
import { rect } from '../element-room/support/elements.ts'
import { newBoardId, useElementHarness } from '../element-room/support/stack.ts'
import { headless, sleep, startProxy, vlog } from './support.ts'

const h = useElementHarness()
const REPS = Number(process.env.V1_REPS ?? 3)
const log = vlog

describe('V1 lost-ack replay', () => {
  it("N3a: A pushes x (ack lost), B then writes x (acked, Saved); A reconnects: B's later write must survive", async () => {
    const st = await h.stack()
    const out: { rep: number; stored: number; aPushedAgain: boolean }[] = []
    for (let rep = 0; rep < REPS; rep++) {
      const b = newBoardId()
      const px = await startProxy(st.server.wsUrl)
      const A = headless(px.url, b, 'alice')
      await A.connect()
      const B = await st.client({ boardId: b, user: 'bob' })
      const id = `n${rep}x`
      A.edit((m) => m.set(id, rect(id, { x: 0, y: 0 }) as unknown as SceneElement))
      A.core.flush()
      await A.saved()
      await B.until(() => B.confirmed.has(id), 'B sees N')
      px.dropDown = true
      const pushesBefore = A.core.pushLog().length
      A.change(id, { x: 111 })
      A.core.flush()
      await B.until(() => B.confirmed.get(id)?.x === 111, "B sees A's commit")
      const ack = await B.push([
        { k: 'p', id, pv: B.confirmed.get(id)?.version, g: { pos: { x: 222, y: 0 } } },
      ])
      expect(ack.r[0]?.ok).toBe(true)
      px.cutAll()
      px.dropDown = false
      await sleep(50)
      await A.saved(20_000)
      await sleep(200)
      const snap = await st.snapshot(b)
      const stored = (snap.elements.find((e) => e.id === id) as { x: number }).x
      const again = A.core
        .pushLog()
        .slice(pushesBefore + 1)
        .some((p) => p.ops.some((o) => o.k === 'p' && o.id === id))
      out.push({ rep, stored, aPushedAgain: again })
      await A.close()
      B.close()
      await px.close()
    }
    log('N3a', JSON.stringify(out))
    const lost = out.filter((o) => o.stored !== 222)
    expect(lost, `B's acked later write overwritten by A's replay in ${lost.length}/${out.length}`).toEqual(
      [],
    )
  })

  it('N3b: A creates M (ack lost), B deletes M (acked); A reconnects: M must stay deleted (no resurrection)', async () => {
    const st = await h.stack()
    const out: { rep: number; deleted: boolean }[] = []
    for (let rep = 0; rep < REPS; rep++) {
      const b = newBoardId()
      const px = await startProxy(st.server.wsUrl)
      const A = headless(px.url, b, 'alice')
      await A.connect()
      const B = await st.client({ boardId: b, user: 'bob' })
      const id = `m${rep}x`
      px.dropDown = true
      A.edit((m) => m.set(id, rect(id, { x: 5, y: 5 }) as unknown as SceneElement))
      A.core.flush()
      await B.until(() => B.confirmed.has(id), 'B sees M')
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
      out.push({ rep, deleted: !!el?.isDeleted })
      await A.close()
      B.close()
      await px.close()
    }
    log('N3b', JSON.stringify(out))
    const revived = out.filter((o) => !o.deleted)
    expect(revived, `B's delete undone by A's create replay in ${revived.length}/${out.length}`).toEqual([])
  })
})

describe('V1 Saved means on disk', () => {
  it('N1: an edit, then a random wait; if the core says Saved, SIGKILL at once: the value is on disk; either way nothing is lost after reconnect', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const A = headless(st.server.url, b, 'alice')
    await A.connect()
    const ids = Array.from({ length: 5 }, (_, i) => `d${i}x`)
    A.edit((m) => {
      for (const id of ids) m.set(id, rect(id, { x: 0, y: 0 }) as unknown as SceneElement)
    })
    A.core.flush()
    await A.saved()
    const out: { rep: number; waitMs: number; state: string; savedMissing: number; finalMissing: number }[] =
      []
    for (let rep = 0; rep < REPS; rep++) {
      // a burst of 1-6 edits on random elements, then a random wait
      const want = new Map<string, number>()
      const n = 1 + Math.floor(Math.random() * 6)
      for (let k = 0; k < n; k++) {
        const id = ids[Math.floor(Math.random() * ids.length)] as string
        const x = 1000 * (rep + 1) + k
        A.change(id, { x })
        want.set(id, x)
        if (Math.random() < 0.5) await sleep(Math.floor(Math.random() * 10))
      }
      const waitMs = Math.floor(Math.random() * 60)
      await sleep(waitMs)
      const state = A.core.saveStatus.state
      const snapAtSaved =
        state === 'saved'
          ? new Map([...A.core.elements()].map(([id, el]) => [id, (el as unknown as { x: number }).x]))
          : null
      await st.server.kill('SIGKILL')
      await st.server.restart()
      let savedMissing = 0
      if (snapAtSaved) {
        const disk = await st.snapshot(b)
        for (const [id, x] of snapAtSaved) {
          const d = disk.elements.find((e) => e.id === id) as { x: number } | undefined
          if (!d || d.x !== x) savedMissing++
        }
      }
      await sleep(100)
      await A.saved(30_000)
      const disk2 = await st.snapshot(b)
      let finalMissing = 0
      for (const [id, x] of want) {
        const d = disk2.elements.find((e) => e.id === id) as { x: number } | undefined
        if (!d || d.x !== x) finalMissing++
      }
      out.push({ rep, waitMs, state, savedMissing, finalMissing })
    }
    await A.close()
    log('N1', JSON.stringify(out))
    expect(out.filter((o) => o.savedMissing > 0 || o.finalMissing > 0)).toEqual([])
  })
})

describe('V1 unscanned writes (Excalidraw holds a write before onChange)', () => {
  it('N2: 20 reps x 25 edits written into the scene without a scan, while a raw writer streams at ~100 Hz; scans come late or never: nothing lost, Saved only when stored', async () => {
    const st = await h.stack()
    const out: { rep: number; lost: number; falseSaved: number; raced: number }[] = []
    for (let rep = 0; rep < REPS; rep++) {
      const b = newBoardId()
      const A = headless(st.server.url, b, 'alice')
      await A.connect()
      const W = await st.client({ boardId: b, user: 'writer' })
      const N = `N${rep}x`
      const R = `R${rep}x`
      A.edit((m) => {
        m.set(N, rect(N, { x: 0, y: 0 }) as unknown as SceneElement)
        m.set(R, rect(R, { x: 500, y: 0 }) as unknown as SceneElement)
      })
      A.core.flush()
      await A.saved()
      await W.until(() => W.confirmed.has(R), 'writer sees R')
      let stop = false
      let raced = 0
      const off = A.core.on((e) => {
        if (e.kind === 'applied') raced++
      })
      const writer = (async () => {
        let dx = 7
        while (!stop) {
          const cur = W.confirmed.get(R)
          await W.push([{ k: 'p', id: R, pv: cur?.version, g: { pos: { x: 500 + dx, y: 0 } } }])
          dx = -dx
          await sleep(10)
        }
      })()
      let falseSaved = 0
      let last = 0
      for (let k = 0; k < 25; k++) {
        const x = 10 + k * 3 + rep * 1000
        last = x
        // the scene holds the write at once (updateScene / mutateElement); onChange comes later or never
        const cur = A.scene.get(N) as SceneElement
        if (k % 3 === 0) {
          // in place, as mutateElement does
          ;(cur as unknown as { x: number }).x = x
          ;(cur as unknown as { version: number }).version = cur.version + 1
          ;(cur as unknown as { versionNonce: number }).versionNonce = Math.floor(Math.random() * 2 ** 31)
        } else
          A.scene.set(N, {
            ...cur,
            x,
            version: cur.version + 1,
            versionNonce: Math.floor(Math.random() * 2 ** 31),
          } as SceneElement)
        // Saved must never show while the write is only in the scene
        if (A.core.saveStatus.state === 'saved') falseSaved++
        await sleep(Math.floor(Math.random() * 12))
        if (Math.random() < 0.6) A.gesture()
      }
      stop = true
      await writer
      off()
      A.core.flush()
      await A.saved(20_000)
      const snap = await st.snapshot(b)
      const stored = (snap.elements.find((e) => e.id === N) as { x: number }).x
      out.push({ rep, lost: stored === last ? 0 : 1, falseSaved, raced })
      await A.close()
      W.close()
    }
    log('N2', JSON.stringify(out))
    expect(out.filter((o) => o.lost || o.falseSaved)).toEqual([])
  })
})
