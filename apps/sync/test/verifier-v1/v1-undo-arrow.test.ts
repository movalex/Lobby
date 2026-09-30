// The spike B verifier V1's probe (part-3 round), adopted as a regression (V1_REPS, default 3; V1 ran 20): an undo of an arrow's midpoint after its target moved (plan §8.6.8 V1; L6 3b+5),
// through O2's engine core and UndoController (headless) against O1's room in the real server process.
import { describe, expect, it } from 'vitest'
import { UndoController } from '../../../web/src/canvas/history/controller.ts'
import { bump } from '../../../web/src/canvas/sync/headless/scene.ts'
import type { SceneElement } from '../../../web/src/canvas/sync/types.ts'
import { newBoardId, useElementHarness } from '../element-room/support/stack.ts'
import {
  bind,
  cloneScene,
  dist,
  dragPoint,
  type El,
  editTarget,
  followError,
  glob,
  newArrow,
  newRect,
  type Pt,
  type Scene,
  TOL,
  useServerTextMetrics,
} from '../room/arrows/support/excalidraw.ts'
import { headless, sleep, until, vlog } from './support.ts'

const h = useElementHarness()
const REPS = Number(process.env.V1_REPS ?? 3)
useServerTextMetrics()

describe('V1 undo of a midpoint after the target moved', () => {
  it('N19: C bends a curved arrow bound at both ends; B then moves/resizes/rotates the start target; C undoes: no change kept, the midpoint back in scene coordinates, both ends on the targets', async () => {
    const st = await h.stack()
    const out: Record<string, unknown>[] = []
    for (let rep = 0; rep < REPS; rep++) {
      const b = newBoardId()
      const B = headless(st.server.url, b, 'bob')
      const C = headless(st.server.url, b, 'carol')
      await B.connect()
      await C.connect()
      const undo = new UndoController({ core: C.core, scene: C.mapScene, bump: (el, p) => bump(el, p) })
      const X1 = newRect({ x: 0, y: 0, width: 200, height: 100 })
      const X2 = newRect({ x: 600, y: 300, width: 200, height: 100 })
      const variant = rep % 2 === 0 ? 'midpoint' : 'free-end'
      const A =
        variant === 'midpoint'
          ? {
              ...newArrow({ x: 205, y: 50 }),
              points: [
                [0, 0],
                [190, 60],
                [390, 300],
              ],
              width: 390,
              height: 300,
              roundness: { type: 2 },
              startArrowhead: null,
              endArrowhead: 'arrow',
            }
          : {
              ...newArrow({ x: 205, y: 50 }),
              points: [
                [0, 0],
                [300, 300],
              ],
              width: 300,
              height: 300,
              startArrowhead: null,
              endArrowhead: 'arrow',
            }
      bind(A, X1, variant === 'midpoint' ? X2 : null, [1, 0.5], [0, 0.5])
      B.edit((m) => {
        m.set(X1.id, X1 as SceneElement)
        m.set(X2.id, X2 as SceneElement)
        m.set(A.id, A as SceneElement)
      })
      B.core.flush()
      await B.saved()
      await until(() => !!C.core.confirmed(A.id), 'C sees A')
      await sleep(50)
      undo.boundary('seen')
      const m0 = glob(C.scene.get(A.id) as El, 1, C.scene as unknown as Scene)
      // C bends the arrow (its midpoint)
      const copyC = cloneScene(C.scene as unknown as Scene)
      const to: Pt = [
        m0[0] + 40 + Math.round(Math.random() * 60),
        m0[1] - 30 - Math.round(Math.random() * 60),
      ]
      dragPoint(copyC, A.id, 1, to)
      C.edit((m) => m.set(A.id, copyC.get(A.id) as SceneElement))
      undo.boundary('bend')
      const fieldsAtRecord = Object.keys(
        undo.history.undoEntries.at(-1)?.changes.get(A.id)?.fields ?? {},
      ).join('+')
      const fixes: string[] = []
      const offAck = C.core.onAck((ack) => {
        for (const r of ack.r) if (r.ok && r.id === A.id && r.fix) fixes.push(Object.keys(r.fix).join('+'))
      })
      C.core.flush()
      await C.saved()
      offAck()
      const fieldsAfterAck = Object.keys(
        undo.history.undoEntries.at(-1)?.changes.get(A.id)?.fields ?? {},
      ).join('+')
      await until(
        () => (B.core.confirmed(A.id) as El | undefined)?.version === (C.core.confirmed(A.id) as El).version,
        'B sees the bend',
      )
      // B then edits the start target (its follow of the arrow is derived)
      const kind = (['move', 'resize', 'rotate'] as const)[rep % 3]
      const copyB = cloneScene(B.scene as unknown as Scene)
      editTarget(
        copyB,
        X1.id,
        kind === 'move'
          ? { x: -40 - Math.round(Math.random() * 40), y: 30 }
          : kind === 'resize'
            ? { width: 260, height: 150 }
            : { angle: 0.5 },
      )
      B.edit((m) => {
        m.set(X1.id, copyB.get(X1.id) as SceneElement)
        m.set(A.id, copyB.get(A.id) as SceneElement)
      })
      B.core.flush()
      await B.saved()
      await until(
        () => (C.core.confirmed(X1.id) as El).version === (B.core.confirmed(X1.id) as El).version,
        'C sees the move',
      )
      await sleep(100)
      // C undoes its bend
      const top = undo.history.undoEntries.at(-1)
      const topFields = top
        ? [...top.changes.values()].map(
            (c) => `${c.id === A.id ? 'A' : c.id}:${Object.keys(c.fields).join('+')}`,
          )
        : []
      const res = undo.undo()
      C.core.flush()
      await C.saved(20_000)
      await sleep(150)
      const snap = await st.snapshot(b)
      const stored = new Map(snap.elements.map((e) => [e.id, e as El]))
      const midErr = dist(glob(stored.get(A.id), 1, stored), m0)
      const ends = followError(stored, A.id)
      out.push({
        rep,
        kind,
        variant,
        kept: res?.kept ?? null,
        topFields,
        fieldsAtRecord,
        fixes,
        fieldsAfterAck,
        applied: res?.result.applied.length ?? 0,
        skips: res?.result.skips.map((s) => `${s.id === A.id ? 'A' : s.id}:${s.what}:${s.reason}`),
        entryFields: Object.keys(undo.history.redoEntries.at(-1)?.changes.get(A.id)?.fields ?? {}),
        midErr: +midErr.toFixed(3),
        endsErr: +ends.toFixed(3),
        ok: res?.kept === 0 && (res?.result.applied.length ?? 0) > 0 && midErr <= TOL && ends <= TOL,
      })
      undo.dispose()
      await B.close()
      await C.close()
    }
    vlog('N19', JSON.stringify(out))
    expect(out.filter((o) => !o.ok)).toEqual([])
  }, 600_000)
})
