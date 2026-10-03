// B3 L10 1-2 + 4 (docs/EXCALIDRAW-MIGRATION.md §8.3, §2.9.4), one scenario of the former b3-l6-l10-arrows spec: A types in a rectangle's label until it grows while B resizes it; then with C's free-end drag, both orders; C undoes.
// Separate Chromium processes A (types), B and C on one board of a real stack, in a room of its own. The helpers
// (and the method, the commit orders and the deviation) are in b3-l6-l10-arrows-kit.ts.
// Run: SPIKE_B_PORT_BASE=<base> pnpm --filter @draftroom/e2e spike-b b3-l6-l10-arrows-l10-1-2   (SPIKE_B3_ARROW_REPS, default 20)
import { expect, test } from '@playwright/test'
import { GEOMETRY_TOLERANCE_PX as TOL } from '../../../packages/canvas-schema/src/limits.ts'
import { closeEditor, converge, everywhere, lc, pushCount, waitSaved } from './b3-kit.ts'
import {
  A,
  arrow,
  arrowChecks,
  arrowOps,
  B,
  buffer,
  C,
  closeRoom,
  committedFirst,
  eventCount,
  type Geo,
  hp,
  kept,
  labelOf,
  N,
  ORDERS,
  type Order,
  openOn,
  openRoom,
  type Pt,
  pointAt,
  r,
  raceBC,
  rec,
  spot,
  textIntact,
  typeKeys,
  undo,
} from './b3-l6-l10-arrows-kit.ts'

test.describe.configure({ mode: 'serial' })
test.setTimeout(180 * 60_000)

test.beforeAll(async () => {
  await openRoom()
})
test.afterAll(async () => {
  await closeRoom()
})

test("L10 1-2 + 4: A types in a rectangle's label until it grows while B resizes it; then with C's free-end drag, both orders; C undoes", async () => {
  const rows: Record<string, unknown>[] = []
  for (const withC of [false, true]) {
    for (const order of withC ? ORDERS : (['C-first'] as Order[])) {
      for (let i = 0; i < N; i++) {
        const at = spot()
        const R = await lc(A()).create('rectangle', {
          x: at.x,
          y: at.y,
          width: 220,
          height: 80,
          roughness: 0,
        })
        await everywhere(r.browsers, R)
        const S = await arrow(
          A(),
          {
            x: at.x + 220,
            y: at.y + 40,
            points: [
              [0, 0],
              [240, 60],
            ],
          },
          { id: R, at: [1, 0.5] },
          null,
        )
        const p0 = await pointAt(C(), S, -1)
        const to: Pt = [p0[0] + 60, p0[1] - 50]
        const from = { A: await pushCount(A()), B: await pushCount(B()), C: await pushCount(C()) }
        // A opens the editor on the empty rectangle (P1 makes its label) and types until it grows
        await openOn(R)
        await typeKeys('a label that wraps onto many lines so the rectangle has to grow')
        const rb = (await lc(B()).get(R)) as unknown as Geo
        const w = rb.width + 90
        const resize = () => hp(B(), 'editTarget', R, { width: w })
        const ev = { B: from.B, C: from.C, eB: await eventCount(B()), eC: await eventCount(C()) }
        if (withC) await raceBC(order, resize, () => hp(C(), 'dragPoint', S, -1, to))
        else {
          await resize()
          await waitSaved(B())
        }
        await typeKeys(' and again')
        const typed = await buffer()
        await closeEditor(A())
        // every map equals the snapshot first: the checks then read the final state in every browser
        await converge(r)
        const label = await labelOf(C(), R)
        const bad = await arrowChecks(S, withC ? { point: { i: -1, at: to } } : {})
        for (const b of r.browsers) {
          const e = (await lc(b.page).get(R)) as unknown as Geo
          const lb = label ? await lc(b.page).bounds(label) : null
          if (!(Math.abs(e.width - w) <= TOL)) bad.push(`${b.name} width ${e.width} want ${w}`)
          if (!lb || lb.height > e.height + TOL)
            bad.push(`${b.name} label does not fit: ${JSON.stringify(lb)} in ${e.height}`)
        }
        const intact = await textIntact(label, typed)
        const aArrow = await arrowOps(A(), [S], from.A)
        const bArrow = await arrowOps(B(), [S], from.B)
        const cOps = (await pushCount(C())) - from.C
        const committed = withC ? await committedFirst(R, S, ev) : null
        let undoBad: string[] = []
        let t: string[] = []
        if (withC) {
          t = await undo(C())
          undoBad = await arrowChecks(S, { point: { i: -1, at: p0 } })
        }
        const ok =
          bad.length === 0 &&
          intact &&
          aArrow === 0 &&
          bArrow === 0 &&
          cOps === (withC ? 1 : 0) &&
          (!withC || committed === order) &&
          undoBad.length === 0 &&
          kept(t).length === 0
        rec(rows, {
          withC,
          order,
          committed,
          i,
          ok,
          bad,
          intact,
          aArrow,
          bArrow,
          cOps,
          undoBad,
          undoToasts: t,
        })
        await converge(r)
      }
    }
  }
  console.log('B3-L10.1-2', JSON.stringify({ n: rows.length, failed: rows.filter((x) => !x.ok).slice(0, 6) }))
  expect(rows.filter((x) => !x.ok)).toEqual([])
})
