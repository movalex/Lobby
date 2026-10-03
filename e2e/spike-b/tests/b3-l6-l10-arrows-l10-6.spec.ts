// B3 L10 6 (docs/EXCALIDRAW-MIGRATION.md §8.3, §2.9.4), one scenario of the former b3-l6-l10-arrows spec: B turns a rectangle 90° while C drags its elbow arrow's fixed segment, live and as an offline replay, both orders; undo.
// Separate Chromium processes A (types), B and C on one board of a real stack, in a room of its own. The helpers
// (and the method, the commit orders and the deviation) are in b3-l6-l10-arrows-kit.ts.
// Run: SPIKE_B_PORT_BASE=<base> pnpm --filter @draftroom/e2e spike-b b3-l6-l10-arrows-l10-6   (SPIKE_B3_ARROW_REPS, default 20)
import { expect, test } from '@playwright/test'
import { closeEditor, converge, everywhere, lc, opsFor, pushCount } from './b3-kit.ts'
import {
  A,
  arrow,
  arrowChecks,
  arrowOps,
  B,
  C,
  closeRoom,
  eventCount,
  fixSegment,
  kept,
  moved,
  N,
  ORDERS,
  openOn,
  openRoom,
  r,
  rec,
  rejectsSince,
  rotateVsSegment,
  spot,
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

test("L10 6: B turns a rectangle 90° while C drags its elbow arrow's fixed segment, live and as an offline replay, both orders; undo", async () => {
  const rows: Record<string, unknown>[] = []
  for (const mode of ['live', 'replay'] as const) {
    for (const order of ORDERS) {
      for (let i = 0; i < N; i++) {
        const at = spot()
        const R = await lc(A()).create('rectangle', {
          x: at.x,
          y: at.y,
          width: 220,
          height: 120,
          roughness: 0,
        })
        const M = await lc(A()).create('rectangle', {
          x: at.x + 560,
          y: at.y + 420,
          width: 150,
          height: 100,
          roughness: 0,
        })
        await everywhere(r.browsers, M)
        const E = await arrow(
          A(),
          {
            x: at.x + 220,
            y: at.y + 60,
            points: [
              [0, 0],
              [340, 410],
            ],
            elbowed: true,
          },
          { id: R, at: [1, 0.5] },
          { id: M, at: [0, 0.5] },
        )
        const seg = await fixSegment(C(), E)
        const from = { A: await pushCount(A()), B: await pushCount(B()), C: await pushCount(C()) }
        const ev = await eventCount(C())
        await openOn(R)
        await typeKeys('label')
        const row = await rotateVsSegment(mode, order, R, E, seg)
        await typeKeys(' more')
        await closeEditor(A())
        // every map equals the snapshot first: the checks then read the final state in every browser
        await converge(r)
        const bad = await arrowChecks(E, { seg: moved(seg), orthogonal: true })
        if (row.committed !== order) bad.push(`committed ${row.committed}`)
        const cRejects = await rejectsSince(C(), ev)
        if (cRejects.length) bad.push(`C rejects ${JSON.stringify(cRejects)}`)
        const cE = (await opsFor(C(), E, from.C)).length
        if (cE !== 1) bad.push(`C pushed E ${cE} times`)
        const aArrow = await arrowOps(A(), [E], from.A)
        const bArrow = await arrowOps(B(), [E], from.B)
        if (aArrow || bArrow) bad.push(`arrow ops A ${aArrow} B ${bArrow}`)
        const t = await undo(C())
        const undoBad = await arrowChecks(E, { seg: moved(seg, 0), orthogonal: true })
        if (kept(t).length) undoBad.push(`kept ${JSON.stringify(t)}`)
        const ok = bad.length === 0 && undoBad.length === 0
        rec(rows, { mode, order, i, ok, bad, undoBad, ...row })
        await converge(r)
      }
    }
  }
  console.log('B3-L10.6', JSON.stringify({ n: rows.length, failed: rows.filter((x) => !x.ok).slice(0, 6) }))
  expect(rows.filter((x) => !x.ok)).toEqual([])
})
