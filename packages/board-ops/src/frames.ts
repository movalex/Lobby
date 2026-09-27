import type { TLPageId, TLRecord, TLShape, TLShapeId } from '@tldraw/tlschema'
import {
  BoardIndex,
  type Box,
  finiteOr,
  pageBounds,
  propsOf,
  readingOrder,
  stringProp,
} from './board-index.ts'

export interface FrameEntry {
  id: TLShapeId
  name: string
  pageId: TLPageId
  /** Nearest ancestor frame (groups in between are skipped), `null` for top-level frames. */
  parentFrameId: TLShapeId | null
  /** Number of frame ancestors (0 = top level). */
  depth: number
  /** Page-space axis-aligned bounds. */
  bounds: Box
}

export interface FrameOrderOptions {
  /** Vertical jitter (page units) tolerated within one reading-order row; default max(24, 25% of the smaller height). */
  rowTolerance?: number
}

function collectFrames(board: BoardIndex, pageId: TLPageId): Map<string, FrameEntry> {
  const entries = new Map<string, FrameEntry>()
  for (const shape of board.shapes.values()) {
    if (shape.type !== 'frame' || board.pageOf(shape.id) !== pageId) continue
    const transform = board.pageTransform(shape.id)
    if (!transform) continue
    const props = propsOf(shape)
    const parentFrame = board.parentFrame(shape.id)
    entries.set(shape.id, {
      id: shape.id,
      name: stringProp(shape, 'name'),
      pageId,
      parentFrameId: parentFrame ? parentFrame.id : null,
      depth: board.frameDepth(shape.id),
      bounds: pageBounds(transform, Math.max(0, finiteOr(props.w, 0)), Math.max(0, finiteOr(props.h, 0))),
    })
  }
  return entries
}

function outline(board: BoardIndex, pageId: TLPageId, opts?: FrameOrderOptions): FrameEntry[] {
  const entries = collectFrames(board, pageId)
  const children = new Map<string | null, FrameEntry[]>()
  for (const entry of entries.values()) {
    const key = entry.parentFrameId
    const list = children.get(key)
    if (list) list.push(entry)
    else children.set(key, [entry])
  }
  const result: FrameEntry[] = []
  const visit = (parent: string | null) => {
    for (const entry of readingOrder(children.get(parent) ?? [], opts?.rowTolerance)) {
      result.push(entry)
      visit(entry.id)
    }
  }
  visit(null)
  return result
}

/**
 * Frames of one page in reading order for an outline / navigator: sibling frames are ordered by rows
 * (top edge, with jitter tolerance) then left to right, and every frame is followed by its nested
 * frames (depth-first). Bounds are page-space: parent frame/group offsets and rotations are composed.
 * Rotation limit: a rotated frame (or one inside a rotated parent) reports the axis-aligned bounding box
 * of its rotated rectangle, and reading order uses that box.
 * Frames on other pages, orphaned frames and frames inside parent cycles are left out.
 */
export function frameOutline(
  records: Iterable<TLRecord>,
  pageId: TLPageId,
  opts?: FrameOrderOptions,
): FrameEntry[] {
  return outline(new BoardIndex(records), pageId, opts)
}

function presentationIndexOf(shape: TLShape | undefined): number | null {
  const meta = shape?.meta
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return null
  const value = (meta as Record<string, unknown>).presentationIndex
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Slides for presentation mode: the page's top-level frames. Frames with a numeric
 * `meta.presentationIndex` come first in ascending order (ties keep reading order), then every other
 * top-level frame in reading order.
 */
export function presentationOrder(
  records: Iterable<TLRecord>,
  pageId: TLPageId,
  opts?: FrameOrderOptions,
): FrameEntry[] {
  const board = new BoardIndex(records)
  const topLevel = outline(board, pageId, opts).filter((entry) => entry.parentFrameId === null)
  const explicit: { entry: FrameEntry; order: number; position: number }[] = []
  const rest: FrameEntry[] = []
  topLevel.forEach((entry, position) => {
    const order = presentationIndexOf(board.shapes.get(entry.id))
    if (order === null) rest.push(entry)
    else explicit.push({ entry, order, position })
  })
  explicit.sort((a, b) => a.order - b.order || a.position - b.position)
  return [...explicit.map((item) => item.entry), ...rest]
}
