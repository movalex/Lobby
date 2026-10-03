// B3 L6 1-2 (docs/EXCALIDRAW-MIGRATION.md §8.3, §2.9.4), one scenario of the former b3-l6-l10-arrows spec: B resizes (and moves, rotated 15°) a note while A types; the arrows follow through the server only.
// Separate Chromium processes A (types), B and C on one board of a real stack, in a room of its own. The helpers
// (and the method, the commit orders and the deviation) are in b3-l6-l10-arrows-kit.ts.
// Run: SPIKE_B_PORT_BASE=<base> pnpm --filter @draftroom/e2e spike-b b3-l6-l10-arrows-l6-1-2   (SPIKE_B3_ARROW_REPS, default 20)
import { expect, test } from '@playwright/test'
import { GEOMETRY_TOLERANCE_PX as TOL } from '../../../packages/canvas-schema/src/limits.ts'
import { closeEditor, converge, everywhere, lc, openEditor, pushCount, waitSaved } from './b3-kit.ts'
import {
  A,
  arrowChecks,
  arrowOps,
  arrowsOf,
  B,
  buffer,
  C,
  closeRoom,
  type Geo,
  hp,
  LONG,
  l6Setup,
  N,
  noteKept,
  only,
  openRoom,
  r,
  rec,
  rewrappedLive,
  textIntact,
  typeKeys,
} from './b3-l6-l10-arrows-kit.ts'

test.describe.configure({ mode: 'serial' })
test.setTimeout(180 * 60_000)

test.beforeAll(async () => {
  await openRoom()
})
test.afterAll(async () => {
  await closeRoom()
})

test('L6 1-2: B resizes N while A types (and moves N rotated 15°); arrows follow through the server only', async () => {
  const rows: Record<string, unknown>[] = []
  for (const variant of ['resize', 'rotated-move'] as const) {
    for (let i = 0; i < N; i++) {
      const s = await l6Setup(variant === 'rotated-move' ? { rotate: (15 * Math.PI) / 180 } : {})
      const from = { A: await pushCount(A()), B: await pushCount(B()), C: await pushCount(C()) }
      await openEditor(A(), s.n.id)
      await A().keyboard.press('End')
      await typeKeys(LONG)
      await everywhere(only('B'), s.n.label as string, (e) =>
        ((e as { originalText?: string }).originalText ?? '').endsWith('all'),
      )
      const nb = (await lc(B()).get(s.n.id)) as unknown as Geo
      const want =
        variant === 'resize'
          ? { width: nb.width + 80, baseHeight: 260, x: nb.x, y: nb.y }
          : { width: nb.width, baseHeight: nb.baseHeight, x: nb.x + 60, y: nb.y + 40 }
      if (variant === 'resize')
        await hp(B(), 'editTarget', s.n.id, {
          width: want.width,
          baseHeight: 260,
          height: Math.max(260, nb.height),
        })
      else await hp(B(), 'editTarget', s.n.id, { x: want.x, y: want.y })
      await waitSaved(B())
      await everywhere(
        only('A'),
        s.n.id,
        (e) => Math.abs((e.width ?? 0) - want.width) <= TOL && Math.abs((e.x ?? 0) - want.x) <= TOL,
      )
      await typeKeys(' more')
      const live = await rewrappedLive(s.n.id, want.width)
      const typed = await buffer()
      await closeEditor(A())
      // every map equals the snapshot first: the checks then read the final state in every browser
      await converge(r)
      const bad = [...(await noteKept(s.n.id, want))]
      for (const a of arrowsOf(s)) bad.push(...(await arrowChecks(a, { orthogonal: a === s.E })))
      const aArrow = await arrowOps(A(), arrowsOf(s), from.A)
      const bArrow = await arrowOps(B(), arrowsOf(s), from.B)
      const cOps = (await pushCount(C())) - from.C
      const intact = await textIntact(s.n.label, typed)
      const ok = bad.length === 0 && aArrow === 0 && bArrow === 0 && cOps === 0 && intact && live
      rec(rows, { variant, i, ok, bad, aArrow, bArrow, cOps, intact, live })
      await converge(r)
    }
  }
  console.log('B3-L6.1-2', JSON.stringify({ n: rows.length, failed: rows.filter((x) => !x.ok).slice(0, 6) }))
  expect(rows.filter((x) => !x.ok)).toEqual([])
})
