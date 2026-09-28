// Mind maps on the live editor: the operations (new map, add child/sibling, move up a level, delete a
// branch, collapse, Tidy up), the size of a topic as its text changes, and the "keeper" that holds
// every map to its automatic layout.
//
// Who writes what, and how it undoes:
//  - An operation is one undo step: a history mark, then the structural change, the new topic's size,
//    the layout of the whole map and its lines, in one `editor.run`.
//  - A topic's size follows its text in a before-change side effect, so it is part of the very change
//    that edits the text (and of its undo).
//  - The keeper re-applies the layout when a map's inputs change for any other reason: typing made a
//    topic bigger, someone resized one, the central topic was dragged (the map follows), a topic was
//    dropped (the map re-sorts: order and side come from where it was dropped), an undo, or another
//    person's change. It writes outside the undo history (the next undo step then starts from a tidy
//    map, and undo itself is followed by a fresh layout), except for a drop, which joins the drag's own
//    undo step.
//  - Changes from other people are checked 400 ms after they settle. Their own client lays out its
//    changes, so normally there is nothing to do; when two people changed the same map at once, every
//    client computes the same layout from the same records and writes the same positions.
//  - Read-only people never write.
// tldraw runs the store's operation-complete handlers after every single put, also in the middle of an
// `editor.run`; the keeper therefore stands still while one of these operations runs (`op`).
//
// Topics and lines copied, duplicated or pasted (or moved to another page) become a map of their own:
// their meta is rewritten in the same undo step, mapping old ids to new ones through the copied lines'
// bindings, and a copied topic whose parent was not copied becomes the new central topic.

import {
  MINDMAP_EDGE_META_KEY,
  MINDMAP_MAX_DEPTH,
  MINDMAP_META_KEY,
  type MindmapSide,
  type MindmapTopicMeta,
} from '@draftroom/contracts'
import {
  atom,
  createShapeId,
  type Editor,
  type GeoShapeUtil,
  getDisplayValues,
  renderHtmlFromRichTextForMeasurement,
  startEditingShapeWithRichText,
  type TLArrowBinding,
  type TLArrowShape,
  type TLDefaultColorStyle,
  type TLGeoShape,
  type TLParentId,
  type TLShape,
  type TLShapeId,
  type TLShapePartial,
  toRichText,
} from 'tldraw'
import { findEmptySpot, unionRects } from '../canvas-ux/placement.ts'
import { frameInView } from '../present-export/export-defaults.ts'
import { fitFrameAround, placeInFrame } from './frame-place.ts'
import { blockHeights, DEFAULT_LAYOUT, layoutTree, movedPositions, type Point } from './layout.ts'
import {
  type Box,
  balancedSides,
  buildTree,
  dropTarget,
  type MindmapTree,
  type NavDirection,
  navigate,
  sideForNewBranch,
  sideOfPoint,
  subtreeIds,
  subtreeOf,
  type TopicInput,
} from './model.ts'
import { BRANCH_COLORS, edgeSize, levelStyle, NEW_ROOT_TEXT, nextBranchColor, ROOT_COLOR } from './style.ts'
import { edgeMetaOf, hasMindmapMeta, TOPIC_TYPES, TreeIndex, topicMetaOf } from './tree-index.ts'
import { hiddenByCollapse } from './visibility.ts'

/** Deleting more topics than this at once asks first. */
export const CONFIRM_DELETE_ABOVE = 10
/** How long after another person's change to a map this client checks its layout. */
export const REMOTE_SETTLE_MS = 400

export interface DeletePlan {
  /** Everything to delete: the selection, widened to whole branches and their lines. */
  ids: TLShapeId[]
  /** Topics among them. */
  topics: number
  /** The topic to select afterwards (the parent of the first deleted topic), if it survives. */
  selectAfter: TLShapeId | null
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
  dropped: Set<TLShapeId>
  /** The change came from undo/redo. */
  replay: boolean
}

const newDirty = (): Dirty => ({
  structure: false,
  size: false,
  rootMoved: false,
  dropped: new Set(),
  replay: false,
})

const isPaletteColor = (c: unknown): c is TLDefaultColorStyle =>
  typeof c === 'string' &&
  (BRANCH_COLORS.includes(c as TLDefaultColorStyle) || c === ROOT_COLOR || c === 'black' || c === 'white')

const colorOf = (shape: TLShape | undefined): TLDefaultColorStyle | null => {
  const c = (shape?.props as { color?: unknown } | undefined)?.color
  return isPaletteColor(c) ? c : null
}

function anchorsFor(side: MindmapSide) {
  return side === 'right'
    ? { parent: { x: 1, y: 0.5 }, child: { x: 0, y: 0.5 } }
    : { parent: { x: 0, y: 0.5 }, child: { x: 1, y: 0.5 } }
}

/** The line's id for a child: deterministic, so two clients repairing the same line make one. */
export function edgeIdFor(childId: string): TLShapeId {
  return createShapeId(`mm-edge-${childId.replace(/^shape:/, '')}`)
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.001

function sizeChanged(prev: TLShape, next: TLShape): boolean {
  const a = prev.props as Record<string, unknown>
  const b = next.props as Record<string, unknown>
  return (
    a.w !== b.w ||
    a.h !== b.h ||
    a.growY !== b.growY ||
    a.scale !== b.scale ||
    (next.type === 'text' && a.richText !== b.richText) ||
    (next.type === 'note' && a.fontSizeAdjustment !== b.fontSizeAdjustment)
  )
}

export class MindmapRuntime {
  readonly index = new TreeIndex()
  /** A delete that is waiting for the "Delete N topics?" confirmation. */
  readonly pendingDelete = atom<DeletePlan | null>('dr-mindmap-pending-delete', null)
  /** Polite status line for screen readers. */
  readonly status = atom<{ n: number; text: string }>('dr-mindmap-status', { n: 0, text: '' })

  private readonly blessed = new Set<TLShapeId>()
  private readonly createdForeign = new Set<TLShapeId>()
  private readonly dirtyUser = new Map<string, Dirty>()
  private readonly dirtyRemote = new Set<string>()
  private readonly pendingDrops = new Map<string, Set<TLShapeId>>()
  private readonly selfWrites = new Map<TLShapeId, Point>()
  private opDepth = 0
  private remoteTimer: ReturnType<typeof setTimeout> | null = null
  private disposers: (() => void)[] = []
  /** A topic just made by Tab/Enter that is still empty: leaving it empty takes it back. */
  fresh: { id: TLShapeId; mark: string } | null = null

  readonly editor: Editor

  constructor(editor: Editor) {
    this.editor = editor
  }

  // ---- setup ------------------------------------------------------------------------------------

  install(): () => void {
    const { editor } = this
    for (const r of editor.store.allRecords()) {
      if (r.typeName === 'shape' && hasMindmapMeta(r as TLShape)) this.index.put(r as TLShape)
    }
    const se = editor.sideEffects
    this.disposers.push(
      se.registerAfterCreateHandler('shape', (shape, source) => {
        if (!hasMindmapMeta(shape) || !this.index.put(shape)) return
        if (source === 'user' && !this.isReplaying() && !this.blessed.has(shape.id)) {
          this.createdForeign.add(shape.id)
        }
        const root = this.rootOfAny(shape.id)
        if (root) this.mark(root, 'structure', source)
      }),
      se.registerAfterChangeHandler('shape', (prev, next, source) => {
        if (prev.meta !== next.meta && (hasMindmapMeta(prev) || hasMindmapMeta(next))) {
          const before = this.rootOfAny(prev.id)
          if (this.index.put(next)) {
            const after = this.rootOfAny(next.id)
            if (before) this.mark(before, 'structure', source)
            if (after && after !== before) this.mark(after, 'structure', source)
          }
        }
        const meta = this.index.topics.get(next.id)
        if (!meta) return
        if (prev.x !== next.x || prev.y !== next.y || prev.parentId !== next.parentId) {
          const own = this.selfWrites.get(next.id)
          if (own && near(own.x, next.x) && near(own.y, next.y)) this.selfWrites.delete(next.id)
          else if (meta.parentId === null) this.mark(meta.rootId, 'rootMoved', source)
          else this.mark(meta.rootId, 'dropped', source, next.id)
        }
        if (prev.props !== next.props) {
          if (sizeChanged(prev, next)) this.mark(meta.rootId, 'size', source)
          // A recoloured topic recolours its line (the line takes its child's colour).
          const pc = (prev.props as { color?: unknown }).color
          if (pc !== (next.props as { color?: unknown }).color) this.mark(meta.rootId, 'structure', source)
        }
      }),
      se.registerAfterDeleteHandler('shape', (shape, source) => {
        const root = this.rootOfAny(shape.id)
        this.blessed.delete(shape.id)
        if (this.index.remove(shape.id) && root) this.mark(root, 'structure', source)
      }),
      // A line that lost a binding (dragged off, or its end unbound) is repaired with its map.
      se.registerAfterDeleteHandler('binding', (binding, source) => {
        const e = this.index.edges.get(binding.fromId as TLShapeId)
        if (e && this.editor.getShape(binding.fromId as TLShapeId)) this.mark(e.rootId, 'structure', source)
      }),
      se.registerBeforeChangeHandler('shape', (prev, next, source) =>
        this.fitOnTextChange(prev, next, source),
      ),
      se.registerOperationCompleteHandler(() => this.onOperationComplete()),
    )
    const onEvent = () => {
      if (this.pendingDrops.size && !editor.isIn('select.translating')) this.flushDrops()
    }
    editor.on('event', onEvent)
    this.disposers.push(() => editor.off('event', onEvent))
    return () => this.dispose()
  }

  private disposed = false

  dispose() {
    this.disposed = true
    for (const d of this.disposers.splice(0)) d()
    if (this.remoteTimer !== null) clearTimeout(this.remoteTimer)
    this.remoteTimer = null
  }

  private isReplaying(): boolean {
    // tldraw 5.4.2 Editor.isReplayingHistory (@internal; sync-quality/perPropUndo.ts relies on it too).
    const fn = (this.editor as unknown as { isReplayingHistory?: () => boolean }).isReplayingHistory
    return typeof fn === 'function' ? fn.call(this.editor) : false
  }

  private rootOfAny(id: TLShapeId): string | null {
    return this.index.topics.get(id)?.rootId ?? this.index.edges.get(id)?.rootId ?? null
  }

  private bless(id: TLShapeId) {
    this.blessed.add(id)
  }

  private say(text: string) {
    this.status.set({ n: this.status.get().n + 1, text })
  }

  /**
   * Runs one of this runtime's own writes: the keeper stands still meanwhile, and what the write marked
   * is already laid out. (When this runs inside an operation-complete handler, the store reports the
   * write's changes in its next round, after this returns: the positions are recognised through
   * `selfWrites`, anything else lays out to the same result.)
   */
  private op<T>(fn: () => T): T {
    this.opDepth++
    try {
      return fn()
    } finally {
      this.opDepth--
      if (!this.opDepth) {
        this.dirtyUser.clear()
        this.createdForeign.clear()
      }
    }
  }

  // ---- reading ----------------------------------------------------------------------------------

  isTopic(id: TLShapeId | null | undefined): boolean {
    return !!id && this.index.topics.has(id)
  }

  metaOf(id: TLShapeId): MindmapTopicMeta | null {
    return this.index.topics.get(id) ?? null
  }

  /** The map rooted at `rootId`, from its topics on the root's page (null when the root is gone). */
  readTree(rootId: string): MindmapTree | null {
    const { editor } = this
    const ids = this.index.byRoot.get(rootId)
    const root = editor.getShape(rootId as TLShapeId)
    if (!ids || !root) return null
    const page = editor.getAncestorPageId(root)
    const inputs: TopicInput[] = []
    for (const id of ids) {
      // Copies still carrying their originals' meta (a paste in progress) are not part of any map yet.
      if (this.createdForeign.has(id)) continue
      const shape = editor.getShape(id)
      const meta = this.index.topics.get(id)
      if (!shape || !meta || editor.getAncestorPageId(shape) !== page) continue
      const b = editor.getShapePageBounds(shape)
      if (!b) continue
      inputs.push({ id, meta, box: { x: b.x, y: b.y, w: b.w, h: b.h } })
    }
    return buildTree(rootId, inputs)
  }

  treeOfTopic(id: TLShapeId): MindmapTree | null {
    const root = this.index.rootOf(id)
    return root ? this.readTree(root) : null
  }

  /** Plain text of a topic (for outlines). */
  textOf(id: string): string {
    const shape = this.editor.getShape(id as TLShapeId)
    if (!shape) return ''
    return this.editor.getShapeUtil(shape).getText?.(shape) ?? ''
  }

  // ---- sizes ------------------------------------------------------------------------------------

  private depthFromMeta(meta: MindmapTopicMeta): number {
    if (meta.parentId === null) return 0
    return meta.parentId === meta.rootId ? 1 : 2
  }

  /** The size a geo topic takes for its text at `depth`: the width follows the text within the level's range. */
  fitSize(shape: TLGeoShape, depth: number): { w: number; h: number } {
    const { editor } = this
    const st = levelStyle(depth)
    const scale = shape.props.scale || 1
    const plain = editor.getShapeUtil(shape).getText?.(shape) ?? ''
    if (!plain.trim()) return { w: st.minW * scale, h: st.minH * scale }
    const util = editor.getShapeUtil('geo') as unknown as GeoShapeUtil
    const dv = getDisplayValues(util, shape) as {
      labelFontFamily: string
      labelFontSize: number
      labelLineHeight: number
      labelPadding: number
      labelExtraPadding: number
    }
    const pad = dv.labelPadding
    const extra = dv.labelExtraPadding
    const html = renderHtmlFromRichTextForMeasurement(editor, shape.props.richText)
    const m = editor.textMeasure.measureHtml(html, {
      fontStyle: 'normal',
      fontWeight: 'normal',
      fontFamily: dv.labelFontFamily,
      fontSize: dv.labelFontSize,
      lineHeight: dv.labelLineHeight,
      padding: '0px',
      maxWidth: st.maxW - pad * 2 - extra - 2,
      minWidth: 0,
    })
    const w = Math.min(st.maxW, Math.max(st.minW, Math.ceil(m.w + pad * 2 + extra + 2)))
    const h = Math.max(st.minH, Math.ceil(m.h + pad * 2))
    return { w: w * scale, h: h * scale }
  }

  private fitOnTextChange(prev: TLShape, next: TLShape, source: 'user' | 'remote'): TLShape {
    if (source !== 'user' || next.type !== 'geo' || prev.props === next.props) return next
    const a = prev.props as TLGeoShape['props']
    const b = next.props as TLGeoShape['props']
    if (a.richText === b.richText && a.size === b.size && a.font === b.font && a.scale === b.scale)
      return next
    const meta = this.index.topics.get(next.id)
    if (!meta || this.isReplaying()) return next
    const size = this.fitSize(next as TLGeoShape, this.depthFromMeta(meta))
    if (near(size.w, b.w) && near(size.h, b.h) && b.growY === 0) return next
    return { ...next, props: { ...b, w: size.w, h: size.h, growY: 0 } } as TLShape
  }

  // ---- the keeper -------------------------------------------------------------------------------

  private mark(
    rootId: string,
    reason: 'structure' | 'size' | 'rootMoved' | 'dropped',
    source: 'user' | 'remote',
    id?: TLShapeId,
  ) {
    if (source === 'remote') {
      this.dirtyRemote.add(rootId)
      return
    }
    let d = this.dirtyUser.get(rootId)
    if (!d) {
      d = newDirty()
      this.dirtyUser.set(rootId, d)
    }
    if (reason === 'dropped') {
      if (id) d.dropped.add(id)
    } else d[reason] = true
    if (this.isReplaying()) d.replay = true
  }

  private onOperationComplete() {
    // Positions this runtime wrote were matched (and consumed) by the after-change handler of the same
    // put; anything left was a no-op write.
    this.selfWrites.clear()
    if (this.opDepth) return
    if (this.createdForeign.size) {
      // A paste puts its shapes and then, in a separate put, their bindings (which map the copies'
      // old ids to new ones). Wait until the whole paste is in; lay out only after renaming.
      this.scheduleNormalize()
      return
    }
    if (this.dirtyUser.size) this.op(() => this.flushUser())
    if (this.dirtyRemote.size) this.scheduleRemote()
  }

  private normalizeQueued = false

  private scheduleNormalize() {
    if (this.normalizeQueued) return
    this.normalizeQueued = true
    queueMicrotask(() => {
      this.normalizeQueued = false
      if (this.disposed) return
      // Still the same undo step as the paste (no history mark in between).
      const dirty = new Map(this.dirtyUser)
      if (this.createdForeign.size) this.op(() => this.normalizeCreated())
      for (const [root, d] of dirty) if (!this.dirtyUser.has(root)) this.dirtyUser.set(root, d)
      if (this.dirtyUser.size) this.op(() => this.flushUser())
      if (this.dirtyRemote.size) this.scheduleRemote()
    })
  }

  private flushUser() {
    const entries = [...this.dirtyUser]
    this.dirtyUser.clear()
    if (this.editor.getIsReadonly()) return
    const translating = this.editor.isIn('select.translating')
    for (const [rootId, d] of entries) {
      let drops: Set<TLShapeId> = new Set()
      if (d.dropped.size && !d.replay) {
        if (translating) {
          const pending = this.pendingDrops.get(rootId) ?? new Set<TLShapeId>()
          for (const id of d.dropped) pending.add(id)
          this.pendingDrops.set(rootId, pending)
          // While the drag lasts, each dragged topic's branch follows it (the drop then lays out all).
          this.editor.run(() => this.followDrag(rootId, d.dropped), { history: 'ignore' })
        } else drops = d.dropped
      }
      const plain = d.structure || d.size || d.rootMoved || (d.dropped.size > 0 && d.replay)
      if (!plain && !drops.size) continue
      this.editor.run(
        () => this.layoutNow(rootId, { drops, edges: d.structure || drops.size > 0 }),
        // A drop joins the drag's undo step; everything else is re-derived, outside the history.
        { history: drops.size ? 'record' : 'ignore' },
      )
    }
  }

  /** Lays out the branches under the dragged topics beside where they are now (not the dragged ones). */
  private followDrag(rootId: string, dragged: ReadonlySet<TLShapeId>) {
    const tree = this.readTree(rootId)
    if (!tree) return
    const selected = new Set<string>(this.editor.getSelectedShapeIds())
    for (const id of dragged) {
      const n = tree.nodes.get(id)
      if (!n || n.parentId === null || !n.children.length) continue
      const sub = subtreeOf(tree, id)
      if (!sub) continue
      const moved = movedPositions(sub, layoutTree(sub))
      for (const s of selected) moved.delete(s)
      this.applyPositions(sub, moved)
    }
  }

  private flushDrops() {
    const entries = [...this.pendingDrops]
    this.pendingDrops.clear()
    if (this.editor.getIsReadonly()) return
    this.op(() => {
      for (const [rootId, drops] of entries) {
        this.editor.run(() => this.layoutNow(rootId, { drops, edges: true }), { history: 'record' })
      }
    })
  }

  private scheduleRemote() {
    if (this.remoteTimer !== null) clearTimeout(this.remoteTimer)
    this.remoteTimer = setTimeout(() => {
      this.remoteTimer = null
      const roots = [...this.dirtyRemote]
      this.dirtyRemote.clear()
      if (this.disposed || this.editor.getIsReadonly()) return
      // Someone here is still dragging: their drop lays the map out.
      if (this.editor.isIn('select.translating')) {
        for (const r of roots) this.dirtyRemote.add(r)
        this.scheduleRemote()
        return
      }
      this.op(() => {
        for (const rootId of roots) {
          this.editor.run(() => this.layoutNow(rootId, { edges: true }), { history: 'ignore' })
        }
      })
    }, REMOTE_SETTLE_MS)
  }

  /**
   * Lays out one map now (inside editor.run). `drops`: topics the user dropped somewhere; a first-level
   * one takes the side of the central topic it was dropped on. `sides`: new first-level sides (Tidy
   * up). `edges`: also repair the lines.
   */
  layoutNow(
    rootId: string,
    opts: { drops?: ReadonlySet<TLShapeId>; sides?: ReadonlyMap<string, MindmapSide>; edges?: boolean } = {},
  ) {
    const { editor } = this
    let tree = this.readTree(rootId)
    if (!tree) return
    const patches = new Map<string, Partial<MindmapTopicMeta>>()
    const patch = (id: string, p: Partial<MindmapTopicMeta>) => patches.set(id, { ...patches.get(id), ...p })
    const restyles: [string, number][] = []
    const root = tree.nodes.get(rootId)
    if (root && opts.drops) {
      for (const id of opts.drops) {
        const n = tree.nodes.get(id)
        if (!n || n.parentId === null) continue
        const cx = n.box.x + n.box.w / 2
        // Dropped onto another topic: it becomes that topic's child (with its whole branch).
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
    const metaUpdates: TLShapePartial[] = []
    for (const [id, p] of patches) {
      const shape = editor.getShape(id as TLShapeId)
      const meta = this.index.topics.get(id as TLShapeId)
      if (!shape || !meta) continue
      const next = { ...meta, ...p }
      if (next.parentId === meta.parentId && next.side === meta.side && next.collapsed === meta.collapsed)
        continue
      metaUpdates.push({ id: shape.id, type: shape.type, meta: { ...shape.meta, [MINDMAP_META_KEY]: next } })
    }
    if (metaUpdates.length || restyles.length) {
      if (metaUpdates.length) editor.updateShapes(metaUpdates)
      for (const [id, delta] of restyles) this.restyleBranch(tree, id as TLShapeId, delta)
      tree = this.readTree(rootId)
      if (!tree) return
    }
    this.applyPositions(tree, movedPositions(tree, layoutTree(tree)))
    if (opts.edges) {
      const after = this.readTree(rootId)
      if (after) this.ensureEdges(after)
    }
    this.keepInFrame(rootId)
  }

  /**
   * R7: a map inside a frame stays inside it as it grows. The frame grows right and down around it
   * (the map moves off the frame's left and top edges first), so no topic is clipped by the frame or
   * missing from its slide. Part of the same write as the layout (and so of its undo step, if any).
   */
  private keepInFrame(rootId: string) {
    const { editor } = this
    const root = editor.getShape(rootId as TLShapeId)
    const frame = root ? editor.getShape(root.parentId as TLShapeId) : undefined
    if (!root || !frame || frame.type !== 'frame' || editor.isShapeOrAncestorLocked(frame)) return
    if (editor.getShapePageTransform(frame).rotation() !== 0) return
    const tree = this.readTree(rootId)
    const fb = editor.getShapePageBounds(frame)
    if (!tree || !fb) return
    const inside: TLShape[] = []
    for (const id of tree.nodes.keys()) {
      const s = editor.getShape(id as TLShapeId)
      if (s && s.parentId === frame.id && !hiddenByCollapse(editor, s)) inside.push(s)
    }
    const content = unionRects(inside.map((s) => tree.nodes.get(s.id)?.box ?? { x: 0, y: 0, w: 0, h: 0 }))
    const fit = fitFrameAround({ x: fb.x, y: fb.y, w: fb.w, h: fb.h }, content)
    if (!fit) return
    if (fit.dx || fit.dy) {
      const updates: TLShapePartial[] = []
      for (const id of tree.nodes.keys()) {
        const s = editor.getShape(id as TLShapeId)
        if (!s || s.parentId !== frame.id) continue
        const origin = editor.getShapePageTransform(s).point()
        const local = editor.getPointInParentSpace(s, { x: origin.x + fit.dx, y: origin.y + fit.dy })
        updates.push({ id: s.id, type: s.type, x: local.x, y: local.y })
        this.selfWrites.set(s.id, { x: local.x, y: local.y })
      }
      editor.updateShapes(updates)
    }
    const props = frame.props as { w: number; h: number }
    if (fit.w !== props.w || fit.h !== props.h) {
      editor.updateShape({ id: frame.id, type: frame.type, props: { w: fit.w, h: fit.h } })
    }
  }

  /**
   * R7: the frame a new map belongs to: the selected frame, else the one that fills the view (the
   * Export dialog's rule). Locked frames are skipped: a map in one could not be edited.
   */
  private frameForNewMap(): TLShape | null {
    const { editor } = this
    const usable = (s: TLShape | undefined | null): s is TLShape =>
      !!s &&
      s.type === 'frame' &&
      !editor.isShapeOrAncestorLocked(s) &&
      editor.getShapePageTransform(s).rotation() === 0
    const only = editor.getOnlySelectedShape()
    if (usable(only)) return only
    const frames: { id: string; bounds: Box }[] = []
    for (const s of editor.getCurrentPageShapes()) {
      if (!usable(s)) continue
      const b = editor.getShapePageBounds(s)
      if (b) frames.push({ id: s.id, bounds: { x: b.x, y: b.y, w: b.w, h: b.h } })
    }
    const id = frameInView(editor.getViewportPageBounds(), frames)
    return id ? (editor.getShape(id as TLShapeId) ?? null) : null
  }

  private applyPositions(tree: MindmapTree, moved: ReadonlyMap<string, Point>) {
    if (!moved.size) return
    const { editor } = this
    const updates: TLShapePartial[] = []
    for (const [id, p] of moved) {
      const shape = editor.getShape(id as TLShapeId)
      const box = tree.nodes.get(id)?.box
      if (!shape || !box) continue
      const origin = editor.getShapePageTransform(shape).point()
      const target = { x: p.x + (origin.x - box.x), y: p.y + (origin.y - box.y) }
      const local = editor.getPointInParentSpace(shape, target)
      updates.push({ id: shape.id, type: shape.type, x: local.x, y: local.y })
      this.selfWrites.set(shape.id, { x: local.x, y: local.y })
    }
    editor.updateShapes(updates)
  }

  /** Every topic but the root has exactly one line from its parent, bound at the right sides. */
  private ensureEdges(tree: MindmapTree) {
    const { editor } = this
    const wanted = new Set<TLShapeId>()
    for (const n of tree.nodes.values()) {
      if (n.parentId === null) continue
      const child = editor.getShape(n.id as TLShapeId)
      const parent = editor.getShape(n.parentId as TLShapeId)
      if (!child || !parent) continue
      const preferred = edgeIdFor(n.id)
      const ids = [...(this.index.edgesByChild.get(n.id) ?? [])]
        .filter((id) => editor.getShape(id) && !this.createdForeign.has(id))
        .sort((a, b) => (a === preferred ? -1 : b === preferred ? 1 : a < b ? -1 : 1))
      const [keep, ...extra] = ids
      if (extra.length) editor.deleteShapes(extra)
      const color = colorOf(child) ?? 'grey'
      if (!keep) {
        wanted.add(this.createEdge(tree.rootId, parent, child, n.side, color, n.depth))
        continue
      }
      wanted.add(keep)
      this.fixEdge(keep, tree.rootId, parent, child, n.side, color, n.depth)
    }
    // Lines of this map whose child is no longer one of its topics.
    const stale: TLShapeId[] = []
    for (const [id, e] of this.index.edges) {
      if (
        e.rootId === tree.rootId &&
        !wanted.has(id) &&
        !this.createdForeign.has(id) &&
        editor.getShape(id)
      ) {
        stale.push(id)
      }
    }
    if (stale.length) editor.deleteShapes(stale)
  }

  private createEdge(
    rootId: string,
    parent: TLShape,
    child: TLShape,
    side: MindmapSide,
    color: TLDefaultColorStyle,
    depth: number,
  ): TLShapeId {
    const { editor } = this
    const preferred = edgeIdFor(child.id)
    const id = editor.getShape(preferred) ? createShapeId() : preferred
    this.bless(id)
    const a = anchorsFor(side)
    const pb = editor.getShapePageBounds(parent)
    const cb = editor.getShapePageBounds(child)
    const start = pb ? { x: pb.x + pb.w * a.parent.x, y: pb.y + pb.h * a.parent.y } : { x: 0, y: 0 }
    const end = cb ? { x: cb.x + cb.w * a.child.x, y: cb.y + cb.h * a.child.y } : start
    const container = editor.getShape(child.parentId as TLShapeId)
    const local = container ? editor.getPointInShapeSpace(container, start) : start
    editor.createShape<TLArrowShape>({
      id,
      type: 'arrow',
      parentId: child.parentId,
      x: local.x,
      y: local.y,
      props: {
        kind: 'elbow',
        color,
        size: edgeSize(depth),
        dash: 'solid',
        fill: 'none',
        arrowheadStart: 'none',
        arrowheadEnd: 'none',
        start: { x: 0, y: 0 },
        end: { x: end.x - start.x, y: end.y - start.y },
      },
      meta: { [MINDMAP_EDGE_META_KEY]: { rootId, parentId: parent.id, childId: child.id } },
    })
    editor.createBindings<TLArrowBinding>([
      {
        type: 'arrow',
        fromId: id,
        toId: parent.id,
        props: {
          terminal: 'start',
          normalizedAnchor: a.parent,
          isExact: false,
          isPrecise: true,
          snap: 'none',
        },
      },
      {
        type: 'arrow',
        fromId: id,
        toId: child.id,
        props: { terminal: 'end', normalizedAnchor: a.child, isExact: false, isPrecise: true, snap: 'none' },
      },
    ])
    return id
  }

  private fixEdge(
    id: TLShapeId,
    rootId: string,
    parent: TLShape,
    child: TLShape,
    side: MindmapSide,
    color: TLDefaultColorStyle,
    depth: number,
  ) {
    const { editor } = this
    const edge = editor.getShape<TLArrowShape>(id)
    if (!edge) return
    const meta = this.index.edges.get(id)
    const size = edgeSize(depth)
    if (
      !meta ||
      meta.rootId !== rootId ||
      meta.parentId !== parent.id ||
      meta.childId !== child.id ||
      edge.props.color !== color ||
      edge.props.size !== size ||
      edge.props.kind !== 'elbow'
    ) {
      editor.updateShape<TLArrowShape>({
        id,
        type: 'arrow',
        props: { color, size, kind: 'elbow' },
        meta: { ...edge.meta, [MINDMAP_EDGE_META_KEY]: { rootId, parentId: parent.id, childId: child.id } },
      })
    }
    const a = anchorsFor(side)
    const bindings = editor.getBindingsFromShape<TLArrowBinding>(id, 'arrow')
    const wantedEnds = [
      { terminal: 'start' as const, target: parent.id, anchor: a.parent },
      { terminal: 'end' as const, target: child.id, anchor: a.child },
    ]
    for (const { terminal, target, anchor } of wantedEnds) {
      const b = bindings.find((x) => x.props.terminal === terminal)
      const ok =
        b &&
        b.toId === target &&
        near(b.props.normalizedAnchor.x, anchor.x) &&
        near(b.props.normalizedAnchor.y, anchor.y) &&
        b.props.isPrecise
      if (ok) continue
      if (b) editor.deleteBindings([b])
      editor.createBindings<TLArrowBinding>([
        {
          type: 'arrow',
          fromId: id,
          toId: target,
          props: { terminal, normalizedAnchor: anchor, isExact: false, isPrecise: true, snap: 'none' },
        },
      ])
    }
  }

  // ---- copies (paste, duplicate, move to page) ---------------------------------------------------

  private normalizeCreated() {
    const { editor } = this
    const created = [...this.createdForeign]
    this.createdForeign.clear()
    if (editor.getIsReadonly()) return
    const topics: TLShape[] = []
    const edges: TLArrowShape[] = []
    for (const id of created) {
      const s = editor.getShape(id)
      if (!s) continue
      if (topicMetaOf(s)) topics.push(s)
      else if (edgeMetaOf(s)) edges.push(s as TLArrowShape)
    }
    if (!topics.length && !edges.length) return
    const topicIds = new Set<string>(topics.map((t) => t.id))
    // Old ids -> new ids: a copied central topic names its old self as rootId; a copied line binds the copies.
    const map = new Map<string, string>()
    for (const t of topics) {
      const m = topicMetaOf(t)
      if (m && m.parentId === null) map.set(m.rootId, t.id)
    }
    for (const e of edges) {
      const m = edgeMetaOf(e)
      if (!m) continue
      for (const b of editor.getBindingsFromShape<TLArrowBinding>(e.id, 'arrow')) {
        if (!topicIds.has(b.toId)) continue
        if (b.props.terminal === 'start') map.set(m.parentId, b.toId)
        else map.set(m.childId, b.toId)
      }
    }
    const parentOf = new Map<string, string | null>()
    for (const t of topics) {
      const m = topicMetaOf(t)
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
    // Loops among copies: cut them at the topic the walk stopped on.
    for (const t of topics) {
      const r = rootOf(t.id)
      if (parentOf.get(r) !== null) parentOf.set(r, null)
    }
    const updates: TLShapePartial[] = []
    const roots = new Set<string>()
    for (const t of topics) {
      const m = topicMetaOf(t)
      if (!m) continue
      const parentId = parentOf.get(t.id) ?? null
      const rootId = rootOf(t.id)
      roots.add(rootId)
      const next: MindmapTopicMeta = {
        rootId,
        parentId,
        side: parentId === null ? 'right' : m.side,
        collapsed: m.collapsed,
      }
      if (next.rootId !== m.rootId || next.parentId !== m.parentId || next.side !== m.side) {
        updates.push({ id: t.id, type: t.type, meta: { ...t.meta, [MINDMAP_META_KEY]: next } })
      }
    }
    const badEdges: TLShapeId[] = []
    for (const e of edges) {
      const bs = editor.getBindingsFromShape<TLArrowBinding>(e.id, 'arrow')
      const start = bs.find((b) => b.props.terminal === 'start')?.toId
      const end = bs.find((b) => b.props.terminal === 'end')?.toId
      if (!start || !end || !topicIds.has(end) || parentOf.get(end) !== start) {
        badEdges.push(e.id)
        continue
      }
      updates.push({
        id: e.id,
        type: 'arrow',
        meta: { ...e.meta, [MINDMAP_EDGE_META_KEY]: { rootId: rootOf(end), parentId: start, childId: end } },
      })
    }
    editor.run(() => {
      if (updates.length) editor.updateShapes(updates)
      if (badEdges.length) editor.deleteShapes(badEdges)
      for (const r of roots) {
        this.layoutNow(r, { edges: true })
        this.moveClearOfOthers(r)
      }
    })
  }

  /**
   * A pasted or duplicated map lands where tldraw puts the copy, usually on top of its original: it
   * moves, whole, to the nearest free spot instead (nothing is moved when it overlaps nothing).
   */
  private moveClearOfOthers(rootId: string) {
    const { editor } = this
    const tree = this.readTree(rootId)
    const root = editor.getShape(rootId as TLShapeId)
    if (!tree || !root) return
    const own = new Set<string>(tree.nodes.keys())
    for (const [id, e] of this.index.edges) if (e.rootId === rootId) own.add(id)
    const boxes = [...tree.nodes.values()].map((n) => n.box)
    const x0 = Math.min(...boxes.map((b) => b.x))
    const y0 = Math.min(...boxes.map((b) => b.y))
    const bounds = {
      x: x0,
      y: y0,
      w: Math.max(...boxes.map((b) => b.x + b.w)) - x0,
      h: Math.max(...boxes.map((b) => b.y + b.h)) - y0,
    }
    const obstacles: Box[] = []
    for (const s of editor.getCurrentPageShapes()) {
      if (own.has(s.id) || s.type === 'frame' || s.type === 'group') continue
      const b = editor.getShapePageBounds(s)
      if (b) obstacles.push({ x: b.x, y: b.y, w: b.w, h: b.h })
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
    const origin = editor.getShapePageTransform(root).point()
    const local = editor.getPointInParentSpace(root, {
      x: origin.x + at.x - bounds.x,
      y: origin.y + at.y - bounds.y,
    })
    editor.updateShape({ id: root.id, type: root.type, x: local.x, y: local.y })
    this.layoutNow(rootId)
  }

  // ---- operations -------------------------------------------------------------------------------

  private canEdit(): boolean {
    return !this.editor.getIsReadonly()
  }

  /** A new geo topic record, top-left at `page` (page space), inside the tldraw parent `container`. */
  private geoTopic(
    id: TLShapeId,
    container: TLParentId,
    page: Point,
    depth: number,
    color: TLDefaultColorStyle,
    meta: MindmapTopicMeta,
    text = '',
  ) {
    const st = levelStyle(depth)
    const draft = {
      id,
      type: 'geo' as const,
      parentId: container,
      x: page.x,
      y: page.y,
      props: {
        geo: 'rectangle' as const,
        w: st.minW,
        h: st.minH,
        color,
        labelColor: 'black' as const,
        fill: st.fill,
        dash: 'solid' as const,
        size: st.size,
        font: 'sans' as const,
        align: 'middle' as const,
        verticalAlign: 'middle' as const,
        richText: toRichText(text),
        growY: 0,
        scale: 1,
      },
      meta: { [MINDMAP_META_KEY]: meta },
    }
    if (text) {
      const size = this.fitSize(draft as unknown as TLGeoShape, depth)
      draft.props.w = size.w
      draft.props.h = size.h
    }
    const parentShape = this.editor.getShape(container as TLShapeId)
    if (parentShape) {
      const local = this.editor.getPointInShapeSpace(parentShape, page)
      draft.x = local.x
      draft.y = local.y
    }
    this.bless(id)
    return draft
  }

  /** The space a new map keeps free around its central topic: room for a few branches either side. */
  private newMapRoom() {
    return { w: levelStyle(0).minW + 2 * (DEFAULT_LAYOUT.hGap(1) + 300), h: 360 }
  }

  /**
   * Where a new map goes inside `frame` (R7): its centre, and the frame's new height when the map only
   * fits below the frame's content.
   */
  private spotInFrame(frame: TLShape, center: Point): { center: Point; growToH: number | null } | null {
    const { editor } = this
    const fb = editor.getShapePageBounds(frame)
    if (!fb) return null
    const children: Box[] = []
    for (const id of editor.getSortedChildIdsForParent(frame.id)) {
      const b = editor.getShapePageBounds(id)
      if (b) children.push({ x: b.x, y: b.y, w: b.w, h: b.h })
    }
    const placed = placeInFrame(this.newMapRoom(), center, { x: fb.x, y: fb.y, w: fb.w, h: fb.h }, children)
    return {
      center: { x: placed.at.x + placed.room.w / 2, y: placed.at.y + placed.room.h / 2 },
      growToH: placed.growToH,
    }
  }

  /** Where a new map goes: the free spot nearest `center` with room for a few branches around it. */
  private spotForNewMap(center: Point): Point {
    const { editor } = this
    const room = this.newMapRoom()
    const obstacles: Box[] = []
    const pageId = editor.getCurrentPageId()
    for (const s of editor.getCurrentPageShapes()) {
      if (s.parentId !== pageId) continue
      const b = editor.getShapePageBounds(s)
      if (b) obstacles.push({ x: b.x, y: b.y, w: b.w, h: b.h })
    }
    const at = findEmptySpot(room, center, obstacles, { gap: 40 })
    return { x: at.x + room.w / 2, y: at.y + room.h / 2 }
  }

  /**
   * New map: a central topic at the free spot nearest the view's centre, selected for typing. With a
   * frame selected or filling the view (R7), inside that frame (which grows downward when it is full),
   * so the map is on the frame's slide in Present and its page in the PDF.
   */
  createMap(center?: Point): TLShapeId | null {
    if (!this.canEdit()) return null
    const { editor } = this
    const want = center ?? editor.getViewportPageBounds().center
    const frame = this.frameForNewMap()
    const inFrame = frame ? this.spotInFrame(frame, want) : null
    const c = inFrame?.center ?? this.spotForNewMap(want)
    const container: TLParentId = frame && inFrame ? frame.id : editor.getCurrentPageId()
    const id = createShapeId()
    editor.markHistoryStoppingPoint('mindmap: new map')
    this.op(() =>
      editor.run(() => {
        if (frame && inFrame?.growToH) {
          editor.updateShape({ id: frame.id, type: 'frame', props: { h: Math.ceil(inFrame.growToH) } })
        }
        const draft = this.geoTopic(
          id,
          container,
          c,
          0,
          ROOT_COLOR,
          { rootId: id, parentId: null, side: 'right', collapsed: false },
          NEW_ROOT_TEXT,
        )
        const topLeft = { x: Math.round(c.x - draft.props.w / 2), y: Math.round(c.y - draft.props.h / 2) }
        const local = frame && inFrame ? editor.getPointInShapeSpace(frame, topLeft) : topLeft
        draft.x = local.x
        draft.y = local.y
        editor.createShape(draft)
      }),
    )
    editor.select(id)
    this.reveal(id)
    startEditingShapeWithRichText(editor, id, { selectAll: true })
    this.say('New mind map. Type the central topic, then press Tab to add a branch.')
    return id
  }

  /** Can `shape` start a map? (A note, text or geo that is not a topic yet, unlocked, not in a group.) */
  canStartFrom(shape: TLShape | null | undefined): shape is TLShape {
    if (!shape || !TOPIC_TYPES.has(shape.type) || this.isTopic(shape.id)) return false
    if (this.editor.isShapeOrAncestorLocked(shape)) return false
    const parent = this.editor.getShape(shape.parentId as TLShapeId)
    return !parent || parent.type === 'frame'
  }

  /** "Start a mind map": the shape becomes the central topic and gets a first branch to type in. */
  startFrom(shapeId: TLShapeId): TLShapeId | null {
    const { editor } = this
    const shape = editor.getShape(shapeId)
    if (!this.canEdit() || !this.canStartFrom(shape)) return null
    editor.markHistoryStoppingPoint('mindmap: start')
    this.op(() =>
      editor.updateShape({
        id: shape.id,
        type: shape.type,
        meta: {
          ...shape.meta,
          [MINDMAP_META_KEY]: { rootId: shape.id, parentId: null, side: 'right', collapsed: false },
        },
      }),
    )
    this.say('Mind map started. Type the first branch; Tab adds a child, Enter a sibling.')
    return this.addChild(shape.id)
  }

  /** Tab: a new child of `parentId` (after its last child), selected and being edited. */
  addChild(parentId: TLShapeId, opts: { side?: MindmapSide } = {}): TLShapeId | null {
    const { editor } = this
    if (!this.canEdit()) return null
    const tree = this.treeOfTopic(parentId)
    const parent = tree?.nodes.get(parentId)
    const parentShape = editor.getShape(parentId)
    if (!tree || !parent || !parentShape) return null
    const mark = editor.markHistoryStoppingPoint('mindmap: add topic')
    const depth = parent.depth + 1
    const heights = blockHeights(tree)
    const side: MindmapSide =
      parent.parentId === null
        ? (opts.side ?? sideForNewBranch(tree, (id) => heights.get(id) ?? 0))
        : parent.side
    const color = this.colorForNew(tree, parentShape, depth)
    const st = levelStyle(depth)
    const siblings =
      parent.parentId === null
        ? parent.children.filter((c) => tree.nodes.get(c)?.side === side)
        : parent.children
    const last = siblings.length ? tree.nodes.get(siblings[siblings.length - 1] as string) : undefined
    const cy = last ? last.box.y + last.box.h / 2 + 1 : parent.box.y + parent.box.h / 2
    const gap = DEFAULT_LAYOUT.hGap(depth)
    const x = side === 'right' ? parent.box.x + parent.box.w + gap : parent.box.x - gap - st.minW
    const id = createShapeId()
    this.op(() =>
      editor.run(() => {
        if (parent.collapsed) this.setCollapsedMeta(parentId, false)
        editor.createShape(
          this.geoTopic(id, parentShape.parentId, { x, y: cy - st.minH / 2 }, depth, color, {
            rootId: tree.rootId,
            parentId,
            side,
            collapsed: false,
          }),
        )
        this.layoutNow(tree.rootId, { edges: true })
      }),
    )
    this.beginTyping(id, mark)
    return id
  }

  /** Enter: a new sibling right below `topicId` (on the central topic: a new branch). */
  addSibling(topicId: TLShapeId): TLShapeId | null {
    const { editor } = this
    if (!this.canEdit()) return null
    const tree = this.treeOfTopic(topicId)
    const node = tree?.nodes.get(topicId)
    if (!tree || !node) return null
    if (node.parentId === null) return this.addChild(topicId)
    const parentShape = editor.getShape(node.parentId as TLShapeId)
    const shape = editor.getShape(topicId)
    if (!parentShape || !shape) return null
    const mark = editor.markHistoryStoppingPoint('mindmap: add topic')
    const depth = node.depth
    const color =
      depth === 1
        ? this.colorForNew(tree, parentShape, depth)
        : (colorOf(shape) ?? colorOf(parentShape) ?? 'grey')
    const st = levelStyle(depth)
    const cy = node.box.y + node.box.h / 2 + 0.5
    const x = node.side === 'right' ? node.box.x : node.box.x + node.box.w - st.minW
    const id = createShapeId()
    this.op(() =>
      editor.run(() => {
        editor.createShape(
          this.geoTopic(id, shape.parentId, { x, y: cy - st.minH / 2 }, depth, color, {
            rootId: tree.rootId,
            parentId: node.parentId,
            side: node.side,
            collapsed: false,
          }),
        )
        this.layoutNow(tree.rootId, { edges: true })
      }),
    )
    this.beginTyping(id, mark)
    return id
  }

  private colorForNew(tree: MindmapTree, parentShape: TLShape, depth: number): TLDefaultColorStyle {
    if (depth > 1) {
      const c = colorOf(parentShape)
      return c && c !== ROOT_COLOR ? c : 'blue'
    }
    const used: string[] = []
    for (const id of tree.nodes.get(tree.rootId)?.children ?? []) {
      const c = colorOf(this.editor.getShape(id as TLShapeId))
      if (c) used.push(c)
    }
    return nextBranchColor(used)
  }

  /** Selects the new topic, keeps it in view and starts typing in it. */
  private beginTyping(id: TLShapeId, mark: string) {
    const { editor } = this
    editor.select(id)
    this.reveal(id)
    startEditingShapeWithRichText(editor, id, { selectAll: true })
    this.fresh = { id, mark }
  }

  /** Pans (without zooming) so `id` is on screen with some room around it. */
  reveal(id: TLShapeId) {
    const { editor } = this
    const b = editor.getShapePageBounds(id)
    if (!b) return
    const vp = editor.getViewportPageBounds()
    const z = editor.getZoomLevel()
    // Room around it, in screen pixels: more at the bottom, where tldraw's toolbar floats.
    const side = Math.min(80 / z, vp.w / 4)
    const top = Math.min(80 / z, vp.h / 4)
    const bottom = Math.min(140 / z, vp.h / 3)
    let dx = 0
    let dy = 0
    if (b.maxX > vp.maxX - side) dx = b.maxX - (vp.maxX - side)
    if (b.minX < vp.minX + side) dx = b.minX - (vp.minX + side)
    if (b.maxY > vp.maxY - bottom) dy = b.maxY - (vp.maxY - bottom)
    if (b.minY < vp.minY + top) dy = b.minY - (vp.minY + top)
    if (!dx && !dy) return
    const cam = editor.getCamera()
    editor.setCamera({ x: cam.x - dx, y: cam.y - dy, z: cam.z }, { animation: { duration: 160 } })
  }

  /**
   * Editing of `id` ended. A topic made by Tab/Enter that is still empty (and has no children) goes
   * back as if it never was: that step is undone and dropped, and its parent is selected again.
   */
  editingEnded(id: TLShapeId) {
    const fresh = this.fresh
    if (!fresh || fresh.id !== id) return
    this.fresh = null
    const { editor } = this
    const meta = this.index.topics.get(id)
    if (!meta || meta.parentId === null || !editor.getShape(id)) return
    if (this.textOf(id).trim() !== '' || (this.index.children.get(id)?.size ?? 0) > 0) return
    const parentId = meta.parentId as TLShapeId
    // What the person selected since (a click elsewhere ended the editing) survives the take-back.
    const selection = editor.getSelectedShapeIds().filter((s) => s !== id)
    editor.bailToMark(fresh.mark)
    const keep = selection.filter((s) => editor.getShape(s))
    if (keep.length) editor.setSelectedShapes(keep)
    else if (editor.getShape(parentId)) editor.select(parentId)
    this.say('Empty topic removed.')
  }

  /** Shift+Tab: the topic becomes its parent's next sibling (one level up). */
  promote(topicId: TLShapeId): boolean {
    const { editor } = this
    if (!this.canEdit()) return false
    const tree = this.treeOfTopic(topicId)
    const node = tree?.nodes.get(topicId)
    if (!tree || !node || node.parentId === null) return false
    const parent = tree.nodes.get(node.parentId)
    const shape = editor.getShape(topicId)
    const meta = this.index.topics.get(topicId)
    if (!parent || !shape || !meta) return false
    if (parent.parentId === null) {
      this.say('This topic is already a main branch.')
      return false
    }
    const newParentId = parent.parentId
    const delta = parent.depth - node.depth
    if (editor.getEditingShapeId() !== topicId) editor.markHistoryStoppingPoint('mindmap: move up a level')
    this.op(() =>
      editor.run(() => {
        // Just below its old parent, so it sorts right after it among its new siblings.
        const origin = editor.getShapePageTransform(shape).point()
        const dy = parent.box.y + parent.box.h / 2 + 0.5 - (node.box.y + node.box.h / 2)
        const local = editor.getPointInParentSpace(shape, { x: origin.x, y: origin.y + dy })
        editor.updateShape({
          id: topicId,
          type: shape.type,
          x: local.x,
          y: local.y,
          meta: { ...shape.meta, [MINDMAP_META_KEY]: { ...meta, parentId: newParentId, side: parent.side } },
        })
        this.restyleBranch(tree, topicId, delta)
        this.layoutNow(tree.rootId, { edges: true })
      }),
    )
    this.reveal(topicId)
    this.say('Moved up a level.')
    return true
  }

  /** Size and fill follow the level after a branch changes depth (geo topics; colours are kept). */
  private restyleBranch(tree: MindmapTree, topicId: TLShapeId, delta: number) {
    if (!delta) return
    const { editor } = this
    const updates: TLShapePartial[] = []
    for (const id of subtreeIds(tree, topicId)) {
      const shape = editor.getShape(id as TLShapeId)
      const n = tree.nodes.get(id)
      if (shape?.type !== 'geo' || !n) continue
      const depth = Math.max(1, n.depth + delta)
      const st = levelStyle(depth)
      const props = shape.props as TLGeoShape['props']
      const size = this.fitSize(
        { ...shape, props: { ...props, size: st.size, fill: st.fill } } as TLGeoShape,
        depth,
      )
      updates.push({
        id: shape.id,
        type: 'geo',
        props: { size: st.size, fill: st.fill, w: size.w, h: size.h, growY: 0 },
      })
    }
    if (updates.length) editor.updateShapes(updates)
  }

  private setCollapsedMeta(id: TLShapeId, collapsed: boolean) {
    const shape = this.editor.getShape(id)
    const meta = this.index.topics.get(id)
    if (!shape || !meta || meta.collapsed === collapsed) return
    this.editor.updateShape({
      id,
      type: shape.type,
      meta: { ...shape.meta, [MINDMAP_META_KEY]: { ...meta, collapsed } },
    })
  }

  /** Collapse or expand a topic's branch (one undo step). */
  toggleCollapsed(id: TLShapeId, collapsed?: boolean): boolean {
    const { editor } = this
    if (!this.canEdit()) return false
    const meta = this.index.topics.get(id)
    const tree = this.treeOfTopic(id)
    const node = tree?.nodes.get(id)
    if (!meta || !tree || !node?.children.length) return false
    const next = collapsed ?? !meta.collapsed
    if (next === meta.collapsed) return false
    const hidden = subtreeIds(tree, id).slice(1)
    editor.markHistoryStoppingPoint(next ? 'mindmap: collapse' : 'mindmap: expand')
    this.op(() =>
      editor.run(() => {
        this.setCollapsedMeta(id, next)
        if (next) {
          const set = new Set<string>(hidden)
          if (editor.getSelectedShapeIds().some((s) => set.has(s))) editor.select(id)
        }
        this.layoutNow(tree.rootId, { edges: true })
      }),
    )
    const n = hidden.length
    this.say(next ? `Collapsed: ${n} ${n === 1 ? 'topic' : 'topics'} hidden.` : 'Expanded.')
    return true
  }

  /** Tidy up: balance the branches between the two sides (keeping their order) and lay out again. */
  tidy(topicId: TLShapeId): boolean {
    const { editor } = this
    if (!this.canEdit()) return false
    const rootId = this.index.rootOf(topicId)
    const tree = rootId ? this.readTree(rootId) : null
    if (!rootId || !tree) return false
    const heights = blockHeights(tree)
    const sides = balancedSides(tree, (id) => heights.get(id) ?? 0)
    editor.markHistoryStoppingPoint('mindmap: tidy up')
    this.op(() => editor.run(() => this.layoutNow(rootId, { sides, edges: true })))
    this.say('Mind map tidied up.')
    return true
  }

  /** Arrow keys: select the next topic in that direction (or open a collapsed one). */
  navigate(id: TLShapeId, dir: NavDirection): boolean {
    const tree = this.treeOfTopic(id)
    if (!tree) return false
    const r = navigate(tree, id, dir)
    if (r.expand) return this.canEdit() ? this.toggleCollapsed(r.expand as TLShapeId, false) : false
    if (!r.select) return false
    this.editor.select(r.select as TLShapeId)
    this.reveal(r.select as TLShapeId)
    return true
  }

  /** F2 / type-to-edit: edit the topic. */
  editTopic(id: TLShapeId): boolean {
    const { editor } = this
    const shape = editor.getShape(id)
    if (!shape || !editor.canEditShape(shape)) return false
    editor.markHistoryStoppingPoint('mindmap: edit topic')
    startEditingShapeWithRichText(editor, shape, { selectAll: false })
    return true
  }

  // ---- delete -----------------------------------------------------------------------------------

  /**
   * What Delete removes for this selection: every selected topic with its whole branch (collapsed
   * parts included) and their lines. A selected line alone is kept (it belongs to its topic). Null when
   * the selection holds no mind-map shape (tldraw's own delete then runs as usual).
   */
  planDelete(ids: readonly TLShapeId[]): DeletePlan | null {
    const { editor } = this
    if (!ids.some((id) => this.index.topics.has(id) || this.index.edges.has(id))) return null
    const out = new Set<TLShapeId>()
    const trees = new Map<string, MindmapTree | null>()
    let selectAfter: TLShapeId | null = null
    let wholeMap = false
    const roots = new Set<string>()
    for (const id of ids) {
      if (this.index.edges.has(id)) continue
      const meta = this.index.topics.get(id)
      if (!meta) {
        out.add(id)
        continue
      }
      if (!trees.has(meta.rootId)) trees.set(meta.rootId, this.readTree(meta.rootId))
      const tree = trees.get(meta.rootId)
      const branch = tree?.nodes.has(id) ? subtreeIds(tree, id) : [id]
      for (const t of branch) out.add(t as TLShapeId)
      if (meta.parentId === null) wholeMap = true
      else {
        roots.add(meta.rootId)
        const parent = tree?.nodes.get(id)?.parentId
        if (!selectAfter && parent) selectAfter = parent as TLShapeId
      }
    }
    let topics = 0
    for (const t of [...out]) {
      if (!this.index.topics.has(t)) continue
      topics++
      for (const e of this.index.edgesByChild.get(t) ?? []) out.add(e)
    }
    for (const [eid, e] of this.index.edges) if (out.has(e.parentId as TLShapeId)) out.add(eid)
    if (selectAfter && out.has(selectAfter)) selectAfter = null
    return {
      ids: [...out].filter((id) => editor.getShape(id)),
      topics,
      selectAfter,
      roots: [...roots].filter((r) => !out.has(r as TLShapeId)),
      wholeMap,
    }
  }

  /** Runs a delete plan as one undo step, lays out what is left and selects the parent. */
  runDelete(plan: DeletePlan) {
    const { editor } = this
    if (!this.canEdit() || !plan.ids.length) return
    editor.markHistoryStoppingPoint('mindmap: delete')
    this.op(() =>
      editor.run(() => {
        editor.deleteShapes(plan.ids)
        for (const r of plan.roots) this.layoutNow(r, { edges: true })
        if (plan.selectAfter && editor.getShape(plan.selectAfter)) editor.select(plan.selectAfter)
      }),
    )
    this.say(plan.topics === 1 ? 'Topic deleted.' : `${plan.topics} topics deleted.`)
  }

  /** The board's Delete, widened: runs now, or asks first above CONFIRM_DELETE_ABOVE topics. */
  requestDelete(ids: readonly TLShapeId[]): 'not-mindmap' | 'asked' | 'done' | 'nothing' {
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
