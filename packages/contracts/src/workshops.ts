// API schemas for the workshops feature (docs/FEATURES-M2-CONTRACTS.md): the shared timer, dot
// voting and "gather everyone". Owned by the workshops engineer. Browser-safe; used by apps/api
// (validates input, shapes output) and apps/web (parses responses and events).
//
// Privacy rule (PRF-07): nothing in this file ever carries another person's ballot before a vote is
// revealed. Per-user state (`myVotes`) is only ever returned to that user; events carry aggregates.
//
// Do not import values from ./index.ts here: index.ts re-exports this module, so the cycle would
// read index's constants before they are initialized.

import { z } from 'zod'

const userIdRe = /^usr_[0-9A-Za-z]{10,40}$/
const WsUserId = z.string().regex(userIdRe)
const IsoDate = z.string()

/** tldraw shape ids: `shape:` + a url-safe id (nanoid by default; templates may use readable ids). */
export const VOTE_SHAPE_ID_PATTERN = /^shape:[A-Za-z0-9_-]{1,100}$/
export const VoteShapeId = z.string().regex(VOTE_SHAPE_ID_PATTERN)

// ---- timer ---------------------------------------------------------------------------------------

export const TIMER_MAX_MS = 24 * 60 * 60 * 1000
export const TIMER_MIN_MS = 1000
export const TIMER_ADD_MAX_MS = 60 * 60 * 1000

export const TimerStatus = z.enum(['running', 'paused', 'stopped', 'finished'])
export type TimerStatus = z.infer<typeof TimerStatus>

/**
 * The shared countdown, always computed by the server at response time.
 * - running: `endsAt` is the authority; clients show `endsAt - (Date.now() + serverOffset)`.
 * - paused: `remainingMs` is frozen; `endsAt` is null.
 * - stopped: reset to `durationMs`; `remainingMs === durationMs`.
 * - finished: reached zero (`remainingMs === 0`); `endsAt` is when it did.
 */
export const WorkshopTimer = z.object({
  status: TimerStatus,
  durationMs: z.number().int().nonnegative(),
  remainingMs: z.number().int().nonnegative(),
  endsAt: IsoDate.nullable(),
  startedAt: IsoDate.nullable(),
  startedBy: WsUserId.nullable(),
  updatedAt: IsoDate,
})
export type WorkshopTimer = z.infer<typeof WorkshopTimer>

const DurationMs = z.number().int().min(TIMER_MIN_MS).max(TIMER_MAX_MS)
const AddMs = z.number().int().min(TIMER_MIN_MS).max(TIMER_ADD_MAX_MS)

export const TimerActionInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start'), durationMs: DurationMs }),
  z.object({ action: z.literal('pause') }),
  z.object({ action: z.literal('resume') }),
  z.object({ action: z.literal('stop') }),
  z.object({ action: z.literal('add'), addMs: AddMs }),
])
export type TimerActionInput = z.infer<typeof TimerActionInput>

export const TimerResponse = z.object({ timer: WorkshopTimer.nullable(), serverNow: IsoDate })
export type TimerResponse = z.infer<typeof TimerResponse>

// ---- voting --------------------------------------------------------------------------------------

export const VoteScope = z.enum(['board', 'frame'])
export type VoteScope = z.infer<typeof VoteScope>
export const VoteStatus = z.enum(['open', 'closed', 'revealed'])
export type VoteStatus = z.infer<typeof VoteStatus>

export const VOTES_PER_PERSON_MAX = 99
export const VOTE_DURATION_MIN_MS = 60 * 1000
export const VOTE_DURATION_MAX_MS = 7 * 24 * 60 * 60 * 1000
const ShapeType = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/)

export const CreateVoteInput = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    votesPerPerson: z.number().int().min(1).max(VOTES_PER_PERSON_MAX),
    onePerObject: z.boolean(),
    scope: VoteScope,
    frameId: VoteShapeId.nullable().optional(),
    /** Optional end time; casting after it fails. null/omitted = until the facilitator ends it. */
    durationMs: z.number().int().min(VOTE_DURATION_MIN_MS).max(VOTE_DURATION_MAX_MS).nullable().optional(),
    /** Only these shape types can receive votes (e.g. ['note']); null/omitted = any votable object. */
    shapeTypes: z.array(ShapeType).min(1).max(10).nullable().optional(),
  })
  .refine((v) => (v.scope === 'frame') === !!v.frameId, {
    message: 'frameId is required for a frame vote, and only allowed there',
    path: ['frameId'],
  })
export type CreateVoteInput = z.infer<typeof CreateVoteInput>

export const VoteSession = z.object({
  id: z.string().regex(/^vot_[0-9A-Za-z]{10,40}$/),
  boardId: z.string(),
  title: z.string(),
  votesPerPerson: z.number().int(),
  onePerObject: z.boolean(),
  scope: VoteScope,
  frameId: VoteShapeId.nullable(),
  shapeTypes: z.array(z.string()).nullable(),
  /** Effective status: an open vote past `endsAt` is reported as closed. */
  status: VoteStatus,
  createdBy: WsUserId,
  createdAt: IsoDate,
  endsAt: IsoDate.nullable(),
  closedAt: IsoDate.nullable(),
  revealedAt: IsoDate.nullable(),
})
export type VoteSession = z.infer<typeof VoteSession>

export const VoteResult = z.object({
  shapeId: VoteShapeId,
  count: z.number().int().positive(),
  /** Competition ranking: ties share a rank (1, 1, 3). */
  rank: z.number().int().positive(),
})
export type VoteResult = z.infer<typeof VoteResult>

/** The caller's view of one vote. Only `myVotes` is per-user, and only the caller's own. */
export const WorkshopVoteState = z.object({
  session: VoteSession,
  myVotes: z.record(z.string(), z.number().int().positive()),
  myRemaining: z.number().int().nonnegative(),
  done: z.boolean(),
  participantsDone: z.number().int().nonnegative(),
  /** People who have cast at least one vote or said they are done. */
  participants: z.number().int().nonnegative(),
  totalVotesCast: z.number().int().nonnegative(),
  /** Only once the vote is revealed; null before (no ballots of others ever leave the server). */
  results: z.array(VoteResult).nullable(),
})
export type WorkshopVoteState = z.infer<typeof WorkshopVoteState>

// ---- raise hand (FAC-08; in-memory on the API, never persisted) -----------------------------------

/** A raised hand is lowered by the server after this long (and when its owner's event stream ends). */
export const HAND_AUTO_LOWER_MS = 10 * 60 * 1000

/** One raised hand. Lists of hands are in the order they went up (first raised first). */
export const RaisedHand = z.object({
  userId: WsUserId,
  /** The display name at the time the hand went up (from the session, never from a request body). */
  name: z.string(),
  raisedAt: IsoDate,
})
export type RaisedHand = z.infer<typeof RaisedHand>

/**
 * Orders hand lists that arrive by different paths (a response, an event, a refetch): `n` grows with
 * every change within one API process (`epoch`); a different epoch means the API restarted (every
 * hand went down) and replaces what a client had.
 */
export const HandsVersion = z.object({ epoch: z.string().min(1).max(40), n: z.number().int().nonnegative() })
export type HandsVersion = z.infer<typeof HandsVersion>

/** Whether `next` may replace `current` (never an older list of the same API process). */
export function isNewerHands(current: HandsVersion | null, next: HandsVersion | null): boolean {
  if (!next) return false
  if (!current || current.epoch !== next.epoch) return true
  return next.n >= current.n
}

export const WorkshopState = z.object({
  timer: WorkshopTimer.nullable(),
  /** The open vote, else the most recent one (so everyone can still see its results). */
  vote: WorkshopVoteState.nullable(),
  /** Raised hands on this board, first raised first (so late joiners see the queue). */
  hands: z.array(RaisedHand).default([]),
  handsVersion: HandsVersion.nullable().default(null),
  serverNow: IsoDate,
})
export type WorkshopState = z.infer<typeof WorkshopState>

export const CastVoteInput = z.object({
  shapeId: VoteShapeId,
  delta: z.union([z.literal(1), z.literal(-1)]),
})
export type CastVoteInput = z.infer<typeof CastVoteInput>

/** Body optional: `{}` or no body = done; `{ done: false }` undoes it. */
export const VoteDoneInput = z.object({ done: z.boolean().optional() }).optional()
export const ExtendVoteInput = z.object({ addMs: AddMs })

export const VoteSessionSummary = VoteSession.extend({
  totalVotesCast: z.number().int().nonnegative(),
  participants: z.number().int().nonnegative(),
})
export type VoteSessionSummary = z.infer<typeof VoteSessionSummary>
export const ListVoteSessionsResponse = z.object({ sessions: z.array(VoteSessionSummary) })
export const VoteResultsResponse = z.object({
  session: VoteSessionSummary,
  results: z.array(VoteResult),
})
export type VoteResultsResponse = z.infer<typeof VoteResultsResponse>

// ---- gather everyone -----------------------------------------------------------------------------

/** Body optional. `targetUserId` = bring one person; omitted = everyone. */
export const SummonInput = z.object({ targetUserId: WsUserId.optional() }).optional()

// ---- reactions (FAC-08; relayed as events only, never stored) -------------------------------------

/**
 * The only reactions there are (a strict allowlist: any other string, including the same emoji
 * without its variation selector, is a 400). Order = the order of the reaction bar.
 */
export const REACTION_EMOJIS = ['👍', '❤️', '😂', '🎉', '🤔', '👏'] as const
export const ReactionEmoji = z.enum(REACTION_EMOJIS)
export type ReactionEmoji = z.infer<typeof ReactionEmoji>
/** Words for screen readers and tooltips, per emoji. */
export const REACTION_LABELS: Readonly<Record<ReactionEmoji, string>> = {
  '👍': 'Thumbs up',
  '❤️': 'Love',
  '😂': 'Laugh',
  '🎉': 'Celebrate',
  '🤔': 'Hmm',
  '👏': 'Applause',
}
/** Per person (across boards): at most REACTION_RATE_MAX reactions in any REACTION_RATE_WINDOW_MS. */
export const REACTION_RATE_MAX = 5
export const REACTION_RATE_WINDOW_MS = 1000

/** POST /api/boards/:bid/reactions. Who reacted comes from the session (other keys are ignored). */
export const ReactionInput = z.object({ emoji: ReactionEmoji })
export type ReactionInput = z.infer<typeof ReactionInput>

/** POST /api/boards/:bid/hand: raise or lower your own hand. */
export const HandInput = z.object({ raised: z.boolean() })
export type HandInput = z.infer<typeof HandInput>

export const HandsResponse = z.object({
  hands: z.array(RaisedHand),
  version: HandsVersion,
  serverNow: IsoDate,
})
export type HandsResponse = z.infer<typeof HandsResponse>

/**
 * Why a hand went up or down: `raised` / `lowered` (by its owner), `lowered_by_facilitator` (one
 * hand) or `cleared` (all hands) by someone who may edit the board, `expired` (HAND_AUTO_LOWER_MS),
 * `disconnected` (the owner's last event stream on the board ended and did not come back).
 */
export const HandChangeReason = z.enum([
  'raised',
  'lowered',
  'lowered_by_facilitator',
  'cleared',
  'expired',
  'disconnected',
])
export type HandChangeReason = z.infer<typeof HandChangeReason>

export const HandChange = z.object({
  userId: WsUserId,
  name: z.string(),
  raised: z.boolean(),
  reason: HandChangeReason,
  /** Who lowered someone else's hand (facilitator actions); null otherwise. */
  byUserId: WsUserId.nullable(),
  byName: z.string().nullable(),
})
export type HandChange = z.infer<typeof HandChange>

// ---- +1 on sticky notes (FAC-08; stored in the note itself, synced by the canvas) --------------------

/**
 * A note's +1s live in its own `meta[PLUS_ONES_META_KEY]`: an array of user ids, oldest first,
 * written through the normal canvas sync, so the sync server's read-only rule decides who can add
 * one (viewers and commenters cannot). tldraw's sync sends an addition as an append at the length
 * the writer saw (dropped by the server if someone else's landed first) and a removal as a rewrite
 * of the array, so writers re-apply a dropped change (apps/web features/workshops/plus-ones.ts).
 * The array can hold ids of people who no longer have access; count them as they are.
 */
export const PLUS_ONES_META_KEY = 'plusOnes'
/** At most this many +1s on one note (enforced by the clients that write them). */
export const PLUS_ONES_MAX = 200

/**
 * The user ids that +1'd a note, oldest first, from its `meta` (malformed and repeated entries are
 * ignored; an `{ [userId]: epoch ms }` map is read too). Never more than PLUS_ONES_MAX.
 */
export function readPlusOnes(meta: unknown): string[] {
  if (!meta || typeof meta !== 'object') return []
  const raw = (meta as Record<string, unknown>)[PLUS_ONES_META_KEY]
  const entries: { id: string; at: number }[] = []
  const seen = new Set<string>()
  const add = (id: unknown, at: number) => {
    if (typeof id !== 'string' || !userIdRe.test(id) || seen.has(id)) return
    seen.add(id)
    entries.push({ id, at })
  }
  if (Array.isArray(raw)) for (const [i, id] of raw.entries()) add(id, i)
  else if (raw && typeof raw === 'object')
    for (const [id, at] of Object.entries(raw as Record<string, unknown>))
      add(id, typeof at === 'number' && Number.isFinite(at) ? at : 0)
  return entries
    .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, PLUS_ONES_MAX)
    .map((e) => e.id)
}

// ---- events (GET /api/boards/:bid/events) --------------------------------------------------------

export const WORKSHOP_EVENTS = {
  timer: 'workshop.timer',
  vote: 'workshop.vote',
  results: 'workshop.vote.results',
  summon: 'workshop.summon',
  reaction: 'workshop.reaction',
  hand: 'workshop.hand',
} as const

/** Someone on the board reacted (a hint to animate; nothing is stored). */
export const WorkshopReactionEvent = z.object({ userId: WsUserId, name: z.string(), emoji: ReactionEmoji })
export type WorkshopReactionEvent = z.infer<typeof WorkshopReactionEvent>

/** The whole queue after a change (idempotent to apply), plus what changed. */
export const WorkshopHandEvent = z.object({
  hands: z.array(RaisedHand),
  changes: z.array(HandChange),
  version: HandsVersion,
})
export type WorkshopHandEvent = z.infer<typeof WorkshopHandEvent>

export const WorkshopTimerEvent = z.object({ timer: WorkshopTimer.nullable() })
/** Aggregates only: each client refetches its own ballot. */
export const WorkshopVoteEvent = z.object({
  sessionId: z.string(),
  status: VoteStatus,
  totalVotesCast: z.number().int().nonnegative(),
  participantsDone: z.number().int().nonnegative(),
  participants: z.number().int().nonnegative(),
  endsAt: IsoDate.nullable(),
})
export type WorkshopVoteEvent = z.infer<typeof WorkshopVoteEvent>
/** Published once, when a vote is revealed. */
export const WorkshopVoteResultsEvent = z.object({
  sessionId: z.string(),
  results: z.array(VoteResult),
  totalVotesCast: z.number().int().nonnegative(),
  participants: z.number().int().nonnegative(),
})
export type WorkshopVoteResultsEvent = z.infer<typeof WorkshopVoteResultsEvent>
export const WorkshopSummonEvent = z.object({
  userId: WsUserId,
  name: z.string(),
  targetUserId: WsUserId.nullable(),
})
export type WorkshopSummonEvent = z.infer<typeof WorkshopSummonEvent>

// ---- which objects can receive votes (same rule on the server and in the browser) -----------------

/** Connectors, ink and groups never take votes (Miro votes go on objects, not lines). */
export const VOTE_INELIGIBLE_TYPES: readonly string[] = ['arrow', 'line', 'draw', 'highlight', 'group']

export interface VoteShapeInfo {
  id: string
  type: string
  parentId: string
}

export interface VoteEligibilityRule {
  scope: VoteScope
  frameId: string | null
  shapeTypes: readonly string[] | null
}

const MAX_DEPTH = 64

/**
 * Whether `shapeId` may receive a vote under `rule`. `lookup` returns shape records only (pages and
 * other records return undefined). Frame scope = the frame is an ancestor (the frame itself is not).
 */
export function isVoteEligible(
  shapeId: string,
  lookup: (id: string) => VoteShapeInfo | undefined,
  rule: VoteEligibilityRule,
): boolean {
  if (!VOTE_SHAPE_ID_PATTERN.test(shapeId)) return false
  const shape = lookup(shapeId)
  if (!shape || shape.id !== shapeId) return false
  if (VOTE_INELIGIBLE_TYPES.includes(shape.type)) return false
  if (rule.shapeTypes && !rule.shapeTypes.includes(shape.type)) return false
  if (rule.scope === 'board') return true
  if (!rule.frameId || shape.id === rule.frameId) return false
  let parentId = shape.parentId
  for (let i = 0; i < MAX_DEPTH && parentId; i++) {
    if (parentId === rule.frameId) return true
    const parent = lookup(parentId)
    if (!parent) return false
    parentId = parent.parentId
  }
  return false
}

/** Competition ranking over per-shape totals, highest first (ties share a rank; id breaks ties in order). */
export function rankVoteResults(totals: Iterable<{ shapeId: string; count: number }>): VoteResult[] {
  const sorted = [...totals]
    .filter((t) => t.count > 0)
    .sort((a, b) => b.count - a.count || (a.shapeId < b.shapeId ? -1 : a.shapeId > b.shapeId ? 1 : 0))
  const out: VoteResult[] = []
  sorted.forEach((t, i) => {
    const prev = out[i - 1]
    out.push({ shapeId: t.shapeId, count: t.count, rank: prev && prev.count === t.count ? prev.rank : i + 1 })
  })
  return out
}

// ---- private brainstorming (wave 3, "private-notes"; build plan §9) --------------------------------
//
// Drafts live in a private server namespace (Postgres rows readable only by their author) and reach
// the board only when the starter or a board owner reveals them: the sync server then writes them as
// real note shapes into the target frame in one storage transaction. Nothing here ever carries
// another person's draft text: events and every response carry counts, and `myNotes` is only ever
// the CALLER's own drafts. Anonymous sessions never tell anyone who wrote what, before or after.

export const PRIVATE_BRAINSTORM_ID_PATTERN = /^pbs_[0-9A-Za-z]{10,40}$/
export const PRIVATE_NOTE_ID_PATTERN = /^pnt_[0-9A-Za-z]{10,40}$/
export const PrivateBrainstormId = z.string().regex(PRIVATE_BRAINSTORM_ID_PATTERN)
export const PrivateNoteId = z.string().regex(PRIVATE_NOTE_ID_PATTERN)

/** Most characters (Unicode code points, like Postgres char_length) in one private note. */
export const PRIVATE_NOTE_MAX_CHARS = 500
export const PRIVATE_PROMPT_MAX_CHARS = 200
/** Drafts one person may hold in one session, and drafts one session may hold in total. */
export const PRIVATE_NOTES_PER_PERSON_MAX = 50
export const PRIVATE_NOTES_PER_SESSION_MAX = 1000
/** The frame a brainstorm creates when no frame is selected. */
export const PRIVATE_FRAME_DEFAULT_NAME = 'Private ideas'

/** The note palette's colour names (tldraw colour styles; the web palette gives them our names). */
export const PRIVATE_NOTE_COLORS = [
  'black',
  'yellow',
  'orange',
  'light-red',
  'red',
  'light-violet',
  'violet',
  'blue',
  'light-blue',
  'green',
  'light-green',
  'grey',
  'white',
] as const
export const PrivateNoteColor = z.enum(PRIVATE_NOTE_COLORS)
export type PrivateNoteColor = z.infer<typeof PrivateNoteColor>

/** Code points, as Postgres char_length counts them (an emoji is one, not two UTF-16 units). */
export const codePointLength = (s: string) => [...s].length

// C0 controls except tab and newline, DEL, and the C1 range: never part of a note or a prompt.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find control characters
const PRIVATE_CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/

/** Trimmed, CRLF normalized, 1..PRIVATE_NOTE_MAX_CHARS code points, no control characters. */
export const PrivateNoteText = z
  .string()
  .transform((s) => s.replace(/\r\n?/g, '\n').trim())
  .refine((s) => s.length > 0, { message: 'Write something first.' })
  .refine((s) => codePointLength(s) <= PRIVATE_NOTE_MAX_CHARS, {
    message: `A note can have at most ${PRIVATE_NOTE_MAX_CHARS} characters.`,
  })
  .refine((s) => !PRIVATE_CONTROL_RE.test(s), {
    message: 'The note contains characters that cannot be shown.',
  })

/** One line: whitespace runs collapse to one space. */
export const PrivatePrompt = z
  .string()
  .transform((s) => s.replace(/\s+/g, ' ').trim())
  .refine((s) => s.length > 0, { message: 'Write a prompt for everyone.' })
  .refine((s) => codePointLength(s) <= PRIVATE_PROMPT_MAX_CHARS, {
    message: `The prompt can have at most ${PRIVATE_PROMPT_MAX_CHARS} characters.`,
  })
  .refine((s) => !PRIVATE_CONTROL_RE.test(s), {
    message: 'The prompt contains characters that cannot be shown.',
  })

const PageRecordId = z.string().regex(/^page:[A-Za-z0-9_-]{1,100}$/)
const Coord = z.number().finite().min(-10_000_000).max(10_000_000)
const Extent = z.number().finite().min(1).max(100_000)

/**
 * Where the notes go: a frame on the board (the selected one, or the "Private ideas" frame the
 * starter's client just created in view). `pageId`/`x`/`y`/`w`/`h` are where it was when the session
 * started (page coordinates): if the frame is gone at reveal, the notes get a new frame there.
 */
export const PrivateTarget = z.object({
  frameId: VoteShapeId,
  pageId: PageRecordId,
  x: Coord,
  y: Coord,
  w: Extent,
  h: Extent,
})
export type PrivateTarget = z.infer<typeof PrivateTarget>

export const StartPrivateBrainstormInput = z.object({
  prompt: PrivatePrompt,
  anonymous: z.boolean(),
  target: PrivateTarget,
})
export type StartPrivateBrainstormInput = z.input<typeof StartPrivateBrainstormInput>

/**
 * - open: people are drafting;
 * - revealed: revealed; the notes are being placed on the board, or placing them failed (retry);
 * - placed / cancelled: over (the drafts are deleted).
 */
export const PrivateBrainstormStatus = z.enum(['open', 'revealed', 'placed', 'cancelled'])
export type PrivateBrainstormStatus = z.infer<typeof PrivateBrainstormStatus>

export const PrivateBrainstorm = z.object({
  id: PrivateBrainstormId,
  boardId: z.string(),
  prompt: z.string(),
  anonymous: z.boolean(),
  frameId: VoteShapeId,
  status: PrivateBrainstormStatus,
  /** The person who started it (they, and board owners, may reveal or cancel it). */
  createdBy: WsUserId,
  createdAt: IsoDate,
  revealedAt: IsoDate.nullable(),
  endedAt: IsoDate.nullable(),
  /** How many notes were placed on the board (once placed). */
  placedCount: z.number().int().nonnegative().nullable(),
})
export type PrivateBrainstorm = z.infer<typeof PrivateBrainstorm>

/** Live counts, safe for everyone on the board: "7 notes from 4 people". */
export const PrivateCounts = z.object({
  notes: z.number().int().nonnegative(),
  people: z.number().int().nonnegative(),
})
export type PrivateCounts = z.infer<typeof PrivateCounts>

/** One of the CALLER's own drafts (nobody else's is ever returned). */
export const PrivateNote = z.object({
  id: PrivateNoteId,
  text: z.string(),
  color: PrivateNoteColor,
  createdAt: IsoDate,
  updatedAt: IsoDate,
})
export type PrivateNote = z.infer<typeof PrivateNote>

/** GET /api/boards/:bid/private-brainstorm, and the answer to every private-brainstorm mutation. */
export const PrivateBrainstormState = z.object({
  /** The board's active session (open or revealed), else null. */
  session: PrivateBrainstorm.nullable(),
  counts: PrivateCounts,
  /** The caller's own drafts in the active session, oldest first (empty for people who cannot edit). */
  myNotes: z.array(PrivateNote),
  /** Whether the caller may reveal, place or cancel the active session (the API decides). */
  canReveal: z.boolean(),
  /** Only in a reveal response: the session that just ended with its notes placed on the board. */
  placed: PrivateBrainstorm.nullable().default(null),
})
export type PrivateBrainstormState = z.infer<typeof PrivateBrainstormState>

export const AddPrivateNoteInput = z.object({ text: PrivateNoteText, color: PrivateNoteColor })
export type AddPrivateNoteInput = z.input<typeof AddPrivateNoteInput>
export const UpdatePrivateNoteInput = z
  .object({ text: PrivateNoteText.optional(), color: PrivateNoteColor.optional() })
  .refine((v) => v.text !== undefined || v.color !== undefined, { message: 'Nothing to change.' })
export type UpdatePrivateNoteInput = z.input<typeof UpdatePrivateNoteInput>

export const PRIVATE_NOTES_EVENTS = { changed: 'workshop.private' } as const

/**
 * Published after every change others should see: start, a draft added or deleted, reveal, placed,
 * cancelled. `session` is the session that changed (also when it just ended). Counts only: each
 * client refetches its own drafts.
 */
export const PrivateBrainstormEvent = z.object({
  session: PrivateBrainstorm,
  counts: PrivateCounts,
})
export type PrivateBrainstormEvent = z.infer<typeof PrivateBrainstormEvent>

/**
 * Placed notes carry `meta[PRIVATE_NOTE_META_KEY] = { session }`, plus `author` (a user id) only when
 * the session was not anonymous. Anonymous notes name nobody (and have no textLastEditedBy).
 */
export const PRIVATE_NOTE_META_KEY = 'drPrivateNote'
