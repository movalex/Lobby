// B3 L6 4 + 5 (docs/EXCALIDRAW-MIGRATION.md §8.3, §2.9.4), one scenario of the former b3-l6-l10-arrows spec: B drags a frame (a note and an arrow with a free end and a bend) while A types, both orders of the drag and A's fit; B undoes.
// Separate Chromium processes A (types), B and C on one board of a real stack, in a room of its own. The helpers
// (and the method, the commit orders and the deviation) are in b3-l6-l10-arrows-kit.ts.
// Run: SPIKE_B_PORT_BASE=<base> pnpm --filter @draftroom/e2e spike-b b3-l6-l10-arrows-l6-4   (SPIKE_B3_ARROW_REPS, default 20)
import { expect, test } from '@playwright/test'
import { GEOMETRY_TOLERANCE_PX as TOL } from '../../../packages/canvas-schema/src/limits.ts'
import { closeEditor, converge, lc, openEditor, opsFor, pushCount, waitSaved } from './b3-kit.ts'
import {
  A,
  arrowChecks,
  arrowOps,
  B,
  buffer,
  C,
  closeRoom,
  commitClock,
  dist,
  eventCount,
  hp,
  kept,
  LONG,
  l6Setup,
  N,
  noteKept,
  openRoom,
  pointAt,
  r,
  race,
  rec,
  TYPING_LAG,
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

test("L6 4 + 5: B drags frame F (N and an arrow with a free end and a bend) while A types, both orders of the drag and A's fit; B undoes", async () => {
  const rows: Record<string, unknown>[] = []
  for (const order of ['drag-first', 'fit-first'] as const) {
    for (let i = 0; i < N; i++) {
      const s = await l6Setup({ frame: true })
      const F = s.F as string
      const free0 = await pointAt(B(), s.S, -1)
      const bend0 = await pointAt(B(), s.S, 1)
      const f0 = (await lc(B()).get(F)) as unknown as { x: number; y: number }
      const by = { x: 70, y: 45 }
      const from = { A: await pushCount(A()), B: await pushCount(B()) }
      await openEditor(A(), s.n.id)
      await A().keyboard.press('End')
      await typeKeys(' typing')
      await waitSaved(A())
      const at = { A: await pushCount(A()), eA: await eventCount(A()), eB: await eventCount(B()) }
      // A's fit (keystrokes that re-lay the label out) and B's frame drag on one barrier; the side that
      // must commit second goes through the relay
      await race(
        order === 'drag-first' ? A() : B(),
        () => hp(B(), 'dragFrame', F, by),
        () => typeKeys(LONG),
        TYPING_LAG,
      )
      await typeKeys(' more')
      const typed = await buffer()
      await closeEditor(A())
      // every map equals the snapshot first: the checks then read the final state in every browser
      await converge(r)
      const bad = [
        ...(await noteKept(s.n.id, { x: s.at.x + by.x, y: s.at.y + by.y })),
        ...(await arrowChecks(s.S, { point: { i: -1, at: [free0[0] + by.x, free0[1] + by.y] } })),
      ]
      for (const b of r.browsers) {
        const bend = await pointAt(b.page, s.S, 1)
        if (!(dist(bend, [bend0[0] + by.x, bend0[1] + by.y]) <= TOL))
          bad.push(`${b.name} bend ${JSON.stringify(bend)}`)
        const a = (await lc(b.page).get(s.S)) as unknown as { frameId: string | null }
        const ab = await lc(b.page).bounds(s.S)
        const fb = await lc(b.page).bounds(F)
        if (a.frameId !== F) bad.push(`${b.name} frameId ${a.frameId}`)
        if (
          !ab ||
          !fb ||
          ab.x < fb.x ||
          ab.y < fb.y ||
          ab.x + ab.width > fb.x + fb.width ||
          ab.y + ab.height > fb.y + fb.height
        )
          bad.push(`${b.name} arrow outside F`)
      }
      const fNow = (await lc(C()).get(F)) as unknown as { x: number; y: number }
      if (!(Math.abs(fNow.x - (f0.x + by.x)) <= TOL && Math.abs(fNow.y - (f0.y + by.y)) <= TOL))
        bad.push(`F at ${fNow.x},${fNow.y}`)
      const aArrow = await arrowOps(A(), [s.S], from.A)
      const bS = (await opsFor(B(), s.S, from.B)).length
      const intact = await textIntact(s.n.label, typed)
      const cf = await commitClock(A(), s.n.label as string, at.A, at.eA)
      const cd = await commitClock(B(), s.n.id, from.B, at.eB)
      const committed =
        cf === null || cd === null ? `unknown (fit ${cf}, drag ${cd})` : cd < cf ? 'drag-first' : 'fit-first'
      // 5: B undoes the frame drag: F, N and the arrow back by F's offset; the bound end on N's edge
      const t = await undo(B())
      const undoBad = await arrowChecks(s.S, { point: { i: -1, at: free0 } })
      const fBack = (await lc(C()).get(F)) as unknown as { x: number; y: number }
      if (!(Math.abs(fBack.x - f0.x) <= TOL && Math.abs(fBack.y - f0.y) <= TOL))
        undoBad.push(`F back at ${fBack.x},${fBack.y}`)
      const ok =
        bad.length === 0 &&
        aArrow === 0 &&
        bS === 1 &&
        intact &&
        committed === order &&
        undoBad.length === 0 &&
        kept(t).length === 0
      rec(rows, { order, committed, i, ok, bad, aArrow, bS, intact, undoBad, undoToasts: t })
      await converge(r)
    }
  }
  console.log('B3-L6.4', JSON.stringify({ n: rows.length, failed: rows.filter((x) => !x.ok).slice(0, 6) }))
  expect(rows.filter((x) => !x.ok)).toEqual([])
})
