// OWNER: WS4 (wave S, the client review page). The page's pure model (docs/WAVE-S-CONTRACTS.md §6): which items the
// page lists and in which order, what each shows, which buttons the caller gets, which open threads belong to an
// item, and the keys that cache a frame's picture. No DOM, no canvas, no network: unit-tested in Node.
import { fromShapeRef } from '@draftroom/canvas-schema/refs'
import {
  type CommentAnchor,
  type CommentThread,
  REVIEW_STATUS_LABELS,
  type ReviewCan,
  type ReviewItem,
  type ReviewRound,
  type ReviewStatus,
  reviewCounts,
} from '@draftroom/contracts'

export interface ElementBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** The file facts of a file card or an image (customData.lobby.file). */
export interface ElementFile {
  readonly assetId: string
  readonly versionId: string
  readonly kind: 'image' | 'pdf' | 'video' | 'other'
  readonly name: string
}

/** What the page knows of an item's element on the canvas (null: the element is gone: the item is orphaned). */
export interface ElementFacts {
  readonly type: string
  /** a frame's own name ('' when it has none) */
  readonly frameName: string | null
  readonly file: ElementFile | null
  readonly bounds: ElementBounds | null
}

/** One item as the page lists it. */
export interface PageEntry {
  readonly item: ReviewItem
  /** the editor's label, else the canvas name */
  readonly label: string
  readonly kind: 'frame' | 'file'
  readonly file: ElementFile | null
  /** 0-based place in the list */
  readonly index: number
}

/** Used when neither the editor nor the canvas gave a name. */
export const UNNAMED_ITEM = 'Untitled item'

/**
 * The label a client reads: the editor's label first (they chose the words for the client), else the canvas name.
 * The item's label is never empty (the api requires 1..120); the canvas name backs a label left blank.
 */
export function entryLabel(item: Pick<ReviewItem, 'label'>, facts: ElementFacts | null): string {
  const label = item.label.trim()
  if (label) return label
  const live = facts?.frameName?.trim() || facts?.file?.name.trim()
  return live || UNNAMED_ITEM
}

/**
 * The items the page lists, in order. The open round's items (those whose roundId is the open round) when a round is
 * open and it holds any, else every live item. Items whose element is gone are left out (a client cannot see what is
 * not on the board: the panel lists them, this page does not). Order: the editor's `position` first (ascending), then
 * frames in presentation order (`frameRank`), then everything else in reading order (top to bottom, left to right).
 */
export function pageEntries(
  review: { items: readonly ReviewItem[]; openRoundId: string | null },
  facts: (elementId: string) => ElementFacts | null,
  frameRank: (frameId: string) => number | null = () => null,
): PageEntry[] {
  const live = review.items.filter((i) => i.removedAt === null)
  const inRound = review.openRoundId ? live.filter((i) => i.roundId === review.openRoundId) : []
  const chosen = inRound.length > 0 ? inRound : live
  const present: { item: ReviewItem; facts: ElementFacts }[] = []
  for (const item of chosen) {
    const f = facts(item.elementId)
    if (f) present.push({ item, facts: f })
  }
  present.sort((a, b) => {
    const pa = a.item.position
    const pb = b.item.position
    if (pa !== null && pb !== null && pa !== pb) return pa - pb
    if (pa !== null && pb === null) return -1
    if (pa === null && pb !== null) return 1
    const fa = a.item.kind === 'frame' ? frameRank(a.item.elementId) : null
    const fb = b.item.kind === 'frame' ? frameRank(b.item.elementId) : null
    if (fa !== null && fb !== null && fa !== fb) return fa - fb
    if (fa !== null && fb === null) return -1
    if (fa === null && fb !== null) return 1
    const ay = a.facts.bounds?.y ?? 0
    const by = b.facts.bounds?.y ?? 0
    const ax = a.facts.bounds?.x ?? 0
    const bx = b.facts.bounds?.x ?? 0
    return ay - by || ax - bx || a.item.id.localeCompare(b.item.id)
  })
  return present.map((x, index) => ({
    item: x.item,
    label: entryLabel(x.item, x.facts),
    kind: x.item.kind,
    file: x.facts.file,
    index,
  }))
}

/** The sticky header's words: "3 of 7 approved". */
export function progressText(entries: readonly Pick<PageEntry, 'item'>[]): string {
  const counts = reviewCounts(entries.map((e) => e.item))
  return `${counts.approved} of ${entries.length} approved`
}

/** Extra words next to the progress when something needs attention ("2 with changes requested"). */
export function progressDetail(entries: readonly Pick<PageEntry, 'item'>[]): string {
  const counts = reviewCounts(entries.map((e) => e.item))
  const parts: string[] = []
  if (counts.changes_requested > 0) parts.push(`${counts.changes_requested} with changes requested`)
  if (counts.pending > 0) parts.push(`${counts.pending} awaiting review`)
  return parts.join(' · ')
}

/** The round line under the title ("Round 2"), or null while no round is open. */
export function roundLabel(review: {
  rounds: readonly ReviewRound[]
  openRoundId: string | null
}): string | null {
  const open = review.rounds.find((r) => r.id === review.openRoundId && r.closedAt === null)
  return open ? open.title : null
}

export const REVIEW_BACK_LABEL = 'Back to awaiting review'
export const REVIEW_NOTE_PLACEHOLDER = 'What should change?'

export interface StatusButton {
  readonly status: ReviewStatus
  readonly label: string
  /** the button asks for a note ("What should change?") before it sends */
  readonly note: boolean
  /** the button asks "sure?" before it sends */
  readonly confirm: boolean
}

/**
 * The buttons a caller gets for an item in `current`: none unless `can.setStatus`. Approve (with a confirm step) and
 * Request changes (with a note) while the item is not already there; "Back to awaiting review" once it was decided.
 */
export function statusButtons(can: Pick<ReviewCan, 'setStatus'>, current: ReviewStatus): StatusButton[] {
  if (!can.setStatus) return []
  const out: StatusButton[] = []
  if (current !== 'approved') out.push({ status: 'approved', label: 'Approve', note: false, confirm: true })
  if (current !== 'changes_requested')
    out.push({ status: 'changes_requested', label: 'Request changes', note: true, confirm: false })
  if (current !== 'pending')
    out.push({ status: 'pending', label: REVIEW_BACK_LABEL, note: false, confirm: false })
  return out
}

/** A thread is shown to a client when it is open and not internal. */
export const clientThread = (t: CommentThread) => t.status === 'open' && t.visibility !== 'team'

const anchorElement = (a: CommentAnchor): string | null =>
  a.kind === 'point' ? null : (fromShapeRef(a.shapeId) ?? a.shapeId)

/**
 * The open, non-internal threads that belong to an item: pinned to its element (an `asset` or `shape` anchor), to an
 * element inside the frame, or (a frame) a point pin inside the frame's bounds. Oldest first.
 */
export function threadsFor(
  threads: readonly CommentThread[],
  entry: Pick<PageEntry, 'item'>,
  scope: {
    /** the ids of the elements inside the frame (frame items) */
    members: ReadonlySet<string>
    bounds: ElementBounds | null
  },
): CommentThread[] {
  const id = entry.item.elementId
  const isFrame = entry.item.kind === 'frame'
  return threads
    .filter((t) => {
      if (!clientThread(t) || t.comments.length === 0) return false
      const a = t.anchor
      if (a.kind === 'point') {
        const b = scope.bounds
        return isFrame && !!b && a.x >= b.x && a.y >= b.y && a.x <= b.x + b.width && a.y <= b.y + b.height
      }
      const target = anchorElement(a)
      return target === id || (isFrame && target !== null && scope.members.has(target))
    })
    .sort((x, y) => Date.parse(x.createdAt) - Date.parse(y.createdAt) || x.id.localeCompare(y.id))
}

/**
 * The key a frame's picture is cached under: the frame and every element inside it, with their versions. A change
 * to any of them (an edit, a move, a restored element) is a new key; an unrelated edit elsewhere is not.
 */
export function frameCacheKey(
  frameId: string,
  frameVersion: number,
  members: readonly { readonly version: number }[],
  scale: number,
): string {
  let sum = frameVersion
  for (const m of members) sum += m.version
  return `${frameId}:${members.length}:${sum}:${scale}`
}

/** The pixel ratio a frame picture is rendered at: the column width × the screen's density, capped at 2 (≥ 1). */
export function pictureScale(columnPx: number, framePx: number, dpr: number): 1 | 2 {
  if (!(framePx > 0)) return 1
  return (columnPx * Math.min(2, Math.max(1, dpr))) / framePx > 1.5 ? 2 : 1
}

/** Previous and next entry indexes (null at the ends). */
export function neighbours(index: number, count: number): { prev: number | null; next: number | null } {
  return { prev: index > 0 ? index - 1 : null, next: index < count - 1 ? index + 1 : null }
}

/** What a screen reader hears after a status was set: "Key art A: approved". */
export const statusAnnouncement = (label: string, status: ReviewStatus) =>
  `${label}: ${REVIEW_STATUS_LABELS[status].toLowerCase()}`
