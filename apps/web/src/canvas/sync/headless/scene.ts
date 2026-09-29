/**
 * A Map-backed scene for Node (docs/EXCALIDRAW-MIGRATION.md §6.2): what the headless client edits and the
 * engine core reads and applies, in the same shapes the Excalidraw adapter uses. `apply` installs the
 * array the core hands it (sorted by index, id), as `updateScene` would.
 *
 * NODE-SAFE (CONTRACTS.md).
 */
import type { GestureState, SceneAdapter, SceneElement, SceneSnapshot } from '../types.ts'
import { IDLE_GESTURE } from '../types.ts'

export interface MapScene extends SceneAdapter {
  readonly map: Map<string, SceneElement>
  gesture: GestureState
  /** how many times the core installed an array (tests count applies) */
  readonly applies: number
}

export function createMapScene(initial: Iterable<SceneElement> = []): MapScene {
  const map = new Map<string, SceneElement>()
  for (const el of initial) map.set(el.id, el)
  let applies = 0
  const scene: MapScene = {
    map,
    gesture: IDLE_GESTURE,
    get applies() {
      return applies
    },
    read(): SceneSnapshot {
      return { elements: [...map.values()], gesture: scene.gesture }
    },
    apply(elements) {
      applies++
      map.clear()
      for (const el of elements) map.set(el.id, el)
    },
  }
  return scene
}

let nonceSeed = 0x2f6b1d
/** A new versionNonce, as Excalidraw's `randomInteger` would give (deterministic per process). */
export function nextNonce(): number {
  nonceSeed = (Math.imul(nonceSeed, 1103515245) + 12345) >>> 0
  return nonceSeed & 0x7fffffff
}

/** A local edit as Excalidraw makes one: a new object, version + 1, a new versionNonce. */
export function bump<T extends SceneElement>(el: T, patch: Readonly<Record<string, unknown>> = {}): T {
  return { ...el, ...patch, version: el.version + 1, versionNonce: nextNonce() } as T
}
