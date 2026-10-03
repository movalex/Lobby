// W5-ENG-2 (wave C, C2; CONTRACTS_REV 11, push receipts): the V1 verifier's last lost-edit residuals as
// real-room probes, the real engine core (headless) through a frame-dropping proxy against the real sync
// server process. Each failed before receipts (the counting rule could not decide them):
//   L-R1  A's move never reaches the room (half-open uplink), B moves the element twice meanwhile: A's
//         move is replayed (an offline change, the later arrival wins), nobody is told it was superseded;
//   L-R2  A's move lands but its ack (and its changes) are lost, B moves twice after: B's last move stays
//         and A is told; the same with nobody else writing: kept, nothing sent again, no notice;
//   DB2   two writes of one board-document key in one round trip: the first lands with its ack lost, the
//         second never arrives: the second is stored, nobody is told anything.
// V1_REPS (default 3).

import { describe, expect, it } from 'vitest'
import type { CoreEvent } from '../../../web/src/canvas/sync/core/engine.ts'
import type { SceneElement } from '../../../web/src/canvas/sync/types.ts'
import { rect } from '../element-room/support/elements.ts'
import { type ElementStack, newBoardId, useElementHarness } from '../element-room/support/stack.ts'
import { callInternal } from '../harness/tickets.ts'
import { headless, sleep, startProxy, vlog } from './support.ts'

const h = useElementHarness()
const REPS = Number(process.env.V1_REPS ?? 3)
const T = 600_000

const supersededOf = (events: CoreEvent[]) =>
  events.filter((e) => e.kind === 'superseded').map((e) => (e.kind === 'superseded' ? e.id : ''))

async function storedX(st: ElementStack, b: string, id: string): Promise<number> {
  const snap = await st.snapshot(b)
  return (snap.elements.find((e) => e.id === id) as { x: number }).x
}
async function storedDoc(st: ElementStack, b: string): Promise<Record<string, unknown>> {
  const res = await callInternal(st.server.url, 'GET', `/internal/boards/${b}/snapshot`)
  return ((await res.json()) as { doc: Record<string, unknown> }).doc
}

describe('W5-ENG-2 through the real room: lost pushes decided by their receipts', () => {
  it(
    "L-R1: A's move never arrives, B moves the element twice meanwhile: A's move is replayed, nobody is told",
    async () => {
      const st = await h.stack()
      const out: Record<string, unknown>[] = []
      for (let rep = 0; rep < REPS; rep++) {
        const b = newBoardId()
        const px = await startProxy(st.server.wsUrl)
        const A = headless(px.url, b, 'alice')
        await A.connect()
        const B = await st.client({ boardId: b, user: 'bob' })
        const X = `x${rep}r`
        A.edit((m) => m.set(X, rect(X, { x: 0, y: 0 }) as unknown as SceneElement))
        A.core.flush()
        await A.saved()
        await B.until(() => B.confirmed.has(X), 'B sees X')
        const events: CoreEvent[] = []
        A.core.on((e) => events.push(e))
        px.dropUp = true // half-open: nothing A sends arrives
        A.change(X, { x: 111 })
        A.core.flush()
        await sleep(200)
        for (const x of [222, 333])
          await B.push([{ k: 'p', id: X, pv: B.confirmed.get(X)?.version, g: { pos: { x, y: 0 } } }])
        px.cutAll()
        px.dropUp = false
        await sleep(50)
        await A.saved(20_000)
        await sleep(200)
        out.push({
          rep,
          stored: await storedX(st, b, X),
          aLocal: (A.scene.get(X) as unknown as { x: number }).x,
          superseded: supersededOf(events),
        })
        await A.close()
        B.close()
        await px.close()
      }
      vlog('L-R1', JSON.stringify(out))
      // before rev 11: stored 333 and A told "superseded" (the two other writes made it undecidable)
      expect(out.filter((o) => o.stored !== 111 || o.aLocal !== 111)).toEqual([])
      expect(out.filter((o) => (o.superseded as string[]).length)).toEqual([])
    },
    T,
  )

  it(
    'L-R2: a push lost with its ack: B wrote twice after it, B stays and A is told; nobody wrote after, kept quietly',
    async () => {
      const st = await h.stack()
      const out: Record<string, unknown>[] = []
      for (let rep = 0; rep < REPS; rep++) {
        for (const others of [2, 0]) {
          const b = newBoardId()
          const px = await startProxy(st.server.wsUrl)
          const A = headless(px.url, b, 'alice')
          await A.connect()
          const B = await st.client({ boardId: b, user: 'bob' })
          const X = `x${rep}l${others}`
          A.edit((m) => m.set(X, rect(X, { x: 0, y: 0 }) as unknown as SceneElement))
          A.core.flush()
          await A.saved()
          await B.until(() => B.confirmed.has(X), 'B sees X')
          const events: CoreEvent[] = []
          A.core.on((e) => events.push(e))
          px.dropDown = true // its ack and changes are lost
          A.change(X, { x: 111 })
          A.core.flush()
          await B.until(() => (B.confirmed.get(X) as { x?: number } | undefined)?.x === 111, 'A landed')
          for (const x of [222, 333].slice(0, others))
            await B.push([{ k: 'p', id: X, pv: B.confirmed.get(X)?.version, g: { pos: { x, y: 0 } } }])
          const pushesBefore = A.core.pushLog().length
          px.cutAll()
          px.dropDown = false
          await sleep(50)
          await A.saved(20_000)
          await sleep(200)
          out.push({
            rep,
            others,
            stored: await storedX(st, b, X),
            superseded: supersededOf(events),
            sentAgain: A.core.pushLog().length - pushesBefore,
          })
          await A.close()
          B.close()
          await px.close()
        }
      }
      vlog('L-R2', JSON.stringify(out))
      for (const o of out) {
        if (o.others === 2) {
          expect(o.stored, JSON.stringify(o)).toBe(333)
          expect(o.superseded, JSON.stringify(o)).toEqual([expect.stringMatching(/^x\d+l2$/)])
        } else {
          expect(o.stored, JSON.stringify(o)).toBe(111)
          expect(o.superseded, JSON.stringify(o)).toEqual([])
          expect(o.sentAgain, JSON.stringify(o)).toBe(0)
        }
      }
    },
    T,
  )

  it(
    'DB2: two writes of one doc key in one round trip, the first landed with its ack lost, the second never arrived: the second is stored, nobody is told',
    async () => {
      const st = await h.stack()
      const out: Record<string, unknown>[] = []
      for (let rep = 0; rep < REPS; rep++) {
        const b = newBoardId()
        const px = await startProxy(st.server.wsUrl)
        const A = headless(px.url, b, 'alice')
        await A.connect()
        const key = `tagDef:topic${rep}`
        const red = { name: `topic${rep}`, color: 'red' }
        const blue = { name: `topic${rep}`, color: 'blue' }
        A.core.setDoc({ [key]: { name: `topic${rep}`, color: 'green' } })
        A.core.flush()
        await A.saved()
        const events: CoreEvent[] = []
        A.core.on((e) => events.push(e))
        // a slow uplink: red reaches the room after 1.5 s, blue (sent 0.6 s later) after 2.1 s
        px.delayUpMs = 1_500
        A.core.setDoc({ [key]: red })
        A.core.flush()
        await sleep(600)
        A.core.setDoc({ [key]: blue })
        A.core.flush()
        px.dropDown = true // red's ack (and its changes) are lost
        const deadline = Date.now() + 10_000
        let landed = false
        while (Date.now() < deadline) {
          const doc = await storedDoc(st, b)
          if ((doc[key] as { color?: string } | undefined)?.color === 'red') {
            landed = true
            break
          }
          await sleep(20)
        }
        // the link breaks before blue arrives (its delayed send then finds no upstream)
        px.cutAll()
        px.dropDown = false
        px.delayUpMs = 0
        await sleep(50)
        await A.saved(20_000)
        await sleep(300)
        const doc = await storedDoc(st, b)
        out.push({
          rep,
          redLandedBeforeTheCut: landed,
          stored: (doc[key] as { color?: string } | undefined)?.color,
          local: (A.core.doc().get(key) as { color?: string } | undefined)?.color,
          superseded: supersededOf(events),
        })
        await A.close()
        await px.close()
      }
      vlog('DB2', JSON.stringify(out))
      expect(out.filter((o) => !o.redLandedBeforeTheCut)).toEqual([])
      // before rev 11: stored red, and A told "someone else changed a board setting"
      expect(out.filter((o) => o.stored !== 'blue' || o.local !== 'blue')).toEqual([])
      expect(out.filter((o) => (o.superseded as string[]).length)).toEqual([])
    },
    T,
  )
})
