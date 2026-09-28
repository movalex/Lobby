// Feature module: ai (docs/WAVE4-CONTRACTS.md §4 ai-assist): AI on the board through OpenAI, with hard
// cost limits.
//
//   GET  /api/boards/:bid/ai       → AiStatus: whether this person may use AI here, and how
//   POST /api/boards/:bid/ai/run   AiRunInput → AiResult: a plan the client applies as canvas edits
//   PUT  /api/boards/:bid/ai/settings, PUT /api/workspaces/:wid/ai/settings: AI on/off (settings.ts)
//
// Decisions (all server-side; the web only follows AiStatus):
// - 404 for anyone who cannot view the board (nothing leaks); 401 without a session.
// - Name-only guests never trigger AI (it costs money): 403 GUEST_ACCOUNT_REQUIRED, after the board
//   checks. Viewers and commenters may only "Summarize" into a panel (view); everything that adds to the
//   board needs edit on an active board (403 otherwise). On a board whose export policy is 'editors',
//   the people it limits get no AI (it reads the content out): 403 AI_EXPORT_DISABLED.
// - On a board where AI is off (its owner's choice, else the workspace default: settings.ts) nobody gets
//   AI: 403 AI_BOARD_OFF, before anything is read or sent, and again right before sending (a call
//   under way when the owner switches AI off sends nothing).
// - The first call per person per workspace needs the "Sends the selected text to OpenAI" notice
//   acknowledged (409 AI_NOTICE_REQUIRED until the client sends `acknowledged: true`, which is stored).
// - The prompt is built from the board's sync snapshot for the requested shape ids (sources.ts), never
//   from client-sent text; comments, private-brainstorm drafts and files are never read.
// - Cost limits (budget.ts): requests per person per minute (before any board is read), in-flight
//   calls, calls per person per hour, tokens per person, per workspace and globally per UTC day, a hard
//   input cap and a worst-case reservation before every call; DRAFTROOM_AI=off
//   refuses everything (503) without calling anyone. Without OPENAI_API_KEY the feature does not exist
//   for the web (AiStatus says 'not-configured').
// - The answer is untrusted (plan.ts): validated, clamped, ids mapped back from this call's aliases.
// - Logs hold counts only: never prompts, answers, board text or the key. No board events are published:
//   the client applies the plan as ordinary canvas edits, which sync like any other edit.

import {
  AI_ERROR_CODES,
  type AiBudget,
  type AiOffReason,
  type AiResult,
  AiRunInput,
  type AiSettings,
  type AiStatus,
} from '@draftroom/contracts'
import { can } from '@draftroom/permissions'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { type BoardAccess, requireBoardAction } from '../../access.ts'
import { userKind } from '../../auth/users.ts'
import type { Params } from '../../context.ts'
import { ApiError, conflict, forbidden, parse } from '../../errors.ts'
import { keyedLimit } from '../../rate-limit.ts'
import type { RoomSnapshotJson } from '../../sync-internal.ts'
import type { FeatureContext } from '../context.ts'
import { mayExport } from '../export-control/policy.ts'
import { guestRefused } from '../guests/guard.ts'
import { checkpointBeforeChange } from '../history/before-change.ts'
import { AiLedger, InFlight, type InFlightLimits } from './budget.ts'
import { aiConfigured } from './config.ts'
import { type ChatOutcome, createOpenAiClient, type OpenAiClient } from './openai.ts'
import { actionsPlan, BadOutput, ideasPlan, summaryPlan, themesPlan } from './plan.ts'
import { buildPrompt, overheadTokens, promptTokens, promptTokensCeiling } from './prompt.ts'
import { aiOn, loadAiSwitches, registerAiSettings, settingsFor } from './settings.ts'
import { collectSources } from './sources.ts'

export const AI_STATUS_ROUTE = '/api/boards/:bid/ai'
export const AI_RUN_ROUTE = '/api/boards/:bid/ai/run'

/** Process-level knobs tests may lower before building an app (like search's searchSettings). */
export const aiSettings: { inFlight: InFlightLimits; fetchImpl: typeof fetch | undefined } = {
  // Each call holds a whole board snapshot in memory while it runs: a few at a time keeps a 512 MB api
  // safe on the biggest boards, and an internal tool never needs more.
  inFlight: { user: 2, workspace: 3, total: 4 },
  fetchImpl: undefined,
}

/**
 * Requests per person, whatever they turn out to be (refused ones included), before any board is read:
 * the ledger's hourly limit counts calls, this keeps a script from making the api read boards for
 * nothing.
 */
export const AI_REQUESTS_PER_MINUTE = { max: 30, timeWindow: 60_000 }
export const AI_STATUS_PER_MINUTE = { max: 120, timeWindow: 60_000 }

const GUEST_MESSAGE = 'AI is for people with a Lobby account. Sign in with an account to use it.'
const BOARD_OFF_MESSAGE = 'AI is turned off on this board. Its owner can turn it back on in the board menu.'
const EXPORT_MESSAGE =
  'The board owner turned off copying and exporting for you, so AI is off on this board too.'

/** An answer before the per-call fields (truncated, budget) are added. */
type AiPlan = AiResult extends infer R ? (R extends unknown ? Omit<R, 'truncated' | 'budget'> : never) : never

interface Gate {
  reason: AiOffReason | null
  canInsert: boolean
  canSummarize: boolean
  /** Null when AI is not configured or off for all of Lobby, and for name-only guests. */
  settings: AiSettings | null
}

export async function registerAi(app: FastifyInstance, ctx: FeatureContext): Promise<void> {
  const { db, now } = ctx
  const cfg = ctx.config.ai
  const ledger = new AiLedger(db, cfg, now)
  const inFlight = new InFlight({ ...aiSettings.inFlight })
  const runsPerUser = keyedLimit(
    AI_REQUESTS_PER_MINUTE,
    now,
    'Too many AI requests. Wait a moment and try again.',
  )
  const statusPerUser = keyedLimit(AI_STATUS_PER_MINUTE, now)
  registerAiSettings(app, ctx)
  const client: OpenAiClient | null = cfg.apiKey
    ? createOpenAiClient({
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        timeoutMs: cfg.timeoutMs,
        maxOutputTokens: cfg.maxOutputTokens,
        reasoningEffort: cfg.reasoningEffort,
        fetchImpl: aiSettings.fetchImpl,
      })
    : null

  /** What this person may do with AI on this board (`access` already passed `view`). */
  async function gate(access: BoardAccess, userId: string): Promise<Gate> {
    let reason: AiOffReason | null = null
    let settings: AiSettings | null = null
    if (!cfg.enabled) reason = 'turned-off'
    else if (!aiConfigured(cfg)) reason = 'not-configured'
    else if ((await userKind(db, userId)) === 'guest') reason = 'guest'
    else {
      const switches = await loadAiSwitches(db, access.board)
      settings = settingsFor(access, switches)
      if (!aiOn(switches)) reason = 'board-off'
      else if (!(await mayExport(db, access, userId))) reason = 'export-policy'
    }
    return {
      reason,
      settings,
      canSummarize: reason === null,
      canInsert: reason === null && can(access.role, 'edit', access.board.status),
    }
  }

  async function noticeAccepted(workspaceId: string, userId: string): Promise<boolean> {
    const row = await db.maybeOne(
      'SELECT 1 AS ok FROM ai_notice_acceptances WHERE workspace_id = $1 AND user_id = $2',
      [workspaceId, userId],
    )
    return row !== null
  }

  /** Workspace owners see the day's budget; everyone else gets null (and so does a ledger failure). */
  async function budgetFor(access: BoardAccess): Promise<AiBudget | null> {
    if (access.workspaceRole !== 'owner') return null
    try {
      return await ledger.view(access.board.workspace_id)
    } catch {
      return null
    }
  }

  app.get(AI_STATUS_ROUTE, async (req): Promise<AiStatus> => {
    const user = await ctx.requireUser(req)
    statusPerUser.take(user.id)
    const { bid = '' } = req.params as Params
    const access = await requireBoardAction(db, bid, user.id, 'view')
    const g = await gate(access, user.id)
    if (g.reason !== null)
      return {
        enabled: false,
        reason: g.reason,
        canInsert: false,
        canSummarize: false,
        noticeAccepted: false,
        budget: null,
        settings: g.settings,
      }
    return {
      enabled: true,
      reason: null,
      canInsert: g.canInsert,
      canSummarize: g.canSummarize,
      noticeAccepted: await noticeAccepted(access.board.workspace_id, user.id),
      budget: await budgetFor(access),
      settings: g.settings,
    }
  })

  app.post(AI_RUN_ROUTE, async (req, reply): Promise<AiResult> => {
    const user = await ctx.requireUser(req)
    runsPerUser.take(user.id)
    const input = parse(AiRunInput, req.body)
    const { bid = '' } = req.params as Params
    const access = await requireBoardAction(db, bid, user.id, 'view')
    const g = await gate(access, user.id)
    if (g.reason === 'turned-off')
      throw new ApiError(503, AI_ERROR_CODES.turnedOff, 'AI is turned off for Lobby right now.')
    if (g.reason === 'not-configured' || !client)
      throw new ApiError(503, AI_ERROR_CODES.notConfigured, 'AI isn’t set up for Lobby.')
    if (g.reason === 'guest') throw guestRefused(GUEST_MESSAGE)
    if (g.reason === 'board-off') throw new ApiError(403, AI_ERROR_CODES.boardOff, BOARD_OFF_MESSAGE)
    if (g.reason === 'export-policy') throw new ApiError(403, AI_ERROR_CODES.exportDisabled, EXPORT_MESSAGE)
    const inserts = input.action !== 'summarize' || input.mode === 'insert'
    if (inserts && !g.canInsert) throw forbidden('Only editors can add AI results to this board.')

    const workspaceId = access.board.workspace_id
    if (input.acknowledged === true) {
      await db.query(
        `INSERT INTO ai_notice_acceptances (workspace_id, user_id, accepted_at) VALUES ($1, $2, $3)
         ON CONFLICT (workspace_id, user_id) DO NOTHING`,
        [workspaceId, user.id, now()],
      )
    } else if (!(await noticeAccepted(workspaceId, user.id))) {
      throw conflict(
        AI_ERROR_CODES.noticeRequired,
        'AI sends the selected text to OpenAI. Confirm that before the first use.',
      )
    }

    const release = inFlight.acquire(user.id, workspaceId)
    if (!release)
      throw new ApiError(
        429,
        AI_ERROR_CODES.busy,
        'Lobby is still working on another AI request. Wait for it to finish.',
        { 'retry-after': '5' },
      )
    try {
      return await run(client, input, access, user.id, reply)
    } finally {
      release()
    }
  })

  async function run(
    client: OpenAiClient,
    input: AiRunInput,
    access: BoardAccess,
    userId: string,
    reply: FastifyReply,
  ): Promise<AiResult> {
    let snapshot: RoomSnapshotJson
    try {
      snapshot = await ctx.sync.snapshot(access.board.id)
    } catch {
      throw new ApiError(
        503,
        AI_ERROR_CODES.unavailable,
        'Lobby couldn’t read the board just now. Try again in a moment.',
      )
    }
    let sources = collectSources(snapshot, input.shapeIds, {
      action: input.action,
      tokenBudget: Math.max(0, cfg.maxInputTokens - overheadTokens(input)),
    })
    // The input cap is a hard one: should the whole prompt still come out over it, items go from the
    // end (their aliases stay as they are) until it fits.
    let prompt = buildPrompt(input, sources)
    while (promptTokens(prompt) > cfg.maxInputTokens && sources.items.length > 0) {
      sources = { ...sources, items: sources.items.slice(0, -1), truncated: true }
      prompt = buildPrompt(input, sources)
    }
    if (input.action === 'themes' && sources.items.length < 2)
      throw new ApiError(
        400,
        AI_ERROR_CODES.nothingToGroup,
        'Select at least two unlocked sticky notes with text, or a frame that holds them.',
      )
    if (input.action !== 'ideas' && sources.items.length === 0)
      throw new ApiError(400, AI_ERROR_CODES.nothingToSend, 'There’s no text in the selection to send.')

    // The owner may have switched AI off while the board was being read (the gate ran before that):
    // read the switch again, so nothing is sent once it is off.
    if (!aiOn(await loadAiSwitches(db, access.board)))
      throw new ApiError(403, AI_ERROR_CODES.boardOff, BOARD_OFF_MESSAGE)

    // The input cap is checked against the estimate; the budgets reserve the worst case, which a board
    // full of token-dense text really reaches (prompt.ts), so a call never costs more than it reserved
    // and concurrent calls cannot together overrun a budget.
    const reserved = Math.max(promptTokens(prompt), promptTokensCeiling(prompt)) + cfg.maxOutputTokens
    const reservation = await ledger.reserve({
      workspaceId: access.board.workspace_id,
      boardId: access.board.id,
      userId,
      action: input.action,
      tokens: reserved,
    })
    const started = Date.now()
    // Never throws: every failure is an outcome, so the settlement below always runs.
    const outcome: ChatOutcome = await client
      .chat(prompt)
      .catch(
        (): ChatOutcome => ({ ok: false, kind: 'network', status: null, usage: null, billing: 'unknown' }),
      )
    const charged =
      outcome.billing === 'usage' && outcome.usage
        ? outcome.usage.total
        : outcome.billing === 'none'
          ? 0
          : reserved
    let plan: AiPlan | null = null
    let failure: ApiError = outcome.ok ? badOutput() : upstreamError(outcome)
    if (outcome.ok) {
      try {
        plan = toPlan(input, outcome.json, sources.items)
      } catch (e) {
        if (!(e instanceof BadOutput)) throw e
        failure = badOutput()
      }
    }
    try {
      await ledger.settle(reservation.id, {
        status: plan ? 'done' : 'failed',
        inputTokens: outcome.usage?.input ?? null,
        outputTokens: outcome.usage?.output ?? null,
        charged,
      })
    } catch {
      // The row keeps its full reservation: the budget stays conservative.
      reply.log.warn({ ai: { action: input.action } }, 'ai usage settlement failed')
    }
    reply.log.info(
      {
        ai: {
          action: input.action,
          items: sources.items.length,
          truncated: sources.truncated,
          reserved,
          inputTokens: outcome.usage?.input ?? null,
          outputTokens: outcome.usage?.output ?? null,
          charged,
          ms: Date.now() - started,
          outcome: plan ? 'ok' : outcome.ok ? 'bad-output' : outcome.kind,
          upstreamStatus: outcome.ok ? null : outcome.status,
        },
      },
      'ai call',
    )
    if (!plan) throw failure
    // R10; R2-09: the checkpoint's name says how many notes, and in which frame when there is one.
    if (plan.action === 'themes')
      await checkpointBeforeChange(app, access.board.id, 'before_ai_themes', {
        notes: sources.items.filter((i) => i.kind === 'note').length,
        frame: sources.frames.length === 1 ? sources.frames[0] : undefined,
      })
    return { ...plan, truncated: sources.truncated, budget: await budgetFor(access) } as AiResult
  }
}

function toPlan(input: AiRunInput, json: unknown, sent: Parameters<typeof themesPlan>[1]): AiPlan {
  switch (input.action) {
    case 'summarize':
      return { action: 'summarize', ...summaryPlan(json), sources: sent.length }
    case 'themes':
      return { action: 'themes', ...themesPlan(json, sent) }
    case 'actions':
      return { action: 'actions', ...actionsPlan(json) }
    case 'ideas':
      return { action: 'ideas', ...ideasPlan(json, input.count) }
  }
}

const badOutput = () =>
  new ApiError(502, AI_ERROR_CODES.badOutput, 'The AI’s answer couldn’t be used. Try again.')

function upstreamError(outcome: Extract<ChatOutcome, { ok: false }>): ApiError {
  switch (outcome.kind) {
    case 'timeout':
      return new ApiError(504, AI_ERROR_CODES.upstream, 'OpenAI took too long to answer. Try again.')
    case 'network':
      return new ApiError(502, AI_ERROR_CODES.upstream, 'Lobby couldn’t reach OpenAI. Try again in a moment.')
    case 'http':
      if (outcome.status === 429)
        return new ApiError(502, AI_ERROR_CODES.upstream, 'OpenAI is busy right now. Try again in a minute.')
      if (outcome.status === 401 || outcome.status === 403)
        return new ApiError(
          502,
          AI_ERROR_CODES.upstream,
          'OpenAI refused Lobby’s key. Ask whoever runs Lobby to check the AI settings.',
        )
      return new ApiError(502, AI_ERROR_CODES.upstream, 'OpenAI couldn’t answer just now. Try again.')
    case 'refused':
      return new ApiError(422, AI_ERROR_CODES.refused, 'The AI declined to answer this one.')
    default:
      return new ApiError(502, AI_ERROR_CODES.badOutput, 'The AI’s answer couldn’t be used. Try again.')
  }
}
