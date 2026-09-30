// Mind maps on the new canvas (docs/EXCALIDRAW-MIGRATION.md §4.7): the operations (new map, start from a
// shape, add child/sibling, move up a level, collapse, Tidy up, delete a branch), a topic's size after its
// text changes, the collapse (hidden through `LobbyCanvas.hide`), and the "keeper" that holds every map to
// its automatic layout. The port of ../runtime.ts onto `LobbyCanvas`; the tree model, the layout and the
// outline are the tldraw feature's own pure modules (../model.ts, ../layout.ts, ../outline.ts).
//
// Who writes what, and how it undoes (tldraw's rules, adapted to Lobby's one-step-per-transact history):
//  - An operation is one undo step: one `transact` with the structural change, the new topic, the layout
//    of the whole map and its lines (./draft.ts plans it, then commits it once).
//  - The keeper re-applies the layout when a map's inputs change for any other reason: a topic's text
//    changed its size, someone resized one, the central topic was dragged (the map follows), a topic was
//    dropped (on another topic it moves there; elsewhere the map re-sorts it by where it was dropped).
//    After this tab's own change its write JOINS that change's undo step (`transact(…, {joinPrevious})`),
//    as tldraw's side-effect writes ran inside the user's own step. It waits while this tab drags, resizes
//    or types (a write in the middle would cut the gesture or the typing into two steps), and runs when
//    the gesture ends or the editor closes.
//  - Changes from other people are checked 400 ms after they settle, and only for a map this tab changed in
//    the last 5 s (when two people changed the same map at once). Their own client lays out its changes,
//    so normally there is nothing to do; the fix-up joins this tab's last step (never a step of its own)
//    and is skipped while this tab can redo. Undo and redo are never followed by a layout write (each step
//    carries its layout; a write there would clear the redo stack).
//  - Read-only people never write (the server refuses their pushes anyway).
//
// The collapse (decided in spike B, B12): only `collapsed` is stored, on the parent's `mindmap` value;
// every client computes the hidden branch (its topics and the lines into them) from the scene and hands it
// to `canvas.hide`, which hides it with a render override and makes the hit guard, Ctrl+A, box/lasso
// selection and exports skip it. As B12 recommends, the layout keeps a collapsed branch's area free (it is
// laid out as if expanded), so nothing visible ever lies over a hidden topic and collapsing or expanding
// moves nothing.
//
// Copies (Ctrl+D, paste) keep their originals' values (the `customData` duplicate handlers in ./index.tsx)
// and become maps of their own right after the copy, in the same undo step (`normalizeCopies`).

import { MINDMAP_MAX_DEPTH, type MindmapSide } from '@draftroom/contracts'
import type { CanvasChange, CanvasElement, LobbyCanvas } from '../../../canvas/api/index.ts'
import { atom, react, untracked } from '../../../lib/signals.ts'
import { findEmptySpot, unionRects } from '../../canvas-ux/placement.ts'
import { frameInView } from '../../present-export/export-defaults.ts'
import { fitFrameAround, placeInFrame } from '../frame-place.ts'
import { blockHeights, DEFAULT_LAYOUT, layoutTree, movedPositions, type Point } from '../layout.ts'
import {
  type Box,
  balancedSides,
  buildTree,
  dropTarget,
  isVisible,
  type MindmapTree,
  type NavDirection,
  navigate,
  sideForNewBranch,
  sideOfPoint,
  subtreeIds,
  type TopicInput,
} from '../model.ts'
import { Draft } from './draft.ts'
import { boxOf, elbowLine, sameLine } from './geometry.ts'
import {
  edgeMetaOf,
  edgePatch,
  hasMindmapData,
  isTopicType,
  MINDMAP_EDGE_KEY,
  MINDMAP_KEY,
  rawTopicValue,
  type TopicMeta,
  topicMetaOf,
  topicPatch,
} from './meta.ts'
import {
  colorForNew,
  colorNameOf,
  edgeStrokeColor,
  edgeStrokeWidth,
  LABEL_INK,
  levelStyle,
  NEW_ROOT_TEXT,
  ROOT_COLOR,
  TOPIC_FONT_FAMILY,
  topicColors,
} from './style.ts'
import { centredLabelAt, fitTopic, type Measure } from './text-fit.ts'
import { TreeIndex } from './tree-index.ts'

/** Deleting more topics than this at once asks first. */
export const CONFIRM_DELETE_ABOVE = 10
/** How long after another person's change to a map this client checks its layout. */
export const REMOTE_SETTLE_MS = 400
/** A fix-up after someone else's change joins this tab's own change to the same map this recent. */
export const RECENT_LOCAL_MS = 5000
/** The owner name of this feature's hidden set (`LobbyCanvas.hide`). */
export const HIDE_OWNER = 'mindmap'

export interface DeletePlan {
  /** Everything to delete: the selection, widened to whole branches and their lines. */
  ids: string[]
  /** Topics among them. */
  topics: number
  /** The topic to select afterwards (the parent of the first deleted topic), if it survives. */
  selectAfter: string | null
  /** Maps that lose topics but keep their central topic (laid out again). */
  roots: string[]
  /** A central topic is among them (a whole map goes). */
  wholeMap: boolean
}

interface Dirty {
  structure: boolean
  size: boolean
  rootMoved: boolean
  /** Topics the user moved (dropped) outside a layout. */
  dropped: Set<string>
}
const newDirty = (): Dirty => ({ structure: false, size: false, rootMoved: false, dropped: new Set() })

/** What the keeper remembers of a topic between changes (to tell a move from a resize from a recolour). */
interface Seen {
  x: number
  y: number
  w: number
  h: number
  color: string | null
  start: string | null
  end: string | null
}

/** Reads the runtime needs: the canvas, or a draft (the canvas plus a write in progress). */
interface View {
  get(id: string): CanvasElement | undefined
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.001
const isLive = (el: CanvasElement | undefined): el is CanvasElement =>
  !!el && !(el as { isDeleted?: boolean }).isDeleted
const bindingOf = (el: CanvasElement | undefined, end: 'start' | 'end') =>
  ((
    el as
      | { startBinding?: { elementId?: string } | null; endBinding?: { elementId?: string } | null }
      | undefined
  )?.[end === 'start' ? 'startBinding' : 'endBinding']?.elementId ?? null) as string | null
const fixedPointOf = (el: CanvasElement | undefined, end: 'start' | 'end') =>
  ((el as Record<string, { fixedPoint?: readonly number[] | null } | null> | undefined)?.[
    end === 'start' ? 'startBinding' : 'endBinding'
  ]?.fixedPoint ?? null) as readonly number[] | null

/** A copy of `tree` in which nothing is collapsed: the layout keeps collapsed branches' areas free (B12). */
function expanded(tree: MindmapTree): MindmapTree {
  const nodes = new Map(tree.nodes)
  for (const [id, n] of nodes) if (n.collapsed) nodes.set(id, { ...n, collapsed: false })
  return { ...tree, nodes }
}

export class MindmapRuntime {
  readonly index = new TreeIndex()
  /** A delete that is waiting for the "Delete N topics?" confirmation. */
  readonly pendingDelete = atom<DeletePlan | null>('mindmap.pending-delete', null)
  /** Polite status line for screen readers. */
  readonly status = atom<{ n: number; text: string }>('mindmap.status', { n: 0, text: '' })
  /** The ids hidden by collapsed branches (topics and their lines), as handed to `canvas.hide`. */
  readonly hidden = atom<ReadonlySet<string>>('mindmap.hidden', new Set())
  /** A topic just made by Tab/Enter that is still empty: leaving it empty takes it back. */
  fresh: { id: string } | null = null

  readonly canvas: LobbyCanvas
  private readonly measure: Measure
  private readonly seen = new Map<string, Seen>()
  private readonly selfMoves = new Map<string, { x: number; y: number }>()
  private readonly dirtyUser = new Map<string, Dirty>()
  private readonly dirtyRemote = new Set<string>()
  private readonly closeWaiters = new Set<() => void>()
  /** When this tab last changed each map (a concurrent fix-up joins this tab's own recent step). */
  private readonly lastLocal = new Map<string, number>()
  /** Copies this tab just made that still carry their originals' mind-map values (not part of any map). */
  private readonly foreign = new Set<string>()
  private remoteTimer: ReturnType<typeof setTimeout> | null = null
  private flushQueued = false
  private lastEditing: string | null = null
  private unhide: (() => void) | null = null
  private hiddenKey = ''
  private disposers: (() => void)[] = []
  private disposed = false

  constructor(canvas: LobbyCanvas, measure?: Measure) {
    this.canvas = canvas
    this.measure =
      measure ?? ((text, fontSize) => canvas.text.measure(text, { fontFamily: TOPIC_FONT_FAMILY, fontSize }))
  }

  // ---- setup ------------------------------------------------------------------------------------

  install(): () => void {
    const { canvas } = this
    untracked(() => {
      this.index.rebuild(canvas.items())
      for (const id of [...this.index.topics.keys(), ...this.index.edges.keys()])
        this.remember(canvas.get(id))
      this.lastEditing = canvas.editingId()
    })
    this.refreshHidden()
    this.disposers.push(
      canvas.on('change', (c) => this.onChange(c)),
      canvas.on('editingChanged', (id) => this.onEditingChanged(id)),
      // the keeper's gate: a flush waiting for a gesture or an editor runs once they are over
      react('mindmap.keeper-gate', () => {
        const blocked = this.blocked()
        if (!blocked && untracked(() => this.dirtyUser.size > 0 || this.foreign.size > 0))
          this.scheduleFlush()
      }),
    )
    return () => this.dispose()
  }

  dispose() {
    this.disposed = true
    for (const d of this.disposers.splice(0)) d()
    if (this.remoteTimer !== null) clearTimeout(this.remoteTimer)
    this.remoteTimer = null
    this.unhide?.()
    this.unhide = null
    this.closeWaiters.clear()
  }

  private say(text: string) {
    this.status.set({ n: this.status.get().n + 1, text })
  }

  private canEdit(): boolean {
    return !this.canvas.readOnly()
  }

  // ---- reading ----------------------------------------------------------------------------------

  isTopic(id: string | null | undefined): boolean {
    return !!id && this.index.topics.has(id)
  }

  metaOf(id: string): TopicMeta | null {
    return this.index.topics.get(id) ?? null
  }

  /** The map rooted at `rootId` as `view` sees it (null when the root is gone). */
  readTree(rootId: string, view: View = this.canvas, extra: Iterable<string> = []): MindmapTree | null {
    const root = view.get(rootId)
    if (!isLive(root)) return null
    const ids = new Set<string>(this.index.byRoot.get(rootId) ?? [])
    for (const id of extra) ids.add(id)
    ids.add(rootId)
    const inputs: TopicInput[] = []
    for (const id of ids) {
      if (this.foreign.has(id)) continue
      const el = view.get(id)
      const meta = topicMetaOf(el)
      if (!el || !meta || meta.rootId !== rootId) continue
      inputs.push({
        id,
        meta,
        box: boxOf(el, view === this.canvas ? (x) => this.canvas.bounds(x) : undefined),
      })
    }
    return buildTree(rootId, inputs)
  }

  treeOfTopic(id: string, view: View = this.canvas): MindmapTree | null {
    const root = this.index.rootOf(id)
    return root ? this.readTree(root, view) : null
  }

  /** Plain text of a topic (for outlines). */
  textOf(id: string): string {
    return this.canvas.text.of(id)
  }

  // ---- the collapse -----------------------------------------------------------------------------

  /** Every topic under a collapsed topic of a live map, and the lines into them. */
  hiddenIds(): Set<string> {
    const out = new Set<string>()
    const roots = new Set<string>()
    for (const id of this.index.collapsed) {
      const r = this.index.rootOf(id)
      if (r) roots.add(r)
    }
    for (const rootId of roots) {
      const tree = this.readTree(rootId)
      if (!tree) continue
      for (const id of tree.nodes.keys()) {
        if (isVisible(tree, id)) continue
        out.add(id)
        for (const e of this.index.edgesByChild.get(id) ?? []) out.add(e)
      }
    }
    return out
  }

  /** Hands the hidden set to the canvas when it changed (the render override, the guard, the filters). */
  private refreshHidden() {
    untracked(() => {
      const ids = this.hiddenIds()
      const key = [...ids].sort().join(',')
      if (key === this.hiddenKey) return
      this.hiddenKey = key
      const previous = this.unhide
      this.unhide = ids.size ? this.canvas.hide(HIDE_OWNER, ids) : null
      if (!ids.size) previous?.()
      this.hidden.set(ids)
      // nothing hidden may stay selected
      const sel = this.canvas.selection
      if (ids.size && sel.some((s) => ids.has(s))) this.canvas.select(sel.filter((s) => !ids.has(s)))
    })
  }

  // ---- the keeper -------------------------------------------------------------------------------

  private remember(el: CanvasElement | undefined) {
    if (!isLive(el)) return
    this.seen.set(el.id, {
      x: el.x,
      y: el.y,
      w: el.width,
      h: el.height,
      color: colorNameOf(el),
      start: bindingOf(el, 'start'),
      end: bindingOf(el, 'end'),
    })
  }

  private mark(dirty: Map<string, Dirty> | null, rootId: string | null, reason: keyof Dirty, id?: string) {
    if (!rootId) return
    if (!dirty) {
      this.dirtyRemote.add(rootId)
      return
    }
    this.lastLocal.set(rootId, Date.now())
    let d = dirty.get(rootId)
    if (!d) {
      d = newDirty()
      dirty.set(rootId, d)
    }
    if (reason === 'dropped') {
      if (id) d.dropped.add(id)
    } else d[reason] = true
  }

  private onChange(c: CanvasChange) {
    if (this.disposed) return
    untracked(() => {
      const local = c.source === 'local' ? this.dirtyUser : null
      const history = c.source === 'history'
      let structural = false
      const touch = (id: string, created = false) => {
        const el = this.canvas.get(id)
        const before = this.index.rootOfAny(id)
        const indexed = this.index.topics.has(id) || this.index.edges.has(id)
        if (!indexed && !hasMindmapData(el)) return
        // A copy (Ctrl+D, Alt-drag, paste) carries its original's mind-map values until it is rewritten
        // as a map of its own (normalizeCopies); until then it is part of no map. This tab's own new
        // topics are indexed when written, so they never arrive here unindexed.
        if (created && local && !indexed && isLive(el)) {
          this.foreign.add(id)
          this.remember(el)
          return
        }
        if (this.foreign.has(id)) {
          if (!isLive(el)) this.foreign.delete(id)
          return
        }
        if (this.index.put(isLive(el) ? el : undefined, id)) {
          structural = true
          const after = this.index.rootOfAny(id)
          if (!history) {
            this.mark(local, before, 'structure')
            if (after !== before) this.mark(local, after, 'structure')
          }
        }
        const prev = this.seen.get(id)
        if (!isLive(el)) {
          this.seen.delete(id)
          return
        }
        this.remember(el)
        if (history) return
        const meta = this.index.topics.get(id)
        if (meta && prev) {
          if (!near(prev.x, el.x) || !near(prev.y, el.y)) {
            const own = this.selfMoves.get(id)
            if (own && near(own.x, el.x) && near(own.y, el.y)) this.selfMoves.delete(id)
            else if (meta.parentId === null) this.mark(local, meta.rootId, 'rootMoved')
            else this.mark(local, meta.rootId, 'dropped', id)
          }
          if (!near(prev.w, el.width) || !near(prev.h, el.height)) this.mark(local, meta.rootId, 'size')
          // a recoloured topic recolours its line (the line takes its child's colour)
          if (prev.color !== colorNameOf(el)) this.mark(local, meta.rootId, 'structure')
        }
        const edge = this.index.edges.get(id)
        // a line that lost a binding (dragged off, or its end unbound) is repaired with its map
        if (edge && prev && (prev.start !== bindingOf(el, 'start') || prev.end !== bindingOf(el, 'end')))
          this.mark(local, edge.rootId, 'structure')
      }
      for (const id of c.created) touch(id, true)
      for (const id of c.updated) touch(id)
      for (const id of c.deleted) {
        const root = this.index.rootOfAny(id)
        this.seen.delete(id)
        this.foreign.delete(id)
        if (this.index.remove(id)) {
          structural = true
          if (!history) this.mark(local, root, 'structure')
        }
      }
      if (structural) this.refreshHidden()
      if (local && (this.dirtyUser.size || this.foreign.size)) this.scheduleFlush()
      if (!local && !history && this.dirtyRemote.size) this.scheduleRemote()
    })
  }

  /** This tab is in the middle of a gesture or typing: a write now would cut it into two undo steps. */
  private blocked(): boolean {
    const g = this.canvas.gesture()
    return g !== 'idle' && g !== 'tool'
  }

  private scheduleFlush() {
    if (this.flushQueued || this.disposed) return
    this.flushQueued = true
    queueMicrotask(() => {
      this.flushQueued = false
      if (this.disposed || untracked(() => this.blocked())) return
      this.flushUser()
    })
  }

  private flushUser() {
    const entries = [...this.dirtyUser]
    this.dirtyUser.clear()
    const copies = [...this.foreign]
    this.foreign.clear()
    if ((!entries.length && !copies.length) || !this.canEdit()) return
    const d = new Draft(this.canvas)
    untracked(() => {
      if (copies.length) this.normalizeCopies(d, copies)
      for (const [rootId, dirty] of entries) {
        const plain = dirty.structure || dirty.size || dirty.rootMoved
        if (!plain && !dirty.dropped.size) continue
        this.layoutNow(d, rootId, { drops: dirty.dropped, edges: dirty.structure || dirty.dropped.size > 0 })
      }
    })
    // after this tab's own change: part of that change's undo step
    this.commit(d, 'mindmap: layout', true)
  }

  private scheduleRemote() {
    if (this.remoteTimer !== null) clearTimeout(this.remoteTimer)
    this.remoteTimer = setTimeout(() => {
      this.remoteTimer = null
      if (this.disposed || !this.canEdit()) {
        this.dirtyRemote.clear()
        return
      }
      // someone here is still dragging or typing: check once that is over
      if (untracked(() => this.blocked())) {
        this.scheduleRemote()
        return
      }
      // Only a tab that changed the same map a moment ago fixes it up (two people changed it at once):
      // the fix-up joins that tab's own change, so one undo still takes back what it did, and nobody
      // else's undo stack gets a step they never made. Not right after an undo or a redo either: a new
      // step would clear the redo stack and take the next Ctrl+Z.
      const now = Date.now()
      const roots = [...this.dirtyRemote].filter((r) => now - (this.lastLocal.get(r) ?? 0) < RECENT_LOCAL_MS)
      this.dirtyRemote.clear()
      if (!roots.length || untracked(() => this.canvas.history.canRedo())) return
      const d = new Draft(this.canvas)
      untracked(() => {
        for (const rootId of roots) this.layoutNow(d, rootId, { edges: true })
      })
      this.commit(d, 'mindmap: layout', true)
    }, REMOTE_SETTLE_MS)
  }

  /**
   * Commits a draft: records the positions it writes (their change events are this runtime's own, not
   * drops) and indexes what it wrote at once (the next key may act on a topic made a moment ago, before
   * the change stream reports it).
   */
  private commit(d: Draft, label: string, joinPrevious: boolean): boolean {
    if (d.empty) return false
    const touched = d.touchedIds()
    for (const id of touched) {
      if (!this.index.topics.has(id)) continue
      const before = this.canvas.get(id)
      const after = d.get(id)
      if (before && after && (!near(before.x, after.x) || !near(before.y, after.y)))
        this.selfMoves.set(id, { x: after.x, y: after.y })
    }
    let ok = false
    try {
      ok = d.commit(label, joinPrevious ? { joinPrevious: true } : undefined)
    } catch (e) {
      console.error('mind map write failed', e)
      return false
    }
    untracked(() => {
      let structural = false
      for (const id of touched) {
        const el = this.canvas.get(id)
        if (this.index.put(isLive(el) ? el : undefined, id)) structural = true
        // what this write left is what the keeper compares the next change with
        if (isLive(el) && (this.index.topics.has(id) || this.index.edges.has(id))) this.remember(el)
        else this.seen.delete(id)
        const root = this.index.rootOfAny(id)
        if (root) this.lastLocal.set(root, Date.now())
      }
      if (structural) this.refreshHidden()
    })
    return ok
  }

  /**
   * Lays out one map in `d`. `drops`: topics the user dropped somewhere (on another topic they move
   * there; a first-level one takes the side of the central topic it was dropped on). `sides`: new
   * first-level sides (Tidy up). `edges`: also repair the lines. `extra`: topics the draft created.
   */
  layoutNow(
    d: Draft,
    rootId: string,
    opts: {
      drops?: ReadonlySet<string>
      sides?: ReadonlyMap<string, MindmapSide>
      edges?: boolean
      extra?: readonly string[]
    } = {},
  ) {
    const extra = [...(opts.extra ?? []), ...d.createdIds()]
    let tree = this.readTree(rootId, d, extra)
    if (!tree) return
    const patches = new Map<string, Partial<TopicMeta>>()
    const patch = (id: string, p: Partial<TopicMeta>) => patches.set(id, { ...patches.get(id), ...p })
    const restyles: [string, number][] = []
    const root = tree.nodes.get(rootId)
    if (root && opts.drops) {
      for (const id of opts.drops) {
        const n = tree.nodes.get(id)
        if (!n || n.parentId === null) continue
        const cx = n.box.x + n.box.w / 2
        // dropped onto another topic: it becomes that topic's child (with its whole branch)
        const target = dropTarget(tree, id)
        const t = target ? tree.nodes.get(target) : undefined
        if (t && t.id !== n.parentId) {
          patch(id, { parentId: t.id, side: t.parentId === null ? sideOfPoint(root.box, cx) : t.side })
          if (t.collapsed) patch(t.id, { collapsed: false })
          restyles.push([id, t.depth + 1 - n.depth])
        } else if (n.depth === 1) patch(id, { side: sideOfPoint(root.box, cx) })
      }
    }
    if (opts.sides) for (const [id, side] of opts.sides) patch(id, { side })
    let rewrote = false
    for (const [id, p] of patches) {
      const meta = topicMetaOf(d.get(id))
      if (!meta) continue
      const next = { ...meta, ...p }
      if (next.parentId === meta.parentId && next.side === meta.side && next.collapsed === meta.collapsed)
        continue
      d.update(id, topicPatch(next))
      rewrote = true
    }
    if (rewrote || restyles.length) {
      tree = this.readTree(rootId, d, extra)
      if (!tree) return
      for (const [id, delta] of restyles) this.restyleBranch(d, tree, id, delta)
      tree = this.readTree(rootId, d, extra)
      if (!tree) return
    }
    this.applyPositions(d, tree, movedPositions(tree, layoutTree(expanded(tree))))
    this.keepInFrame(d, rootId, extra)
    const after = this.readTree(rootId, d, extra)
    if (!after) return
    if (opts.edges) this.ensureEdges(d, after)
    else this.refreshLines(d, after)
  }

  private applyPositions(d: Draft, tree: MindmapTree, moved: ReadonlyMap<string, Point>) {
    for (const [id, p] of moved) {
      const el = d.get(id)
      const box = tree.nodes.get(id)?.box
      if (!el || !box) continue
      d.move(id, p.x + (el.x - box.x), p.y + (el.y - box.y))
    }
  }

  /**
   * Whether this draft moves or resizes `id` (or makes it). A line's geometry is written only when one of
   * its ends moved here: the server re-routes a bound elbow arrow when its ends move (and so may draw it a
   * little differently from `elbowLine`), so a line is never "repaired" to this client's own drawing, or
   * two writers would take turns redrawing it.
   */
  private movesHere(d: Draft, id: string): boolean {
    const now = this.canvas.get(id)
    const next = d.get(id)
    if (!now || !next) return !!next
    return (
      !near(now.x, next.x) ||
      !near(now.y, next.y) ||
      !near(now.width, next.width) ||
      !near(now.height, next.height)
    )
  }

  /** The geometry of every line of the map whose ends this draft moved. */
  private refreshLines(d: Draft, tree: MindmapTree) {
    for (const n of tree.nodes.values()) {
      if (n.parentId === null) continue
      const parent = tree.nodes.get(n.parentId)
      if (!parent || !(this.movesHere(d, n.id) || this.movesHere(d, parent.id))) continue
      for (const e of this.edgesOf(d, n.id)) {
        const g = elbowLine(parent.box, n.box, n.side)
        const el = d.get(e)
        if (el && !sameLine(el as never, g)) d.update(e, { ...g })
      }
    }
  }

  /** The live lines into `childId` (the index's plus the ones this draft made), sorted by id. */
  private edgesOf(d: Draft, childId: string): string[] {
    const ids = new Set(this.index.edgesByChild.get(childId) ?? [])
    for (const id of d.touchedIds()) if (edgeMetaOf(d.get(id))?.childId === childId) ids.add(id)
    return [...ids].filter((id) => isLive(d.get(id)) && edgeMetaOf(d.get(id))).sort()
  }

  /** Every topic but the root has exactly one line from its parent, bound at the right sides. */
  private ensureEdges(d: Draft, tree: MindmapTree) {
    const wanted = new Set<string>()
    for (const n of tree.nodes.values()) {
      if (n.parentId === null) continue
      const parent = tree.nodes.get(n.parentId)
      const child = d.get(n.id)
      if (!parent || !child) continue
      const [keep, ...extra] = this.edgesOf(d, n.id)
      for (const e of extra) this.deleteLine(d, e)
      const color = colorNameOf(child) ?? 'grey'
      const g = elbowLine(parent.box, n.box, n.side)
      const meta = { rootId: tree.rootId, parentId: parent.id, childId: n.id }
      const style = {
        strokeColor: edgeStrokeColor(color),
        strokeWidth: edgeStrokeWidth(n.depth),
        elbowed: true,
        startArrowhead: null,
        endArrowhead: null,
      }
      const createLine = () => {
        const id = d.create('arrow', {
          ...g,
          ...style,
          roughness: 0,
          strokeStyle: 'solid',
          frameId: child.frameId ?? null,
          fixedSegments: null,
          customData: { lobby: { [MINDMAP_EDGE_KEY]: meta } },
        })
        d.bind(id, 'start', parent.id)
        d.bind(id, 'end', n.id)
        wanted.add(id)
      }
      if (!keep) {
        createLine()
        continue
      }
      const el = d.get(keep) as unknown as Record<string, unknown>
      const fix: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(style)) if (el[k] !== v) fix[k] = v
      const em = edgeMetaOf(d.get(keep))
      if (!em || em.rootId !== meta.rootId || em.parentId !== meta.parentId || em.childId !== meta.childId)
        Object.assign(fix, edgePatch(meta))
      const ends = [
        { end: 'start' as const, target: parent.id, fp: side(n.side).parent },
        { end: 'end' as const, target: n.id, fp: side(n.side).child },
      ]
      const rebind = ends.some(({ end, target, fp }) => {
        const got = fixedPointOf(d.get(keep), end)
        return (
          bindingOf(d.get(keep), end) !== target ||
          !got ||
          !near(got[0] ?? -1, fp[0]) ||
          !near(got[1] ?? -1, fp[1])
        )
      })
      const endsMoved = this.movesHere(d, n.id) || this.movesHere(d, parent.id)
      // A line whose ends change, or whose style changes while an end moves (a topic moved to another
      // parent or level), is replaced rather than rewritten: Lobby's history takes a bound arrow's change
      // as derived from its moving ends and records it later as a step of its own (CR-3D-4), while a new
      // line is part of the step that makes it.
      if (rebind || (Object.keys(fix).length && endsMoved)) {
        this.deleteLine(d, keep)
        createLine()
        continue
      }
      wanted.add(keep)
      // the geometry only when an end moved here (see movesHere)
      if (endsMoved && !sameLine(el as never, g)) Object.assign(fix, g)
      if (Object.keys(fix).length) d.update(keep, fix)
    }
    // lines of this map whose child is no longer one of its topics
    for (const id of new Set([...this.index.edges.keys(), ...d.touchedIds()])) {
      const e = edgeMetaOf(d.get(id))
      if (e && e.rootId === tree.rootId && !wanted.has(id)) this.deleteLine(d, id)
    }
  }

  private deleteLine(d: Draft, id: string) {
    if (!isLive(d.get(id))) return
    if (bindingOf(d.get(id), 'start')) d.bind(id, 'start', null)
    if (bindingOf(d.get(id), 'end')) d.bind(id, 'end', null)
    d.delete(id)
  }

  /**
   * R7: a map inside a frame stays inside it as it grows. The frame grows right and down around it (the
   * map moves off the frame's left and top edges first), so no topic is clipped by the frame or missing
   * from its slide. Part of the same write as the layout (and so of its undo step).
   */
  private keepInFrame(d: Draft, rootId: string, extra: readonly string[]) {
    const root = d.get(rootId)
    const frame = root?.frameId ? d.get(root.frameId) : undefined
    if (!root || !isLive(frame) || frame.type !== 'frame' || frame.locked || frame.angle) return
    const tree = this.readTree(rootId, d, extra)
    if (!tree) return
    const inside = [...tree.nodes.values()].filter((n) => d.get(n.id)?.frameId === frame.id)
    const content = unionRects(inside.map((n) => n.box))
    const fit = fitFrameAround({ x: frame.x, y: frame.y, w: frame.width, h: frame.height }, content)
    if (!fit) return
    if (fit.dx || fit.dy)
      for (const n of inside) d.move(n.id, (d.get(n.id)?.x ?? 0) + fit.dx, (d.get(n.id)?.y ?? 0) + fit.dy)
    if (fit.w !== frame.width || fit.h !== frame.height) d.update(frame.id, { width: fit.w, height: fit.h })
  }

  // ---- copies (Ctrl+D, Alt-drag, paste) ---------------------------------------------------------

  /**
   * Topics and lines copied, duplicated or pasted become a map of their own, in the same undo step as the
   * copy: their values are rewritten, mapping old ids to new ones through the copied lines' bindings (the
   * engine rebinds a copied line to the copies of both its ends) and a copied central topic's own old id,
   * and a copied topic whose parent was not copied becomes the new central topic. A copied line that does
   * not join a copied parent to its copied child is deleted. The port of ../runtime.ts normalizeCreated.
   */
  private normalizeCopies(d: Draft, created: readonly string[]) {
    const topics: CanvasElement[] = []
    const edges: CanvasElement[] = []
    for (const id of created) {
      const el = d.get(id)
      if (!isLive(el)) continue
      if (rawTopicValue(el)) topics.push(el)
      else if (edgeMetaOf(el)) edges.push(el)
    }
    if (!topics.length && !edges.length) return
    const topicIds = new Set(topics.map((t) => t.id))
    // old ids -> new ids: a copied central topic names its old self as rootId; a copied line binds the copies
    const map = new Map<string, string>()
    for (const t of topics) {
      const m = rawTopicValue(t)
      if (m && m.parentId === null) map.set(m.rootId, t.id)
    }
    for (const e of edges) {
      const m = edgeMetaOf(e)
      if (!m) continue
      const start = bindingOf(e, 'start')
      const end = bindingOf(e, 'end')
      if (start && topicIds.has(start)) map.set(m.parentId, start)
      if (end && topicIds.has(end)) map.set(m.childId, end)
    }
    const parentOf = new Map<string, string | null>()
    for (const t of topics) {
      const m = rawTopicValue(t)
      const p = m?.parentId ? map.get(m.parentId) : undefined
      parentOf.set(t.id, p && p !== t.id && topicIds.has(p) ? p : null)
    }
    const rootOf = (id: string): string => {
      let cur = id
      const seen = new Set<string>([id])
      for (let i = 0; i <= MINDMAP_MAX_DEPTH; i++) {
        const p = parentOf.get(cur) ?? null
        if (p === null || seen.has(p)) return cur
        seen.add(p)
        cur = p
      }
      return cur
    }
    // loops among copies: cut them at the topic the walk stopped on
    for (const t of topics) {
      const r = rootOf(t.id)
      if (parentOf.get(r) !== null) parentOf.set(r, null)
    }
    const roots = new Set<string>()
    for (const t of topics) {
      const m = rawTopicValue(t)
      if (!m) continue
      const parentId = parentOf.get(t.id) ?? null
      const rootId = rootOf(t.id)
      roots.add(rootId)
      d.update(
        t.id,
        topicPatch({ rootId, parentId, side: parentId === null ? 'right' : m.side, collapsed: m.collapsed }),
      )
    }
    for (const e of edges) {
      const start = bindingOf(e, 'start')
      const end = bindingOf(e, 'end')
      if (!start || !end || !topicIds.has(end) || parentOf.get(end) !== start) {
        this.deleteLine(d, e.id)
        continue
      }
      d.update(e.id, edgePatch({ rootId: rootOf(end), parentId: start, childId: end }))
    }
    for (const r of roots) {
      this.layoutNow(d, r, { edges: true, extra: [...topicIds] })
      this.moveClearOfOthers(d, r, [...topicIds])
    }
  }

  /**
   * A pasted or duplicated map lands where the engine puts the copy, usually on top of its original: it
   * moves, whole, to the nearest free spot instead (nothing is moved when it overlaps nothing).
   */
  private moveClearOfOthers(d: Draft, rootId: string, extra: readonly string[]) {
    const tree = this.readTree(rootId, d, extra)
    const root = d.get(rootId)
    if (!tree || !root) return
    const own = new Set<string>(tree.nodes.keys())
    for (const id of tree.nodes.keys()) {
      const label = d.labelOf(id)
      if (label) own.add(label.id)
      for (const e of this.edgesOf(d, id)) own.add(e)
    }
    for (const id of d.createdIds()) own.add(id)
    const boxes = [...tree.nodes.values()].map((n) => n.box)
    const bounds = unionRects(boxes)
    if (!bounds) return
    const obstacles: Box[] = []
    for (const el of d.items()) {
      if (own.has(el.id) || el.type === 'frame' || (el.type === 'text' && el.containerId)) continue
      if (edgeMetaOf(el) && own.has(edgeMetaOf(el)?.childId ?? '')) continue
      const b = boxOf(el, (x) => this.canvas.bounds(x))
      obstacles.push(b)
    }
    const hit = (o: Box) =>
      o.x < bounds.x + bounds.w + 16 &&
      bounds.x < o.x + o.w + 16 &&
      o.y < bounds.y + bounds.h + 16 &&
      bounds.y < o.y + o.h + 16
    if (!obstacles.some(hit)) return
    const at = findEmptySpot(
      { w: bounds.w, h: bounds.h },
      { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 },
      obstacles,
      { gap: 48 },
    )
    d.move(rootId, root.x + at.x - bounds.x, root.y + at.y - bounds.y)
    this.layoutNow(d, rootId, { edges: true, extra })
  }

  // ---- sizes and styles -------------------------------------------------------------------------

  private depthFromMeta(meta: TopicMeta): number {
    if (meta.parentId === null) return 0
    return meta.parentId === meta.rootId ? 1 : 2
  }

  /**
   * The size a rectangle topic takes for its text at `depth` (the width follows the text within the
   * level's range) and its label laid out in it. Other topic kinds keep Excalidraw's own sizing (a note
   * fits its text itself; an ellipse or a diamond wraps inside its own shape).
   */
  private fit(d: Draft, id: string, depth: number, fontSize?: number) {
    const el = d.get(id)
    if (!isLive(el) || el.type !== 'rectangle') return
    const label = d.labelOf(id)
    const text = String((label as { originalText?: string } | undefined)?.originalText ?? '')
    const st = levelStyle(depth)
    const size = fontSize ?? Number((label as { fontSize?: number } | undefined)?.fontSize ?? st.fontSize)
    const f = fitTopic(text, size, st, this.measure)
    const width = f.width
    const height = f.height
    d.update(id, { width, height })
    if (!label || !f.label) return
    // somebody else is typing in it: the words and their layout are theirs (the lease)
    const holder = this.canvas.leaseHolder(id)
    const me = this.canvas.engine?.welcome?.sid ?? null
    if (holder && holder.sid !== me) return
    const at = centredLabelAt({ x: el.x, y: el.y, width, height }, f.label)
    d.update(label.id, {
      text: f.label.text,
      originalText: text,
      fontSize: size,
      width: f.label.width,
      height: f.label.height,
      x: at.x,
      y: at.y,
    })
  }

  /** Stroke, fill, text size and size follow the level after a branch changes depth (colours are kept). */
  private restyleBranch(d: Draft, tree: MindmapTree, topicId: string, delta: number) {
    if (!delta) return
    for (const id of subtreeIds(tree, topicId)) {
      const el = d.get(id)
      const n = tree.nodes.get(id)
      if (!el || !n || el.type !== 'rectangle') continue
      const depth = Math.max(1, n.depth + delta)
      const st = levelStyle(depth)
      const color = colorNameOf(el)
      d.update(id, { strokeWidth: st.strokeWidth, ...(color ? topicColors(color, depth) : {}) })
      this.fit(d, id, depth, st.fontSize)
    }
  }

  /**
   * A label for a topic `containerId` (centred, the level's size). A new topic gets its (empty) label in
   * the write that makes it, so the editor that opens on it edits that label: the words typed are then a
   * change of the label alone, and undoing the topic's creation takes the label with it (a label the
   * engine's editor made on open would belong to no step, and keep the topic from being undone).
   */
  private addLabel(d: Draft, containerId: string, text: string, fontSize: number) {
    const c = d.get(containerId)
    if (!c) return
    // an empty label has the height of one line (as Excalidraw measures it)
    const m = text ? this.measure(text, fontSize) : { width: 0, height: this.measure(' ', fontSize).height }
    const cx = c.x + c.width / 2
    const cy = c.y + c.height / 2
    const id = d.create(
      'text',
      {
        // newTextElement places a centred label by its centre: it subtracts half its measured size
        x: cx,
        y: cy,
        text,
        originalText: text,
        fontSize,
        fontFamily: TOPIC_FONT_FAMILY,
        textAlign: 'center',
        verticalAlign: 'middle',
        containerId,
        strokeColor: LABEL_INK,
        frameId: c.frameId ?? null,
        autoResize: true,
      },
      { x: cx - m.width / 2, y: cy - m.height / 2, width: m.width, height: m.height },
    )
    const bound = (
      (c as { boundElements?: { id: string; type: string }[] | null }).boundElements ?? []
    ).filter((b) => b.type !== 'text')
    d.update(containerId, { boundElements: [...bound, { id, type: 'text' }] })
  }

  /** A new rectangle topic, top-left at `at`, at `depth`, in `color`. */
  private newTopic(
    d: Draft,
    at: Point,
    depth: number,
    color: Parameters<typeof topicColors>[0],
    meta: Omit<TopicMeta, 'rootId'> & { rootId: string | null },
    opts: { frameId?: string | null; text?: string; id?: string } = {},
  ): string {
    const st = levelStyle(depth)
    const text = opts.text ?? ''
    const f = fitTopic(text, st.fontSize, st, this.measure)
    const id = d.create('rectangle', {
      ...(opts.id ? { id: opts.id } : {}),
      x: at.x,
      y: at.y,
      width: f.width,
      height: f.height,
      ...topicColors(color, depth),
      strokeWidth: st.strokeWidth,
      fillStyle: 'solid',
      strokeStyle: 'solid',
      roughness: 0,
      roundness: null,
      frameId: opts.frameId ?? null,
    })
    d.update(id, topicPatch({ ...meta, rootId: meta.rootId ?? id } as TopicMeta))
    this.addLabel(d, id, text, st.fontSize)
    if (text) this.fit(d, id, depth, st.fontSize)
    return id
  }

  // ---- placing new maps -------------------------------------------------------------------------

  /** The space a new map keeps free around its central topic: room for a few branches either side. */
  private newMapRoom() {
    return { w: levelStyle(0).minW + 2 * (DEFAULT_LAYOUT.hGap(1) + 300), h: 360 }
  }

  /**
   * R7: the frame a new map belongs to: the selected frame, else the one that fills the view (the Export
   * dialog's rule). Locked or rotated frames are skipped: a map in one could not be edited.
   */
  private frameForNewMap(): CanvasElement | null {
    const { canvas } = this
    const usable = (el: CanvasElement | undefined): el is CanvasElement =>
      isLive(el) && el.type === 'frame' && !el.locked && !el.angle
    const sel = canvas.selection
    const only = sel.length === 1 ? canvas.get(sel[0] as string) : undefined
    if (usable(only)) return only
    const frames: { id: string; bounds: { x: number; y: number; w: number; h: number } }[] = []
    for (const el of canvas.items()) {
      if (usable(el)) frames.push({ id: el.id, bounds: { x: el.x, y: el.y, w: el.width, h: el.height } })
    }
    const v = canvas.viewport.get()
    const id = frameInView({ x: v.x, y: v.y, w: v.width, h: v.height }, frames)
    return id ? (canvas.get(id) ?? null) : null
  }

  private spotInFrame(frame: CanvasElement, center: Point): { center: Point; growToH: number | null } {
    const children: Box[] = []
    for (const el of this.canvas.items()) {
      if (el.frameId !== frame.id || (el.type === 'text' && el.containerId)) continue
      const b = this.canvas.bounds(el.id)
      if (b) children.push({ x: b.x, y: b.y, w: b.width, h: b.height })
    }
    const placed = placeInFrame(
      this.newMapRoom(),
      center,
      { x: frame.x, y: frame.y, w: frame.width, h: frame.height },
      children,
    )
    return {
      center: { x: placed.at.x + placed.room.w / 2, y: placed.at.y + placed.room.h / 2 },
      growToH: placed.growToH,
    }
  }

  /** The free spot nearest `center` with room for a few branches around it (top-level content only). */
  private spotForNewMap(center: Point): Point {
    const room = this.newMapRoom()
    const obstacles: Box[] = []
    for (const el of this.canvas.items()) {
      if (el.frameId || (el.type === 'text' && el.containerId)) continue
      const b = this.canvas.bounds(el.id)
      if (b) obstacles.push({ x: b.x, y: b.y, w: b.width, h: b.height })
    }
    const at = findEmptySpot(room, center, obstacles, { gap: 40 })
    return { x: at.x + room.w / 2, y: at.y + room.h / 2 }
  }

  // ---- operations -------------------------------------------------------------------------------

  /**
   * New map: a central topic at the free spot nearest the view's centre. With a frame selected or filling
   * the view (R7), inside that frame (which grows downward when it is full). Returns the new topic; the
   * caller opens its editor (the placeholder "Central topic" goes with the first key).
   */
  createMap(center?: Point): string | null {
    if (!this.canEdit()) return null
    const { canvas } = this
    const v = canvas.viewport.get()
    const want = center ?? { x: v.x + v.width / 2, y: v.y + v.height / 2 }
    const frame = this.frameForNewMap()
    const inFrame = frame ? this.spotInFrame(frame, want) : null
    const c = inFrame?.center ?? this.spotForNewMap(want)
    const d = new Draft(canvas)
    if (frame && inFrame?.growToH) d.update(frame.id, { height: Math.ceil(inFrame.growToH) })
    const st = levelStyle(0)
    const f = fitTopic(NEW_ROOT_TEXT, st.fontSize, st, this.measure)
    const id = this.newTopic(
      d,
      { x: Math.round(c.x - f.width / 2), y: Math.round(c.y - f.height / 2) },
      0,
      ROOT_COLOR,
      { rootId: null, parentId: null, side: 'right', collapsed: false },
      { frameId: frame && inFrame ? frame.id : null, text: NEW_ROOT_TEXT },
    )
    this.commit(d, 'mindmap: new map', false)
    canvas.select([id])
    this.reveal(id)
    this.say('New mind map. Type the central topic, then press Tab to add a branch.')
    return id
  }

  /** Can `el` start a map? (A note, text or shape that is not a topic yet, unlocked, not in a group.) */
  canStartFrom(el: CanvasElement | undefined): el is CanvasElement {
    if (!isLive(el) || !isTopicType(el) || this.isTopic(el.id)) return false
    if (this.canvas.isLocked(el.id) || this.canvas.isHidden(el.id)) return false
    return el.groupIds.length === 0
  }

  /** "Start a mind map": the element becomes the central topic (one step); a first branch follows (another). */
  startFrom(id: string): string | null {
    const el = this.canvas.get(id)
    if (!this.canEdit() || !this.canStartFrom(el)) return null
    const d = new Draft(this.canvas)
    d.update(id, topicPatch({ rootId: id, parentId: null, side: 'right', collapsed: false }))
    this.commit(d, 'mindmap: start', false)
    this.index.put(this.canvas.get(id), id)
    this.say('Mind map started. Type the first branch; Tab adds a child, Enter a sibling.')
    return this.addChild(id)
  }

  /** Tab: a new child of `parentId` (after its last child), selected; the caller opens its editor. */
  addChild(parentId: string, opts: { side?: MindmapSide } = {}): string | null {
    if (!this.canEdit()) return null
    const tree = this.treeOfTopic(parentId)
    const parent = tree?.nodes.get(parentId)
    const parentEl = this.canvas.get(parentId)
    if (!tree || !parent || !isLive(parentEl)) return null
    const depth = parent.depth + 1
    const heights = blockHeights(expanded(tree))
    const side: MindmapSide =
      parent.parentId === null
        ? (opts.side ?? sideForNewBranch(tree, (id) => heights.get(id) ?? 0))
        : parent.side
    const firstLevel = (tree.nodes.get(tree.rootId)?.children ?? [])
      .map((c) => colorNameOf(this.canvas.get(c)))
      .filter((c): c is NonNullable<typeof c> => !!c)
    const color = colorForNew(depth, colorNameOf(parentEl), firstLevel)
    const st = levelStyle(depth)
    const siblings =
      parent.parentId === null
        ? parent.children.filter((c) => tree.nodes.get(c)?.side === side)
        : parent.children
    const last = siblings.length ? tree.nodes.get(siblings[siblings.length - 1] as string) : undefined
    const cy = last ? last.box.y + last.box.h / 2 + 1 : parent.box.y + parent.box.h / 2
    const gap = DEFAULT_LAYOUT.hGap(depth)
    const x = side === 'right' ? parent.box.x + parent.box.w + gap : parent.box.x - gap - st.minW
    const d = new Draft(this.canvas)
    if (parent.collapsed) {
      const m = this.index.topics.get(parentId)
      if (m) d.update(parentId, topicPatch({ ...m, collapsed: false }))
    }
    const id = this.newTopic(
      d,
      { x, y: cy - st.minH / 2 },
      depth,
      color,
      { rootId: tree.rootId, parentId, side, collapsed: false },
      { frameId: parentEl.frameId ?? null },
    )
    this.layoutNow(d, tree.rootId, { edges: true })
    this.commit(d, 'mindmap: add topic', false)
    this.index.put(this.canvas.get(id), id)
    this.canvas.select([id])
    this.reveal(id)
    this.fresh = { id }
    return id
  }

  /** Enter: a new sibling right below `topicId` (on the central topic: a new branch). */
  addSibling(topicId: string): string | null {
    if (!this.canEdit()) return null
    const tree = this.treeOfTopic(topicId)
    const node = tree?.nodes.get(topicId)
    if (!tree || !node) return null
    if (node.parentId === null) return this.addChild(topicId)
    const parentEl = this.canvas.get(node.parentId)
    const el = this.canvas.get(topicId)
    if (!isLive(parentEl) || !isLive(el)) return null
    const depth = node.depth
    const firstLevel = (tree.nodes.get(tree.rootId)?.children ?? [])
      .map((c) => colorNameOf(this.canvas.get(c)))
      .filter((c): c is NonNullable<typeof c> => !!c)
    const color =
      depth === 1
        ? colorForNew(depth, colorNameOf(parentEl), firstLevel)
        : (colorNameOf(el) ?? colorNameOf(parentEl) ?? 'grey')
    const st = levelStyle(depth)
    const cy = node.box.y + node.box.h / 2 + 0.5
    const x = node.side === 'right' ? node.box.x : node.box.x + node.box.w - st.minW
    const d = new Draft(this.canvas)
    const id = this.newTopic(
      d,
      { x, y: cy - st.minH / 2 },
      depth,
      color,
      { rootId: tree.rootId, parentId: node.parentId, side: node.side, collapsed: false },
      { frameId: el.frameId ?? null },
    )
    this.layoutNow(d, tree.rootId, { edges: true })
    this.commit(d, 'mindmap: add topic', false)
    this.index.put(this.canvas.get(id), id)
    this.canvas.select([id])
    this.reveal(id)
    this.fresh = { id }
    return id
  }

  /** Pans (without zooming) so `id` is on screen with some room around it. */
  reveal(id: string) {
    const { canvas } = this
    const b = canvas.bounds(id)
    if (!b) return
    const vp = canvas.viewport.get()
    const z = vp.zoom || 1
    // room around it, in screen pixels: more at the bottom, where the toolbar floats
    const side = Math.min(80 / z, vp.width / 4)
    const top = Math.min(80 / z, vp.height / 4)
    const bottom = Math.min(140 / z, vp.height / 3)
    let dx = 0
    let dy = 0
    if (b.x + b.width > vp.x + vp.width - side) dx = b.x + b.width - (vp.x + vp.width - side)
    if (b.x < vp.x + side) dx = b.x - (vp.x + side)
    if (b.y + b.height > vp.y + vp.height - bottom) dy = b.y + b.height - (vp.y + vp.height - bottom)
    if (b.y < vp.y + top) dy = b.y - (vp.y + top)
    if (!dx && !dy) return
    canvas.viewport.set({ x: vp.x + dx, y: vp.y + dy }, { animate: { durationMs: 160 } })
  }

  /** Shift+Tab: the topic becomes its parent's next sibling (one level up). */
  promote(topicId: string): boolean {
    if (!this.canEdit()) return false
    const tree = this.treeOfTopic(topicId)
    const node = tree?.nodes.get(topicId)
    if (!tree || !node || node.parentId === null) return false
    const parent = tree.nodes.get(node.parentId)
    const el = this.canvas.get(topicId)
    const meta = this.index.topics.get(topicId)
    if (!parent || !el || !meta) return false
    if (parent.parentId === null) {
      this.say('This topic is already a main branch.')
      return false
    }
    const d = new Draft(this.canvas)
    // just below its old parent, so it sorts right after it among its new siblings
    const dy = parent.box.y + parent.box.h / 2 + 0.5 - (node.box.y + node.box.h / 2)
    d.move(topicId, el.x, el.y + dy)
    d.update(topicId, topicPatch({ ...meta, parentId: parent.parentId, side: parent.side }))
    const moved = this.readTree(tree.rootId, d)
    if (moved) this.restyleBranch(d, moved, topicId, parent.depth - node.depth)
    this.layoutNow(d, tree.rootId, { edges: true })
    this.commit(d, 'mindmap: move up a level', false)
    this.reveal(topicId)
    this.say('Moved up a level.')
    return true
  }

  /** Collapse or expand a topic's branch (one undo step). */
  toggleCollapsed(id: string, collapsed?: boolean): boolean {
    if (!this.canEdit()) return false
    const meta = this.index.topics.get(id)
    const tree = this.treeOfTopic(id)
    const node = tree?.nodes.get(id)
    if (!meta || !tree || !node?.children.length) return false
    const next = collapsed ?? !meta.collapsed
    if (next === meta.collapsed) return false
    const hidden = subtreeIds(tree, id).slice(1)
    if (next) {
      const set = new Set(hidden)
      if (this.canvas.selection.some((s) => set.has(s))) this.canvas.select([id])
    }
    const d = new Draft(this.canvas)
    d.update(id, topicPatch({ ...meta, collapsed: next }))
    this.layoutNow(d, tree.rootId, { edges: true })
    this.commit(d, next ? 'mindmap: collapse' : 'mindmap: expand', false)
    this.index.put(this.canvas.get(id), id)
    this.refreshHidden()
    const n = hidden.length
    this.say(next ? `Collapsed: ${n} ${n === 1 ? 'topic' : 'topics'} hidden.` : 'Expanded.')
    return true
  }

  /** Tidy up: balance the branches between the two sides (keeping their order) and lay out again. */
  tidy(topicId: string): boolean {
    if (!this.canEdit()) return false
    const rootId = this.index.rootOf(topicId) ?? this.index.edges.get(topicId)?.rootId ?? null
    const tree = rootId ? this.readTree(rootId) : null
    if (!rootId || !tree) return false
    const heights = blockHeights(expanded(tree))
    const sides = balancedSides(tree, (id) => heights.get(id) ?? 0)
    const d = new Draft(this.canvas)
    this.layoutNow(d, rootId, { sides, edges: true })
    this.commit(d, 'mindmap: tidy up', false)
    this.say('Mind map tidied up.')
    return true
  }

  /**
   * Writes a topic's words without its editor (setup, tests, and features that fill topics): through the
   * lease (`text.replace`) when it has a label; a topic that is still empty gets its label in one write.
   * The topic's size and the map's layout follow, in the same undo step.
   */
  setTopicText(id: string, text: string): boolean {
    const meta = this.index.topics.get(id)
    if (!meta || !this.canEdit()) return false
    // somebody else is typing in it: the words are theirs (the text lease; the server refuses the write
    // anyway). Nobody, or this tab: the words and their layout can be written directly.
    const holder = this.canvas.leaseHolder(id)
    if (holder && holder.sid !== (this.canvas.engine?.welcome?.sid ?? null)) return false
    if (this.canvas.editingId() === id) return false
    const depth = this.depthFromMeta(meta)
    const d = new Draft(this.canvas)
    const el = d.get(id)
    const label = d.labelOf(id)
    if (label) {
      d.update(label.id, { text, originalText: text })
      if (el?.type === 'rectangle') this.fit(d, id, depth)
      else {
        // a note, an ellipse, a diamond or a text keeps its own sizing: the words, unwrapped
        const m = this.measure(text, Number((label as { fontSize?: number }).fontSize ?? 20))
        if (el?.type !== 'text' && el)
          d.update(label.id, {
            width: m.width,
            height: m.height,
            x: el.x + (el.width - m.width) / 2,
            y: el.y + (el.height - m.height) / 2,
          })
      }
    } else if (el?.type === 'text') d.update(id, { text, originalText: text })
    else if (text) {
      const size = el?.type === 'stickynote' ? 20 : levelStyle(depth).fontSize
      this.addLabel(d, id, text, size)
      this.fit(d, id, depth, size)
    }
    this.layoutNow(d, meta.rootId, { edges: true })
    this.commit(d, 'mindmap: topic text', false)
    return true
  }

  /** Arrow keys: select the next topic in that direction (or open a collapsed one). */
  navigate(id: string, dir: NavDirection): boolean {
    const tree = this.treeOfTopic(id)
    if (!tree) return false
    const r = navigate(tree, id, dir)
    if (r.expand) return this.canEdit() ? this.toggleCollapsed(r.expand, false) : false
    if (!r.select) return false
    this.canvas.select([r.select])
    this.reveal(r.select)
    return true
  }

  // ---- the editor closing -----------------------------------------------------------------------

  /** Runs `fn` once this tab's text editor is closed (now, when none is open). */
  whenEditorClosed(fn: () => void): void {
    if (this.canvas.editingId() === null) {
      fn()
      return
    }
    this.closeWaiters.add(fn)
  }

  private onEditingChanged(id: string | null) {
    const prev = this.lastEditing
    this.lastEditing = id
    if (id !== null || this.disposed) return
    untracked(() => {
      if (prev && this.isTopic(prev)) this.editorClosed(prev)
    })
    const waiters = [...this.closeWaiters]
    this.closeWaiters.clear()
    for (const w of waiters) {
      try {
        w()
      } catch (e) {
        console.error('mind map: after the editor closed', e)
      }
    }
  }

  /**
   * Editing of topic `id` ended. A topic made by Tab/Enter that is still empty (and has no children) goes
   * back as if it never was, and its parent is selected again. Otherwise its size follows its text and the
   * map is laid out again, inside the typing's undo step.
   */
  private editorClosed(id: string) {
    const meta = this.index.topics.get(id)
    if (!meta || !this.canEdit()) return
    const fresh = this.fresh
    if (fresh && fresh.id === id) this.fresh = null
    const empty = this.textOf(id).trim() === '' && (this.index.children.get(id)?.size ?? 0) === 0
    if (fresh?.id === id && empty && meta.parentId !== null) {
      this.takeBack(id, meta)
      return
    }
    const d = new Draft(this.canvas)
    this.fit(d, id, this.depthFromMeta(meta))
    this.layoutNow(d, meta.rootId, { edges: true })
    this.commit(d, 'mindmap: layout', true)
  }

  /** The editor of `id` never opened (the lease went to someone else, or Esc while it was pending). */
  editorNeverOpened(id: string, opts: { selectParent?: boolean } = {}) {
    const meta = this.index.topics.get(id)
    if (!meta || !this.canEdit() || this.fresh?.id !== id) return
    this.fresh = null
    const empty = this.textOf(id).trim() === '' && (this.index.children.get(id)?.size ?? 0) === 0
    if (empty && meta.parentId !== null) this.takeBack(id, meta, opts.selectParent === true)
  }

  /**
   * Takes back an empty new topic. What the person selected since (a click elsewhere ended the typing)
   * survives; `selectParent` (the keys' own replay, whose selections the engine has not applied yet)
   * selects the parent again.
   */
  private takeBack(id: string, meta: TopicMeta, selectParent = false) {
    const parentId = meta.parentId as string
    const selection = selectParent ? [] : this.canvas.selection.filter((s) => s !== id)
    const d = new Draft(this.canvas)
    for (const e of this.index.edgesByChild.get(id) ?? []) this.deleteLine(d, e)
    d.delete(id)
    this.layoutNow(d, meta.rootId, { edges: true })
    this.commit(d, 'mindmap: remove empty topic', true)
    const keep = selection.filter((s) => isLive(this.canvas.get(s)))
    if (keep.length) this.canvas.select(keep)
    else if (isLive(this.canvas.get(parentId))) this.canvas.select([parentId])
    this.say('Empty topic removed.')
  }

  // ---- delete -----------------------------------------------------------------------------------

  /**
   * What Delete removes for this selection: every selected topic with its whole branch (collapsed parts
   * included) and their lines. A selected line alone is kept (it belongs to its topic). Null when the
   * selection holds no mind-map element (the board's own delete then runs as usual).
   */
  planDelete(ids: readonly string[]): DeletePlan | null {
    const topicIds = (id: string) => {
      const el = this.canvas.get(id)
      // a bound label stands for its container
      return el?.type === 'text' && el.containerId ? el.containerId : id
    }
    const list = ids.map(topicIds)
    if (!list.some((id) => this.index.topics.has(id) || this.index.edges.has(id))) return null
    const out = new Set<string>()
    const trees = new Map<string, MindmapTree | null>()
    let selectAfter: string | null = null
    let wholeMap = false
    const roots = new Set<string>()
    for (const id of list) {
      if (this.index.edges.has(id)) continue
      const meta = this.index.topics.get(id)
      if (!meta) {
        out.add(id)
        continue
      }
      if (!trees.has(meta.rootId)) trees.set(meta.rootId, this.readTree(meta.rootId))
      const tree = trees.get(meta.rootId)
      const branch = tree?.nodes.has(id) ? subtreeIds(tree, id) : [id]
      for (const t of branch) out.add(t)
      if (meta.parentId === null) wholeMap = true
      else {
        roots.add(meta.rootId)
        const parent = tree?.nodes.get(id)?.parentId
        if (!selectAfter && parent) selectAfter = parent
      }
    }
    let topics = 0
    for (const t of [...out]) {
      if (!this.index.topics.has(t)) continue
      topics++
      for (const e of this.index.edgesByChild.get(t) ?? []) out.add(e)
    }
    for (const [eid, e] of this.index.edges) if (out.has(e.parentId)) out.add(eid)
    if (selectAfter && out.has(selectAfter)) selectAfter = null
    return {
      ids: [...out].filter((id) => isLive(this.canvas.get(id))),
      topics,
      selectAfter,
      roots: [...roots].filter((r) => !out.has(r)),
      wholeMap,
    }
  }

  /** Runs a delete plan as one undo step, lays out what is left and selects the parent. */
  runDelete(plan: DeletePlan) {
    if (!this.canEdit() || !plan.ids.length) return
    const d = new Draft(this.canvas)
    for (const id of plan.ids) {
      if (this.index.edges.has(id)) this.deleteLine(d, id)
      else d.delete(id)
    }
    for (const r of plan.roots) this.layoutNow(d, r, { edges: true })
    this.commit(d, 'mindmap: delete', false)
    if (plan.selectAfter && isLive(this.canvas.get(plan.selectAfter))) this.canvas.select([plan.selectAfter])
    else this.canvas.select([])
    this.say(plan.topics === 1 ? 'Topic deleted.' : `${plan.topics} topics deleted.`)
  }

  /** The board's Delete, widened: runs now, or asks first above CONFIRM_DELETE_ABOVE topics. */
  requestDelete(ids: readonly string[]): 'not-mindmap' | 'asked' | 'done' | 'nothing' {
    const plan = this.planDelete(ids)
    if (!plan) return 'not-mindmap'
    if (!plan.ids.length) {
      this.say('A line in a mind map belongs to its topic: delete the topic instead.')
      return 'nothing'
    }
    if (plan.topics > CONFIRM_DELETE_ABOVE) {
      this.pendingDelete.set(plan)
      return 'asked'
    }
    this.runDelete(plan)
    return 'done'
  }
}

const side = (s: MindmapSide) =>
  s === 'right'
    ? { parent: [1, 0.5] as const, child: [0, 0.5] as const }
    : { parent: [0, 0.5] as const, child: [1, 0.5] as const }

/** The `customData.lobby` keys this feature owns (for the duplicate handlers and the tests). */
export const MINDMAP_KEYS_OWNED = [MINDMAP_KEY, MINDMAP_EDGE_KEY] as const

/** MINDMAP_MAX_DEPTH re-exported for the overlay's side walk. */
export { MINDMAP_MAX_DEPTH }
