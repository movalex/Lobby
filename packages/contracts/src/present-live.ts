// API schemas for present-live (docs/WAVE4-CONTRACTS.md "present-live"): presenting to everyone on a
// board, following the presenter, handing over. Browser-safe. Owned by the present-live owner.
//
// Server authority: the api keeps one live presentation per board IN MEMORY (like raised hands; never
// written to the database). It decides who presents, which slide is current and who follows; clients
// only ask (start, next slide, follow, hand over, end) and render what the server says. Everything in
// an event is safe for every viewer of the board: names that already show on the board, frame ids and
// counts. The presenting tab's id is a random value the presenter's browser made up; it grants nothing
// (every route checks the signed-in user).
//
// Who may do what (the api enforces it; the UI only hides controls):
// - see the presentation and follow it: everyone who can view the board, name-only guests included;
// - present to everyone, take it over, receive a hand-off: people with an account who can edit;
// - move the slides, hand over: the presenter; end it: the presenter or a board owner.
//
// Do not import values from ./index.ts here: index.ts re-exports this module.

import { z } from 'zod'

const PlUserId = z.string().regex(/^usr_[0-9A-Za-z]{10,40}$/)
const PlIsoDate = z.string()

/** One live presentation (a new id per "Present to everyone"; kept through a hand-off). */
export const PRESENTATION_ID_PATTERN = /^prs_[0-9A-Za-z]{10,40}$/
export const PresentationId = z.string().regex(PRESENTATION_ID_PATTERN)

/** The presenting browser tab's own random id (sessionStorage: it survives a reload of that tab). */
export const PRESENTER_TAB_PATTERN = /^[A-Za-z0-9_-]{8,64}$/
export const PresenterTab = z.string().regex(PRESENTER_TAB_PATTERN)

/** A slide is a frame: a tldraw shape id. */
export const PresentSlideId = z.string().regex(/^shape:[A-Za-z0-9_-]{1,100}$/)

/** Upper bound for slide indexes and counts (a board holds at most 20k shapes). */
export const PRESENT_SLIDES_MAX = 20_000

/** The presenter's current slide as their browser reports it (the index/count are hints). */
export const PresentSlide = z.object({
  slideId: PresentSlideId.nullable(),
  index: z.number().int().min(0).max(PRESENT_SLIDES_MAX),
  count: z.number().int().min(0).max(PRESENT_SLIDES_MAX),
})
export type PresentSlide = z.infer<typeof PresentSlide>

// ---- timing (server side; exported so the UI can say what happens) --------------------------------

/** The presenter without any connection to the board for this long: followers see "reconnecting". */
export const PRESENTER_OFFLINE_NOTICE_MS = 3_000
/** ...and for this long: the presentation ends for everyone (a reload comes back well within it). */
export const PRESENTER_GRACE_MS = 15_000
/** A follower without any connection to the board for this long stops counting as following. */
export const FOLLOWER_GRACE_MS = 5_000
/** Followers named in a presentation (the count is always exact). */
export const PRESENT_FOLLOWERS_LISTED = 200

// ---- state -------------------------------------------------------------------------------------------

export const PresentPerson = z.object({
  userId: PlUserId,
  /** The display name (a name-only guest's already ends in " (guest)", as everywhere on the board). */
  name: z.string(),
  /** A name-only guest (users.kind = 'guest'). */
  guest: z.boolean(),
})
export type PresentPerson = z.infer<typeof PresentPerson>

export const LivePresentation = z.object({
  id: PresentationId,
  presenter: z.object({ userId: PlUserId, name: z.string() }),
  /** The tab that presents; null right after a hand-off until one of the new presenter's tabs takes it. */
  tab: PresenterTab.nullable(),
  slideId: PresentSlideId.nullable(),
  index: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  startedAt: PlIsoDate,
  /** False once the presenter has had no connection to the board for PRESENTER_OFFLINE_NOTICE_MS. */
  presenterOnline: z.boolean(),
  /** Who follows (the presenter never counts), first joined first; at most PRESENT_FOLLOWERS_LISTED. */
  followers: z.array(PresentPerson),
  followerCount: z.number().int().nonnegative(),
})
export type LivePresentation = z.infer<typeof LivePresentation>

/**
 * Orders states that arrive by different paths (a response, an event, a refetch): `n` grows with every
 * change within one API process (`epoch`); another epoch means the api restarted (and lost its state).
 */
export const PresentLiveVersion = z.object({
  epoch: z.string().min(1).max(40),
  n: z.number().int().nonnegative(),
})
export type PresentLiveVersion = z.infer<typeof PresentLiveVersion>

/** Whether `next` may replace `current` (never an older state of the same API process). */
export function isNewerLive(current: PresentLiveVersion | null, next: PresentLiveVersion | null): boolean {
  if (!next) return false
  if (!current || current.epoch !== next.epoch) return true
  return next.n >= current.n
}

/** GET /api/boards/:bid/presentation and every POST under it. */
export const PresentLiveState = z.object({
  presentation: LivePresentation.nullable(),
  version: PresentLiveVersion,
  serverNow: PlIsoDate,
})
export type PresentLiveState = z.infer<typeof PresentLiveState>

// ---- events ------------------------------------------------------------------------------------------

export const PRESENT_LIVE_EVENTS = { changed: 'present.live' } as const

export const PresentChangeKind = z.enum([
  'started',
  /** The api restarted and the presenter's tab put the same presentation back. */
  'resumed',
  'slide',
  /** A tab of the presenter took the presentation (after a hand-off, or "Present from this tab"). */
  'claimed',
  'handoff',
  'followers',
  'presenter-offline',
  'presenter-online',
  'ended',
])
export type PresentChangeKind = z.infer<typeof PresentChangeKind>

/** Why a presentation ended: the presenter or an owner ended it, or the presenter left (the grace ran out). */
export const PresentEndReason = z.enum(['stopped', 'ended-by-owner', 'presenter-left'])
export type PresentEndReason = z.infer<typeof PresentEndReason>

export const PresentChange = z.object({
  kind: PresentChangeKind,
  reason: PresentEndReason.nullable(),
  /** Who did it (null when the server did: a grace running out). */
  byUserId: PlUserId.nullable(),
  byName: z.string().nullable(),
})
export type PresentChange = z.infer<typeof PresentChange>

/** The whole state after a change (idempotent to apply), plus what changed. */
export const PresentLiveEvent = z.object({
  presentation: LivePresentation.nullable(),
  change: PresentChange,
  version: PresentLiveVersion,
})
export type PresentLiveEvent = z.infer<typeof PresentLiveEvent>

// ---- inputs --------------------------------------------------------------------------------------------

/**
 * POST /api/boards/:bid/presentation: present to everyone from this tab. By the current presenter it
 * moves the presentation to this tab (same id, same followers). `resumeId` puts back a presentation the
 * api lost (a restart), so followers keep following. `takeOver` takes a presentation whose presenter
 * has been offline for a few seconds (anyone who may present); otherwise another person's presentation
 * is a 409.
 */
export const StartPresentationInput = PresentSlide.extend({
  tab: PresenterTab,
  resumeId: PresentationId.optional(),
  takeOver: z.boolean().optional(),
})
export type StartPresentationInput = z.infer<typeof StartPresentationInput>

/** POST …/presentation/slide: the presenting tab moved to another slide. */
export const PresentSlideInput = PresentSlide.extend({ id: PresentationId, tab: PresenterTab })
export type PresentSlideInput = z.infer<typeof PresentSlideInput>

/** POST …/presentation/stop: end it for everyone. */
export const StopPresentationInput = z.object({ id: PresentationId })

/** POST …/presentation/handoff: make another editor (on the board now, with an account) the presenter. */
export const HandOffPresentationInput = z.object({ id: PresentationId, userId: PlUserId })

/** POST …/presentation/follow: follow it (true) or step out (false). */
export const FollowPresentationInput = z.object({ id: PresentationId, following: z.boolean() })
