// Wave S (client review; docs/WAVE-S-CONTRACTS.md §2): the review statuses and what a status event was, in a leaf
// module of their own, so that ./comments.ts (the bell's NotificationItem.review) and ./review.ts (items, events,
// routes) share one list without importing each other. Frozen by the wave S foundation; only the lead changes it.
//
// Do not import values from ./index.ts here: index.ts re-exports this module.

import { z } from 'zod'

/**
 * `pending` "Awaiting review", `changes_requested` "Changes requested", `approved` "Approved". "Not in review" is no
 * live item. Any status may follow any other; the history keeps every step. Stored in review_items.status and
 * review_events.status / previous_status (0037's CHECKs hold the same three).
 */
export const REVIEW_STATUSES = ['pending', 'changes_requested', 'approved'] as const
export const ReviewStatus = z.enum(REVIEW_STATUSES)
export type ReviewStatus = z.infer<typeof ReviewStatus>

/** The words a person reads (pills, the panel's filters, the bell, the summary PDF). Never colour alone. */
export const REVIEW_STATUS_LABELS: Readonly<Record<ReviewStatus, string>> = {
  pending: 'Awaiting review',
  changes_requested: 'Changes requested',
  approved: 'Approved',
}

/**
 * Why a status changed: `set` a person chose it; `new_version` a new version of the item's file reset it to pending
 * (the uploader is the actor); `new_round` starting a round reset it (the editor who started it is the actor).
 */
export const REVIEW_STATUS_REASONS = ['set', 'new_version', 'new_round'] as const
export const ReviewStatusReason = z.enum(REVIEW_STATUS_REASONS)
export type ReviewStatusReason = z.infer<typeof ReviewStatusReason>

/** What a history row records (review_events.kind). Round events have no item. */
export const REVIEW_EVENT_KINDS = ['status', 'added', 'removed', 'round_opened', 'round_closed'] as const
export const ReviewEventKind = z.enum(REVIEW_EVENT_KINDS)
export type ReviewEventKind = z.infer<typeof ReviewEventKind>

/**
 * Wave S (WS1): what the dashboard's board list adds to a board with live review items ("2 awaiting · 1 changes"):
 * live items per status. Optional (absent: no live item, or an older api); a z.object, so an older web strips it.
 */
export const BoardReviewCounts = z.object({
  pending: z.number().int().min(0),
  changes: z.number().int().min(0),
  approved: z.number().int().min(0),
})
export type BoardReviewCounts = z.infer<typeof BoardReviewCounts>

/**
 * Wave S (WS4; 0037 invitations.landing): where a review link opens, `board` (as before wave S) or `review` (the
 * board's review page, review.ts reviewLandingPath). Here, in the leaf, because guests.ts and dashboard.ts carry it.
 */
export const REVIEW_LANDINGS = ['board', 'review'] as const
export const ReviewLanding = z.enum(REVIEW_LANDINGS)
export type ReviewLanding = z.infer<typeof ReviewLanding>
