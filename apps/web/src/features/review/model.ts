// OWNER: WS1 (wave S, review status; docs/WAVE-S-CONTRACTS.md §2). The pure model of review on the board: which
// elements may be marked (a frame, a file card, an image with a Lobby file of kind image; never a placed PDF page),
// the label an item starts with, the panel's order, the filter chips, where a badge sits, and the words a person
// reads (never colour alone). No DOM, no canvas: unit-tested.

import {
  REVIEW_LIMITS,
  REVIEW_STATUS_LABELS,
  type ReviewEvent,
  type ReviewItem,
  type ReviewItemKind,
  type ReviewStatus,
  reviewActorLabel,
  reviewCounts,
} from '@draftroom/contracts'
import type { Bounds, CanvasElement } from '../../canvas/api/index.ts'
import { factsOf, fileItemKind } from '../../file-card/ported/model.ts'
import { formatRelativeTime } from '../../lib/format.ts'

// ---- what may be marked -------------------------------------------------------------------------------------

export interface Markable {
  readonly elementId: string
  readonly kind: ReviewItemKind
  /** file items: the deliverable's asset; its version is the one the element shows */
  readonly assetId?: string
  readonly versionId?: string
  /** the label the item starts with: the frame's name, the file's name */
  readonly label: string
}

const isFrame = (el: Pick<CanvasElement, 'type'>) => el.type === 'frame' || el.type === 'magicframe'

/** What marking `el` for review would send, or null when it cannot be a review item (or is deleted). */
export function markableOf(el: CanvasElement | undefined | null): Markable | null {
  if (!el || (el as { isDeleted?: boolean }).isDeleted) return null
  if (isFrame(el)) {
    const raw = (el as unknown as { name?: unknown }).name
    const name = typeof raw === 'string' ? raw : ''
    return { elementId: el.id, kind: 'frame', label: defaultLabel(name, 'Frame') }
  }
  const kind = fileItemKind(el)
  // a placed PDF page is a picture of one page, not a deliverable of its own
  if (kind !== 'card' && kind !== 'image') return null
  const facts = factsOf(el)
  if (!facts) return null
  return {
    elementId: el.id,
    kind: 'file',
    assetId: facts.assetId,
    versionId: facts.versionId,
    label: defaultLabel(facts.name, kind === 'image' ? 'Image' : 'File'),
  }
}

/** A label of 1..120 characters (the server cleans and checks it again). */
export function defaultLabel(name: string, fallback: string): string {
  const one = name.replace(/\s+/g, ' ').trim()
  const chars = [...one]
  if (chars.length === 0) return fallback
  return chars.length > REVIEW_LIMITS.labelChars ? chars.slice(0, REVIEW_LIMITS.labelChars).join('') : one
}

/** The version a file item's element shows now (what a status is about), or null. */
export function shownVersionOf(el: CanvasElement | undefined | null): string | null {
  return el ? (factsOf(el)?.versionId ?? null) : null
}

// ---- the panel ---------------------------------------------------------------------------------------------

export type ReviewFilter = 'all' | ReviewStatus

export const REVIEW_FILTERS: readonly { readonly id: ReviewFilter; readonly label: string }[] = [
  { id: 'pending', label: REVIEW_STATUS_LABELS.pending },
  { id: 'changes_requested', label: REVIEW_STATUS_LABELS.changes_requested },
  { id: 'approved', label: REVIEW_STATUS_LABELS.approved },
  { id: 'all', label: 'All' },
]

export interface PanelRow {
  readonly item: ReviewItem
  /** the element is deleted on the canvas (the item comes back with it) */
  readonly orphaned: boolean
}

/**
 * The panel's (and the review page's) order: the editor's `position`, else the frames' presentation order, else
 * reading order (top to bottom, then left to right); items on a deleted element last.
 */
export function orderItems(
  items: readonly ReviewItem[],
  look: {
    bounds(elementId: string): Bounds | null
    presentIndex(elementId: string): number | null
    alive(elementId: string): boolean
  },
): PanelRow[] {
  const rows = items
    .filter((i) => i.removedAt === null)
    .map((item) => ({
      item,
      orphaned: !look.alive(item.elementId),
      b: look.bounds(item.elementId),
      p: look.presentIndex(item.elementId),
    }))
  rows.sort((a, b) => {
    if (a.orphaned !== b.orphaned) return a.orphaned ? 1 : -1
    const pa = a.item.position ?? Number.POSITIVE_INFINITY
    const pb = b.item.position ?? Number.POSITIVE_INFINITY
    if (pa !== pb) return pa - pb
    const ia = a.p ?? Number.POSITIVE_INFINITY
    const ib = b.p ?? Number.POSITIVE_INFINITY
    if (ia !== ib) return ia - ib
    const ya = a.b?.y ?? Number.POSITIVE_INFINITY
    const yb = b.b?.y ?? Number.POSITIVE_INFINITY
    if (ya !== yb) return ya - yb
    const xa = a.b?.x ?? Number.POSITIVE_INFINITY
    const xb = b.b?.x ?? Number.POSITIVE_INFINITY
    if (xa !== xb) return xa - xb
    return a.item.createdAt < b.item.createdAt ? -1 : a.item.createdAt > b.item.createdAt ? 1 : 0
  })
  return rows.map(({ item, orphaned }) => ({ item, orphaned }))
}

export const filterRows = (rows: readonly PanelRow[], f: ReviewFilter) =>
  f === 'all' ? [...rows] : rows.filter((r) => r.item.status === f)

/** "3 of 7 approved" (the panel's head and the review page's sticky header). */
export function progressText(items: readonly ReviewItem[]): string {
  const c = reviewCounts(items)
  const total = c.pending + c.changes_requested + c.approved
  return `${c.approved} of ${total} approved`
}

// ---- the badge ---------------------------------------------------------------------------------------------

/** How tall the frame's name band is above it on screen (canvas-ux FRAME_NAME_BAND_PX), so the pill goes above it. */
export const FRAME_NAME_PX = 24
export const PILL_HEIGHT_PX = 24

/**
 * Where an item's pill goes, in overlay pixels: a frame's above its name at the top-left; a file's just under its
 * bottom-left corner. `toOverlay` maps a scene point to overlay pixels.
 */
export function badgeAnchor(
  kind: ReviewItemKind,
  b: Bounds,
  toOverlay: (p: { x: number; y: number }) => { x: number; y: number },
): { x: number; y: number } {
  if (kind === 'frame') {
    const p = toOverlay({ x: b.x, y: b.y })
    return { x: p.x, y: p.y - FRAME_NAME_PX - PILL_HEIGHT_PX - 2 }
  }
  const p = toOverlay({ x: b.x, y: b.y + b.height })
  return { x: p.x, y: p.y + 4 }
}

// ---- words -------------------------------------------------------------------------------------------------

/** The pill: "Approved · Ana (guest) · 2 h ago" (icon and text; never colour alone). */
export function pillLine(
  item: Pick<ReviewItem, 'status' | 'statusBy' | 'statusAt'>,
  now: Date = new Date(),
): string {
  const parts = [REVIEW_STATUS_LABELS[item.status]]
  if (item.statusBy) parts.push(reviewActorLabel(item.statusBy))
  if (item.statusAt) parts.push(formatRelativeTime(item.statusAt, now))
  return parts.join(' · ')
}

/** The pill's accessible name. */
export const pillLabel = (item: ReviewItem) => `Review status of ${item.label}: ${pillLine(item)}`

/** One history row: "Approved by Ana (guest)", "Back to Awaiting review: new version", "Marked for review". */
export function eventLine(e: ReviewEvent): string {
  const who = reviewActorLabel(e.actor)
  switch (e.kind) {
    case 'added':
      return `Marked for review by ${who}`
    case 'removed':
      return `Removed from review by ${who}`
    case 'round_opened':
      return `${who} started a review round`
    case 'round_closed':
      return `${who} closed the review round`
    case 'status': {
      const label = e.status ? REVIEW_STATUS_LABELS[e.status] : 'Updated'
      if (e.reason === 'new_version') return `${label}: ${who} uploaded a new version`
      if (e.reason === 'new_round') return `${label}: ${who} started a new round`
      return `${label} by ${who}`
    }
  }
}

export { boardChipText, reviewNotificationText } from './copy.ts'
