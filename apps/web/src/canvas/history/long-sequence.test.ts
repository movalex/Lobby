/**
 * UNDO-group-redo: collab-conflicts.spec.ts "undo: alice's own drag, resize, note, text, arrow, group and
 * delete undo and redo step by step" (the e2e acceptance test) on the engine core in Node.
 *
 * Excalidraw's Ctrl+G also moves the grouped elements next to each other in paint order: it writes a new
 * `index` on the ones it moves. The undo of the group writes the old `index` back. The browser installs an
 * undo through `updateScene` (Scene.replaceAllElements → syncInvalidIndices), which re-keys every element
 * whose `index` is not strictly between its array neighbours, with a version bump. The undo installed the
 * elements in the scene's array order, so the moved element sat in its grouped slot with its old key: it
 * was re-keyed straight back, the z-order was not undone, and the board page's boundary after the press
 * recorded that re-key as a new step, which cleared the redo stack (the group's redo, and every redo after
 * it, was gone: "the redo of an own Ctrl+G does nothing").
 */
import * as excalidraw from '@excalidraw/element'
import { describe, expect, it } from 'vitest'
import { bump } from '../sync/headless/scene.ts'
import { note, rect, text } from '../sync/testing/elements.ts'
import { stored } from '../sync/testing/fakeRoom.ts'
import { createHarness, type TestClient } from '../sync/testing/harness.ts'
import type { SceneElement } from '../sync/types.ts'
import { UndoController } from './controller.ts'

// biome-ignore lint/suspicious/noExplicitAny: Excalidraw's element helpers, typed loosely on purpose
const X = excalidraw as any

/**
 * What the board page's install does (session.ts: `api.updateScene({elements})`): Excalidraw re-keys the
 * elements whose `index` is out of place in the array (a new copy here, as the scene's own objects are
 * shared with the core), then reports the change (onChange → the core's scan).
 */
const excalidrawInstall = (c: TestClient) => (elements: readonly SceneElement[]) => {
  const copies = elements.map((e) => ({ ...e }))
  X.syncInvalidIndices(copies)
  c.scene.apply(copies as unknown as SceneElement[])
  c.core.onSceneChange(c.scene.read())
}

/** A tab's live elements as comparable facts, in paint order (as the e2e test's `docFacts`, plus the order). */
const facts = (c: TestClient) =>
  c.scene
    .read()
    .elements.filter((e) => !e.isDeleted)
    .map((e) => {
      const x = e as unknown as Record<string, unknown>
      return {
        id: e.id,
        x: x.x,
        y: x.y,
        w: x.width,
        h: x.height,
        groupIds: [...((x.groupIds as string[] | undefined) ?? [])],
        text: (x.originalText as string | undefined) ?? null,
      }
    })

describe('a long undo-all / redo-all sequence with an own Ctrl+G (UNDO-group-redo)', () => {
  it('create, drag, resize, type, group (which moves an element up), delete: each undo and each redo lands on its state, one press each', async () => {
    const h = createHarness({
      seed: [
        stored(rect('g1', 'a0')),
        stored(rect('g2', 'a1', { x: 300 })),
        stored(rect('g3', 'a2', { y: 400 })),
      ],
    })
    const a = h.client('alice')
    const b = h.client('bob')
    h.settle()
    const undo = new UndoController({ core: a.core, scene: a.scene, bump, install: excalidrawInstall(a) })
    const states = [facts(a)]
    const step = (run: () => void) => {
      run()
      undo.boundary()
      h.settle()
      undo.boundary() // the board page's boundary at the onChange after the ack
      states.push(facts(a))
    }

    step(() => a.change('g1', { x: 60, y: 40 })) // 1. drag box 1
    step(() => a.change('g2', { width: 220, height: 160 })) // 2. resize box 2
    step(() =>
      // 3. a note with its label
      a.edit((m) => {
        m.set('N', note('N', 'a3', { x: 700, boundElements: [{ id: 'N.t', type: 'text' }] }))
        m.set(
          'N.t',
          text('N.t', 'a4', { containerId: 'N', x: 720, y: 80, text: 'note', originalText: 'note' }),
        )
      }),
    )
    step(() => a.change('N.t', { text: 'note with words', originalText: 'note with words', width: 150 })) // 4.
    // 5. Ctrl+G on box 2 and the note: one new group on all three, and Excalidraw moves box 2 up to sit right
    // under the note (a new key between box 3's and the note's, in the array too)
    const G = 'grp-1'
    step(() =>
      a.edit((m) => {
        const before = new Map(m)
        m.clear()
        for (const id of ['g1', 'g3', 'g2', 'N', 'N.t']) {
          const el = before.get(id) as SceneElement
          const groupIds = id === 'g1' || id === 'g3' ? undefined : [G]
          const patch = id === 'g2' ? { groupIds, index: 'a2V' } : groupIds ? { groupIds } : null
          m.set(id, patch ? bump(el, patch) : el)
        }
      }),
    )
    expect(a.get('g2')?.index).toBe('a2V')
    step(() => a.change('g3', { isDeleted: true })) // 6. delete box 3
    expect(undo.history.undoSize).toBe(6)

    const press = (dir: 'undo' | 'redo') => {
      const r = dir === 'undo' ? undo.undo() : undo.redo()
      undo.boundary() // the onChange of the install
      h.settle()
      undo.boundary() // and of the ack
      return r
    }
    for (let i = states.length - 1; i > 0; i--) {
      const r = press('undo')
      expect(r?.kept, `undo of step ${i}`).toBe(0)
      expect(facts(a), `undo of step ${i}`).toEqual(states[i - 1])
      expect([undo.history.undoSize, undo.history.redoSize], `stacks after the undo of step ${i}`).toEqual([
        i - 1,
        states.length - i,
      ])
    }
    // the z-order is back too: box 2 under box 3 again
    expect(a.get('g2')?.index).toBe('a1')
    expect(facts(b)).toEqual(states[0])
    for (let i = 1; i < states.length; i++) {
      const r = press('redo')
      expect(r?.kept, `redo of step ${i}`).toBe(0)
      expect(facts(a), `redo of step ${i}`).toEqual(states[i])
    }
    expect([undo.history.undoSize, undo.history.redoSize]).toEqual([6, 0])
    expect(facts(b)).toEqual(states[states.length - 1])
    expect(await a.hash()).toBe(await h.roomHash())
    expect(await b.hash()).toBe(await h.roomHash())
  })
})
