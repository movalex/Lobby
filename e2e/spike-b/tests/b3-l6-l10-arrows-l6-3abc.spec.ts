// B3 L6 3/3a-3c + 5 (docs/EXCALIDRAW-MIGRATION.md §8.3, §2.9.4), one scenario of the former b3-l6-l10-arrows spec: C's free end, loop midpoint or fixed segment survives B's resize while A types, both orders; C undoes.
// Separate Chromium processes A (types), B and C on one board of a real stack, in a room of its own. The helpers
// (and the method, the commit orders and the deviation) are in b3-l6-l10-arrows-kit.ts.
// Run: SPIKE_B_PORT_BASE=<base> pnpm --filter @draftroom/e2e spike-b b3-l6-l10-arrows-l6-3abc   (SPIKE_B3_ARROW_REPS, default 20)
import { expect, test } from '@playwright/test'
import { closeEditor, converge, lc, openEditor, pushCount } from './b3-kit.ts'
import {
  A,
  arrowChecks,
  arrowOps,
  arrowsOf,
  B,
  buffer,
  C,
  closeRoom,
  committedFirst,
  dragSeg,
  eventCount,
  fixSegment,
  type Geo,
  hp,
  kept,
  LONG,
  l6Setup,
  moved,
  N,
  noteKept,
  ORDERS,
  openRoom,
  type Pt,
  pointAt,
  r,
  raceBC,
  rec,
  rejectsSince,
  sub,
  textIntact,
  typeKeys,
  undo,
  type Want,
} from './b3-l6-l10-arrows-kit.ts'

test.describe.configure({ mode: 'serial' })
test.setTimeout(180 * 60_000)

test.beforeAll(async () => {
  await openRoom()
})
test.afterAll(async () => {
  await closeRoom()
})

test("L6 3/3a-3c + 5: C's free end, loop midpoint or fixed segment survives B's resize while A types, both orders; C undoes", async () => {
  const rows: Record<string, unknown>[] = []
  for (const kind of ['3a-free-end', '3b-midpoint', '3c-segment'] as const) {
    for (const order of ORDERS) {
      for (let i = 0; i < N; i++) {
        const s = await l6Setup({ loop: kind === '3b-midpoint' })
        let target = s.S
        let want: Want
        let before: Want
        let drag: () => Promise<unknown>
        if (kind === '3a-free-end') {
          const p0 = await pointAt(C(), s.S, -1)
          const to: Pt = [p0[0] + 40, p0[1] + 90]
          before = { point: { i: -1, at: p0 } }
          want = { point: { i: -1, at: to } }
          drag = () => hp(C(), 'dragPoint', s.S, -1, to)
        } else if (kind === '3b-midpoint') {
          target = s.K as string
          const m0 = await pointAt(C(), target, 1)
          const s0 = await pointAt(C(), target, 0)
          const to: Pt = [m0[0] + 50, m0[1] - 30]
          before = { rel: { i: 1, rel: sub(m0, s0) } }
          want = { rel: { i: 1, rel: sub(to, s0) } }
          drag = () => hp(C(), 'dragPoint', target, 1, to)
        } else {
          target = s.E as string
          const seg = await fixSegment(C(), target)
          before = { seg: moved(seg, 0), orthogonal: true }
          want = { seg: moved(seg), orthogonal: true }
          drag = () => dragSeg(C(), target, seg)
        }
        const from = { A: await pushCount(A()), B: await pushCount(B()), C: await pushCount(C()) }
        const ev = await eventCount(C())
        const evB = await eventCount(B())
        await openEditor(A(), s.n.id)
        await A().keyboard.press('End')
        await typeKeys(LONG)
        const nb = (await lc(B()).get(s.n.id)) as unknown as Geo
        const w = nb.width + 70
        await raceBC(
          order,
          () =>
            hp(B(), 'editTarget', s.n.id, { width: w, baseHeight: 300, height: Math.max(300, nb.height) }),
          drag,
        )
        await typeKeys(' more')
        const typed = await buffer()
        await closeEditor(A())
        // every map equals the snapshot first: the checks then read the final state in every browser
        await converge(r)
        const bad = [
          ...(await noteKept(s.n.id, { width: w, baseHeight: 300 })),
          ...(await arrowChecks(target, want)),
        ]
        for (const a of arrowsOf(s)) if (a !== target) bad.push(...(await arrowChecks(a)))
        const aArrow = await arrowOps(A(), arrowsOf(s), from.A)
        const bArrow = await arrowOps(B(), arrowsOf(s), from.B)
        const cArrow = await arrowOps(C(), [target], from.C)
        const cOps = (await pushCount(C())) - from.C
        const cRejects = await rejectsSince(C(), ev)
        const intact = await textIntact(s.n.label, typed)
        const committed = await committedFirst(s.n.id, target, { B: from.B, C: from.C, eB: evB, eC: ev })
        // 5: C undoes its drag after B's write landed: the dragged point back, bound ends on N's current edge
        const t = await undo(C())
        const undoBad = await arrowChecks(target, before)
        const ok =
          bad.length === 0 &&
          aArrow === 0 &&
          bArrow === 0 &&
          cArrow === 1 &&
          cOps === 1 &&
          cRejects.length === 0 &&
          intact &&
          committed === order &&
          undoBad.length === 0 &&
          kept(t).length === 0
        rec(rows, {
          kind,
          order,
          committed,
          i,
          ok,
          bad,
          aArrow,
          bArrow,
          cArrow,
          cOps,
          cRejects,
          intact,
          undoBad,
          undoToasts: t,
        })
        await converge(r)
      }
    }
  }
  console.log('B3-L6.3a-c', JSON.stringify({ n: rows.length, failed: rows.filter((x) => !x.ok).slice(0, 6) }))
  expect(rows.filter((x) => !x.ok)).toEqual([])
})
