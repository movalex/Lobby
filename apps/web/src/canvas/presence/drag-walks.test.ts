// N1-6 (wave N): a local drag on a 10k board reads no whole scene per pointer move. The hub looks the dragged
// elements up in the engine's own map (`elementMap`), and a dragged frame's children come from the scene index
// (`frameChildren`): neither `elements()` (the whole array) nor a walk of the map runs per move.
import { describe, expect, it } from 'vitest'
import { resetSceneWalks, sceneWalks } from '../api/parts/scene-index.ts'
import type { LobbyEngineCore } from '../sync/core/engine.ts'
import { frame, note, text } from '../sync/testing/elements.ts'
import type { SceneElement } from '../sync/types.ts'
import { IDLE_GESTURE } from '../sync/types.ts'
import { PresenceHub } from './hub.ts'

function setup(o: { index: boolean }) {
  const scene = new Map<string, SceneElement>()
  scene.set('f1', frame('f1', 'a0'))
  for (let i = 0; i < 300; i++) {
    scene.set(`n${i}`, note(`n${i}`, `a${i + 1}`, { frameId: i < 3 ? 'f1' : null, x: i }))
    scene.set(`n${i}.t`, text(`n${i}.t`, `b${i + 1}`, { containerId: `n${i}` }))
  }
  const sent: unknown[] = []
  const core = {
    sid: 'usr_me:t' as string | null,
    on: () => () => {},
    roster: () => new Map(),
    sendPresence: (p: unknown) => sent.push(p),
  }
  let reads = 0
  let mapReads = 0
  const hub = new PresenceHub({
    core: core as unknown as LobbyEngineCore,
    overrides: null,
    elements: () => {
      reads++
      return [...scene.values()]
    },
    elementMap: () => {
      mapReads++
      return scene
    },
    ...(o.index
      ? {
          frameChildren: (id: string) => [...scene.values()].filter((e) => e.frameId === id),
        }
      : {}),
    view: () => null,
    readOnly: () => false,
  })
  return { hub, scene, sent, reads: () => reads, mapReads: () => mapReads }
}

const move = (scene: Map<string, SceneElement>, id: string, x: number) =>
  scene.set(id, { ...(scene.get(id) as SceneElement), x })

describe('a local drag reads no whole scene per move (N1-6)', () => {
  it('a note: 100 moves, 0 reads of the whole array, one map lookup each, the deltas sent', () => {
    resetSceneWalks()
    const { hub, scene, sent, reads, mapReads } = setup({ index: true })
    for (let i = 1; i <= 100; i++) {
      move(scene, 'n10', 10 + i)
      hub.onGesture({ ...IDLE_GESTURE, dragging: true, selectedElementIds: ['n10'] })
    }
    expect(reads()).toBe(0)
    expect(mapReads()).toBe(100)
    expect(sceneWalks()).toEqual({})
    expect(sent.length).toBeGreaterThan(0)
    hub.dispose()
  })

  it('a frame: its children come from the index at the drag’s start (no walk); without the index one walk, once', () => {
    for (const index of [true, false]) {
      resetSceneWalks()
      const { hub, scene, reads } = setup({ index })
      for (let i = 1; i <= 20; i++) {
        move(scene, 'f1', i)
        hub.onGesture({ ...IDLE_GESTURE, dragging: true, selectedElementIds: ['f1'] })
      }
      expect(reads()).toBe(0)
      expect(sceneWalks()).toEqual(index ? {} : { 'presence.dragStart': 1 })
      hub.dispose()
    }
  })
})
