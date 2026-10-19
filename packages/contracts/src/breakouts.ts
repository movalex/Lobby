// Wave V (V3): breakouts, "breakout frames" (docs/WAVE-V-CONTRACTS.md §4). OWNER: the wave V lead (contracts are
// lead-only); WS4 builds the api (apps/api/src/features/breakouts) and the web (apps/web/src/features/breakouts).
// Browser-safe.
//
// A facilitator splits the room into 2-20 groups, each with a frame on the board: everyone is assigned (`auto`: the api
// deals out everyone with an open event stream on the board, facilitators left out, round robin over a shuffled list;
// `manual`: the facilitator picks; `choose`: people pick their group, up to an optional cap). A chip says "Group 2 ·
// 8:30 left · Go to my frame"; the facilitator broadcasts a line to everyone or to one group, summons a group to them,
// moves people, adds time and ends it ("Return everyone" = the existing Gather everyone).
//
// Membership is not secret (names are on the board already). A group's summon and broadcast reach ONLY that group's
// streams: the api delivers them with hub.publish(bid, ev, {to: uid => members.has(uid)}), and the web obeys a summon
// only for its own group (breakoutSummonApplies). That is "follow never leaks across groups". Editing is NOT fenced to
// a group's frame (a guide, not a fence; the UI copy says so). Presence stays ephemeral and untouched.
//
// Do not import values from ./index.ts here: index.ts re-exports this module.

import { z } from 'zod'
import { hasForbiddenActivityChar } from './live-activities.ts'
import { codePointLength, SummonScreen, VoteShapeId } from './workshops.ts'

const IsoDate = z.string()
const WsUserId = z.string().regex(/^usr_[0-9A-Za-z]{10,40}$/)

export const BREAKOUT_ID_PATTERN = /^brk_[0-9A-Za-z]{10,40}$/
export const BreakoutId = z.string().regex(BREAKOUT_ID_PATTERN)
/** A group's id within its session: g1 … g20, in the order the facilitator gave the groups. */
export const BREAKOUT_GROUP_ID_PATTERN = /^g([1-9]|1[0-9]|20)$/
export const BreakoutGroupId = z.string().regex(BREAKOUT_GROUP_ID_PATTERN)
export const breakoutGroupId = (index: number) => `g${index + 1}`

export const BREAKOUT_LIMITS = {
  groupsMin: 2,
  groupsMax: 20,
  groupNameMaxChars: 40,
  /** choose mode's optional cap per group */
  groupCapMax: 200,
  /** one broadcast line, code points */
  broadcastMaxChars: 200,
  durationMinMs: 60_000,
  durationMaxMs: 4 * 60 * 60 * 1000,
  extendMaxMs: 60 * 60 * 1000,
  /** people moved by one assign call */
  movesMax: 200,
  /** broadcasts and summons, per session together, like one person's summon cooldown */
  broadcastWindow: { max: 1, windowMs: 3_000 },
  summonWindow: { max: 1, windowMs: 3_000 },
} as const

// C0/C1 controls and the bidi/zero-width controls, with ZWJ and ZWNJ allowed where they join (an emoji sequence, a
// Persian word): the one rule of live-activities.ts (review m7).
const bad = hasForbiddenActivityChar
const oneLine = (max: number, empty: string, what: string) =>
  z
    .string()
    .max(max * 8)
    .transform((s) => s.replace(/\s+/gu, ' ').trim())
    .refine((s) => s.length > 0, { message: empty })
    .refine((s) => codePointLength(s) <= max, { message: `${what} can have at most ${max} characters.` })
    .refine((s) => !bad(s), { message: `${what} contains characters that cannot be shown.` })

export const BreakoutGroupName = oneLine(BREAKOUT_LIMITS.groupNameMaxChars, 'Name the group.', 'A group name')
export const BreakoutBroadcastText = oneLine(
  BREAKOUT_LIMITS.broadcastMaxChars,
  'Write a message.',
  'The message',
)

export const BreakoutMode = z.enum(['auto', 'manual', 'choose'])
export type BreakoutMode = z.infer<typeof BreakoutMode>

/** A group: its name and the frame it works in (an api ref, `shape:<element id>`, as votes and spotlights). */
export const BreakoutGroup = z.object({ id: BreakoutGroupId, name: z.string(), frameId: VoteShapeId })
export type BreakoutGroup = z.infer<typeof BreakoutGroup>

/** POST /api/boards/:bid/breakouts (facilitate). The groups get ids g1 … gN in this order. */
export const StartBreakoutsInput = z
  .strictObject({
    groups: z
      .array(z.strictObject({ name: BreakoutGroupName, frameId: VoteShapeId }))
      .min(BREAKOUT_LIMITS.groupsMin)
      .max(BREAKOUT_LIMITS.groupsMax),
    mode: BreakoutMode,
    /** optional end time for every group (one session-wide timer; per-group timers are deferred) */
    durationMs: z
      .number()
      .int()
      .min(BREAKOUT_LIMITS.durationMinMs)
      .max(BREAKOUT_LIMITS.durationMaxMs)
      .nullable()
      .default(null),
    /** choose mode only: the most people one group takes */
    groupCap: z.number().int().min(1).max(BREAKOUT_LIMITS.groupCapMax).nullable().default(null),
  })
  .superRefine((v, ctx) => {
    if (new Set(v.groups.map((g) => g.frameId)).size !== v.groups.length)
      ctx.addIssue({ code: 'custom', path: ['groups'], message: 'Each group needs its own frame.' })
    if (v.groupCap !== null && v.mode !== 'choose')
      ctx.addIssue({ code: 'custom', path: ['groupCap'], message: 'A group cap is for "people choose".' })
  })
export type StartBreakoutsInput = z.input<typeof StartBreakoutsInput>

export const BreakoutStatus = z.enum(['running', 'ended'])
export type BreakoutStatus = z.infer<typeof BreakoutStatus>

export const BreakoutSession = z.object({
  id: BreakoutId,
  boardId: z.string(),
  groups: z.array(BreakoutGroup).min(BREAKOUT_LIMITS.groupsMin).max(BREAKOUT_LIMITS.groupsMax),
  mode: BreakoutMode,
  groupCap: z.number().int().nullable(),
  status: BreakoutStatus,
  createdBy: WsUserId.nullable(),
  createdAt: IsoDate,
  endsAt: IsoDate.nullable(),
  endedAt: IsoDate.nullable(),
  /** grows with every change of the session or its members (0038 breakout_sessions.rev) */
  rev: z.number().int().nonnegative(),
})
export type BreakoutSession = z.infer<typeof BreakoutSession>

/** One person's group. Names are the session's (a guest's display form, "Sam (guest)"), never a request body's. */
export const BreakoutMember = z.object({ userId: WsUserId, name: z.string(), groupId: BreakoutGroupId })
export type BreakoutMember = z.infer<typeof BreakoutMember>

/** GET /api/boards/:bid/breakouts (view), and the answer to every breakout mutation. Not strict. */
export const BreakoutState = z.object({
  /** the running session, else the last one if it ended within BREAKOUT_RECENT_MS (for the summary), else null */
  session: BreakoutSession.nullable(),
  members: z.array(BreakoutMember),
  /** the caller's group in the running session; null when none (or ended) */
  myGroupId: BreakoutGroupId.nullable(),
  /** the caller may assign, shuffle, extend, broadcast, summon and end (the api decides) */
  canManage: z.boolean(),
  serverNow: IsoDate,
})
export type BreakoutState = z.infer<typeof BreakoutState>

/** How long an ended session is still the board's `session` (GET), for the chip's "Breakouts ended" and the summary. */
export const BREAKOUT_RECENT_MS = 12 * 60 * 60 * 1000

/** Whether `next` may replace `current` (never an older state of the same session). */
export function isNewerBreakoutState(
  current: Pick<BreakoutState, 'session'> | null,
  next: Pick<BreakoutState, 'session'> | null,
): boolean {
  if (!next) return false
  if (!current?.session || !next.session || current.session.id !== next.session.id) return true
  return next.session.rev >= current.session.rev
}

/** POST /api/breakouts/:brk/assign (manage): move people (null: out of every group). */
export const AssignBreakoutInput = z.strictObject({
  moves: z
    .array(z.strictObject({ userId: WsUserId, groupId: BreakoutGroupId.nullable() }))
    .min(1)
    .max(BREAKOUT_LIMITS.movesMax)
    .refine((m) => new Set(m.map((x) => x.userId)).size === m.length, { message: 'Each person once.' }),
})
export type AssignBreakoutInput = z.infer<typeof AssignBreakoutInput>

/** POST /api/breakouts/:brk/join (participate; choose mode): the caller's own group. */
export const JoinBreakoutInput = z.strictObject({ groupId: BreakoutGroupId })
export type JoinBreakoutInput = z.infer<typeof JoinBreakoutInput>

/** POST /api/breakouts/:brk/extend (manage). */
export const ExtendBreakoutInput = z.strictObject({
  addMs: z.number().int().min(1000).max(BREAKOUT_LIMITS.extendMaxMs),
})
export type ExtendBreakoutInput = z.infer<typeof ExtendBreakoutInput>

/** POST /api/breakouts/:brk/broadcast (manage): one line to everyone (groupId null) or to one group. Never stored. */
export const BreakoutBroadcastInput = z.strictObject({
  text: BreakoutBroadcastText,
  groupId: BreakoutGroupId.nullable(),
})
export type BreakoutBroadcastInput = z.input<typeof BreakoutBroadcastInput>

/** POST /api/breakouts/:brk/summon (manage): bring one group to the caller (everyone: the existing summon). */
export const BreakoutSummonInput = z.strictObject({
  groupId: BreakoutGroupId,
  screen: SummonScreen.optional(),
})
export type BreakoutSummonInput = z.infer<typeof BreakoutSummonInput>

export const BREAKOUT_ERROR_CODES = {
  /** 409: the board already runs breakouts */
  running: 'BREAKOUTS_RUNNING',
  /** 409: the session has ended */
  ended: 'BREAKOUTS_ENDED',
  /** 409: a live presentation or a spotlight is on (end it first) */
  presenting: 'PRESENTING',
  spotlight: 'SPOTLIGHT',
  /** 409: choose mode, the group is full */
  groupFull: 'BREAKOUT_GROUP_FULL',
  /** 409: join is for choose mode */
  notChoose: 'BREAKOUT_NOT_CHOOSE',
} as const

// ---- events --------------------------------------------------------------------------------------------------------

/** Event names (also in workshops.ts WORKSHOP_EVENTS). An older web has no listener for them. */
export const BREAKOUT_EVENTS = {
  state: 'workshop.breakout',
  broadcast: 'workshop.breakout.broadcast',
  summon: 'workshop.breakout.summon',
} as const

/** `workshop.breakout` (to everyone on the board): the whole state after a change (idempotent; isNewerBreakoutState). */
export const WorkshopBreakoutEvent = z.object({
  session: BreakoutSession.nullable(),
  members: z.array(BreakoutMember),
})
export type WorkshopBreakoutEvent = z.infer<typeof WorkshopBreakoutEvent>

/** `workshop.breakout.broadcast`: to the group's members only (groupId set), or to everyone (null). */
export const WorkshopBreakoutBroadcastEvent = z.object({
  sessionId: BreakoutId,
  text: z.string(),
  from: z.object({ userId: WsUserId, name: z.string() }),
  groupId: BreakoutGroupId.nullable(),
  at: IsoDate,
})
export type WorkshopBreakoutBroadcastEvent = z.infer<typeof WorkshopBreakoutBroadcastEvent>

/** `workshop.breakout.summon`: to the group's members only. The web follows the summoner (followSidOf). */
export const WorkshopBreakoutSummonEvent = z.object({
  sessionId: BreakoutId,
  userId: WsUserId,
  name: z.string(),
  groupId: BreakoutGroupId,
  screen: SummonScreen.optional(),
})
export type WorkshopBreakoutSummonEvent = z.infer<typeof WorkshopBreakoutSummonEvent>

/**
 * Whether this tab obeys a group summon (pure; the web half of "follow never leaks across groups"): only for the
 * caller's own group in the same session, never their own summon. The api already sends it to that group only.
 */
export function breakoutSummonApplies(
  ev: Pick<WorkshopBreakoutSummonEvent, 'sessionId' | 'userId' | 'groupId'>,
  self: { userId: string; sessionId: string | null; groupId: string | null },
): boolean {
  return (
    self.sessionId !== null &&
    self.groupId !== null &&
    ev.sessionId === self.sessionId &&
    ev.groupId === self.groupId &&
    ev.userId !== self.userId
  )
}

// ---- routes (./live.ts LiveRule) -----------------------------------------------------------------------------------

export const BREAKOUT_ROUTES = {
  board: '/api/boards/:bid/breakouts',
  assign: '/api/breakouts/:brk/assign',
  shuffle: '/api/breakouts/:brk/shuffle',
  join: '/api/breakouts/:brk/join',
  extend: '/api/breakouts/:brk/extend',
  broadcast: '/api/breakouts/:brk/broadcast',
  summon: '/api/breakouts/:brk/summon',
  end: '/api/breakouts/:brk/end',
} as const
const B = BREAKOUT_ROUTES
export const BREAKOUT_ROUTE_KEYS = [
  `GET ${B.board}`,
  `POST ${B.board}`,
  `POST ${B.assign}`,
  `POST ${B.shuffle}`,
  `POST ${B.join}`,
  `POST ${B.extend}`,
  `POST ${B.broadcast}`,
  `POST ${B.summon}`,
  `POST ${B.end}`,
] as const
export type BreakoutRouteKey = (typeof BREAKOUT_ROUTE_KEYS)[number]

export const BREAKOUT_RULES: Readonly<
  Record<BreakoutRouteKey, 'view' | 'participate' | 'facilitate' | 'manage'>
> = {
  'GET /api/boards/:bid/breakouts': 'view',
  'POST /api/boards/:bid/breakouts': 'facilitate',
  'POST /api/breakouts/:brk/assign': 'manage',
  'POST /api/breakouts/:brk/shuffle': 'manage',
  'POST /api/breakouts/:brk/join': 'participate',
  'POST /api/breakouts/:brk/extend': 'manage',
  'POST /api/breakouts/:brk/broadcast': 'manage',
  'POST /api/breakouts/:brk/summon': 'manage',
  'POST /api/breakouts/:brk/end': 'manage',
}

/** The routes a name-only guest is refused outright (guests/guard.ts, LIVE_FACILITATE_GUESTS_MESSAGE). */
export const BREAKOUT_FACILITATOR_ROUTE_KEYS: readonly BreakoutRouteKey[] = BREAKOUT_ROUTE_KEYS.filter(
  (k) => BREAKOUT_RULES[k] === 'facilitate' || BREAKOUT_RULES[k] === 'manage',
)

const enc = encodeURIComponent
export const breakoutsPath = (bid: string) => `/api/boards/${enc(bid)}/breakouts`
export const breakoutActionPath = (
  brk: string,
  action: 'assign' | 'shuffle' | 'join' | 'extend' | 'broadcast' | 'summon' | 'end',
) => `/api/breakouts/${enc(brk)}/${action}`
