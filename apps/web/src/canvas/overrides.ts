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
//
// Spike B (O5, §8.6.3) closes the guard's three gaps from A10 (§2.7): the dead zone (a swallowed press
// selects the visible element under it), the hover cursor (`default` over blocked elements) and touch
// (taps, double-taps and long-presses), and adds the board page seam at the end of this file:
// `installBoardOverrides` provides `isBlocked` and `isHidden` through `registries.ts`.
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
import type { LodTarget } from './lod/cull.ts'
import type { ScenePoint } from './port.ts'
import type { CanvasRegistries, HitBlock } from './registries.ts'

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
  /**
   * Render-only invisible ids: a bound arrow a peer's drag re-routes, which Lobby's drag preview draws
   * re-routed (presence/drag-arrows.ts; D1, W5-08). Hit tests treat them as moving, never as hidden.
   */
  readonly previewHidden?: ReadonlySet<string>
  /**
   * Render-only culled ids (CR 3b-5: the level-of-detail pass, canvas/lod): moved far out of view, so the
   * engine's renderer leaves them out. An id another entry names keeps that entry.
   */
  readonly culled?: ReadonlySet<string>
}

/** A render offset far outside any view: the engine's renderer leaves an element moved by it out. */
export const CULL_OFFSET: Offset = Object.freeze({ x: 1e9, y: 1e9 })

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
  for (const id of input.previewHidden ?? []) {
    const entry = out.get(id) ?? {}
    entry.opacity = 0
    out.set(id, entry)
  }
  for (const id of input.culled ?? []) if (!out.has(id)) out.set(id, { offset: CULL_OFFSET })
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
  private readonly previewHiddenBySource = new Map<string, Set<string>>()
  private readonly culledBySource = new Map<string, Set<string>>()
  private readonly submitListeners = new Set<(snapshot: ElementRenderOverrides) => void>()
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

  /**
   * A peer's drag preview re-routes these bound arrows (Lobby draws them, presence/drag-arrows.ts): the
   * engine draws them invisible meanwhile. Render-only; a press on one is a press on a moving element.
   */
  setPreviewHidden(source: string, ids: Iterable<string> | null): void {
    const list = ids ? new Set(ids) : null
    const had = this.previewHiddenBySource.get(source)
    if (!list?.size && !had) return
    if (list && had && list.size === had.size && [...list].every((id) => had.has(id))) return
    if (list?.size) this.previewHiddenBySource.set(source, list)
    else this.previewHiddenBySource.delete(source)
    this.invalidate()
  }

  /**
   * Render-only culling (CR 3b-5): `source`'s ids are left out of the engine's render (the level-of-detail
   * pass draws them as a frame bitmap). Hit tests, selection, editing, exports and `isHidden` never see
   * them. An id a drag preview or a collapse names keeps that entry.
   */
  setCulled(source: string, ids: ReadonlySet<string> | null): void {
    const had = this.culledBySource.get(source)
    if (!ids?.size && !had) return
    if (ids && had && ids.size === had.size && [...ids].every((id) => had.has(id))) return
    if (ids?.size) this.culledBySource.set(source, new Set(ids))
    else this.culledBySource.delete(source)
    this.invalidate()
  }

  /** Ids a peer's drag preview moves right now (a non-zero offset). */
  movedIds(): ReadonlySet<string> {
    const out = new Set<string>()
    for (const offsets of this.drags.values())
      for (const [id, o] of offsets) if (o.x !== 0 || o.y !== 0) out.add(id)
    return out
  }

  /** Called after every snapshot submitted to the engine. */
  onSubmit(listener: (snapshot: ElementRenderOverrides) => void): () => void {
    this.submitListeners.add(listener)
    return () => this.submitListeners.delete(listener)
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

  /** Whether any peer's drag preview is active. */
  hasDrags(): boolean {
    return this.drags.size > 0 || this.previewHiddenBySource.size > 0
  }

  /** The peer whose drag preview currently moves this element, if any. */
  movingSource(id: string): string | null {
    let found: string | null = null
    for (const [source, offsets] of this.drags) if (offsets.has(id)) found = source
    if (found) return found
    for (const [source, ids] of this.previewHiddenBySource) if (ids.has(id)) found = source
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
    const previewHidden = new Set<string>()
    for (const ids of this.previewHiddenBySource.values()) for (const id of ids) previewHidden.add(id)
    const culled = new Set<string>()
    for (const ids of this.culledBySource.values()) for (const id of ids) culled.add(id)
    const next = mergeRenderOverrides({
      drags: this.drags,
      hidden: this.hiddenExpanded,
      previewHidden,
      culled,
    })
    if (sameOverrides(next, this.applied)) {
      this.stats.skipped++
      return
    }
    this.applied = next
    this.stats.submits++
    this.target.setElementRenderOverrides(next.size ? next : null)
    for (const l of [...this.submitListeners]) l(next)
  }

  dispose(): void {
    this.disposed = true
    this.drags.clear()
    this.hiddenBySource.clear()
    this.previewHiddenBySource.clear()
    this.culledBySource.clear()
    this.submitListeners.clear()
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
 * Excalidraw's hit threshold (App.getElementHitThreshold, dist/dev/index.js:50038-50046):
 * max(strokeWidth / 2 + 0.1, 0.85 * DEFAULT_COLLISION_THRESHOLD / zoom). DEFAULT_COLLISION_THRESHOLD is
 * 2 * SIDE_RESIZING_THRESHOLD - EPSILON = 8 - 1e-5 (@excalidraw/common dist/dev/index.js:1831-1834).
 */
const hitThreshold = (el: ExcalidrawElement, zoom: number) =>
  Math.max(el.strokeWidth / 2 + 0.1, (0.85 * DEFAULT_COLLISION_THRESHOLD) / zoom)

/**
 * The element Excalidraw would pick at a scene point, by document geometry: the same filters and order
 * as App.getElementsAtPosition / getElementAtPosition (dist/dev/index.js:49977-50037): live, unlocked,
 * not a bound label (its container counts through hitElementBoundText), inside its frame when frames
 * clip; the topmost, re-checked with half the threshold, else the one below it.
 *
 * `skip` leaves elements out as if they were not in the scene: the guard's own hit test (§2.7 "the dead
 * zone") skips hidden elements and elements under a peer's drag preview, to find what the user SEES at
 * the point.
 */
export function elementAtScenePoint(
  elements: readonly ExcalidrawElement[],
  appState: Pick<AppState, 'zoom' | 'frameRendering'>,
  x: number,
  y: number,
  skip?: (el: ExcalidrawElement) => boolean,
): ExcalidrawElement | null {
  const live = elements.filter((e) => !e.isDeleted)
  const map = new Map(live.map((e) => [e.id, e])) as unknown as ElementsMap
  const zoom = appState.zoom.value
  const point = pointFrom<GlobalPoint>(x, y)
  const hits: ExcalidrawElement[] = []
  for (const el of live) {
    if (el.locked) continue
    if (el.type === 'text' && el.containerId) continue
    if (skip?.(el)) continue
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
  /**
   * §2.7 "the dead zone": a swallowed press whose point shows a visible element (under the hidden or
   * moving one) selected that element instead. Absent when nothing visible lay there.
   */
  selected?: string
}

/** Who drags an element right now: O2's presence (registries `dragger`), for "Bob is moving this". */
export type DraggerLookup = (id: string) => { readonly sid: string; readonly name: string } | null

/** The engine API surface the guard uses (ExcalidrawImperativeAPI satisfies it; tests pass a fake). */
export type GuardApi = Pick<
  ExcalidrawImperativeAPI,
  'getAppState' | 'getSceneElements' | 'updateScene' | 'onChange'
>

export interface HitGuardOptions {
  /** Lobby's board wrapper (an ancestor of Excalidraw's canvases). */
  wrapper: HTMLElement
  api: GuardApi
  overrides: RenderOverrides
  /** Called for each swallowed event (e.g. to toast "Bob is moving this"). */
  onBlocked?: (e: HitGuardEvent) => void
  /** O2's presence: who drags an element (a drag it knows of blocks presses as `moving` too). */
  dragger?: DraggerLookup
  /**
   * §2.7 dead zone: when a press is swallowed, select the visible element under it through `appState`
   * (selection only; a drag needs a second press). Default true.
   */
  deadZone?: boolean
  /** §2.7 hover cursor: force `cursor: default` over blocked elements. Default true. */
  hoverCursor?: boolean
  /** Where Space is tracked (default: the window, when there is one). */
  keyTarget?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null
  /** Schedules the hover test (default: one per animation frame; a microtask outside a browser). */
  scheduleHover?: (fn: () => void) => void
}

/** Excalidraw's interactive canvas (the one its pointer handlers listen on). No DOM globals needed. */
const isInteractiveCanvas = (t: EventTarget | null) => {
  const el = t as { tagName?: string; classList?: { contains(c: string): boolean } } | null
  return !!el && el.tagName === 'CANVAS' && !!el.classList?.contains('interactive')
}

/** Tools whose press never selects or edits (panning, the laser): let them through. */
const PASS_TOOLS = new Set(['hand', 'laser'])

/** The wrapper class the hover rule toggles; the style below turns the canvas cursor to `default`. */
export const HIT_BLOCKED_CLASS = 'lobby-hit-blocked'
const HIT_BLOCKED_STYLE_ID = 'lobby-hit-blocked-style'
/**
 * Excalidraw writes the cursor inline on the interactive canvas (App.cursor.set, dist/dev/index.js
 * 27988-27991), without `!important`, so an important author rule wins over it.
 */
const HIT_BLOCKED_CSS = `.${HIT_BLOCKED_CLASS} canvas.interactive { cursor: default !important; }`

function ensureBlockedStyle(): void {
  const doc = (globalThis as { document?: Document }).document
  if (!doc || doc.getElementById(HIT_BLOCKED_STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = HIT_BLOCKED_STYLE_ID
  style.textContent = HIT_BLOCKED_CSS
  doc.head.appendChild(style)
}

/** A blocked hit: the element Excalidraw would pick, and why a press on it must not reach Excalidraw. */
export interface BlockedHit {
  id: string
  reason: BlockReason
  /** the dragger's name for `moving` (null when nobody named it) */
  name: string | null
}

/**
 * The guard's decisions, DOM-free (unit-tested in Node): what Excalidraw would pick at a scene point,
 * whether that is blocked, and what the user sees there instead.
 */
export class HitGuardCore {
  private readonly api: GuardApi
  private readonly overrides: RenderOverrides
  private readonly dragger: DraggerLookup | undefined

  constructor(api: GuardApi, overrides: RenderOverrides, dragger?: DraggerLookup) {
    this.api = api
    this.overrides = overrides
    this.dragger = dragger
  }

  /** Whether any element can be blocked at all (cheap: the hover test skips the hit test otherwise). */
  anyBlocked(): boolean {
    return this.overrides.hiddenIds().size > 0 || this.overrides.hasDrags()
  }

  /**
   * Why a press on `id` must not reach Excalidraw: hidden, or drawn elsewhere by a peer's drag preview
   * (a preview is what moves the drawing away from the document position, so only a preview blocks; the
   * dragger lookup only names the peer).
   */
  private reasonOf(id: string): { reason: BlockReason; name: string | null } | null {
    const r = this.overrides.blockReason(id)
    if (!r) return null
    if (r.kind === 'hidden') return { reason: r, name: null }
    return { reason: r, name: this.dragger?.(id)?.name ?? null }
  }

  blockedAtScene(x: number, y: number): BlockedHit | null {
    const appState = this.api.getAppState()
    const el = elementAtScenePoint(this.api.getSceneElements() as ExcalidrawElement[], appState, x, y)
    if (!el) return null
    const r = this.reasonOf(el.id)
    return r ? { id: el.id, ...r } : null
  }

  blockedAtClient(clientX: number, clientY: number): BlockedHit | null {
    const p = viewportCoordsToSceneCoords({ clientX, clientY }, this.api.getAppState())
    return this.blockedAtScene(p.x, p.y)
  }

  /** §2.7 dead zone: the visible element at the point, skipping hidden and moving ones, or null. */
  visibleAtScene(x: number, y: number): ExcalidrawElement | null {
    const appState = this.api.getAppState()
    return elementAtScenePoint(
      this.api.getSceneElements() as ExcalidrawElement[],
      appState,
      x,
      y,
      (el) => this.reasonOf(el.id) !== null,
    )
  }

  /** The registries' `hitGuard.isBlocked` (O2's double-tap detector and double-click classifier). */
  isBlocked(point: ScenePoint): HitBlock | null {
    const hit = this.blockedAtScene(point.x, point.y)
    if (!hit) return null
    if (hit.reason.kind === 'hidden') return { kind: 'hidden' }
    return { kind: 'moving', sid: hit.reason.source, name: hit.name ?? '' }
  }
}

/**
 * Capture-phase guard on the wrapper. It runs before Excalidraw's handlers (React's root listener and the
 * interactive canvas's own touchstart listener) and swallows, when the element Excalidraw would pick is
 * hidden or under a peer's drag preview:
 *   - pointerdown (primary button, mouse, TOUCH and PEN alike; not while Space is held, not with the hand
 *     or laser tool): no select, no drag, no text editing on the second click, no custom-tool action, and
 *     on touch no long-press menu (Excalidraw arms it inside its pointerdown,
 *     maybeOpenContextMenuAfterPointerDownOnTouchDevices, dist/dev/index.js:45941-45955);
 *   - dblclick (text editing, entering a group, the linear editor);
 *   - contextmenu (Excalidraw selects the element under the pointer first; also a long-press's menu);
 *   - a one-finger touchstart (Excalidraw's own double-tap detector opens the text editor).
 * §2.7's gaps, closed in spike B:
 *   - the dead zone: a swallowed press selects the visible element Lobby's own hit test finds at that
 *     point (skipping hidden and moving elements), through `appState` only;
 *   - the hover cursor: a passive pointermove test toggles HIT_BLOCKED_CLASS on the wrapper, so the
 *     cursor over a blocked element is `default`, not `move`;
 *   - touch: the rules above run for touch and pen pointers too.
 * It also post-filters the selection: an element hidden by a collapse never stays selected (box and
 * lasso selections are Excalidraw's own). Returns the uninstaller.
 */
export function installHitGuard(opts: HitGuardOptions): () => void {
  const { wrapper, api, overrides } = opts
  const core = new HitGuardCore(api, overrides, opts.dragger)
  const deadZone = opts.deadZone ?? true
  const hoverCursor = opts.hoverCursor ?? true
  let spaceHeld = false

  const swallow = (e: Event, hit: BlockedHit, selected?: string) => {
    e.stopPropagation()
    e.stopImmediatePropagation()
    if (e.cancelable) e.preventDefault()
    opts.onBlocked?.({
      id: hit.id,
      reason: hit.reason,
      type: e.type,
      ...(selected ? { selected } : {}),
    })
  }

  /** The dead-zone rule: select what the user sees at the press (nothing when nothing visible is there). */
  const selectVisibleAt = (clientX: number, clientY: number): string | undefined => {
    if (!deadZone) return undefined
    const p = viewportCoordsToSceneCoords({ clientX, clientY }, api.getAppState())
    const visible = core.visibleAtScene(p.x, p.y)
    if (!visible) return undefined
    const groups = visible.groupIds ?? []
    api.updateScene({
      appState: {
        selectedElementIds: { [visible.id]: true },
        // the outermost group, as a click on a grouped element selects it (selection only, no document change)
        selectedGroupIds: groups.length ? { [groups[groups.length - 1] as string]: true } : {},
      },
    })
    return visible.id
  }

  const onPointerDown = (e: PointerEvent) => {
    if (!isInteractiveCanvas(e.target) || e.button !== 0 || spaceHeld) return
    if (PASS_TOOLS.has(api.getAppState().activeTool.type)) return
    const hit = core.blockedAtClient(e.clientX, e.clientY)
    if (!hit) return
    // Selection only on a primary press of the pointer that started it (never on the second of a pair).
    swallow(e, hit, e.isPrimary === false ? undefined : selectVisibleAt(e.clientX, e.clientY))
  }
  const onMouseLike = (e: MouseEvent) => {
    if (!isInteractiveCanvas(e.target)) return
    const hit = core.blockedAtClient(e.clientX, e.clientY)
    if (hit) swallow(e, hit)
  }
  const onTouchStart = (e: TouchEvent) => {
    if (!isInteractiveCanvas(e.target) || e.touches.length !== 1) return
    const t = e.touches[0]
    if (!t) return
    const hit = core.blockedAtClient(t.clientX, t.clientY)
    if (hit) swallow(e, hit)
  }
  const onKey = (e: Event) => {
    const k = e as KeyboardEvent
    if (k.code === 'Space') spaceHeld = k.type === 'keydown'
  }
  const onBlur = () => {
    spaceHeld = false
  }

  // §2.7 hover cursor: one test per frame at the last pointer position; never while a button is held
  // (the user's own drag), never with the hand or laser tool.
  let hoverAt: { x: number; y: number } | null = null
  let hoverScheduled = false
  let blockedClass = false
  const setBlockedClass = (on: boolean) => {
    if (on === blockedClass) return
    blockedClass = on
    wrapper.classList.toggle(HIT_BLOCKED_CLASS, on)
  }
  const schedule =
    opts.scheduleHover ??
    ((fn: () => void) =>
      typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => fn()) : queueMicrotask(fn))
  const runHover = () => {
    hoverScheduled = false
    const at = hoverAt
    if (!at) return setBlockedClass(false)
    if (!core.anyBlocked() || PASS_TOOLS.has(api.getAppState().activeTool.type)) return setBlockedClass(false)
    setBlockedClass(core.blockedAtClient(at.x, at.y) !== null)
  }
  const onPointerMove = (e: PointerEvent) => {
    if (e.buttons !== 0) return
    hoverAt = isInteractiveCanvas(e.target) ? { x: e.clientX, y: e.clientY } : null
    if (hoverScheduled) return
    hoverScheduled = true
    schedule(runHover)
  }
  const onPointerLeave = () => {
    hoverAt = null
    setBlockedClass(false)
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

  const keyTarget =
    opts.keyTarget === undefined ? ((globalThis as { window?: EventTarget }).window ?? null) : opts.keyTarget
  const cap = { capture: true } as const
  if (hoverCursor) ensureBlockedStyle()
  wrapper.addEventListener('pointerdown', onPointerDown, cap)
  wrapper.addEventListener('dblclick', onMouseLike, cap)
  wrapper.addEventListener('contextmenu', onMouseLike, cap)
  wrapper.addEventListener('touchstart', onTouchStart, { capture: true, passive: false })
  if (hoverCursor) {
    wrapper.addEventListener('pointermove', onPointerMove, { capture: true, passive: true })
    wrapper.addEventListener('pointerleave', onPointerLeave, { passive: true })
  }
  keyTarget?.addEventListener('keydown', onKey, cap)
  keyTarget?.addEventListener('keyup', onKey, cap)
  keyTarget?.addEventListener('blur', onBlur)
  return () => {
    unsubscribe()
    wrapper.removeEventListener('pointerdown', onPointerDown, cap)
    wrapper.removeEventListener('dblclick', onMouseLike, cap)
    wrapper.removeEventListener('contextmenu', onMouseLike, cap)
    wrapper.removeEventListener('touchstart', onTouchStart, cap)
    wrapper.removeEventListener('pointermove', onPointerMove, cap)
    wrapper.removeEventListener('pointerleave', onPointerLeave)
    keyTarget?.removeEventListener('keydown', onKey, cap)
    keyTarget?.removeEventListener('keyup', onKey, cap)
    keyTarget?.removeEventListener('blur', onBlur)
    setBlockedClass(false)
    hoverAt = null
  }
}

/** Scene → client coordinates (for overlays and tests). */
export function sceneToClient(api: ExcalidrawImperativeAPI, x: number, y: number): { x: number; y: number } {
  return sceneCoordsToViewportCoords({ sceneX: x, sceneY: y }, api.getAppState())
}

// ---- the board page seam (spike B, §8.6.3) ------------------------------------------------------------
//
// One RenderOverrides and one hit guard per board page. O2's board page (or port-impl) calls
// `installBoardOverrides` once the Excalidraw API is ready, and uses the returned `overrides` for drag
// previews (`setDrag`, `clearDragFor`: the existing drag-offset API). This module then:
//   - provides `registries.hitGuard.isBlocked` (O2's double-tap detector and double-click classifier)
//     and `registries.hidden.isHidden` (O2's selectAll.ts and the box/lasso post-filter);
//   - reads O2's `registries.dragger.draggerOf` for "Bob is moving this";
//   - hands the same RenderOverrides to O5's features (the mind-map collapse) through `onOverrides`, so
//     neither side edits the other's file and there is one snapshot owner (see the header).

const boardOverrides = new WeakMap<CanvasRegistries, RenderOverrides>()
const waiting = new WeakMap<CanvasRegistries, Set<(o: RenderOverrides) => void>>()

/** Makes `overrides` the board page's overrides for `registries` (features waiting for it are called). */
export function attachOverrides(registries: CanvasRegistries, overrides: RenderOverrides): () => void {
  boardOverrides.set(registries, overrides)
  const pending = waiting.get(registries)
  waiting.delete(registries)
  for (const cb of pending ?? []) cb(overrides)
  return () => {
    if (boardOverrides.get(registries) === overrides) boardOverrides.delete(registries)
  }
}

/** The board page's overrides, if installed. */
export function overridesOf(registries: CanvasRegistries): RenderOverrides | null {
  return boardOverrides.get(registries) ?? null
}

/**
 * Calls `cb` with the board page's overrides now, or as soon as the board page attaches them (features
 * may install before the engine is ready). Returns the cancel.
 */
export function onOverrides(registries: CanvasRegistries, cb: (o: RenderOverrides) => void): () => void {
  const now = boardOverrides.get(registries)
  if (now) {
    cb(now)
    return () => {}
  }
  const set = waiting.get(registries) ?? new Set()
  set.add(cb)
  waiting.set(registries, set)
  return () => set.delete(cb)
}

/**
 * The board page's engine handles, for O5's modules that must READ the engine (the image loader hands
 * decoded files to `api.addFiles`; exports read `getFiles`, `getAppState`). Every WRITE still goes
 * through `CanvasPort.transact` and the sync engine.
 */
export interface BoardEngine {
  readonly api: ExcalidrawImperativeAPI
  readonly wrapper: HTMLElement
  /** the board id (`/b/:boardId`): the file routes need `?board=` */
  readonly boardId: string | null
}

const boardEngines = new WeakMap<CanvasRegistries, BoardEngine>()
const waitingEngine = new WeakMap<CanvasRegistries, Set<(e: BoardEngine) => void>>()

/** Makes `engine` the board page's engine for `registries` (modules waiting for it are called). */
export function attachBoardEngine(registries: CanvasRegistries, engine: BoardEngine): () => void {
  boardEngines.set(registries, engine)
  const pending = waitingEngine.get(registries)
  waitingEngine.delete(registries)
  for (const cb of pending ?? []) cb(engine)
  return () => {
    if (boardEngines.get(registries) === engine) boardEngines.delete(registries)
  }
}

/** The board page's engine, if attached. */
export function boardEngineOf(registries: CanvasRegistries): BoardEngine | null {
  return boardEngines.get(registries) ?? null
}

/** Calls `cb` with the board page's engine now, or once attached. Returns the cancel. */
export function onBoardEngine(registries: CanvasRegistries, cb: (e: BoardEngine) => void): () => void {
  const now = boardEngines.get(registries)
  if (now) {
    cb(now)
    return () => {}
  }
  const set = waitingEngine.get(registries) ?? new Set()
  set.add(cb)
  waitingEngine.set(registries, set)
  return () => set.delete(cb)
}

export interface BoardOverridesOptions {
  api: ExcalidrawImperativeAPI
  /** Lobby's board wrapper (an ancestor of Excalidraw's canvases). */
  wrapper: HTMLElement
  registries: CanvasRegistries
  /** The board id (for O5's file routes); default: read from `/b/:boardId` in the page URL. */
  boardId?: string
  /** "Bob is moving this" (default: a small status line inside the wrapper, `data-lobby-hit-toast`). */
  toast?: (message: string) => void
  /** Every swallowed event (tests and evidence). */
  onBlocked?: (e: HitGuardEvent) => void
}

export interface BoardOverrides {
  readonly overrides: RenderOverrides
  /** The swallowed events so far (at most 200, newest last). */
  readonly log: readonly HitGuardEvent[]
  dispose(): void
}

/** The default toast: one status line in the wrapper, gone after 2.5 s. */
function wrapperToast(wrapper: HTMLElement): (message: string) => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  return (message) => {
    const doc = wrapper.ownerDocument
    let el = wrapper.querySelector<HTMLElement>('[data-lobby-hit-toast]')
    if (!el) {
      el = doc.createElement('div')
      el.setAttribute('data-lobby-hit-toast', '')
      el.setAttribute('role', 'status')
      el.style.cssText =
        'position:absolute;left:50%;bottom:72px;transform:translateX(-50%);z-index:30;padding:6px 12px;' +
        'border-radius:8px;background:rgba(20,20,24,.88);color:#fff;font:13px/1.3 system-ui,sans-serif;' +
        'pointer-events:none;max-width:calc(100% - 32px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis'
      wrapper.appendChild(el)
    }
    el.textContent = message
    el.hidden = false
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      if (el) el.hidden = true
    }, 2_500)
  }
}

/** The message of a swallowed press on an element a peer is dragging (§2.7). */
export const movingMessage = (name: string | null) => `${name?.trim() || 'Someone'} is moving this`

/**
 * The board page's overrides and hit guard (see the section header). O2 calls it once per board page
 * after the Excalidraw API is ready; the returned `dispose` undoes everything.
 */
export function installBoardOverrides(opts: BoardOverridesOptions): BoardOverrides {
  const { api, wrapper, registries } = opts
  const overrides = new RenderOverrides(api, {
    elements: () => api.getSceneElementsIncludingDeleted() as unknown as Iterable<OverrideElementInfo>,
  })
  const dragger: DraggerLookup = (id) => registries.dragger.draggerOf(id)
  const core = new HitGuardCore(api, overrides, dragger)
  const toast = opts.toast ?? wrapperToast(wrapper)
  const log: HitGuardEvent[] = []
  const uninstallGuard = installHitGuard({
    wrapper,
    api,
    overrides,
    dragger,
    onBlocked: (e) => {
      log.push(e)
      if (log.length > 200) log.shift()
      opts.onBlocked?.(e)
      // One toast per press (pointerdown or a touch's touchstart), for moving elements only.
      if (e.reason.kind === 'moving' && (e.type === 'pointerdown' || e.type === 'touchstart')) {
        const who = registries.dragger.draggerOf(e.id)
        toast(movingMessage(who?.name ?? null))
      }
    },
  })
  const unprovideBlocked = registries.hitGuard.provide((point) => core.isBlocked(point))
  const unprovideHidden = registries.hidden.provide((id) => overrides.isHidden(id))
  // New labels and frame children join a collapsed branch as they arrive.
  const unsubscribeScene = api.onChange(() => overrides.refresh())
  const detach = attachOverrides(registries, overrides)
  const detachEngine = attachBoardEngine(registries, {
    api,
    wrapper,
    boardId: opts.boardId ?? boardIdFromLocation(),
  })
  return {
    overrides,
    log,
    dispose() {
      detachEngine()
      detach()
      unsubscribeScene()
      unprovideHidden()
      unprovideBlocked()
      uninstallGuard()
      overrides.dispose()
      api.setElementRenderOverrides(null)
    },
  }
}

/**
 * The level-of-detail pass's render seam on RenderOverrides (CR 3b-5, replacing lod/cull.ts's Proxy of the
 * engine API, W3-14): its culled ids are a render-only source of the one snapshot, its `moved` ids are the
 * drag previews', and it hears every submitted snapshot (the ids whose opacity changed).
 */
export function overridesLodTarget(overrides: RenderOverrides, api: ExcalidrawImperativeAPI): LodTarget {
  const stats = { submits: 0 }
  let opacity = new Map<string, number>()
  const listeners = new Set<(changed: ReadonlySet<string>) => void>()
  overrides.onSubmit((snapshot) => {
    stats.submits++
    const next = new Map<string, number>()
    for (const [id, o] of snapshot) if (o.opacity !== undefined) next.set(id, o.opacity)
    const changed = new Set<string>()
    for (const [id, o] of next) if (opacity.get(id) !== o) changed.add(id)
    for (const id of opacity.keys()) if (!next.has(id)) changed.add(id)
    opacity = next
    for (const l of [...listeners]) l(changed)
  })
  return {
    api,
    setCulled: (ids) => overrides.setCulled('lod', ids),
    moved: () => overrides.movedIds(),
    onSnapshot(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    stats,
  }
}

/** `/b/:boardId` of the page URL (the spike board page's route), or null. */
export function boardIdFromLocation(): string | null {
  const path = (globalThis as { location?: { pathname?: string } }).location?.pathname ?? ''
  const m = /^\/b\/([a-z0-9][a-z0-9_-]{2,63})(?:\/|$)/.exec(path)
  return m?.[1] ?? null
}
