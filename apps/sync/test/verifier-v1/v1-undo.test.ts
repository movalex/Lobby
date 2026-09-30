// The spike B verifier V1's probe (part-3 round), adopted as a regression (V1_REPS, default 3; V1 ran 20): O2's UndoController on the headless engine core, the real sync server.
import { describe, expect, it } from 'vitest'
import { UndoController } from '../../../web/src/canvas/history/controller.ts'
import { bump } from '../../../web/src/canvas/sync/headless/scene.ts'
import type { SceneElement } from '../../../web/src/canvas/sync/types.ts'
import { assetId, image, rect, versionId } from '../element-room/support/elements.ts'
import { newBoardId, useElementHarness } from '../element-room/support/stack.ts'
import { headless, sleep, until, vlog } from './support.ts'

const h = useElementHarness()
const REPS = Number(process.env.V1_REPS ?? 3)

describe('V1 undo after a retryable reject', () => {
  it('N9: A moves R; the push is answered UNAVAILABLE (a failed COMMIT) and lands on the retry; Ctrl+Z must move R back (not undo the step before)', async () => {
    const st = await h.stack()
    const out: Record<string, unknown>[] = []
    for (let rep = 0; rep < REPS; rep++) {
      const b = newBoardId()
      const A = headless(st.server.url, b, 'alice')
      await A.connect()
      const undo = new UndoController({ core: A.core, scene: A.mapScene, bump: (el, p) => bump(el, p) })
      const R = `r${rep}x`
      // step 1: create R; step 2: recolour R (both saved)
      A.edit((m) => m.set(R, rect(R, { x: 0, y: 0 }) as unknown as SceneElement))
      undo.boundary('create')
      A.core.flush()
      await A.saved()
      A.change(R, { strokeColor: '#e03131' })
      undo.boundary('recolour')
      A.core.flush()
      await A.saved()
      // step 3: move R; its COMMIT fails once (UNAVAILABLE, 4000 RECONNECT), then the retry lands
      await st.failCommit(b, 1)
      const rejects: string[] = []
      const off = A.core.onAck((ack) => {
        for (const r of ack.r) if (!r.ok) rejects.push(r.code)
      })
      A.change(R, { x: 400 })
      undo.boundary('move')
      A.core.flush()
      await until(() => rejects.length > 0, 'UNAVAILABLE ack', 10_000)
      await sleep(100)
      await A.saved(20_000)
      off()
      const stored1 = (await st.snapshot(b)).elements.find((e) => e.id === R) as {
        x: number
        strokeColor: string
      }
      const entries = undo.history.undoSize
      // Ctrl+Z once: the move must be undone (x back to 0), the colour kept
      const res = undo.undo()
      A.core.flush()
      await A.saved(20_000)
      const after = (await st.snapshot(b)).elements.find((e) => e.id === R) as {
        x: number
        strokeColor: string
        isDeleted: boolean
      }
      out.push({
        rep,
        rejects,
        storedBeforeUndo: { x: stored1.x, color: stored1.strokeColor },
        entriesBeforeUndo: entries,
        applied: res?.result.applied.map((c) => Object.keys(c.fields)) ?? null,
        afterUndo: { x: after.x, color: after.strokeColor, deleted: after.isDeleted },
        ok: after.x === 0 && after.strokeColor === '#e03131' && !after.isDeleted,
      })
      undo.dispose()
      await A.close()
    }
    vlog('N9', JSON.stringify(out))
    expect(out.filter((o) => !o.ok)).toEqual([])
  }, 600_000)

  it('N9b: A drops an image while the api is slow (file-refs times out: UNAVAILABLE), the retry lands; Ctrl+Z must remove the image (not undo the step before)', async () => {
    const st = await h.stack()
    const out: Record<string, unknown>[] = []
    for (let rep = 0; rep < Math.min(REPS, 10); rep++) {
      const b = newBoardId()
      const A = headless(st.server.url, b, 'alice')
      await A.connect()
      const undo = new UndoController({ core: A.core, scene: A.mapScene, bump: (el, p) => bump(el, p) })
      const R = `r${rep}x`
      A.edit((m) => m.set(R, rect(R, { x: 0, y: 0 }) as unknown as SceneElement))
      undo.boundary('create')
      A.core.flush()
      await A.saved()
      A.change(R, { strokeColor: '#e03131' })
      undo.boundary('recolour')
      A.core.flush()
      await A.saved()
      const v = versionId(5000 + rep)
      st.api.addFile({
        versionId: v,
        assetId: assetId(5000 + rep),
        kind: 'image',
        name: 'p.png',
        mimeType: 'image/png',
        sizeBytes: 5,
        pageCount: null,
      })
      st.api.fileRefsMode = 'hang'
      const rejects: string[] = []
      const off = A.core.onAck((ack) => {
        for (const r of ack.r) if (!r.ok) rejects.push(r.code)
      })
      const I = `i${rep}x`
      A.edit((m) => m.set(I, image(I, v, { x: 300, y: 0 }) as unknown as SceneElement))
      undo.boundary('image')
      A.core.flush()
      await until(() => rejects.length > 0, 'UNAVAILABLE ack', 10_000)
      st.api.fileRefsMode = 'ok'
      await A.saved(30_000)
      off()
      const stored = (await st.snapshot(b)).elements.find((e) => e.id === I) as
        | { isDeleted: boolean }
        | undefined
      const entries = undo.history.undoSize
      undo.undo()
      A.core.flush()
      await A.saved(20_000)
      const snap = await st.snapshot(b)
      const img = snap.elements.find((e) => e.id === I) as { isDeleted: boolean } | undefined
      const r = snap.elements.find((e) => e.id === R) as { strokeColor: string }
      out.push({
        rep,
        rejects,
        imageStored: !!stored && !stored.isDeleted,
        entriesBeforeUndo: entries,
        imageGoneAfterUndo: !img || img.isDeleted,
        colourKept: r.strokeColor === '#e03131',
        ok: (!img || img.isDeleted) && r.strokeColor === '#e03131',
      })
      undo.dispose()
      await A.close()
    }
    vlog('N9b', JSON.stringify(out))
    expect(out.filter((o) => !o.ok)).toEqual([])
  }, 600_000)
})
