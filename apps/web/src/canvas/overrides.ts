// The single owner of Excalidraw's render overrides (docs/EXCALIDRAW-MIGRATION.md §2.3.1, §2.7, §4.7;
// spike check A10).
//
// `api.setElementRenderOverrides` REPLACES the whole snapshot on every call
// (@excalidraw/excalidraw dist/types/excalidraw/types.d.ts:1095-1110; App.setElementRenderOverrides,
// dist/dev/index.js:43855-43870). Two features write overrides:
//   - remote drag previews (§2.7): a render offset per dragged element, per peer;
//   - mind-map collapse (§4.7): opacity 0 for every element of a collapsed branch.
// Each would erase the other if it called the engine itself, so both go through RenderOverrides, which
// merges them into one snapshot and submits it only when it changed (the engine repaints on every
// submitted snapshot, even an equal one).
//
// Engine rules the merge follows (types.d.ts:1095-1110):
//   - a bound label inherits its container's offset; an offset set on the label itself is ignored, so
//     labels never get one here;
//   - label opacity is independent: hiding a container must hide its bound label explicitly;
//   - frame opacity multiplies its children, but children are targeted explicitly: hiding a frame hides
//     its children explicitly too;
//   - hit tests, selection, editing and exports keep using document values. Hence the guard below: a
//     press on a hidden element (or on the document position of an element a peer is dragging) never
//     reaches Excalidraw, and a box/lasso selection is post-filtered.
import {
  DEFAULT_COLLISION_THRESHOLD,
  sceneCoordsToViewportCoords,
  viewportCoordsToSceneCoords,
} from '@excalidraw/common'
import {
  getContainingFrame,
  hitElementBoundText,
  hitElementItself,
  isCursorInFrame,
} from '@excalidraw/element'
import type {
  ElementsMap,
  ExcalidrawElement,
  ExcalidrawFrameLikeElement,
  NonDeleted,
} from '@excalidraw/element/types'
import type {
  AppState,
  ElementRenderOverride,
  ElementRenderOverrides,
  ExcalidrawImperativeAPI,
} from '@excalidraw/excalidraw/types'
import { pointFrom } from '@excalidraw/math'
import type { GlobalPoint } from '@excalidraw/math/types'

export interface Offset {
  readonly x: number
  readonly y: number
}

/** The slice of the element Lobby needs to expand a hidden set (labels, frame children). */
export interface OverrideElementInfo {
  readonly id: string
  readonly type: string
  readonly isDeleted?: boolean
  readonly containerId?: string | null
  readonly frameId?: string | null
  readonly boundElements?: readonly { readonly id: string; readonly type: string }[] | null
}

export interface OverridesInput {
  /** Drag offsets per source (a peer's session id), in the order the sources were last updated. */
  readonly drags: ReadonlyMap<string, ReadonlyMap<string, Offset>>
  /** Hidden element ids per source (a collapsed mind-map parent), already expanded. */
  readonly hidden: ReadonlySet<string>
}

/**
 * Pure merge: one snapshot for the engine. For an element dragged by several sources the most recently
 * updated source wins. Zero offsets are dropped (they draw nothing different).
 */
export function mergeRenderOverrides(input: OverridesInput): Map<string, ElementRenderOverride> {
  const out = new Map<string, { opacity?: number; offset?: Offset }>()
  for (const offsets of input.drags.values()) {
    for (const [id, offset] of offsets) {
      if (!Number.isFinite(offset.x) || !Number.isFinite(offset.y)) continue
      if (offset.x === 0 && offset.y === 0) {
        out.delete(id)
        continue
      }
      out.set(id, { offset: { x: offset.x, y: offset.y } })
    }
  }
  for (const id of input.hidden) {
    const entry = out.get(id) ?? {}
    entry.opacity = 0
    out.set(id, entry)
  }
  return out as Map<string, ElementRenderOverride>
}

/** Snapshot equality (same ids, same opacity, same offset). */
export function sameOverrides(a: ElementRenderOverrides, b: ElementRenderOverrides): boolean {
  if (a.size !== b.size) return false
  for (const [id, x] of a) {
    const y = b.get(id)
    if (!y) return false
    if (x.opacity !== y.opacity) return false
    if ((x.offset?.x ?? 0) !== (y.offset?.x ?? 0) || (x.offset?.y ?? 0) !== (y.offset?.y ?? 0)) return false
    if (!x.offset !== !y.offset) return false
  }
  return true
}

/**
 * Hidden set expansion: bound labels of hidden containers, children (and their labels) of hidden frames.
 * `elements` is the current scene (deleted elements are ignored).
 */
export function expandHidden(ids: Iterable<string>, elements: Iterable<OverrideElementInfo>): Set<string> {
  const byId = new Map<string, OverrideElementInfo>()
  const childrenOfFrame = new Map<string, string[]>()
  for (const el of elements) {
    if (el.isDeleted) continue
    byId.set(el.id, el)
    if (el.frameId) {
      const list = childrenOfFrame.get(el.frameId) ?? []
      list.push(el.id)
      childrenOfFrame.set(el.frameId, list)
    }
  }
  const out = new Set<string>()
  const add = (id: string) => {
    if (out.has(id) || !byId.has(id)) return
    out.add(id)
    const el = byId.get(id)
    for (const b of el?.boundElements ?? []) if (b.type === 'text') add(b.id)
    if (el?.type === 'frame' || el?.type === 'magicframe')
      for (const c of childrenOfFrame.get(id) ?? []) add(c)
  }
  for (const id of ids) add(id)
  return out
}

/** What the engine side of RenderOverrides needs (the imperative API satisfies it). */
export interface OverridesTarget {
  setElementRenderOverrides(overrides: ElementRenderOverrides | null): void
}

export interface RenderOverridesOptions {
  /** The current scene, for label and frame-child expansion of hidden sets. */
  elements: () => Iterable<OverrideElementInfo>
  /** Coalesces changes into one submit (default: a microtask). Tests pass a manual scheduler. */
  schedule?: (flush: () => void) => void
}

export type BlockReason = { kind: 'hidden' } | { kind: 'moving'; source: string }

/**
 * Owns the engine's render-override snapshot. Every writer (drag previews, mind-map collapse) calls this;
 * nothing else in Lobby calls setElementRenderOverrides.
 */
export class RenderOverrides {
  private readonly drags = new Map<string, Map<string, Offset>>()
  private readonly hiddenBySource = new Map<string, Set<string>>()
  private hiddenExpanded = new Set<string>()
  private applied: ElementRenderOverrides = new Map()
  private scheduled = false
  private disposed = false
  /** Submits to the engine and submits skipped because nothing changed. */
  readonly stats = { submits: 0, skipped: 0 }

  private readonly target: OverridesTarget
  private readonly opts: RenderOverridesOptions

  constructor(target: OverridesTarget, opts: RenderOverridesOptions) {
    this.target = target
    this.opts = opts
  }

  /** A peer's drag preview: the offset of every element it drags (labels follow their container). */
  setDrag(source: string, offsets: ReadonlyMap<string, Offset> | null): void {
    this.drags.delete(source) // re-inserted last: the most recent source wins on overlap
    if (offsets?.size) this.drags.set(source, new Map(offsets))
    this.invalidate()
  }

  /** The committed positions of these elements arrived: their previews end, whoever set them. */
  clearDragFor(ids: Iterable<string>): void {
    let changed = false
    for (const id of ids) {
      for (const [source, offsets] of this.drags) {
        if (offsets.delete(id)) changed = true
        if (!offsets.size) this.drags.delete(source)
      }
    }
    if (changed) this.invalidate()
  }

  /** A collapse source (e.g. the collapsed parent's id) hides these ids; null shows them again. */
  setHidden(source: string, ids: Iterable<string> | null): void {
    const list = ids ? new Set(ids) : null
    if (list?.size) this.hiddenBySource.set(source, list)
    else this.hiddenBySource.delete(source)
    this.invalidate()
  }

  /** Re-expand hidden sets after scene changes (a new label, a new frame child). */
  refresh(): void {
    if (this.hiddenBySource.size) this.invalidate()
  }

  isHidden(id: string): boolean {
    this.ensureExpanded()
    return this.hiddenExpanded.has(id)
  }

  /** The peer whose drag preview currently moves this element, if any. */
  movingSource(id: string): string | null {
    let found: string | null = null
    for (const [source, offsets] of this.drags) if (offsets.has(id)) found = source
    return found
  }

  /** Why a press on this element must not reach Excalidraw, or null. */
  blockReason(id: string): BlockReason | null {
    if (this.isHidden(id)) return { kind: 'hidden' }
    const source = this.movingSource(id)
    return source ? { kind: 'moving', source } : null
  }

  hiddenIds(): ReadonlySet<string> {
    this.ensureExpanded()
    return this.hiddenExpanded
  }

  /** The snapshot the engine has now. */
  current(): ElementRenderOverrides {
    return this.applied
  }

  /** Submits now if anything changed. */
  flush(): void {
    this.scheduled = false
    if (this.disposed) return
    this.expand()
    const next = mergeRenderOverrides({ drags: this.drags, hidden: this.hiddenExpanded })
    if (sameOverrides(next, this.applied)) {
      this.stats.skipped++
      return
    }
    this.applied = next
    this.stats.submits++
    this.target.setElementRenderOverrides(next.size ? next : null)
  }

  dispose(): void {
    this.disposed = true
    this.drags.clear()
    this.hiddenBySource.clear()
    this.hiddenExpanded.clear()
  }

  private dirtyExpansion = false

  private invalidate(): void {
    this.dirtyExpansion = true
    if (this.scheduled || this.disposed) return
    this.scheduled = true
    ;(this.opts.schedule ?? queueMicrotask)(() => this.flush())
  }

  private ensureExpanded(): void {
    if (this.dirtyExpansion) this.expand()
  }

  private expand(): void {
    this.dirtyExpansion = false
    const all: string[] = []
    for (const ids of this.hiddenBySource.values()) all.push(...ids)
    this.hiddenExpanded = all.length ? expandHidden(all, this.opts.elements()) : new Set()
  }
}

// ---- hit-test guard ------------------------------------------------------------------------------

/**
 * Excalidraw's hit threshold (App.getElementHitThreshold, dist/dev/index.js:50043-50051):
 * max(strokeWidth / 2 + 0.1, 0.85 * DEFAULT_COLLISION_THRESHOLD / zoom). DEFAULT_COLLISION_THRESHOLD is
 * 2 * SIDE_RESIZING_THRESHOLD - EPSILON = 8 - 1e-5 (@excalidraw/common dist/dev/index.js:1831-1834).
 */
const hitThreshold = (el: ExcalidrawElement, zoom: number) =>
  Math.max(el.strokeWidth / 2 + 0.1, (0.85 * DEFAULT_COLLISION_THRESHOLD) / zoom)

/**
 * The element Excalidraw would pick at a scene point, by document geometry: the same filters and order
 * as App.getElementsAtPosition / getElementAtPosition (dist/dev/index.js:49977-50042): live, unlocked,
 * not a bound label (its container counts through hitElementBoundText), inside its frame when frames
 * clip; the topmost, re-checked with half the threshold, else the one below it.
 */
export function elementAtScenePoint(
  elements: readonly ExcalidrawElement[],
  appState: Pick<AppState, 'zoom' | 'frameRendering'>,
  x: number,
  y: number,
): ExcalidrawElement | null {
  const live = elements.filter((e) => !e.isDeleted)
  const map = new Map(live.map((e) => [e.id, e])) as unknown as ElementsMap
  const zoom = appState.zoom.value
  const point = pointFrom<GlobalPoint>(x, y)
  const hits: ExcalidrawElement[] = []
  for (const el of live) {
    if (el.locked) continue
    if (el.type === 'text' && el.containerId) continue
    const hit =
      hitElementBoundText(point, el, map) ||
      hitElementItself({ point, element: el, threshold: hitThreshold(el, zoom), elementsMap: map })
    if (!hit) continue
    const frame = getContainingFrame(el, map)
    if (frame && appState.frameRendering.enabled && appState.frameRendering.clip) {
      if (!isCursorInFrame({ x, y }, frame as NonDeleted<ExcalidrawFrameLikeElement>, map)) continue
    }
    hits.push(el)
  }
  if (hits.length > 1) {
    const top = hits[hits.length - 1] as ExcalidrawElement
    const precise = hitElementItself({
      point,
      element: top,
      threshold: hitThreshold(top, zoom) / 2,
      elementsMap: map,
    })
    return precise ? top : (hits[hits.length - 2] ?? null)
  }
  return hits[0] ?? null
}

export interface HitGuardEvent {
  id: string
  reason: BlockReason
  type: string
}

export interface HitGuardOptions {
  /** Lobby's board wrapper (an ancestor of Excalidraw's canvases). */
  wrapper: HTMLElement
  api: ExcalidrawImperativeAPI
  overrides: RenderOverrides
  /** Called for each swallowed event (e.g. to toast "Bob is moving this"). */
  onBlocked?: (e: HitGuardEvent) => void
}

const isInteractiveCanvas = (t: EventTarget | null) =>
  t instanceof HTMLCanvasElement && t.classList.contains('interactive')

/** Tools whose press never selects or edits (panning, the laser): let them through. */
const PASS_TOOLS = new Set(['hand', 'laser'])

/**
 * Capture-phase guard on the wrapper. It runs before Excalidraw's handlers (React's root listener and the
 * interactive canvas's own touchstart listener) and swallows, when the element Excalidraw would pick is
 * hidden or under a peer's drag preview:
 *   - pointerdown (primary button; not while Space is held, not with the hand or laser tool): no select,
 *     no drag, no text editing on the second click, no custom-tool action;
 *   - dblclick (text editing, entering a group, the linear editor);
 *   - contextmenu (Excalidraw selects the element under the pointer first);
 *   - a one-finger touchstart (Excalidraw's own double-tap detector opens the text editor).
 * It also post-filters the selection: an element hidden by a collapse never stays selected (box and
 * lasso selections are Excalidraw's own). Returns the uninstaller.
 */
export function installHitGuard(opts: HitGuardOptions): () => void {
  const { wrapper, api, overrides } = opts
  let spaceHeld = false

  const blockedAt = (clientX: number, clientY: number): { id: string; reason: BlockReason } | null => {
    const appState = api.getAppState()
    const p = viewportCoordsToSceneCoords({ clientX, clientY }, appState)
    const el = elementAtScenePoint(api.getSceneElements() as ExcalidrawElement[], appState, p.x, p.y)
    if (!el) return null
    const reason = overrides.blockReason(el.id)
    return reason ? { id: el.id, reason } : null
  }
  const swallow = (e: Event, hit: { id: string; reason: BlockReason }) => {
    e.stopPropagation()
    e.stopImmediatePropagation()
    if (e.cancelable) e.preventDefault()
    opts.onBlocked?.({ ...hit, type: e.type })
  }

  const onPointerDown = (e: PointerEvent) => {
    if (!isInteractiveCanvas(e.target) || e.button !== 0 || spaceHeld) return
    if (PASS_TOOLS.has(api.getAppState().activeTool.type)) return
    const hit = blockedAt(e.clientX, e.clientY)
    if (hit) swallow(e, hit)
  }
  const onMouseLike = (e: MouseEvent) => {
    if (!isInteractiveCanvas(e.target)) return
    const hit = blockedAt(e.clientX, e.clientY)
    if (hit) swallow(e, hit)
  }
  const onTouchStart = (e: TouchEvent) => {
    if (!isInteractiveCanvas(e.target) || e.touches.length !== 1) return
    const t = e.touches[0]
    if (!t) return
    const hit = blockedAt(t.clientX, t.clientY)
    if (hit) swallow(e, hit)
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.code === 'Space') spaceHeld = e.type === 'keydown'
  }
  const onBlur = () => {
    spaceHeld = false
  }

  // Selection post-filter: hidden ids never stay selected.
  const unsubscribe = api.onChange((_elements, appState) => {
    const hidden = overrides.hiddenIds()
    if (!hidden.size) return
    const selected = Object.keys(appState.selectedElementIds).filter((id) => appState.selectedElementIds[id])
    if (!selected.some((id) => hidden.has(id))) return
    const keep: Record<string, true> = {}
    for (const id of selected) if (!hidden.has(id)) keep[id] = true
    api.updateScene({ appState: { selectedElementIds: keep } })
  })

  const cap = { capture: true } as const
  wrapper.addEventListener('pointerdown', onPointerDown, cap)
  wrapper.addEventListener('dblclick', onMouseLike, cap)
  wrapper.addEventListener('contextmenu', onMouseLike, cap)
  wrapper.addEventListener('touchstart', onTouchStart, { capture: true, passive: false })
  window.addEventListener('keydown', onKey, cap)
  window.addEventListener('keyup', onKey, cap)
  window.addEventListener('blur', onBlur)
  return () => {
    unsubscribe()
    wrapper.removeEventListener('pointerdown', onPointerDown, cap)
    wrapper.removeEventListener('dblclick', onMouseLike, cap)
    wrapper.removeEventListener('contextmenu', onMouseLike, cap)
    wrapper.removeEventListener('touchstart', onTouchStart, cap)
    window.removeEventListener('keydown', onKey, cap)
    window.removeEventListener('keyup', onKey, cap)
    window.removeEventListener('blur', onBlur)
  }
}

/** Scene → client coordinates (for overlays and tests). */
export function sceneToClient(api: ExcalidrawImperativeAPI, x: number, y: number): { x: number; y: number } {
  return sceneCoordsToViewportCoords({ sceneX: x, sceneY: y }, api.getAppState())
}
