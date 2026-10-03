// B3 L10 3-5 (docs/EXCALIDRAW-MIGRATION.md §8.3, §2.9.4), one scenario of the former b3-l6-l10-arrows spec: an arrow bound to a free text follows its box on every write while A types; C's free end survives; a centred text moved by B keeps B's move. SPIKE_B3_L10_VARIANTS, a comma list of 3-left,5-centred-moved,5-slow-typist, runs some of them (a filtered run is a repro aid, never the check's evidence).
// Separate Chromium processes A (types), B and C on one board of a real stack, in a room of its own. The helpers
// (and the method, the commit orders and the deviation) are in b3-l6-l10-arrows-kit.ts.
// Run: SPIKE_B_PORT_BASE=<base> pnpm --filter @draftroom/e2e spike-b b3-l6-l10-arrows-l10-3-5   (SPIKE_B3_ARROW_REPS, default 20)
import { expect, type Page, test } from '@playwright/test'
import { GEOMETRY_TOLERANCE_PX as TOL } from '../../../packages/canvas-schema/src/limits.ts'
import { closeEditor, converge, everywhere, lc, openEditor, pushCount, waitSaved } from './b3-kit.ts'
import {
  A,
  arrow,
  arrowChecks,
  arrowOps,
  aTrace,
  B,
  boardLogCount,
  buffer,
  C,
  closeRoom,
  commitClock,
  eventCount,
  events,
  type Geo,
  hp,
  kept,
  N,
  openRoom,
  type Pt,
  pointAt,
  r,
  race,
  rec,
  SLOW_KEY_MS,
  spot,
  TYPING_LAG,
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

test("L10 3-5: an arrow bound to a free text T follows T's box on every write while A types; C's free end survives; a centred T moved by B keeps B's move", async () => {
  const rows: Record<string, unknown>[] = []
  const all = ['3-left', '5-centred-moved', '5-slow-typist'] as const
  const pick = (process.env.SPIKE_B3_L10_VARIANTS ?? '').split(',').filter(Boolean)
  for (const variant of all.filter((v) => !pick.length || pick.includes(v))) {
    const slow = variant === '5-slow-typist'
    for (const order of ['A-first', 'other-first'] as const) {
      for (let i = 0; i < N; i++) {
        const at = spot()
        const T = await lc(A()).create('text', {
          x: at.x,
          y: at.y,
          text: 'free',
          textAlign: variant === '3-left' ? 'left' : 'center',
          roughness: 0,
        })
        await everywhere(r.browsers, T)
        const tb0 = await lc(A()).bounds(T)
        const S = await arrow(
          A(),
          {
            x: (tb0?.x ?? 0) + (tb0?.width ?? 0),
            y: (tb0?.y ?? 0) + (tb0?.height ?? 0) / 2,
            points: [
              [0, 0],
              [250, 80],
            ],
          },
          { id: T, at: [1, 0.5] },
          null,
        )
        const p0 = await pointAt(C(), S, -1)
        const to: Pt = [p0[0] + 40, p0[1] + 60]
        const from = { A: await pushCount(A()), B: await pushCount(B()), C: await pushCount(C()) }
        const evA = await eventCount(A())
        for (const b of r.browsers) await hp(b.page, 'startSampling', [S])
        await openEditor(A(), T)
        await A().keyboard.press('End')
        await typeKeys(' grows')
        await waitSaved(A())
        const other = variant === '3-left' ? C() : B()
        const otherId = variant === '3-left' ? S : T
        const at0 = {
          A: await pushCount(A()),
          O: await pushCount(other),
          eA: await eventCount(A()),
          eO: await eventCount(other),
          lA: await boardLogCount(A()),
        }
        let bMove: { x: number; y: number; w: number; cx: number } | null = null
        const trace: Record<string, unknown> = {}
        if (variant === '3-left')
          await race(
            order === 'A-first' ? other : A(),
            () => typeKeys(' wider and wider'),
            () => hp(C(), 'dragPoint', S, -1, to),
            TYPING_LAG,
          )
        else {
          const tb = (await lc(B()).get(T)) as unknown as Geo
          const move = { x: tb.x + 80, y: tb.y + 50, w: tb.width, cx: tb.x + 80 + tb.width / 2 }
          bMove = move
          await race(
            order === 'A-first' ? other : A(),
            () => typeKeys(' centred text grows', slow ? SLOW_KEY_MS : 4),
            () => hp(B(), 'editTarget', T, { x: move.x, y: move.y }),
            TYPING_LAG,
          )
        }
        const geo = async (p: Page) => {
          const e = (await lc(p).get(T)) as unknown as Geo
          return { x: e.x, w: e.width, cx: e.x + e.width / 2 }
        }
        trace.beforeEnd = { A: await geo(A()), C: await geo(C()) }
        await typeKeys(' end')
        await waitSaved(A())
        trace.afterEnd = { A: await geo(A()), C: await geo(C()) }
        const typed = await buffer()
        await closeEditor(A())
        // every map equals the snapshot first: the checks then read the final state in every browser
        await converge(r)
        trace.closed = { A: await geo(A()) }
        const samples: Record<string, unknown> = {}
        let followMax = 0
        for (const b of r.browsers) {
          const s = await hp<{ max: Record<string, number>; samples: number } | null>(b.page, 'stopSampling')
          samples[b.name] = s
          followMax = Math.max(followMax, s?.max[S] ?? 0)
        }
        const bad = await arrowChecks(S, variant === '3-left' ? { point: { i: -1, at: to } } : {})
        if (!(followMax <= TOL)) bad.push(`follow sampled ${followMax.toFixed(3)} ${JSON.stringify(samples)}`)
        let intact = true
        for (const b of r.browsers)
          if (((await lc(b.page).get(T)) as { originalText?: string } | null)?.originalText !== typed)
            intact = false
        if (bMove)
          for (const b of r.browsers) {
            const e = (await lc(b.page).get(T)) as unknown as Geo
            if (!(Math.abs(e.y - bMove.y) <= TOL)) bad.push(`${b.name} y ${e.y} want ${bMove.y}`)
            // B's move committed first: A's fit (computed before it) is dropped and redone on B's position,
            // so the text grows around the centre B left. A's fit first: B's write (x from B's copy) lands
            // on the grown text; from there A's typing keeps the centre, which lies between the two bounds
            const cx = e.x + e.width / 2
            const lo = bMove.cx
            const hi = bMove.x + e.width / 2
            const inRange =
              order === 'other-first' ? Math.abs(cx - lo) <= TOL : cx >= lo - TOL && cx <= hi + TOL
            if (!inRange)
              bad.push(`${b.name} centre ${cx} want ${order === 'other-first' ? lo : `[${lo}, ${hi}]`}`)
          }
        const refits = (await events(A(), evA)).filter((e) => e.kind === 'refit').length
        // A's side of the race, for the evidence: its pushes of T (seq, base, the fit and the groups), its
        // acks (seq -> commit clock) and refits, and the core's fit_superseded records (ids and numbers only)
        if (bMove) trace.a = await aTrace(T, at0.A, at0.eA, at0.lA)
        const ca = await commitClock(A(), T, at0.A, at0.eA)
        const co = await commitClock(other, otherId, at0.O, at0.eO)
        const committed =
          ca === null || co === null ? `unknown (A ${ca}, other ${co})` : ca < co ? 'A-first' : 'other-first'
        const aArrow = await arrowOps(A(), [S], from.A)
        const bArrow = await arrowOps(B(), [S], from.B)
        const cOps = (await pushCount(C())) - from.C
        let undoBad: string[] = []
        let t: string[] = []
        if (variant === '3-left') {
          t = await undo(C())
          undoBad = await arrowChecks(S, { point: { i: -1, at: p0 } })
        }
        const ok =
          bad.length === 0 &&
          intact &&
          aArrow === 0 &&
          bArrow === 0 &&
          cOps === (variant === '3-left' ? 1 : 0) &&
          committed === order &&
          undoBad.length === 0 &&
          kept(t).length === 0
        rec(rows, {
          variant,
          order,
          committed,
          i,
          ok,
          bad,
          intact,
          aArrow,
          bArrow,
          cOps,
          refits,
          followMax,
          ...(bMove ? { trace, bMove } : {}),
          undoBad,
          undoToasts: t,
        })
        await converge(r)
      }
    }
  }
  console.log('B3-L10.3-5', JSON.stringify({ n: rows.length, failed: rows.filter((x) => !x.ok).slice(0, 6) }))
  expect(rows.filter((x) => !x.ok)).toEqual([])
})
