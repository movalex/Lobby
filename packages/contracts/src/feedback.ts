// API schemas for the "Send feedback" button (wave J5, the pilot's feedback channel). Browser-safe, additive:
// nothing existing changes, so no LOBBY_CLIENT_REV bump (an older web build never calls these routes).
//
// Do not import values from ./index.ts here: index.ts re-exports this module.
//
// Anyone signed in, a name-only guest included, sends plain-text feedback from the board menu or the
// dashboard's account menu: POST /api/feedback { text, expected?, context }. The api cleans the text
// (control and bidi characters out), caps it, rate limits per person and stores it (migration 0027).
// People named in DRAFTROOM_FEEDBACK_ADMINS (verified email, checked on the server) read the list and mark
// items done: GET /api/feedback, PATCH /api/feedback/:id, and GET /api/feedback/access tells the web whether
// to show the inbox link. The lead's triage tooling reads GET /internal/feedback (the internal secret).
// Nothing here ever logs or echoes the text outside these routes.

import { z } from 'zod'

export const FEEDBACK_ROUTE = '/api/feedback'
export const FEEDBACK_ITEM_ROUTE = '/api/feedback/:id'
export const FEEDBACK_ACCESS_ROUTE = '/api/feedback/access'
export const FEEDBACK_INTERNAL_ROUTE = '/internal/feedback'
export const feedbackItemPath = (id: string) => `${FEEDBACK_ROUTE}/${encodeURIComponent(id)}`

/** "What happened?" (required) and "What did you expect?" (optional): at most this many characters each. */
export const FEEDBACK_TEXT_MAX = 4_000
/**
 * The most UTF-16 units either field may carry on the wire (a field of FEEDBACK_TEXT_MAX characters can
 * hold astral ones, two units each). The exact limit, in characters after cleaning, is the api's.
 */
export const FEEDBACK_WIRE_MAX = FEEDBACK_TEXT_MAX * 2
/** Feedback per person: ten an hour (a guest counts as a person; a client address has its own backstop). */
export const FEEDBACK_PER_PERSON = { max: 10, windowMs: 60 * 60 * 1000 } as const

export const FEEDBACK_STATUSES = ['open', 'done'] as const
export const FeedbackStatus = z.enum(FEEDBACK_STATUSES)
export type FeedbackStatus = z.infer<typeof FeedbackStatus>

export const FeedbackKind = z.enum(['account', 'guest'])
export type FeedbackKind = z.infer<typeof FeedbackKind>

export const FeedbackId = z.string().regex(/^fbk_[0-9A-Za-z]{10,40}$/)

/** Mirrors BOARD_ID_PATTERN (index.ts), which this file may not import. */
const BOARD_ID = /^[a-z0-9][a-z0-9_-]{2,63}$/

/**
 * What the page attaches to the message, which the person sees before sending: the page path (never a
 * query string or fragment), the board's id and title when on a board, browser and OS (the user agent),
 * the viewport, the app build and the time on the person's clock. Plain text, each field capped. The api
 * stores what is valid and nulls or defaults the rest: feedback is never refused over its context.
 */
export const FeedbackContext = z.object({
  path: z.string().max(200),
  boardId: z.string().regex(BOARD_ID).nullable(),
  boardTitle: z.string().max(120).nullable(),
  userAgent: z.string().max(300),
  viewport: z.object({
    width: z.number().int().min(0).max(20_000),
    height: z.number().int().min(0).max(20_000),
  }),
  build: z.string().max(40),
  at: z.string().max(40),
})
export type FeedbackContext = z.infer<typeof FeedbackContext>

/**
 * POST /api/feedback. `context` is parsed field by field on the api (a bad field is dropped, not a 400),
 * so it is `unknown` here.
 */
export const FeedbackInput = z.object({
  text: z.string().max(FEEDBACK_WIRE_MAX),
  expected: z.string().max(FEEDBACK_WIRE_MAX).nullish(),
  context: z.unknown().optional(),
})
export type FeedbackInput = z.infer<typeof FeedbackInput>

/** 201 of POST /api/feedback. */
export const FeedbackSent = z.object({ id: FeedbackId, createdAt: z.string() })
export type FeedbackSent = z.infer<typeof FeedbackSent>

/** GET /api/feedback/access: whether the caller reads the inbox (a guest, or anyone not listed, is false). */
export const FeedbackAccess = z.object({ admin: z.boolean() })
export type FeedbackAccess = z.infer<typeof FeedbackAccess>

/** One message as the inbox shows it. */
export const FeedbackItem = z.object({
  id: FeedbackId,
  createdAt: z.string(),
  userId: z.string(),
  /** The sender's display name when they sent it (it can change later). */
  name: z.string(),
  kind: FeedbackKind,
  text: z.string(),
  expected: z.string().nullable(),
  context: FeedbackContext,
  status: FeedbackStatus,
  /** When it was last marked done or reopened; null while it has never been. */
  statusAt: z.string().nullable(),
})
export type FeedbackItem = z.infer<typeof FeedbackItem>

/** Newest first. `next` is the cursor of the following page (pass it back as `cursor`), null at the end. */
export const FeedbackList = z.object({ items: z.array(FeedbackItem), next: z.string().nullable() })
export type FeedbackList = z.infer<typeof FeedbackList>

export const FEEDBACK_LIST_LIMIT = { default: 50, max: 200 } as const
export const FeedbackListQuery = z.object({
  status: z.enum(['open', 'done', 'all']).default('open'),
  limit: z.coerce.number().int().min(1).max(FEEDBACK_LIST_LIMIT.max).default(FEEDBACK_LIST_LIMIT.default),
  cursor: z.string().max(200).optional(),
})
export type FeedbackListQuery = z.infer<typeof FeedbackListQuery>

/** PATCH /api/feedback/:id: marks it done, or opens it again. Answers the updated FeedbackItem. */
export const FeedbackPatch = z.object({ status: FeedbackStatus })
export type FeedbackPatch = z.infer<typeof FeedbackPatch>

/**
 * GET /internal/feedback (the internal secret): what the lead's triage tooling reads. Ids, text and
 * context only: no display names and no addresses.
 */
export const FEEDBACK_INTERNAL_LIMIT = { default: 200, max: 500 } as const
export const FeedbackInternalItem = z.object({
  id: FeedbackId,
  createdAt: z.string(),
  status: FeedbackStatus,
  kind: FeedbackKind,
  userId: z.string(),
  text: z.string(),
  expected: z.string().nullable(),
  context: FeedbackContext,
})
export type FeedbackInternalItem = z.infer<typeof FeedbackInternalItem>
export const FeedbackInternalList = z.object({
  items: z.array(FeedbackInternalItem),
  next: z.string().nullable(),
})
export type FeedbackInternalList = z.infer<typeof FeedbackInternalList>
export const FeedbackInternalQuery = z.object({
  status: z.enum(['open', 'done', 'all']).default('open'),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(FEEDBACK_INTERNAL_LIMIT.max)
    .default(FEEDBACK_INTERNAL_LIMIT.default),
  cursor: z.string().max(200).optional(),
})
export type FeedbackInternalQuery = z.infer<typeof FeedbackInternalQuery>

/** The refusals the web tells apart (the messages say what to do). */
export const FEEDBACK_CODES = {
  /** 400: nothing to send after cleaning, or a field over its limit. */
  invalid: 'FEEDBACK_INVALID',
} as const

// ---- wave M (M2-5, W2; frozen by the wave M foundation): the end-of-moment prompt ----------------------------------
//
// "How did this go in Lobby? [Good] [Something got in the way]" after a facilitated moment. It uses POST
// /api/feedback as it is: no route, contract field, column or migration (the wave M migrations end at 0030).
// FeedbackKind already says who sent an item (account or guest), and FeedbackInput and its context drop unknown
// keys, so a `kind: 'praise'` or a `moment` field would be lost without an error. The prompt therefore says both in
// the text the person sends:
//   - Good sends feedbackPromptGoodText(moment) as `text`, "Good (after a vote reveal)", with the usual context;
//   - Something got in the way opens the FeedbackDialog with feedbackPromptIssuePrefill(moment) in "What happened?",
//     "After a vote reveal: ", for the person to finish (they can edit or delete it).
// The inbox tells a Good apart by its text (FEEDBACK_PROMPT_GOOD_PREFIX).

/** The facilitated moments that end with the prompt. */
export const FEEDBACK_PROMPT_MOMENTS = [
  'presentation-stop',
  'vote-reveal',
  'results-to-board',
  'run-of-show-end',
] as const
export type FeedbackPromptMoment = (typeof FEEDBACK_PROMPT_MOMENTS)[number]

/** How each moment reads in the sent text. */
export const FEEDBACK_PROMPT_MOMENT_LABELS: Readonly<Record<FeedbackPromptMoment, string>> = {
  'presentation-stop': 'a presentation',
  'vote-reveal': 'a vote reveal',
  'results-to-board': 'vote results to the board',
  'run-of-show-end': 'the run of show',
}

/** Every Good starts with this, so the inbox (and the lead's triage) can tell it from a report. */
export const FEEDBACK_PROMPT_GOOD_PREFIX = 'Good (after '

/** The whole `text` of a Good: "Good (after a vote reveal)". */
export const feedbackPromptGoodText = (moment: FeedbackPromptMoment): string =>
  `${FEEDBACK_PROMPT_GOOD_PREFIX}${FEEDBACK_PROMPT_MOMENT_LABELS[moment]})`

/** What "Something got in the way" puts in "What happened?" first: "After a vote reveal: ". */
export const feedbackPromptIssuePrefill = (moment: FeedbackPromptMoment): string => {
  const label = FEEDBACK_PROMPT_MOMENT_LABELS[moment]
  return `After ${label}: `
}
