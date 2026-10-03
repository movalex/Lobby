// B3 L6 3d-3f + 5 (docs/EXCALIDRAW-MIGRATION.md §8.3, §2.9.4), one scenario of the former b3-l6-l10-arrows spec: a 90° turn of the note against C's segment drag (live and offline replay) and a selection rotation against C's free-end drag, both orders.
// Separate Chromium processes A (types), B and C on one board of a real stack, in a room of its own. The helpers
// (and the method, the commit orders and the deviation) are in b3-l6-l10-arrows-kit.ts.
// Run: SPIKE_B_PORT_BASE=<base> pnpm --filter @draftroom/e2e spike-b b3-l6-l10-arrows-l6-3def   (SPIKE_B3_ARROW_REPS, default 20)
import { expect, test } from '@playwright/test'
import { GEOMETRY_TOLERANCE_PX as TOL } from '../../../packages/canvas-schema/src/limits.ts'
import { closeEditor, converge, lc, openEditor, opsFor, pushCount } from './b3-kit.ts'
import {
  A,
  arrowChecks,
  arrowOps,
  arrowsOf,
  B,
  C,
  closeRoom,
  committedFirst,
  dist,
  eventCount,
  fixSegment,
  hp,
  kept,
  l6Setup,
  moved,
  N,
  ORDERS,
  openRoom,
  type Pt,
  pointAt,
  r,
  raceBC,
  rec,
  rejectsSince,
  rotateVsSegment,
  typeKeys,
  undo,
} from './b3-l6-l10-arrows-kit.ts'

test.describe.configure({ mode: 'serial' })
test.setTimeout(180 * 60_000)
// no trace: the config's retain-on-failure records every call of the three launched browsers in the worker, and
// its live heap grew about 3 MB a repetition (L6 1-2, 80 rows: 81 -> 317 MB with it, 78 -> 108 MB without) until
// the worker ran out in a whole-file run. The rows print the evidence (heapMB at the end of each).
test.use({ trace: 'off' })

test.beforeAll(async () => {
  await openRoom()
})
test.afterAll(async () => {
  await closeRoom()
})

test("L6 3d-3f + 5: a 90° turn of N against C's segment drag (live and offline replay) and a selection rotation against C's free-end drag, both orders", async () => {
  const rows: Record<string, unknown>[] = []
  for (const kind of ['3d-turn', '3f-replay', '3e-rotate-selection'] as const) {
    for (const order of ORDERS) {
      for (let i = 0; i < N; i++) {
        const s = await l6Setup()
        const E = s.E as string
        const seg = kind === '3e-rotate-selection' ? null : await fixSegment(C(), E)
        const from = { A: await pushCount(A()), B: await pushCount(B()), C: await pushCount(C()) }
        const ev = await eventCount(C())
        await openEditor(A(), s.n.id)
        await A().keyboard.press('End')
        await typeKeys(' typing')
        const bad: string[] = []
        const row: Record<string, unknown> = { kind, order, i }
        if (seg) {
          Object.assign(
            row,
            await rotateVsSegment(kind === '3d-turn' ? 'live' : 'replay', order, s.n.id, E, seg),
          )
          await typeKeys(' more')
          await closeEditor(A())
          // every map equals the snapshot first: the checks then read the final state in every browser
          await converge(r)
          if (row.committed !== order) bad.push(`committed ${row.committed}`)
          bad.push(
            ...(await arrowChecks(E, { seg: moved(seg), orthogonal: true })),
            ...(await arrowChecks(s.S)),
          )
          const cRejects = await rejectsSince(C(), ev)
          if (cRejects.length) bad.push(`C rejects ${JSON.stringify(cRejects)}`)
          const cE = (await opsFor(C(), E, from.C)).length
          if (cE !== 1) bad.push(`C pushed E ${cE} times`)
          // 5: C's undo finds the renumbered segment by order; then B's undo of the turn leaves C's segment
          const tc = await undo(C())
          const undoC = await arrowChecks(E, { seg: moved(seg, 0), orthogonal: true })
          const tb = await undo(B())
          const undoB = await arrowChecks(E, { seg: moved(seg, 0), orthogonal: true })
          if (kept(tc).length || kept(tb).length) bad.push(`kept: ${JSON.stringify([...tc, ...tb])}`)
          bad.push(...undoC.map((x) => `C undo: ${x}`), ...undoB.map((x) => `B undo: ${x}`))
        } else {
          // 3e: B rotates a selection holding N and S; C drags S's free end
          const p0 = await pointAt(C(), s.S, -1)
          const to: Pt = [p0[0] + 30, p0[1] + 80]
          const versions: { B?: { angle: number; end: Pt }; C?: { angle: number; end: Pt } } = {}
          const at = {
            B: await pushCount(B()),
            C: await pushCount(C()),
            eB: await eventCount(B()),
            eC: await eventCount(C()),
          }
          await raceBC(
            order,
            async () => {
              await hp(B(), 'rotateSelection', [s.n.id, s.S], 0.5)
              const a = (await lc(B()).get(s.S)) as unknown as { angle: number }
              versions.B = { angle: a.angle, end: await pointAt(B(), s.S, -1) }
            },
            async () => {
              await hp(C(), 'dragPoint', s.S, -1, to)
              const a = (await lc(C()).get(s.S)) as unknown as { angle: number }
              versions.C = { angle: a.angle, end: await pointAt(C(), s.S, -1) }
            },
          )
          await closeEditor(A())
          // every map equals the snapshot first: the checks then read the final state in every browser
          await converge(r)
          const stored = (await lc(C()).get(s.S)) as unknown as { angle: number }
          const end = await pointAt(C(), s.S, -1)
          const is = (v?: { angle: number; end: Pt }) =>
            !!v && Math.abs(v.angle - stored.angle) <= 1e-6 && dist(v.end, end) <= TOL
          const whose = is(versions.C) ? 'C' : is(versions.B) ? 'B' : 'mixture'
          row.whose = whose
          row.committed = await committedFirst(s.S, s.S, at)
          if (row.committed !== order) bad.push(`committed ${row.committed}`)
          // the later commit's whole version is stored
          if (whose !== (order === 'C-first' ? 'B' : 'C'))
            bad.push(`stored is ${whose}'s, the later writer is not`)
          if (whose === 'mixture')
            bad.push(`stored ${JSON.stringify({ angle: stored.angle, end })} vs ${JSON.stringify(versions)}`)
          bad.push(...(await arrowChecks(s.S)))
          const bS = (await opsFor(B(), s.S, from.B)).length
          if (bS !== 1) bad.push(`B pushed S ${bS} times`)
          // 5: the earlier writer's undo is skipped as changed (the later version is stored); the later
          // writer's undo then applies
          const later = whose === 'C' ? C() : B()
          const earlier = whose === 'C' ? B() : C()
          const te = await undo(earlier)
          const tl = await undo(later)
          row.undo = { later: tl, earlier: te }
          if (kept(tl).length) bad.push(`later undo kept: ${JSON.stringify(tl)}`)
          if (!kept(te).length) bad.push(`earlier undo not skipped: ${JSON.stringify(te)}`)
          bad.push(...(await arrowChecks(s.S)))
        }
        const aArrow = await arrowOps(A(), arrowsOf(s), from.A)
        const bArrow = await arrowOps(B(), kind === '3e-rotate-selection' ? [E] : arrowsOf(s), from.B)
        if (aArrow || bArrow) bad.push(`arrow ops A ${aArrow} B ${bArrow}`)
        rec(rows, { ...row, ok: bad.length === 0, bad })
        await converge(r)
      }
    }
  }
  console.log('B3-L6.3d-f', JSON.stringify({ n: rows.length, failed: rows.filter((x) => !x.ok).slice(0, 6) }))
  expect(rows.filter((x) => !x.ok)).toEqual([])
})
