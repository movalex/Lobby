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

import { AI_ERROR_CODES, type AiAction, type AiBudget } from '@draftroom/contracts'
import type { Db } from '@draftroom/db'
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

export interface ReserveInput {
  workspaceId: string
  boardId: string
  userId: string
  action: AiAction
  /** The worst case: estimated input plus the output cap. */
  tokens: number
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

  /** The workspace's budget today, as workspace owners see it. */
  async view(workspaceId: string): Promise<AiBudget> {
    const now = this.now()
    const row = await this.db.one<{ used: number }>(
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
