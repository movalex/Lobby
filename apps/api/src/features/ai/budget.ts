// Hard cost limits for AI (docs/WAVE4-CONTRACTS.md §4 ai-assist). The OpenAI key has no spending cap at
// the provider, so this is the only brake. Every call goes through here, server-side:
//
// 1. InFlight (memory): at most a few calls at once per person, per workspace and in the whole process,
//    so a burst of parallel requests queues nothing and fans nothing out (429 AI_BUSY).
// 2. AiLedger.reserve (Postgres, one transaction under one advisory lock, so concurrent requests are
//    decided one at a time, across api instances too): the person's calls in the last hour, then the
//    tokens charged today (UTC) to the workspace, to the person and to all of Lobby, each checked with
//    this call's WORST case added (its prompt at a token per UTF-8 byte, prompt.ts promptTokensCeiling,
//    plus the output cap); if everything fits, the
//    worst case is written as a 'reserved' row before the model is called. Limits hold across restarts
//    because they are sums over rows, never counters in memory.
// 3. AiLedger.settle: the row gets what OpenAI reported (usage.total_tokens). A call whose cost is
//    unknown keeps its full reservation, a row a crash left 'reserved' keeps it too, and nothing gives
//    budget back (the rows have no foreign keys to cascade from).
// Fail-closed: if the ledger cannot be read or written, the call is refused (503 AI_UNAVAILABLE) and
// the model is never called.

import {
  AI_ERROR_CODES,
  type AiAction,
  type AiBudget,
  CAPTURE_ERROR_CODES,
  type CAPTURE_LEDGER_ACTIONS,
  type WORKSPACE_ASK_LEDGER_ACTION,
} from '@draftroom/contracts'
import type { Db, Queryable } from '@draftroom/db'
import { ApiError } from '../../errors.ts'
import type { AiConfig } from './config.ts'

const HOUR = 3_600_000
/** pg_advisory_xact_lock key of the AI ledger ("DRAI"). */
export const AI_LEDGER_LOCK = 0x44524149
const MAX_CHARGE = 2_000_000_000

export const utcDay = (d: Date) => d.toISOString().slice(0, 10)
export function nextUtcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1))
}

export const unavailable = () =>
  new ApiError(
    503,
    AI_ERROR_CODES.unavailable,
    'Lobby can’t check the AI budget right now, so AI is paused. Try again in a moment.',
  )

function untilMidnight(now: Date): Record<string, string> {
  const s = Math.max(1, Math.ceil((nextUtcMidnight(now).getTime() - now.getTime()) / 1000))
  return { 'retry-after': String(s) }
}

/** Wave N (WS5): the 429 of a capture's per-day cap, the person's or everyone's. */
export function dailyCapReached(
  cap: { user: number; what: string },
  whose: 'user' | 'global',
  now: Date,
): ApiError {
  return new ApiError(
    429,
    CAPTURE_ERROR_CODES.dailyCap,
    whose === 'user'
      ? `You’ve used your ${cap.user} ${cap.what} for today. They reset at midnight UTC.`
      : `Lobby’s ${cap.what} for today are used up. They reset at midnight UTC.`,
    untilMidnight(now),
  )
}

export interface InFlightLimits {
  user: number
  workspace: number
  total: number
}

/** Calls to the model running right now (this process). */
export class InFlight {
  private readonly users = new Map<string, number>()
  private readonly workspaces = new Map<string, number>()
  private total = 0
  private readonly limits: InFlightLimits
  constructor(limits: InFlightLimits) {
    this.limits = limits
  }

  /** A release function, or null when a limit is reached (nothing is counted then). */
  acquire(userId: string, workspaceId: string): (() => void) | null {
    const u = this.users.get(userId) ?? 0
    const w = this.workspaces.get(workspaceId) ?? 0
    if (u >= this.limits.user || w >= this.limits.workspace || this.total >= this.limits.total) return null
    this.users.set(userId, u + 1)
    this.workspaces.set(workspaceId, w + 1)
    this.total++
    let released = false
    return () => {
      if (released) return
      released = true
      const nu = (this.users.get(userId) ?? 1) - 1
      if (nu > 0) this.users.set(userId, nu)
      else this.users.delete(userId)
      const nw = (this.workspaces.get(workspaceId) ?? 1) - 1
      if (nw > 0) this.workspaces.set(workspaceId, nw)
      else this.workspaces.delete(workspaceId)
      this.total--
    }
  }

  get running(): number {
    return this.total
  }
}

/** Wave N (WS5): the ledger actions of Capture the room ('capture-photo', 'capture-transcript'). */
export type CaptureLedgerAction = (typeof CAPTURE_LEDGER_ACTIONS)[keyof typeof CAPTURE_LEDGER_ACTIONS]

export interface ReserveInput {
  workspaceId: string
  boardId: string
  userId: string
  /**
   * A board action, wave M's ask across boards (its board_id is then 'ws:<workspace id>'), or wave N's capture
   * actions (one row per capture, whatever number of model calls it makes).
   */
  action: AiAction | typeof WORKSPACE_ASK_LEDGER_ACTION | CaptureLedgerAction
  /** The worst case: estimated input plus the output cap. */
  tokens: number
  /**
   * Wave N (WS5): per-day caps on this action's rows (UTC day, every status counted, failed calls too): the
   * person's and everyone's (null: none). Checked in the same transaction, under the same lock, as the budgets, so
   * concurrent requests cannot together pass a cap. `what` names the captures in the refusal ("photo captures").
   */
  dailyCap?: { user: number; global: number | null; what: string }
}

/** Today's rows of each capture action (UTC day): the person's, and everyone's. */
export interface CaptureCounts {
  photoUser: number
  photoAll: number
  transcriptUser: number
}

export interface Settlement {
  status: 'done' | 'failed'
  inputTokens: number | null
  outputTokens: number | null
  /** What counts toward the budgets from now on. */
  charged: number
}

type Limits = Pick<
  AiConfig,
  'callsPerUserPerHour' | 'userDailyTokens' | 'workspaceDailyTokens' | 'globalDailyTokens'
>

export class AiLedger {
  private readonly db: Db
  private readonly limits: Limits
  private readonly now: () => Date
  constructor(db: Db, limits: Limits, now: () => Date) {
    this.db = db
    this.limits = limits
    this.now = now
  }

  /** Checks every limit and records the reservation, atomically; throws a 429/503 ApiError otherwise. */
  async reserve(input: ReserveInput): Promise<{ id: string }> {
    const now = this.now()
    const day = utcDay(now)
    const tokens = Math.max(0, Math.min(MAX_CHARGE, Math.ceil(input.tokens)))
    const L = this.limits
    try {
      return await this.db.transaction(async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock($1)', [AI_LEDGER_LOCK])
        const calls = await tx.one<{ n: number; oldest: Date | null }>(
          `SELECT count(*)::int AS n, min(created_at) AS oldest
             FROM ai_usage WHERE user_id = $1 AND created_at > $2`,
          [input.userId, new Date(now.getTime() - HOUR)],
        )
        if (calls.n >= L.callsPerUserPerHour) {
          const wait = calls.oldest ? calls.oldest.getTime() + HOUR - now.getTime() : HOUR
          throw new ApiError(
            429,
            AI_ERROR_CODES.rateLimited,
            `You’ve used AI ${L.callsPerUserPerHour} times in the last hour. Try again a little later.`,
            { 'retry-after': String(Math.max(1, Math.ceil(wait / 1000))) },
          )
        }
        if (input.dailyCap) {
          const cap = input.dailyCap
          const n = await tx.one<{ user_n: number; all_n: number }>(
            `SELECT count(*) FILTER (WHERE user_id = $3)::int AS user_n, count(*)::int AS all_n
               FROM ai_usage WHERE day = $1::date AND action = $2`,
            [day, input.action, input.userId],
          )
          if (n.user_n >= cap.user) throw dailyCapReached(cap, 'user', now)
          if (cap.global !== null && n.all_n >= cap.global) throw dailyCapReached(cap, 'global', now)
        }
        const used = await tx.one<{ user_tokens: number; ws_tokens: number; all_tokens: number }>(
          `SELECT coalesce(sum(charged_tokens) FILTER (WHERE user_id = $2), 0)::float8 AS user_tokens,
                  coalesce(sum(charged_tokens) FILTER (WHERE workspace_id = $3), 0)::float8 AS ws_tokens,
                  coalesce(sum(charged_tokens), 0)::float8 AS all_tokens
             FROM ai_usage WHERE day = $1::date`,
          [day, input.userId, input.workspaceId],
        )
        if (used.ws_tokens + tokens > L.workspaceDailyTokens)
          throw new ApiError(
            429,
            AI_ERROR_CODES.workspaceBudget,
            'AI budget for today is used up. It resets at midnight UTC.',
            untilMidnight(now),
          )
        if (used.user_tokens + tokens > L.userDailyTokens)
          throw new ApiError(
            429,
            AI_ERROR_CODES.userBudget,
            'You’ve used your AI allowance for today. It resets at midnight UTC.',
            untilMidnight(now),
          )
        if (used.all_tokens + tokens > L.globalDailyTokens)
          throw new ApiError(
            429,
            AI_ERROR_CODES.globalBudget,
            'Lobby’s AI budget for today is used up. It resets at midnight UTC.',
            untilMidnight(now),
          )
        const row = await tx.one<{ id: string }>(
          `INSERT INTO ai_usage (workspace_id, board_id, user_id, action, day, status, reserved_tokens,
                                 charged_tokens, created_at)
           VALUES ($1, $2, $3, $4, $5::date, 'reserved', $6, $6, $7)
           RETURNING id::text AS id`,
          [input.workspaceId, input.boardId, input.userId, input.action, day, tokens, now],
        )
        return { id: row.id }
      })
    } catch (e) {
      if (e instanceof ApiError) throw e
      throw unavailable()
    }
  }

  /** Records what the call cost. Only a 'reserved' row changes (a settlement never runs twice). */
  async settle(id: string, s: Settlement): Promise<void> {
    const clamp = (n: number | null) => (n === null ? null : Math.max(0, Math.min(MAX_CHARGE, Math.ceil(n))))
    await this.db.query(
      `UPDATE ai_usage SET status = $2, input_tokens = $3, output_tokens = $4, charged_tokens = $5,
              finished_at = $6
        WHERE id = $1::bigint AND status = 'reserved'`,
      [id, s.status, clamp(s.inputTokens), clamp(s.outputTokens), clamp(s.charged) ?? 0, this.now()],
    )
  }

  /** Wave N (WS5): today's capture rows (UTC day) of this person and of everyone, for the quota in each answer. */
  async captureCounts(userId: string, q: Queryable = this.db): Promise<CaptureCounts> {
    const row = await q.one<{ photo_user: number; photo_all: number; transcript_user: number }>(
      `SELECT count(*) FILTER (WHERE action = 'capture-photo' AND user_id = $2)::int AS photo_user,
              count(*) FILTER (WHERE action = 'capture-photo')::int AS photo_all,
              count(*) FILTER (WHERE action = 'capture-transcript' AND user_id = $2)::int AS transcript_user
         FROM ai_usage WHERE day = $1::date AND action IN ('capture-photo', 'capture-transcript')`,
      [utcDay(this.now()), userId],
    )
    return { photoUser: row.photo_user, photoAll: row.photo_all, transcriptUser: row.transcript_user }
  }

  /**
   * The workspace's budget today, as workspace owners see it. `q` (wave M): the connection to read on, e.g.
   * open-state's transaction; default the pool.
   */
  async view(workspaceId: string, q: Queryable = this.db): Promise<AiBudget> {
    const now = this.now()
    const row = await q.one<{ used: number }>(
      `SELECT coalesce(sum(charged_tokens), 0)::float8 AS used
         FROM ai_usage WHERE day = $1::date AND workspace_id = $2`,
      [utcDay(now), workspaceId],
    )
    return {
      usedPercent: budgetPercent(row.used, this.limits.workspaceDailyTokens),
      resetsAt: nextUtcMidnight(now).toISOString(),
    }
  }
}

/**
 * Whole percent used: 0 only when nothing was used, 100 only when nothing is left, rounded down in
 * between (a first small call reads 1%, not a misleading 0%).
 */
export function budgetPercent(used: number, limit: number): number {
  if (limit <= 0) return 100
  if (used >= limit) return 100
  if (used <= 0) return 0
  return Math.max(1, Math.min(99, Math.floor((used * 100) / limit)))
}
