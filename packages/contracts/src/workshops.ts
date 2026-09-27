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

export const WorkshopState = z.object({
  timer: WorkshopTimer.nullable(),
  /** The open vote, else the most recent one (so everyone can still see its results). */
  vote: WorkshopVoteState.nullable(),
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

// ---- events (GET /api/boards/:bid/events) --------------------------------------------------------

export const WORKSHOP_EVENTS = {
  timer: 'workshop.timer',
  vote: 'workshop.vote',
  results: 'workshop.vote.results',
  summon: 'workshop.summon',
} as const

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
