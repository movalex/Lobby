// M2's gate "the headless client passes O1's protocol suites" (docs/EXCALIDRAW-MIGRATION.md §8.6.4): the
// same server process as the other suites, driven by O2's headless client (apps/web/src/canvas/sync/
// headless, the frozen `HeadlessClient` of sync/types.ts), so the client code browsers run meets the real
// room. SKIPPED while O2's module is the C0 stub ("not implemented (O2)"); it runs after the lead merges
// O2's branch. Nothing here is O2's implementation: only its frozen interface.
//
//  - B10 (echo, spike subset): a receiving-only client pushes 0 ops while two others create, move,
//    recolour and delete; A and B each create 50 notes at the top of the order at once, and C still pushes
//    nothing; every key unique; every map (tombstones included) hashes equal to the test snapshot.
//  - rule 7 through the core: B moves an arrow's target; B's core pushes no arrow op (its follow is derived,
//    or its scene never moved the arrow); the server re-snaps and every client converges.

import { hashElements } from '@draftroom/canvas-schema/hash'
import { checkInvariants } from '@draftroom/canvas-schema/invariants'
import { describe, expect, it } from 'vitest'
import { createHeadlessClient } from '../../../web/src/canvas/sync/headless/index.ts'
import type { HeadlessClient, SceneElement } from '../../../web/src/canvas/sync/types.ts'
import { ticketFor } from './support/client.ts'
import { arrow, bindArrow, type El, note, rect } from './support/elements.ts'
import { newBoardId, useElementHarness } from './support/stack.ts'

const h = useElementHarness()

/** Whether O2's headless client exists yet (the C0 stub throws "not implemented (O2)"). */
const available = (() => {
  try {
    const c = createHeadlessClient({
      syncUrl: 'ws://127.0.0.1:9',
      boardId: 'b-probe00000',
      tab: 'probe',
      ticket: 'x',
    })
    void c.close().catch(() => {})
    return true
  } catch (e) {
    return !/not implemented \(O2\)/.test(String((e as Error)?.message))
  }
})()

/** An element changed the way Excalidraw's `mutateElement` changes it: a new version and nonce. */
function bumped(el: SceneElement, patch: Record<string, unknown>): SceneElement {
  return {
    ...el,
    ...patch,
    version: el.version + 1,
    versionNonce: Math.floor(Math.random() * 2 ** 31),
  } as SceneElement
}

describe.skipIf(!available)('the headless client (O2) against the room', () => {
  const clients: HeadlessClient[] = []
  const open = async (wsUrl: string, boardId: string, user: string) => {
    const c = createHeadlessClient({
      syncUrl: wsUrl,
      boardId,
      tab: `tab-${user}`,
      ticket: ticketFor(boardId, user),
    })
    clients.push(c)
    await c.connect()
    return c
  }
  /** Pushes everything now and waits until it is acked (the core coalesces edits for up to 50 ms). */
  const settle = async (c: HeadlessClient) => {
    c.core.flush()
    await c.saved(20_000)
  }
  /** Waits until `c` has processed the server clock `clock`. */
  const reach = async (c: HeadlessClient, clock: number) => {
    const deadline = Date.now() + 10_000
    while (c.core.clock < clock && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
    expect(c.core.clock).toBeGreaterThanOrEqual(clock)
  }
  const converge = async (st: Awaited<ReturnType<typeof h.stack>>, boardId: string, cs: HeadlessClient[]) => {
    for (const c of cs) await settle(c)
    const snap = await st.snapshot(boardId)
    const digest = await hashElements(snap.elements)
    for (const c of cs) {
      const deadline = Date.now() + 10_000
      while ((await hashElements(c.core.elements().values())) !== digest && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 50))
      expect(await hashElements(c.core.elements().values())).toBe(digest)
    }
    expect(checkInvariants(snap.elements)).toEqual([])
    return snap
  }

  it('B10 subset: a receiving-only client pushes nothing while two others edit; everyone converges', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const A = await open(st.server.wsUrl, b, 'alice')
    const B = await open(st.server.wsUrl, b, 'bob')
    const C = await open(st.server.wsUrl, b, 'carol')
    A.edit((s) => {
      for (let i = 0; i < 10; i++) s.set(`a${i}`, rect(`a${i}`, { x: i * 20 }) as SceneElement)
    })
    await settle(A)
    expect(A.core.pushLog().length).toBeGreaterThan(0)
    await reach(B, A.core.clock)
    B.edit((s) => {
      for (let i = 0; i < 10; i += 2) s.set(`a${i}`, bumped(s.get(`a${i}`) as SceneElement, { y: 300 }))
    })
    A.edit((s) => {
      for (let i = 1; i < 10; i += 2)
        s.set(`a${i}`, bumped(s.get(`a${i}`) as SceneElement, { strokeColor: '#e03131' }))
      s.set('a9', bumped(s.get('a9') as SceneElement, { isDeleted: true }))
    })
    await converge(st, b, [A, B, C])
    expect(C.core.pushLog()).toEqual([])
  })

  it('B10: A and B each create 50 notes at the top of the order at once; C pushes 0 ops; keys unique', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const A = await open(st.server.wsUrl, b, 'alice')
    const B = await open(st.server.wsUrl, b, 'bob')
    const C = await open(st.server.wsUrl, b, 'carol')
    const notes = (who: string) => (s: Map<string, SceneElement>) => {
      for (let i = 0; i < 50; i++) s.set(`${who}${i}`, note(`${who}${i}`) as SceneElement)
    }
    A.edit(notes('na'))
    B.edit(notes('nb'))
    const snap = await converge(st, b, [A, B, C])
    expect(C.core.pushLog()).toEqual([])
    const keys = snap.elements.filter((e) => !e.isDeleted).map((e) => e.index)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('rule 7 through the core: B moves a target and pushes no arrow op; the server re-snaps the arrow', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const A = await open(st.server.wsUrl, b, 'alice')
    const X = rect('X', { x: 0, y: 0, width: 200, height: 100 })
    const a1 = arrow('A1', {
      x: 205,
      y: 50,
      width: 300,
      height: 300,
      points: [
        [0, 0],
        [300, 300],
      ],
    }) as El
    bindArrow(a1, X, null, [1, 0.5])
    A.edit((s) => {
      s.set('X', X as SceneElement)
      s.set('A1', a1 as SceneElement)
    })
    await settle(A)
    const B = await open(st.server.wsUrl, b, 'bob')
    await reach(B, A.core.clock)
    B.edit((s) => s.set('X', bumped(s.get('X') as SceneElement, { height: 180 })))
    await converge(st, b, [A, B])
    const arrowOps = B.core
      .pushLog()
      .flatMap((p) => p.ops)
      .filter((o) => (o.k === 'p' ? o.id : o.el.id) === 'A1')
    expect(arrowOps).toEqual([])
  })
})

describe.runIf(!available)('the headless client (O2) against the room', () => {
  it.skip("skipped: O2's headless client is still the C0 stub on this branch", () => {})
})
