// The spike B verifier V1's re-check probes of beff59d (round 2), adopted as wave-5 regressions (2C):
// pushes and doc writes whose acks were lost, on a reconnect and across a reload, against the real room
// and the real engine core through a frame-dropping proxy. V1_REPS (default 3; V1 ran 20).
import { describe, expect, it } from 'vitest'
import type { SceneElement } from '../../../web/src/canvas/sync/types.ts'
import { rect } from '../element-room/support/elements.ts'
import { newBoardId, useElementHarness } from '../element-room/support/stack.ts'
import { headless, sleep, startProxy, until, vlog } from './support.ts'

const h = useElementHarness()
const REPS = Number(process.env.V1_REPS ?? 3)

describe('V1r2: an unlanded push against an offline edit', () => {
  it("R8: A's socket goes silent upstream (half-open: A's pushes never arrive), A moves X and recolours Y; B moves X meanwhile (Saved); the socket drops and A reconnects: is A's move of X kept or told?", async () => {
    const st = await h.stack()
    const out: Record<string, unknown>[] = []
    for (let rep = 0; rep < REPS; rep++) {
      const b = newBoardId()
      const px = await startProxy(st.server.wsUrl)
      const A = headless(px.url, b, 'alice')
      await A.connect()
      const B = await st.client({ boardId: b, user: 'bob' })
      const X = `x${rep}x`
      const Y = `y${rep}x`
      A.edit((m) => {
        m.set(X, rect(X, { x: 0, y: 0 }) as unknown as SceneElement)
        m.set(Y, rect(Y, { x: 300, y: 0 }) as unknown as SceneElement)
      })
      A.core.flush()
      await A.saved()
      await B.until(() => B.confirmed.has(X) && B.confirmed.has(Y), 'B sees X, Y')
      const events: string[] = []
      A.core.on((e) => {
        if (e.kind === 'reject') events.push(`reject:${e.id}:${e.code}`)
      })
      // half-open: nothing A sends arrives
      px.dropUp = true
      A.change(X, { x: 111 })
      A.change(Y, { strokeColor: '#e03131' })
      A.core.flush()
      await sleep(200)
      const stateWhileSilent = A.core.saveStatus.state
      await B.push([{ k: 'p', id: X, pv: B.confirmed.get(X)?.version, g: { pos: { x: 222, y: 0 } } }])
      await sleep(100)
      px.cutAll()
      px.dropUp = false
      await sleep(50)
      await A.saved(20_000)
      await sleep(200)
      const snap = await st.snapshot(b)
      const x = (snap.elements.find((e) => e.id === X) as { x: number }).x
      const y = (snap.elements.find((e) => e.id === Y) as { strokeColor: string }).strokeColor
      const aLocalX = (A.scene.get(X) as unknown as { x: number }).x
      out.push({
        rep,
        stateWhileSilent,
        storedX: x,
        aLocalX,
        yRecolourStored: y === '#e03131',
        aState: A.core.saveStatus.state,
        events,
        aMoveKeptOrTold: x === 111 || events.length > 0,
      })
      await A.close()
      B.close()
      await px.close()
    }
    vlog('R8', JSON.stringify(out))
    expect(out.filter((o) => !o.aMoveKeptOrTold)).toEqual([])
  }, 600_000)

  it("R8b (control): the same move of X made with the socket down (offline), B moves X meanwhile; A reconnects: A's move is replayed and stored (the later arrival wins below 10 minutes)", async () => {
    const st = await h.stack()
    const out: Record<string, unknown>[] = []
    for (let rep = 0; rep < REPS; rep++) {
      const b = newBoardId()
      const px = await startProxy(st.server.wsUrl)
      const A = headless(px.url, b, 'alice')
      await A.connect()
      const B = await st.client({ boardId: b, user: 'bob' })
      const X = `x${rep}x`
      A.edit((m) => m.set(X, rect(X, { x: 0, y: 0 }) as unknown as SceneElement))
      A.core.flush()
      await A.saved()
      await B.until(() => B.confirmed.has(X), 'B sees X')
      px.dropUp = true
      px.dropDown = true
      px.cutAll()
      await until(() => A.core.saveStatus.state === 'offline', 'offline')
      A.change(X, { x: 111 })
      await B.push([{ k: 'p', id: X, pv: B.confirmed.get(X)?.version, g: { pos: { x: 222, y: 0 } } }])
      px.dropUp = false
      px.dropDown = false
      px.cutAll()
      await A.saved(20_000)
      await sleep(200)
      const x = ((await st.snapshot(b)).elements.find((e) => e.id === X) as { x: number }).x
      out.push({ rep, storedX: x })
      await A.close()
      B.close()
      await px.close()
    }
    vlog('R8b', JSON.stringify(out))
    expect(out.filter((o) => o.storedX !== 111)).toEqual([])
  }, 600_000)
})
