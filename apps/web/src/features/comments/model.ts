// Pure comment-thread logic for the web client (no React, no editor): read state per person, pin
// states, panel filters and ordering, and the anchor geometry used to place pins. Unit-tested in Node.

import type { CommentAnchor, CommentThread, ThreadComment } from '@draftroom/contracts'
import { commentPlainText } from '@draftroom/contracts'

export type PinState = 'unread' | 'read' | 'resolved' | 'mentioned'

const time = (iso: string | undefined | null) => {
  const t = iso ? Date.parse(iso) : Number.NaN
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY
}

/** Comments by other people posted after my read mark. My own comments are never unread. */
export function unreadComments(
  thread: CommentThread,
  meId: string,
  readAt: string | undefined,
): ThreadComment[] {
  const mark = time(readAt)
  return thread.comments.filter((c) => c.author.id !== meId && time(c.createdAt) > mark)
}

export function isUnread(thread: CommentThread, meId: string, readAt: string | undefined): boolean {
  return unreadComments(thread, meId, readAt).length > 0
}

export function mentionsMe(thread: CommentThread, meId: string): boolean {
  return thread.comments.some((c) => c.author.id !== meId && c.mentions.includes(meId))
}

/**
 * Marker state for one person: resolved wins; otherwise unread threads show "mentioned" when an
 * unread comment mentions them, else "unread"; everything else is "read".
 */
export function pinState(thread: CommentThread, meId: string, readAt: string | undefined): PinState {
  if (thread.status === 'resolved') return 'resolved'
  const unread = unreadComments(thread, meId, readAt)
  if (unread.length === 0) return 'read'
  return unread.some((c) => c.mentions.includes(meId)) ? 'mentioned' : 'unread'
}

export type ThreadFilter = 'open' | 'resolved' | 'mine' | 'mentions' | 'all'

export const THREAD_FILTERS: readonly { id: ThreadFilter; label: string }[] = [
  { id: 'open', label: 'Open' },
  { id: 'mine', label: 'Mine' },
  { id: 'mentions', label: 'Mentioning me' },
  { id: 'resolved', label: 'Resolved' },
  { id: 'all', label: 'All' },
]

export const isThreadFilter = (v: unknown): v is ThreadFilter =>
  typeof v === 'string' && THREAD_FILTERS.some((f) => f.id === v)

export function participatedIn(thread: CommentThread, meId: string): boolean {
  return thread.createdBy.id === meId || thread.comments.some((c) => c.author.id === meId)
}

/** Panel filters: open/mine/mentions show open threads only; resolved and all as named. */
export function matchesFilter(thread: CommentThread, filter: ThreadFilter, meId: string): boolean {
  switch (filter) {
    case 'open':
      return thread.status === 'open'
    case 'resolved':
      return thread.status === 'resolved'
    case 'mine':
      return thread.status === 'open' && participatedIn(thread, meId)
    case 'mentions':
      return thread.status === 'open' && mentionsMe(thread, meId)
    case 'all':
      return true
  }
}

export function lastActivity(thread: CommentThread): number {
  const last = thread.comments[thread.comments.length - 1]
  return Math.max(time(last?.createdAt), time(thread.resolvedAt))
}

/** Unread first, then most recent activity first; stable by id. */
export function sortThreads(
  threads: readonly CommentThread[],
  meId: string,
  reads: Readonly<Record<string, string>>,
): CommentThread[] {
  return [...threads].sort((a, b) => {
    const ua = isUnread(a, meId, reads[a.id]) ? 1 : 0
    const ub = isUnread(b, meId, reads[b.id]) ? 1 : 0
    if (ua !== ub) return ub - ua
    const d = lastActivity(b) - lastActivity(a)
    return d !== 0 ? d : a.id.localeCompare(b.id)
  })
}

export function snippet(body: string, max = 120): string {
  const text = commentPlainText(body).replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

// ---- geometry --------------------------------------------------------------------------------------

export interface Point {
  x: number
  y: number
}

/** What the editor knows about the shape an anchor points at (null: not on the board any more). */
export interface ShapeFrame {
  pageId: string
  /** The shape's own (unrotated) geometry bounds, in shape space. */
  bounds: { x: number; y: number; w: number; h: number }
  /** Shape space -> page space (the shape's page transform). */
  toPage(p: Point): Point
  /** Page space -> shape space. */
  toLocal(p: Point): Point
}

export type AnchorPlacement =
  | { kind: 'placed'; pageId: string | null; point: Point }
  /** The anchored shape is gone (deleted): listed as "on a deleted object" until it comes back. */
  | { kind: 'orphan' }

/** Plain {x, y} (editor transforms return Vec objects with a z). */
const xy = (p: Point): Point => ({ x: p.x, y: p.y })
const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5)

/** Where an anchor sits on the board right now. Shape anchors follow the shape (move/resize/rotate). */
export function placeAnchor(
  anchor: CommentAnchor,
  frameOf: (shapeId: string) => ShapeFrame | null,
): AnchorPlacement {
  if (anchor.kind === 'point')
    return { kind: 'placed', pageId: anchor.pageId ?? null, point: { x: anchor.x, y: anchor.y } }
  const frame = frameOf(anchor.shapeId)
  if (!frame) return { kind: 'orphan' }
  const { bounds } = frame
  if (anchor.kind === 'asset') {
    // File-card comments sit on the card's top-right corner.
    return {
      kind: 'placed',
      pageId: frame.pageId,
      point: xy(frame.toPage({ x: bounds.x + bounds.w, y: bounds.y })),
    }
  }
  const local = { x: bounds.x + clamp01(anchor.u) * bounds.w, y: bounds.y + clamp01(anchor.v) * bounds.h }
  return { kind: 'placed', pageId: frame.pageId, point: xy(frame.toPage(local)) }
}

/** (u, v) of a page point inside a shape, clamped to [0, 1] (a zero-size side gives 0.5). */
export function uvFor(frame: ShapeFrame, pagePoint: Point): { u: number; v: number } {
  const local = frame.toLocal(pagePoint)
  const { bounds } = frame
  const u = bounds.w > 0 ? (local.x - bounds.x) / bounds.w : 0.5
  const v = bounds.h > 0 ? (local.y - bounds.y) / bounds.h : 0.5
  const round = (n: number) => Math.round(clamp01(n) * 10_000) / 10_000
  return { u: round(u), v: round(v) }
}

export interface ClickTarget {
  shapeId: string
  type: string
  props?: Record<string, unknown>
  frame: ShapeFrame
}

const AST_RE = /^ast_[0-9A-Za-z]{10,40}$/
const VER_RE = /^ver_[0-9A-Za-z]{10,40}$/
const MAX_COORD = 1e7

/**
 * The anchor for a comment-tool click: on a file card -> asset anchor, on any other shape -> shape
 * anchor at the clicked spot, on empty canvas -> point anchor on the current page.
 */
export function anchorForClick(pagePoint: Point, target: ClickTarget | null, pageId: string): CommentAnchor {
  if (target) {
    const assetId = target.props?.assetId
    const versionId = target.props?.versionId
    if (
      target.type === 'dr-file-card' &&
      typeof assetId === 'string' &&
      AST_RE.test(assetId) &&
      typeof versionId === 'string' &&
      VER_RE.test(versionId)
    ) {
      return { kind: 'asset', shapeId: target.shapeId, assetId, versionId }
    }
    return { kind: 'shape', shapeId: target.shapeId, ...uvFor(target.frame, pagePoint) }
  }
  const bound = (n: number) => Math.round(Math.max(-MAX_COORD, Math.min(MAX_COORD, n)) * 100) / 100
  return { kind: 'point', x: bound(pagePoint.x), y: bound(pagePoint.y), pageId }
}

/** What the board knows around an anchor right now (see geometry.ts `anchorContext`). */
export interface AnchorContext {
  /** The anchored shape's tldraw type (shape and file anchors). */
  shapeType?: string | null
  /**
   * The name of the frame the anchor is in: the anchored shape's nearest frame ancestor (a frame
   * itself for a comment on a frame), or the frame a point pin sits in. Null outside any frame.
   */
  frameName?: string | null
  /**
   * F2-09: the file an image, video or file card shows ("halden-05-option-b-sage.jpg"), so a thread
   * says which of 37 photos it is about. Null or absent when there is none.
   */
  fileName?: string | null
}

/** A file name on one line, at most 60 characters (the middle gives way, the extension stays). */
export function shortFileName(name: unknown): string | null {
  const clean = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : ''
  if (!clean) return null
  const chars = Array.from(clean)
  if (chars.length <= 60) return clean
  return `${chars.slice(0, 40).join('')}…${chars.slice(-19).join('')}`
}

const FRIENDLY_TYPES: Record<string, string> = {
  note: 'note',
  text: 'text',
  geo: 'shape',
  arrow: 'connector',
  line: 'line',
  draw: 'drawing',
  highlight: 'highlight',
  frame: 'frame',
  group: 'group',
  image: 'image',
  video: 'video',
  embed: 'embed',
  bookmark: 'link',
  'dr-file-card': 'file',
}

/** "note", "shape", "file"… for a tldraw shape type ("object" when unknown). */
export const friendlyShapeType = (type: string | null | undefined): string =>
  (type && FRIENDLY_TYPES[type]) || 'object'

const withArticle = (noun: string) => `${/^[aeiou]/.test(noun) ? 'an' : 'a'} ${noun}`

/** Frame names as the board shows them (an unnamed frame is "Frame"), on one line. */
export function frameDisplayName(name: unknown): string {
  const clean = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : ''
  return clean || 'Frame'
}

/**
 * Short description of where a thread is, for the panel rows, the popover and composer headers and
 * screen readers: "Concept B – Fresh Start · note" for a comment on a note in that frame, "In Concept
 * B" for a pin on the board inside a frame, "On a note" / "On the board" outside frames.
 */
export function anchorLabel(
  anchor: CommentAnchor,
  placement: AnchorPlacement,
  currentPageId: string,
  context: AnchorContext = {},
): string {
  if (placement.kind === 'orphan') return 'On a deleted object'
  const elsewhere = placement.pageId !== null && placement.pageId !== currentPageId
  const frame = context.frameName ? frameDisplayName(context.frameName) : null
  let base: string
  if (anchor.kind === 'point') base = frame ? `In ${frame}` : 'On the board'
  else {
    const type = anchor.kind === 'asset' ? 'file' : friendlyShapeType(context.shapeType)
    const file = shortFileName(context.fileName)
    // F2-09: the file's name says which image or file it is ("On halden-05.jpg"), the type otherwise.
    base = frame ? `${frame} · ${file ?? type}` : file ? `On ${file}` : `On ${withArticle(type)}`
  }
  const detail =
    anchor.kind === 'asset' && anchor.page
      ? `, page ${anchor.page}`
      : anchor.kind === 'asset' && anchor.timeMs !== undefined
        ? `, at ${Math.floor(anchor.timeMs / 60_000)}:${String(Math.floor((anchor.timeMs % 60_000) / 1000)).padStart(2, '0')}`
        : ''
  return `${base}${detail}${elsewhere ? ' (another page)' : ''}`
}
