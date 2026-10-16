// Wave S, client review (docs/WAVE-S-CONTRACTS.md §2, §5; migration 0037_client_review). OWNER: WS1 (review status)
// and WS4 (the review page and the summary) after the wave S foundation, which froze this file: change it through
// the lead.
//
//   GET    /api/boards/:bid/review                          → 200 GetReviewResponse                         (view)
//   POST   /api/boards/:bid/review/items                    AddReviewItemInput → 201 ReviewItemResponse     (manage)
//   PATCH  /api/boards/:bid/review/items/:rvi               PatchReviewItemInput → 200 ReviewItemResponse   (manage)
//   DELETE /api/boards/:bid/review/items/:rvi               → 204 (soft: removed_at; history kept)          (manage)
//   POST   /api/boards/:bid/review/items/:rvi/status        SetReviewStatusInput → 200 SetReviewStatusResponse (setStatus)
//   GET    /api/boards/:bid/review/items/:rvi/events?before= → 200 ListReviewEventsResponse                 (view)
//   POST   /api/boards/:bid/review/rounds                   StartReviewRoundInput → 201 ReviewRoundResponse (manage)
//   POST   /api/boards/:bid/review/rounds/:rvr/close        → 200 ReviewRoundResponse                       (manage)
//
// Who (server-side, @draftroom/permissions): `view` can(role, 'view'); `setStatus` canSetReviewStatus (anyone who may
// comment on an active board, a name-only guest on a commenter link included: the status then reads "(guest)");
// `manage` canManageReview (edit rights AND an account: a name-only guest on a workshop link never manages). Who did
// it is always the session's user, never a body field (every input is strict). A review item is one deliverable of
// one board: a frame or a file (a file card, or an image element with customData.lobby.file of kind image; never a
// placed PDF page), addressed by its Excalidraw element id. Status lives only in Postgres: nothing here is an element
// field, so CONTRACTS_REV is unchanged.
//
// Do not import values from ./index.ts here: index.ts re-exports this module.

import { z } from 'zod'
import { CommentBody, CommentThread } from './comments.ts'
import { GUEST_NAME_SUFFIX } from './guests.ts'
import { cleanDisplayText } from './outside.ts'
import {
  REVIEW_STATUS_LABELS,
  ReviewEventKind,
  type ReviewLanding,
  ReviewStatus,
  ReviewStatusReason,
} from './review-status.ts'

export * from './review-status.ts'

const prefixed = (p: string) => z.string().regex(new RegExp(`^${p}_[0-9A-Za-z]{10,40}$`))
const UserIdLike = prefixed('usr')
const BoardIdLike = z.string().regex(/^[a-z0-9][a-z0-9_-]{2,63}$/)
const isoDate = z.string()

// ---- ids -----------------------------------------------------------------------------------------------------------

export const REVIEW_ITEM_ID_PATTERN = /^rvi_[0-9A-Za-z]{10,40}$/
export const REVIEW_ROUND_ID_PATTERN = /^rvr_[0-9A-Za-z]{10,40}$/
export const REVIEW_EVENT_ID_PATTERN = /^rve_[0-9A-Za-z]{10,40}$/
export const ReviewItemId = z.string().regex(REVIEW_ITEM_ID_PATTERN)
export const ReviewRoundId = z.string().regex(REVIEW_ROUND_ID_PATTERN)
export const ReviewEventId = z.string().regex(REVIEW_EVENT_ID_PATTERN)

/** An Excalidraw element id (canvas-schema ELEMENT_ID_PATTERN; 0037 CHECKs the same). */
export const REVIEW_ELEMENT_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,120}$/
export const ReviewElementId = z.string().regex(REVIEW_ELEMENT_ID_PATTERN)

const AssetIdLike = prefixed('ast')
const VersionIdLike = prefixed('ver')

export const REVIEW_ITEM_KINDS = ['frame', 'file'] as const
export const ReviewItemKind = z.enum(REVIEW_ITEM_KINDS)
export type ReviewItemKind = z.infer<typeof ReviewItemKind>

// ---- limits --------------------------------------------------------------------------------------------------------

export const REVIEW_LIMITS = {
  /** an item's label (cleanDisplayText, then 1..120 characters) */
  labelChars: 120,
  /** a round's title ("Round 2"; 1..80) */
  roundTitleChars: 80,
  /** live (not removed) items per board: 409 REVIEW_FULL past it */
  liveItemsPerBoard: 200,
  /** rounds per board (0037 CHECKs number 1..100) */
  roundsPerBoard: 100,
  /** history rows per item: the oldest go past it (a status still applies) */
  eventsPerItem: 1_000,
  /** status changes per person per board per minute: 429 REVIEW_RATE_LIMITED past it */
  statusChangesPerMinute: 30,
  /** GET …/events page size (newest first) */
  eventsPage: 50,
  /** a round start's explicit item list */
  roundItems: 200,
} as const

// ---- who did it ----------------------------------------------------------------------------------------------------

export const REVIEW_ACTOR_KINDS = ['account', 'guest'] as const
export const ReviewActorKind = z.enum(REVIEW_ACTOR_KINDS)
export type ReviewActorKind = z.infer<typeof ReviewActorKind>

/**
 * Who did something, as it was THEN (review_events.actor_*): `name` is the name the person had then; for a name-only
 * guest it is the name as typed (users.guest_name), never users.name (which already ends in " (guest)"), so the label
 * never says "(guest) (guest)". `kind` is read from users.kind in the write's own transaction, never from the
 * request. `external`: an account outside Dark Burn Creative and Trailer Park Group (wave J knownOutsideSql), the same
 * for every viewer. `id` is null once the account was removed.
 */
export const ReviewActor = z.object({
  id: UserIdLike.nullable(),
  name: z.string(),
  kind: ReviewActorKind,
  external: z.boolean(),
})
export type ReviewActor = z.infer<typeof ReviewActor>

/** The tag next to an outside account's name (as comment authors show it). */
export const REVIEW_EXTERNAL_TAG = 'External'

/**
 * How an actor is written everywhere (pills, history, the bell, chat, the summary PDF): a guest is its typed name
 * plus " (guest)"; an outside account its name plus " · External". Control, bidi and zero-width characters are
 * removed (cleanDisplayText); an empty name reads "Someone".
 */
export function reviewActorLabel(actor: Pick<ReviewActor, 'name' | 'kind' | 'external'>): string {
  const name = cleanDisplayText(actor.name).trim() || 'Someone'
  if (actor.kind === 'guest') return `${name}${GUEST_NAME_SUFFIX}`
  return actor.external ? `${name} · ${REVIEW_EXTERNAL_TAG}` : name
}

/** The summary PDF's footnote whenever a guest appears in it. */
export const REVIEW_GUEST_FOOTNOTE = '(guest): joined with a name only; identity not verified.'

// ---- entities ------------------------------------------------------------------------------------------------------

/**
 * One deliverable in review. The same for every viewer of the board (it is published as a board event): no per-user
 * state. `statusSeq` counts status changes (the `fromSeq` of a write). A file item's status is about
 * `statusVersionId` (the version the person was looking at: "Approved v3"). `removedAt` set: no longer in review
 * (history kept; marking the element again revives the row). `orphaned` is the web's own fact (the element is
 * deleted on the canvas), never stored.
 */
export const ReviewItem = z.object({
  id: ReviewItemId,
  boardId: BoardIdLike,
  elementId: ReviewElementId,
  kind: ReviewItemKind,
  /** file items only: the deliverable's asset (every version of it shares this id: asset-versions.ts) */
  assetId: AssetIdLike.nullable(),
  label: z.string(),
  /** the editor's order in the review panel and page; null: presentation order, else reading order */
  position: z.number().int().nullable(),
  roundId: ReviewRoundId.nullable(),
  status: ReviewStatus,
  statusSeq: z.number().int().min(0),
  statusBy: ReviewActor.nullable(),
  statusAt: isoDate.nullable(),
  statusVersionId: VersionIdLike.nullable(),
  createdAt: isoDate,
  removedAt: isoDate.nullable(),
})
export type ReviewItem = z.infer<typeof ReviewItem>

/** One history row, oldest to newest by `seq`. Round events have no item. */
export const ReviewEvent = z.object({
  id: ReviewEventId,
  itemId: ReviewItemId.nullable(),
  roundId: ReviewRoundId.nullable(),
  kind: ReviewEventKind,
  status: ReviewStatus.nullable(),
  previousStatus: ReviewStatus.nullable(),
  reason: ReviewStatusReason.nullable(),
  versionId: VersionIdLike.nullable(),
  /** the note's thread (an 'everyone' thread made in the same transaction), while it exists */
  threadId: z.string().nullable(),
  actor: ReviewActor,
  /** round events: how many items it touched */
  itemCount: z.number().int().min(0).nullable(),
  createdAt: isoDate,
  seq: z.number().int().min(1),
})
export type ReviewEvent = z.infer<typeof ReviewEvent>

/** A round ("Round 2"). At most one open round per board; a closed round is frozen. */
export const ReviewRound = z.object({
  id: ReviewRoundId,
  boardId: BoardIdLike,
  number: z.number().int().min(1).max(REVIEW_LIMITS.roundsPerBoard),
  title: z.string(),
  openedBy: ReviewActor.nullable(),
  openedAt: isoDate,
  closedAt: isoDate.nullable(),
  /** the named manual checkpoint "Review round N sent" taken at the start (null: it could not be taken) */
  checkpointId: z.string().nullable(),
})
export type ReviewRound = z.infer<typeof ReviewRound>

/** What the caller may do here (the server decides again on every write). */
export const ReviewCan = z.object({ setStatus: z.boolean(), manage: z.boolean() })
export type ReviewCan = z.infer<typeof ReviewCan>

// ---- requests and answers ------------------------------------------------------------------------------------------

const Label = z
  .string()
  .transform((s) => cleanDisplayText(s).trim())
  .pipe(z.string().min(1).max(REVIEW_LIMITS.labelChars))
const RoundTitle = z
  .string()
  .transform((s) => cleanDisplayText(s).trim())
  .pipe(z.string().min(1).max(REVIEW_LIMITS.roundTitleChars))

/** GET /api/boards/:bid/review: the live items (removed ones left out), every round, the open one, the caller's can. */
export const GetReviewResponse = z.object({
  items: z.array(ReviewItem),
  rounds: z.array(ReviewRound),
  openRoundId: ReviewRoundId.nullable(),
  can: ReviewCan,
})
export type GetReviewResponse = z.infer<typeof GetReviewResponse>

/**
 * POST …/review/items. A file item names its asset, which must have a version servable on this board (404
 * otherwise, no probing); a frame names none (400). 409 ALREADY_IN_REVIEW when the element has a live item.
 */
export const AddReviewItemInput = z
  .strictObject({
    elementId: ReviewElementId,
    kind: ReviewItemKind,
    assetId: AssetIdLike.optional(),
    label: Label,
  })
  .refine((v) => (v.kind === 'file') === (v.assetId !== undefined), {
    message: 'a file item names its assetId; a frame item none',
    path: ['assetId'],
  })
export type AddReviewItemInput = z.input<typeof AddReviewItemInput>

export const PatchReviewItemInput = z
  .strictObject({
    label: Label.optional(),
    position: z.number().int().min(0).max(100_000).nullable().optional(),
  })
  .refine((v) => v.label !== undefined || v.position !== undefined, 'nothing to update')
export type PatchReviewItemInput = z.input<typeof PatchReviewItemInput>

export const ReviewItemResponse = z.object({ item: ReviewItem })
export type ReviewItemResponse = z.infer<typeof ReviewItemResponse>

/**
 * POST …/items/:rvi/status. `fromSeq`: the item's statusSeq the person saw (another seq now: 409 STATUS_CHANGED with
 * the current item; without it the write wins). A file item needs `versionId` (400 VERSION_REQUIRED), which must be
 * the newest version servable on the board (409 NEWER_VERSION with `latestVersionId`). `note`: an 'everyone' thread
 * made in the same transaction (the comments rules: mentions rewritten, ≤ 5,000 characters); the UI asks for one with
 * "Request changes".
 */
export const SetReviewStatusInput = z.strictObject({
  status: ReviewStatus,
  fromSeq: z.number().int().min(0).optional(),
  versionId: VersionIdLike.optional(),
  note: CommentBody.optional(),
})
export type SetReviewStatusInput = z.input<typeof SetReviewStatusInput>

export const SetReviewStatusResponse = z.object({
  item: ReviewItem,
  event: ReviewEvent,
  thread: CommentThread.optional(),
})
export type SetReviewStatusResponse = z.infer<typeof SetReviewStatusResponse>

/** GET …/events?before=<seq>: 50 per page, newest first; `nextBefore` null on the last page. */
export const ListReviewEventsQuery = z.strictObject({
  before: z
    .string()
    .regex(/^\d{1,15}$/)
    .optional(),
})
export const ListReviewEventsResponse = z.object({
  events: z.array(ReviewEvent),
  nextBefore: z.number().int().nullable(),
})
export type ListReviewEventsResponse = z.infer<typeof ListReviewEventsResponse>

/**
 * POST …/review/rounds: picks `itemIds` (default: every live item not approved, or with keepApproved false every live
 * item), resets them to pending (reason new_round), takes the named manual checkpoint, opens the round. 409
 * ROUND_OPEN while one is open.
 */
export const StartReviewRoundInput = z.strictObject({
  title: RoundTitle.optional(),
  itemIds: z.array(ReviewItemId).max(REVIEW_LIMITS.roundItems).optional(),
  keepApproved: z.boolean().default(true),
})
export type StartReviewRoundInput = z.input<typeof StartReviewRoundInput>

export const ReviewRoundResponse = z.object({ round: ReviewRound, items: z.array(ReviewItem) })
export type ReviewRoundResponse = z.infer<typeof ReviewRoundResponse>

/** The default title of round `n`, and the checkpoint name it takes. */
export const reviewRoundTitle = (n: number) => `Round ${n}`
export const reviewRoundCheckpointName = (title: string) =>
  `Review ${title.slice(0, REVIEW_LIMITS.roundTitleChars).replace(/^Round /, 'round ')} sent`

// ---- errors --------------------------------------------------------------------------------------------------------

export const REVIEW_CODES = {
  /** 409: the element already has a live item */
  alreadyInReview: 'ALREADY_IN_REVIEW',
  /** 409: someone set a status since `fromSeq` (the body carries the current item) */
  statusChanged: 'STATUS_CHANGED',
  /** 409: a newer version of the file is servable here (the body carries latestVersionId) */
  newerVersion: 'NEWER_VERSION',
  /** 400: a file item's status needs the version it is about */
  versionRequired: 'VERSION_REQUIRED',
  /** 409: a round is already open on this board */
  roundOpen: 'ROUND_OPEN',
  /** 409: the round is closed (frozen) */
  roundClosed: 'ROUND_CLOSED',
  /** 409: the board has REVIEW_LIMITS.liveItemsPerBoard live items, or roundsPerBoard rounds */
  full: 'REVIEW_FULL',
  /** 429 (Retry-After): REVIEW_LIMITS.statusChangesPerMinute */
  rateLimited: 'REVIEW_RATE_LIMITED',
} as const

/** 409 STATUS_CHANGED: the usual error plus the item as it is now ("Ana (guest) just requested changes"). */
export const ReviewStatusChangedBody = z.object({
  error: z.object({ code: z.literal(REVIEW_CODES.statusChanged), message: z.string() }),
  item: ReviewItem,
})
/** 409 NEWER_VERSION: the usual error plus the newest servable version. */
export const ReviewNewerVersionBody = z.object({
  error: z.object({ code: z.literal(REVIEW_CODES.newerVersion), message: z.string() }),
  latestVersionId: VersionIdLike,
})

// ---- board events (after COMMIT, the same payload for every viewer; an older tab ignores unknown types) ----------

export const REVIEW_ITEM_EVENT = 'review.item'
export const REVIEW_ROUND_EVENT = 'review.round'
export const ReviewItemEvent = z.object({ item: ReviewItem })
export const ReviewRoundEvent = z.object({ round: ReviewRound })

// ---- routes and who may call them ----------------------------------------------------------------------------------

export const REVIEW_ROUTES = {
  review: '/api/boards/:bid/review',
  items: '/api/boards/:bid/review/items',
  item: '/api/boards/:bid/review/items/:rvi',
  status: '/api/boards/:bid/review/items/:rvi/status',
  events: '/api/boards/:bid/review/items/:rvi/events',
  rounds: '/api/boards/:bid/review/rounds',
  close: '/api/boards/:bid/review/rounds/:rvr/close',
} as const
const R = REVIEW_ROUTES
export const REVIEW_ROUTE_KEYS = [
  `GET ${R.review}`,
  `POST ${R.items}`,
  `PATCH ${R.item}`,
  `DELETE ${R.item}`,
  `POST ${R.status}`,
  `GET ${R.events}`,
  `POST ${R.rounds}`,
  `POST ${R.close}`,
] as const
export type ReviewRouteKey = (typeof REVIEW_ROUTE_KEYS)[number]

/**
 * The rule each route enforces (server-side): `view` can(role, 'view'); `setStatus` canSetReviewStatus (the board
 * active); `manage` canManageReview (edit and an account). No route creates a board or hands out access, so none has
 * a creator row (DOMAIN-ACCESS-CONTRACTS.md: marking for review is neither).
 */
export const REVIEW_RULES: Readonly<Record<ReviewRouteKey, 'view' | 'setStatus' | 'manage'>> = {
  'GET /api/boards/:bid/review': 'view',
  'POST /api/boards/:bid/review/items': 'manage',
  'PATCH /api/boards/:bid/review/items/:rvi': 'manage',
  'DELETE /api/boards/:bid/review/items/:rvi': 'manage',
  'POST /api/boards/:bid/review/items/:rvi/status': 'setStatus',
  'GET /api/boards/:bid/review/items/:rvi/events': 'view',
  'POST /api/boards/:bid/review/rounds': 'manage',
  'POST /api/boards/:bid/review/rounds/:rvr/close': 'manage',
}

/** The routes a name-only guest is refused outright (guests/guard.ts: 403 GUEST_ACCOUNT_REQUIRED): the manage ones. */
export const REVIEW_MANAGE_ROUTE_KEYS: readonly ReviewRouteKey[] = REVIEW_ROUTE_KEYS.filter(
  (k) => REVIEW_RULES[k] === 'manage',
)
export const REVIEW_GUESTS_MESSAGE =
  'Setting up a review needs a Lobby account. You can still approve items or request changes.'

const enc = encodeURIComponent
export const reviewPath = (bid: string) => `/api/boards/${enc(bid)}/review`
export const reviewItemsPath = (bid: string) => `${reviewPath(bid)}/items`
export const reviewItemPath = (bid: string, rvi: string) => `${reviewItemsPath(bid)}/${enc(rvi)}`
export const reviewStatusPath = (bid: string, rvi: string) => `${reviewItemPath(bid, rvi)}/status`
export const reviewEventsPath = (bid: string, rvi: string, before?: number) =>
  `${reviewItemPath(bid, rvi)}/events${before === undefined ? '' : `?before=${before}`}`
export const reviewRoundsPath = (bid: string) => `${reviewPath(bid)}/rounds`
export const reviewRoundClosePath = (bid: string, rvr: string) => `${reviewRoundsPath(bid)}/${enc(rvr)}/close`

// ---- the review page (WS4) -----------------------------------------------------------------------------------------

// Where a review link lands (review-status.ts ReviewLanding, 0037 invitations.landing): the board, or the board
// route's review overlay `/b/:bid?view=review` (focus mode over the mounted board: the same ticket, sync session,
// access checks and asset loader as the board; matchRoute is unchanged).
export const REVIEW_VIEW_PARAM = 'view'
export const REVIEW_VIEW_VALUE = 'review'
/** The web path a link with `landing` opens for board `bid`. */
export const reviewLandingPath = (bid: string, landing: ReviewLanding = 'board') =>
  `/b/${enc(bid)}${landing === 'review' ? `?${REVIEW_VIEW_PARAM}=${REVIEW_VIEW_VALUE}` : ''}`

// ---- the summary PDF (WS4; built in the browser, present-export's pipeline) ---------------------------------------

export const REVIEW_SUMMARY = {
  /** the report kind's page cap (MAX_REPORT_PAGES is raised to this for it, then counted) */
  maxPages: 60,
  /** status history rows per item */
  historyRows: 10,
  /** pages per item (two for long threads) */
  pagesPerItem: 2,
} as const

/** "v3 of 3" (n-th of the versions servable on this board). */
export const reviewVersionLabel = (n: number, of: number) => `v${n} of ${of}`

/** What the summary PDF prints (WS4 builds it from GetReviewResponse, the events and the comments store). */
export interface ReviewSummaryModel {
  readonly cover: {
    readonly boardTitle: string
    /** null: no round (every live item) */
    readonly roundTitle: string | null
    readonly openedAt: string | null
    readonly closedAt: string | null
    readonly counts: Readonly<Record<ReviewStatus, number>>
    readonly generatedBy: string
    readonly generatedAt: string
  }
  readonly items: readonly {
    readonly label: string
    readonly status: ReviewStatus
    /** reviewActorLabel of the last status setter; null: never set */
    readonly by: string | null
    readonly at: string | null
    /** reviewVersionLabel for a file item; null for a frame */
    readonly version: string | null
    /** the last REVIEW_SUMMARY.historyRows events, newest first, as text */
    readonly history: readonly string[]
    /** every OPEN thread of the item with its replies (resolved ones are counted, not printed) */
    readonly threads: readonly { readonly author: string; readonly lines: readonly string[] }[]
    readonly resolvedThreads: number
  }[]
  /** REVIEW_GUEST_FOOTNOTE when any guest appears */
  readonly footnote: string | null
}

/** Live items per status (the cover, the sticky header "3 of 7 approved", the dashboard counts). */
export function reviewCounts(
  items: readonly Pick<ReviewItem, 'status' | 'removedAt'>[],
): Record<ReviewStatus, number> {
  const out: Record<ReviewStatus, number> = { pending: 0, changes_requested: 0, approved: 0 }
  for (const i of items) if (i.removedAt === null) out[i.status]++
  return out
}

/** The pill's text: "Approved · Ana (guest)". */
export const reviewPillText = (item: Pick<ReviewItem, 'status' | 'statusBy'>) =>
  item.statusBy
    ? `${REVIEW_STATUS_LABELS[item.status]} · ${reviewActorLabel(item.statusBy)}`
    : REVIEW_STATUS_LABELS[item.status]
