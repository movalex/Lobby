/**
 * W5-26 (CR-3F-1): a write outside this tab's undo history (`transact(…, {skipUndo: true})`, a +1).
 * `UndoController.outside` takes it in like a remote change: no step, no join, the redo stack kept, the
 * next boundary records nothing of it, and the server's answer to its push folds without a step.
 */
import { describe, expect, it } from 'vitest'
import type { LobbyEngineCore } from '../sync/core/engine.ts'
import { bump, createMapScene } from '../sync/headless/scene.ts'
import { note, rect } from '../sync/testing/elements.ts'
import { stored } from '../sync/testing/fakeRoom.ts'
import { createHarness, type TestClient } from '../sync/testing/harness.ts'
import type { SceneElement } from '../sync/types.ts'
import { UndoController } from './controller.ts'
import type { HistEl } from './diff.ts'
import type { Ack } from './stack.ts'

const lobby = (c: TestClient, id: string) =>
  ((c.get(id)?.customData as { lobby?: Record<string, unknown> } | undefined)?.lobby ?? {}) as Record<
    string,
    unknown
  >

/** A +1 as `writePlusOne` makes it through the port: the note's own key, outside the history. */
const plusOne = (c: TestClient, undo: UndoController, id: string) => {
  const before = c.get(id)
  undo.outside(
    () =>
      c.edit((m) => {
        const el = m.get(id) as SceneElement
        const cd = (el.customData as { lobby?: Record<string, unknown> } | undefined) ?? {}
        m.set(id, bump(el, { customData: { lobby: { ...(cd.lobby ?? {}), [`plusOne:${c.name}`]: true } } }))
      }),
    [[id, before]],
  )
}

describe('a +1 outside the undo history, on the engine (W5-26)', () => {
  it('is no step: Ctrl+Z undoes the colour change before it, and the +1 stays for everyone', async () => {
    const h = createHarness({ seed: [stored(note('N', 'a0')), stored(rect('R', 'a1'))] })
    const a = h.client('alice')
    const b = h.client('bob')
    h.settle()
    const undo = new UndoController({ core: a.core, scene: a.scene, bump })
    a.change('R', { backgroundColor: '#a7b7f6' })
    undo.boundary()
    h.settle()
    plusOne(a, undo, 'N')
    expect(undo.history.undoSize).toBe(1)
    expect(undo.boundary()).toBeNull() // the board page's boundary at the onChange
    h.settle()
    expect(undo.boundary()).toBeNull() // and after the ack
    expect(lobby(b, 'N')).toEqual({ 'plusOne:alice': true })

    const r = undo.undo()
    expect(r?.kept).toBe(0)
    expect([...(r?.result.patches.keys() ?? [])]).toEqual(['R'])
    h.settle()
    for (const c of [a, b]) {
      expect(c.get('R')?.backgroundColor).toBe('transparent')
      expect(lobby(c, 'N')).toEqual({ 'plusOne:alice': true })
    }
    expect(undo.history.undoSize).toBe(0)
    expect(undo.undo()).toBeNull() // nothing else to undo: the +1 never was a step
    undo.redo()
    h.settle()
    expect(b.get('R')?.backgroundColor).toBe('#a7b7f6')
    expect(lobby(b, 'N')).toEqual({ 'plusOne:alice': true })
    expect(await a.hash()).toBe(await h.roomHash())
  })

  it('keeps the redo stack: a +1 between an undo and its redo does not end the redo', () => {
    const h = createHarness({ seed: [stored(note('N', 'a0')), stored(rect('R', 'a1'))] })
    const a = h.client('alice')
    h.settle()
    const undo = new UndoController({ core: a.core, scene: a.scene, bump })
    a.change('R', { x: 300 })
    undo.boundary()
    h.settle()
    undo.undo()
    h.settle()
    expect(undo.history.redoSize).toBe(1)
    plusOne(a, undo, 'N')
    undo.boundary()
    h.settle()
    undo.boundary()
    expect([undo.history.undoSize, undo.history.redoSize]).toEqual([0, 1])
    expect(undo.redo()?.kept).toBe(0)
    h.settle()
    expect(h.room.elements.get('R')?.x).toBe(300)
    expect(Object.keys(lobby(a, 'N'))).toEqual(['plusOne:alice'])
  })

  it('leaves a local change not recorded yet a change: the next boundary records it alone', () => {
    const h = createHarness({ seed: [stored(note('N', 'a0')), stored(rect('R', 'a1'))] })
    const a = h.client('alice')
    h.settle()
    const undo = new UndoController({ core: a.core, scene: a.scene, bump })
    // an edit on the same note whose step has not ended yet (no boundary), then the +1 on it
    a.change('N', { backgroundColor: '#ffc9c9' })
    plusOne(a, undo, 'N')
    const step = undo.boundary()
    expect(step).not.toBeNull()
    const n = step?.changes.get('N')
    expect(Object.keys(n?.fields ?? {})).toEqual(['backgroundColor'])
    expect(n?.lobby).toEqual({})
    h.settle()
    undo.undo()
    h.settle()
    expect(h.room.elements.get('N')?.backgroundColor).toBe('#f8e48f')
    expect(Object.keys(lobby(a, 'N'))).toEqual(['plusOne:alice'])
  })

  it('an undo of an earlier step that changed the same field keeps the write’s value ("1 change kept")', () => {
    const h = createHarness({ seed: [stored(note('N', 'a0'))] })
    const a = h.client('alice')
    h.settle()
    const undo = new UndoController({ core: a.core, scene: a.scene, bump })
    a.change('N', { backgroundColor: '#ffc9c9' })
    undo.boundary()
    h.settle()
    const before = a.get('N')
    undo.outside(() => a.change('N', { backgroundColor: '#a5d8ff' }), [['N', before]])
    h.settle()
    expect(undo.history.undoSize).toBe(1)
    const r = undo.undo()
    expect(r?.kept).toBe(1)
    h.settle()
    expect(h.room.elements.get('N')?.backgroundColor).toBe('#a5d8ff')
  })
})

/** A core stand-in that lets a test send the push events and acks (the fake room never answers a `fix`). */
function scriptedCore() {
  const events: ((e: unknown) => void)[] = []
  const acks: ((a: unknown) => void)[] = []
  const core = {
    welcome: null,
    sid: 'me',
    on: (l: (e: unknown) => void) => {
      events.push(l)
      return () => {}
    },
    onAck: (l: (a: unknown) => void) => {
      acks.push(l)
      return () => {}
    },
    leaseHolders: () => new Map(),
    isDerivedHeld: () => false,
    confirmed: () => undefined,
    onSceneChange: () => {},
  }
  return {
    core: core as unknown as LobbyEngineCore,
    push: (seq: number, ids: string[]) => {
      for (const l of events) l({ kind: 'push', record: { seq }, ids })
    },
    ack: (a: Ack) => {
      for (const l of acks) l(a)
    },
  }
}

describe('a write outside the history and the server’s fix for its push (W5-26)', () => {
  it('makes no entry, and the fix folds with no step; a fix row for an earlier step in the same push still folds into it', () => {
    const scene = createMapScene([rect('R', 'a0', { x: 10 }), note('N', 'a1')])
    const s = scriptedCore()
    const undo = new UndoController({ core: s.core, scene, bump })
    undo.history.reset(new Map(scene.read().elements.map((e) => [e.id, e as unknown as HistEl])))
    const set = (id: string, patch: Record<string, unknown>) =>
      scene.map.set(id, bump(scene.map.get(id) as SceneElement, patch))

    // the user's step on N, recorded but not sent yet (offline, or before the core's scan)
    set('N', { backgroundColor: '#ffc9c9' })
    expect(undo.boundary()).not.toBeNull()
    // the write outside the history: R's x, and N's +1
    const before = [
      ['R', scene.map.get('R')],
      ['N', scene.map.get('N')],
    ] as const
    undo.outside(() => {
      set('R', { x: 10.123 })
      set('N', { customData: { lobby: { 'plusOne:me': true } } })
    }, before)
    expect(undo.history.undoSize).toBe(1)
    expect(undo.boundary()).toBeNull()

    // one push carries both elements; the server rounds R's x and answers N's colour with a fix too
    s.push(1, ['R', 'N'])
    set('R', { x: 10.12 })
    set('N', { backgroundColor: '#ffc9c8' })
    s.ack({
      seq: 1,
      r: [
        { id: 'R', ok: true, fix: { x: 10.12 } },
        { id: 'N', ok: true, fix: { backgroundColor: '#ffc9c8' } },
      ],
    })
    // no step from the fix of the write outside the history
    expect(undo.boundary()).toBeNull()
    expect(undo.history.undoSize).toBe(1)
    const step = undo.history.undoEntries[0]
    expect([...(step?.changes.keys() ?? [])]).toEqual(['N'])
    expect(step?.changes.get('N')?.fields.backgroundColor).toEqual({ before: '#f8e48f', after: '#ffc9c8' })
    // and the undo of the step applies from the fixed value, leaving R and the +1 alone
    const r = undo.undo()
    expect(r?.kept).toBe(0)
    expect(scene.map.get('N')?.backgroundColor).toBe('#f8e48f')
    expect(
      (scene.map.get('N')?.customData as { lobby?: Record<string, unknown> } | undefined)?.lobby,
    ).toEqual({
      'plusOne:me': true,
    })
    expect(scene.map.get('R')?.x).toBe(10.12)
  })

  it('a boundary while the write is being installed records nothing (an onChange inside updateScene)', () => {
    const scene = createMapScene([rect('R', 'a0')])
    const s = scriptedCore()
    const undo = new UndoController({ core: s.core, scene, bump })
    undo.history.reset(new Map(scene.read().elements.map((e) => [e.id, e as unknown as HistEl])))
    const before = scene.map.get('R')
    undo.outside(() => {
      scene.map.set('R', bump(scene.map.get('R') as SceneElement, { x: 99 }))
      expect(undo.boundary()).toBeNull()
    }, [['R', before]])
    expect(undo.boundary()).toBeNull()
    expect(undo.history.undoSize).toBe(0)
  })
})
