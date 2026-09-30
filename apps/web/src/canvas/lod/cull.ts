/**
 * OWNER: 3b (navigation). The level-of-detail pass's seam into the engine's render (docs/EXCALIDRAW-
 * MIGRATION.md §8.5): the elements a frame bitmap draws are left out of Excalidraw's static render.
 *
 * Excalidraw 0.18.0-1118751 has one render-only knob per element, the render-override snapshot
 * (`setElementRenderOverrides`, types.d.ts 1095-1110: exports, hit tests, selection and editing keep the
 * document values), and its renderer culls an element whose render offset moves it out of view
 * (Renderer.getVisibleElementsWithRenderOffsets, dist/dev/index.js 24150-24205). Opacity 0 does not help:
 * the engine still draws the element, invisibly (measured: 7.7 against 5.6 fps at fit on the heavy board;
 * the offset: 34 fps).
 *
 * canvas/overrides.ts (spike B) owns that snapshot: `RenderOverrides` merges drag previews and mind-map
 * collapses and submits them to its target. This module does not edit it: the board page hands
 * `installBoardOverrides` the API through `createLodTarget`, whose `setElementRenderOverrides` adds the
 * pass's culled ids to whatever snapshot `RenderOverrides` submits (never replacing one of its entries),
 * and re-submits that merge when the culled set changes. `RenderOverrides`' own state (`isHidden`,
 * `blockReason`, the hit guard) never sees the culled ids: a culled note is still hit, selected, dragged,
 * edited and exported as before. CR 3b-5 asks spike B to own this merge in RenderOverrides (a render-only
 * `setCulled(source, ids)`); this seam then shrinks to that call.
 */
import type {
  ElementRenderOverride,
  ElementRenderOverrides,
  ExcalidrawImperativeAPI,
} from '@excalidraw/excalidraw/types'

/** A render offset far outside any view: the engine's renderer leaves an element moved by it out. */
export const LOD_CULL_OFFSET = Object.freeze({ x: 1e9, y: 1e9 })
const CULL: ElementRenderOverride = Object.freeze({ offset: LOD_CULL_OFFSET })

/**
 * The snapshot the engine gets: the board overrides' own snapshot, plus the culled ids it does not name
 * (an id it names keeps its entry: a peer's drag preview or a collapse wins). Null when both are empty.
 */
export function mergeCulled(
  snapshot: ElementRenderOverrides | null,
  culled: ReadonlySet<string>,
): ElementRenderOverrides | null {
  if (!culled.size) return snapshot?.size ? snapshot : null
  const out = new Map<string, ElementRenderOverride>(snapshot ?? [])
  for (const id of culled) if (!out.has(id)) out.set(id, CULL)
  return out
}

/** The ids of a snapshot's entries that move an element (a drag preview), and those that set an opacity. */
export function splitSnapshot(snapshot: ElementRenderOverrides | null): {
  moved: Set<string>
  opacity: Map<string, number>
} {
  const moved = new Set<string>()
  const opacity = new Map<string, number>()
  for (const [id, o] of snapshot ?? []) {
    if (o.offset && (o.offset.x !== 0 || o.offset.y !== 0)) moved.add(id)
    if (o.opacity !== undefined) opacity.set(id, o.opacity)
  }
  return { moved, opacity }
}

export interface LodTarget {
  /** the engine API to hand `installBoardOverrides`: everything forwarded, the snapshot merged */
  readonly api: ExcalidrawImperativeAPI
  /** the elements to leave out of the engine's render (null or empty: none) */
  setCulled(ids: ReadonlySet<string> | null): void
  /** ids the board's overrides move right now (never culled; the pass draws their frames live) */
  moved(): ReadonlySet<string>
  /** called after every snapshot the board's overrides submit, with the ids whose opacity changed */
  onSnapshot(listener: (opacityChanged: ReadonlySet<string>) => void): () => void
  /** snapshots submitted to the engine (evidence) */
  readonly stats: { submits: number }
}

export function createLodTarget(api: ExcalidrawImperativeAPI): LodTarget {
  let snapshot: ElementRenderOverrides | null = null
  let split = splitSnapshot(null)
  let culled: ReadonlySet<string> = new Set()
  const listeners = new Set<(changed: ReadonlySet<string>) => void>()
  const stats = { submits: 0 }
  const submit = () => {
    stats.submits++
    api.setElementRenderOverrides(mergeCulled(snapshot, culled))
  }
  const fromOverrides = (next: ElementRenderOverrides | null) => {
    const before = split
    snapshot = next?.size ? next : null
    split = splitSnapshot(snapshot)
    const changed = new Set<string>()
    for (const [id, o] of split.opacity) if (before.opacity.get(id) !== o) changed.add(id)
    for (const id of before.opacity.keys()) if (!split.opacity.has(id)) changed.add(id)
    submit()
    for (const l of listeners) l(changed)
  }
  const proxy = new Proxy(api, {
    get(target, key, receiver) {
      if (key === 'setElementRenderOverrides') return fromOverrides
      return Reflect.get(target, key, receiver)
    },
  })
  return {
    api: proxy,
    setCulled(ids) {
      const next = ids ?? new Set<string>()
      if (next.size === culled.size && [...next].every((id) => culled.has(id))) return
      culled = new Set(next)
      submit()
    },
    moved: () => split.moved,
    onSnapshot(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    stats,
  }
}
