/**
 * N1-2 (wave N, PERF-3b): the no-sharing assertion of the core suites. Excalidraw mutates scene elements in place
 * (`mutateElement`, `bumpVersion`), so no object of the core's confirmed map may ever be in the scene: no scene
 * element, and none of its object-valued fields (points, pressures, groupIds, boundElements, fixedSegments,
 * bindings, customData) nor its `customData.lobby`, may be (===) one of a confirmed copy's. The harness
 * (./harness.ts) and the cached-page helper (./cached.ts) run it after every apply the core makes.
 *
 * NODE-SAFE (CONTRACTS.md).
 */
import type { SceneAdapter, SceneElement } from '../types.ts'

/** The objects of one element that must never be shared: itself, its object-valued fields, its lobby. */
function objectsOf(el: SceneElement): object[] {
  const out: object[] = [el]
  for (const k in el) {
    const v = (el as Record<string, unknown>)[k]
    if (v === null || typeof v !== 'object') continue
    out.push(v)
    if (k === 'customData') {
      const lobby = (v as { lobby?: unknown }).lobby
      if (lobby && typeof lobby === 'object') {
        out.push(lobby)
        for (const x of Object.values(lobby)) if (x && typeof x === 'object') out.push(x)
      }
    }
    if (Array.isArray(v)) for (const x of v) if (x && typeof x === 'object') out.push(x)
  }
  return out
}

export interface SharingCore {
  confirmedElements(): ReadonlyMap<string, SceneElement>
}

/** Throws when a scene element (or one of its objects) is one of a confirmed copy's (see the header). */
export function assertNoSharing(core: SharingCore, scene: Pick<SceneAdapter, 'read'>): void {
  const confirmed = new Map<object, string>()
  for (const el of core.confirmedElements().values()) for (const o of objectsOf(el)) confirmed.set(o, el.id)
  for (const el of scene.read().elements)
    for (const o of objectsOf(el)) {
      const of = confirmed.get(o)
      if (of !== undefined)
        throw new Error(
          `no-sharing: the scene's ${el.id} shares ${o === el ? 'itself' : 'an object'} with the confirmed copy of ${of}`,
        )
    }
}

/** Wraps `scene.apply` so every apply is followed by the assertion (`core()` read at call time). */
export function checkSharingOnApply<S extends SceneAdapter>(scene: S, core: () => SharingCore | null): S {
  const apply = scene.apply.bind(scene)
  ;(scene as { apply: SceneAdapter['apply'] }).apply = (elements) => {
    apply(elements)
    const c = core()
    if (c) assertNoSharing(c, scene)
  }
  return scene
}
