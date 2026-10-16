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
//   checks. Viewers and commenters may only read answers into a private panel (view): "Summarize" and
//   "Recap" to a panel, "Ask this board", and a command in 'find' mode. Everything that adds to or
//   changes the board needs edit on an active board (403 otherwise). On a board whose export policy is
//   'editors', the people it limits get no AI (it reads the content out): 403 AI_EXPORT_DISABLED.
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
// - Logs hold counts and the run id only: never prompts, questions, answers, board text or the key.
//
// Wave L (W1):
// - Six more actions (recap, ask, command, diagram, sort, score) and the vote-weighted 'actions'
//   (voteSessionId: 404 for another board's vote, 409 AI_VOTE_NOT_REVEALED before its reveal). All of them
//   go through this one route and the same gate, notice, in-flight limits and ledger (no new route).
// - Every run gets a run id (`air_` + 20 base62), returned as AiResult.runId and never stored.
// - Live awareness (live.ts): `ai.working` once the gate passed and the ledger reserved the call, `ai.done`
//   after it settled, success or failure; neither for a refused call. The client still applies the plan
//   as ordinary canvas edits, which sync like any other edit.
// - Sort and score move notes, so like "Group into themes" they save a before_ai_themes checkpoint first.

import {
  AI_ACTIONS,
  AI_ERROR_CODES,
  AI_RECAP_MAX_WINDOW_MS,
  type AiAction,
  type AiBudget,
  type AiOffReason,
  type AiResult,
  AiRunInput,
  type AiSettings,
  type AiStatus,
  type AiTopVoted,
} from '@draftroom/contracts'
import { newId, type Queryable } from '@draftroom/db'
import { can } from '@draftroom/permissions'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { type BoardAccess, requireBoardAction } from '../../access.ts'
import { userKind } from '../../auth/users.ts'
import type { Params } from '../../context.ts'
import { ApiError, badRequest, conflict, forbidden, parse } from '../../errors.ts'
import { keyedLimit } from '../../rate-limit.ts'
import type { BoardSnapshotJson } from '../../sync-internal.ts'
import type { FeatureContext } from '../context.ts'
import { mayExport } from '../export-control/policy.ts'
import { guestRefused } from '../guests/guard.ts'
import { ticketName } from '../guests/label.ts'
import { checkpointBeforeChange } from '../history/before-change.ts'
import { PENDING_ROUTES, type PendingRoute } from '../pending-routes.ts'
import { AiLedger, InFlight, type InFlightLimits } from './budget.ts'
import { registerCapture } from './capture.ts'
import { aiConfigured } from './config.ts'
import { clampRect, publishDone, publishWorking } from './live.ts'
import { type ChatOutcome, createOpenAiClient, type OpenAiClient } from './openai.ts'
import { badOutput, upstreamError } from './outcome.ts'
import {
  actionsPlan,
  askPlan,
  BadOutput,
  commandPlan,
  diagramPlan,
  ideasPlan,
  recapPlan,
  scorePlan,
  sortPlan,
  summaryPlan,
  themesPlan,
  votedActionsPlan,
} from './plan.ts'
import { buildPrompt, overheadTokens, type Prompt, promptTokens, promptTokensCeiling } from './prompt.ts'
import { aiOn, loadAiSwitches, registerAiSettings, settingsFor } from './settings.ts'
import {
  allShapeIds,
  collectIndex,
  collectRecapSources,
  collectSources,
  type ItemExtra,
  type ShapeMap,
  type SourceItem,
  type Sources,
  scopeOf,
  shapesOf,
  themeLabelOf,
} from './sources.ts'
import { fitScript, storyboardOverheadTokens, storyboardPlan, storyboardPrompt } from './storyboard.ts'
import { revealedTallies, topVotedOf, votedSessionTallies } from './tallies.ts'
import { registerWorkspaceAsk } from './workspace-ask.ts'

export const AI_STATUS_ROUTE = '/api/boards/:bid/ai'
export const AI_RUN_ROUTE = '/api/boards/:bid/ai/run'

/** Process-level knobs tests may lower before building an app (like search's searchSettings). */
export const aiSettings: {
  inFlight: InFlightLimits
  fetchImpl: typeof fetch | undefined
  /**
   * Wave N (WS5): the pending-route list Capture the room's routes are registered against (default the api's own,
   * ../pending-routes.ts PENDING_ROUTES). Only the capture tests pass another (none pending), so they can run
   * while the routes are still held pending there.
   */
  capturePending: Readonly<Record<string, PendingRoute>>
} = {
  // Each call holds a whole board snapshot in memory while it runs: a few at a time keeps a 512 MB api
  // safe on the biggest boards, and an internal tool never needs more.
  inFlight: { user: 2, workspace: 3, total: 4 },
  fetchImpl: undefined,
  capturePending: PENDING_ROUTES,
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

/** An answer before the per-call fields (truncated, budget, runId) are added. */
type AiPlan = AiResult extends infer R
  ? R extends unknown
    ? Omit<R, 'truncated' | 'budget' | 'runId'>
    : never
  : never

/**
 * The actions this api runs: every one the contracts name, wave T's `storyboard` included since WS2 landed its
 * handler (./storyboard.ts; docs/WAVE-T-CONTRACTS.md §4). An action held here would get the 400 BAD_REQUEST an
 * unknown action gets, with nothing read, reserved or sent (the pattern a later wave's pending action follows).
 */
export const PENDING_AI_ACTIONS: ReadonlySet<string> = new Set<AiAction>()
export const LIVE_AI_ACTIONS: ReadonlySet<string> = new Set<AiAction>(
  AI_ACTIONS.filter((a) => !PENDING_AI_ACTIONS.has(a)),
)
/** A run input of an action this api runs (see LIVE_AI_ACTIONS). */
export type LiveAiRunInput = AiRunInput
const isLive = (input: AiRunInput): input is LiveAiRunInput => LIVE_AI_ACTIONS.has(input.action)

/** A run id (contracts AiRunId: `air_` and 20 base62 characters), one per run, never stored. */
export const newAiRunId = (): string => newId('air')

/**
 * Whether a run changes the board (edit on an active board) rather than only answering into a private
 * panel (view): Summarize and Recap to a panel, Ask, and a 'find' command only answer.
 */
export function aiRunNeedsEdit(input: AiRunInput): boolean {
  switch (input.action) {
    case 'summarize':
    case 'recap':
      return input.mode === 'insert'
    case 'ask':
      return false
    case 'command':
      return input.mode === 'do'
    default:
      return true
  }
}

/** Actions that move notes: a before_ai_themes checkpoint is saved before their plan returns. */
const MOVES_NOTES: ReadonlySet<AiAction> = new Set<AiAction>(['themes', 'sort', 'score'])

/**
 * What this person may do with AI on one board (wave M, M8-1: exported, the same rules for every reader).
 * `allowed`: AI is on for them here at all (`reason` null): configured and on for Lobby, not a name-only guest,
 * the board's AI switch (else the workspace default) on, and mayExport for this person.
 */
export interface AiGate {
  allowed: boolean
  reason: AiOffReason | null
  canInsert: boolean
  canSummarize: boolean
  /** Null when AI is not configured or off for all of Lobby, and for name-only guests. */
  settings: AiSettings | null
}

/**
 * The per-board AI gate and the AI status as loaders (wave M, M8-1; owner W8): GET /api/boards/:bid/ai answers
 * loadAiStatus, POST …/ai/run checks aiGateFor, W5's open-state builds its `ai` part with loadAiStatus and W8's
 * Ask across boards drops every board aiGateFor refuses. `access` must already have passed 'view'. `q`: the queries'
 * connection (a transaction's, for open-state's one READ ONLY transaction); default the api's pool.
 */
export interface AiLoaders {
  aiGateFor(access: BoardAccess, userId: string, q?: Queryable): Promise<AiGate>
  loadAiStatus(access: BoardAccess, userId: string, q?: Queryable): Promise<AiStatus>
  /** Whether the person acknowledged the OpenAI notice in this workspace. */
  noticeAccepted(workspaceId: string, userId: string, q?: Queryable): Promise<boolean>
  /**
   * Workspace owners see the day's budget; everyone else gets null, and so does a ledger failure. On a transaction's
   * connection (any `q` other than the pool) the read runs in its own SAVEPOINT, so a failed read leaves the
   * transaction usable (on Postgres a failed statement otherwise aborts it: 25P02 for every later read).
   */
  budgetFor(access: BoardAccess, q?: Queryable): Promise<AiBudget | null>
}

/** budgetFor's savepoint on a caller's transaction (a fixed name: it is released before budgetFor returns). */
const BUDGET_SAVEPOINT = 'dr_ai_budget'

export function createAiLoaders(ctx: Pick<FeatureContext, 'db' | 'config' | 'now'>): AiLoaders {
  const { db, now } = ctx
  const cfg = ctx.config.ai
  const ledger = new AiLedger(db, cfg, now)

  async function aiGateFor(access: BoardAccess, userId: string, q: Queryable = db): Promise<AiGate> {
    let reason: AiOffReason | null = null
    let settings: AiSettings | null = null
    if (!cfg.enabled) reason = 'turned-off'
    else if (!aiConfigured(cfg)) reason = 'not-configured'
    else if ((await userKind(q, userId)) === 'guest') reason = 'guest'
    else {
      const switches = await loadAiSwitches(q, access.board)
      settings = settingsFor(access, switches)
      if (!aiOn(switches)) reason = 'board-off'
      else if (!(await mayExport(q, access, userId))) reason = 'export-policy'
    }
    return {
      allowed: reason === null,
      reason,
      settings,
      canSummarize: reason === null,
      canInsert: reason === null && can(access.role, 'edit', access.board.status),
    }
  }

  async function noticeAccepted(workspaceId: string, userId: string, q: Queryable = db): Promise<boolean> {
    const row = await q.maybeOne(
      'SELECT 1 AS ok FROM ai_notice_acceptances WHERE workspace_id = $1 AND user_id = $2',
      [workspaceId, userId],
    )
    return row !== null
  }

  async function budgetFor(access: BoardAccess, q: Queryable = db): Promise<AiBudget | null> {
    if (access.workspaceRole !== 'owner') return null
    if (q === db) {
      try {
        return await ledger.view(access.board.workspace_id, q)
      } catch {
        return null
      }
    }
    // A transaction's connection: undo only the failed read (the caller's other reads go on in the transaction).
    await q.query(`SAVEPOINT ${BUDGET_SAVEPOINT}`)
    try {
      const budget = await ledger.view(access.board.workspace_id, q)
      await q.query(`RELEASE SAVEPOINT ${BUDGET_SAVEPOINT}`)
      return budget
    } catch {
      await q.query(`ROLLBACK TO SAVEPOINT ${BUDGET_SAVEPOINT}`)
      await q.query(`RELEASE SAVEPOINT ${BUDGET_SAVEPOINT}`)
      return null
    }
  }

  async function loadAiStatus(access: BoardAccess, userId: string, q: Queryable = db): Promise<AiStatus> {
    const g = await aiGateFor(access, userId, q)
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
      noticeAccepted: await noticeAccepted(access.board.workspace_id, userId, q),
      budget: await budgetFor(access, q),
      settings: g.settings,
    }
  }

  return { aiGateFor, loadAiStatus, noticeAccepted, budgetFor }
}

/** What the plan of a run is made from besides the answer: what was sent, and what the server knows. */
interface PlanContext {
  sent: readonly SourceItem[]
  /** L1-7: the named vote's tallies; null for 'actions' without a vote. */
  voted: ReadonlyMap<string, number> | null
  /** L1-2: the recap window's start as applied, and the server's top voted list. */
  windowFrom: number | null
  topVoted: AiTopVoted[]
}

export async function registerAi(app: FastifyInstance, ctx: FeatureContext): Promise<void> {
  const { db, now, events } = ctx
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

  // M8-1: the gate and the status are the shared loaders (createAiLoaders above), unchanged in behaviour
  const loaders = createAiLoaders(ctx)
  const { aiGateFor: gate, loadAiStatus, noticeAccepted, budgetFor } = loaders
  // wave M (M8-2): Ask across boards (./workspace-ask.ts), under the same per-minute and in-flight limits, ledger,
  // model client and per-board gate as the board's AI
  registerWorkspaceAsk(app, ctx, { runsPerUser, inFlight, ledger, client, loaders })
  // wave N (WS5): Capture the room (./capture.ts), under the same per-minute and in-flight limits, ledger and gate.
  // Its calls go through clients of their own, with the capture's output cap (DRAFTROOM_AI_CAPTURE_MAX_OUTPUT_TOKENS:
  // a wall of notes is a long answer; the board's own cap stays as it is): photos with DRAFTROOM_AI_VISION_MODEL
  // (else OPENAI_MODEL) and the vision timeout, transcripts with OPENAI_MODEL and the longer of the two timeouts.
  const capture = cfg.capture
  const visionClient: OpenAiClient | null =
    cfg.apiKey && capture.vision
      ? createOpenAiClient({
          apiKey: cfg.apiKey,
          baseUrl: cfg.baseUrl,
          model: capture.visionModel ?? cfg.model,
          timeoutMs: capture.visionTimeoutMs,
          maxOutputTokens: capture.maxOutputTokens,
          reasoningEffort: cfg.reasoningEffort,
          fetchImpl: aiSettings.fetchImpl,
        })
      : null
  const transcriptClient: OpenAiClient | null = cfg.apiKey
    ? createOpenAiClient({
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        timeoutMs: Math.max(cfg.timeoutMs, capture.visionTimeoutMs),
        maxOutputTokens: capture.maxOutputTokens,
        reasoningEffort: cfg.reasoningEffort,
        fetchImpl: aiSettings.fetchImpl,
      })
    : null
  await registerCapture(app, ctx, {
    runsPerUser,
    inFlight,
    ledger,
    client: transcriptClient,
    visionClient,
    loaders,
    pending: aiSettings.capturePending,
  })

  app.get(AI_STATUS_ROUTE, async (req): Promise<AiStatus> => {
    const user = await ctx.requireUser(req)
    statusPerUser.take(user.id)
    const { bid = '' } = req.params as Params
    const access = await requireBoardAction(db, bid, user.id, 'view')
    return loadAiStatus(access, user.id)
  })

  app.post(AI_RUN_ROUTE, async (req, reply): Promise<AiResult> => {
    const user = await ctx.requireUser(req)
    runsPerUser.take(user.id)
    const parsed = parse(AiRunInput, req.body)
    if (!isLive(parsed)) throw badRequest('action: this AI action is not available on this server yet')
    const input = parsed
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
    if (aiRunNeedsEdit(input) && !g.canInsert)
      throw forbidden('Only editors can add AI results to this board.')
    // L1-7: the vote must be this board's and revealed, before anything is read or sent.
    const voted =
      input.action === 'actions' && input.voteSessionId !== undefined
        ? await votedSessionTallies(db, access.board.id, input.voteSessionId)
        : null

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
      return await run(client, input, access, user, reply, voted)
    } finally {
      release()
    }
  })

  /** What a run sends: the items its action reads, with the vote facts the server knows. */
  async function gather(
    input: LiveAiRunInput,
    shapes: ShapeMap,
    boardId: string,
    voted: ReadonlyMap<string, number> | null,
  ): Promise<{ sources: Sources; windowFrom: number | null; topVoted: AiTopVoted[] }> {
    const tokenBudget =
      input.action === 'storyboard' ? 0 : Math.max(0, cfg.maxInputTokens - overheadTokens(input))
    const wholeBoard = (ids: readonly string[]) => (ids.length ? ids : allShapeIds(shapes))
    switch (input.action) {
      case 'storyboard':
        // wave T: the pasted script is the whole input; nothing of the board is read
        return { sources: { items: [], frames: [], truncated: false }, windowFrom: null, topVoted: [] }
      case 'recap': {
        const nowMs = now().getTime()
        const floor = nowMs - AI_RECAP_MAX_WINDOW_MS
        // At most 14 days back, and never after now: a `since` in the future (up to the contract's
        // unbounded int, past what a Date can hold) is a window from now, which finds nothing to send.
        const windowFrom =
          input.scope.kind === 'since' ? Math.min(Math.max(input.scope.since, floor), nowMs) : null
        const tallies = await revealedTallies(db, boardId, windowFrom ?? floor)
        const extraOf = (s: { id: string }): ItemExtra | undefined => {
          const votes = tallies.get(s.id)
          return votes ? { votes } : undefined
        }
        if (input.scope.kind === 'since')
          return {
            sources: collectRecapSources(shapes, { since: windowFrom ?? floor, tokenBudget, extraOf }),
            windowFrom,
            topVoted: topVotedOf(tallies, (id) => shapes.has(id)),
          }
        // A recap of named shapes: the votes revealed in the last 14 days, on what those shapes hold only.
        const scope = scopeOf(shapes, input.scope.shapeIds)
        return {
          sources: collectSources(shapes, input.scope.shapeIds, { action: 'recap', tokenBudget, extraOf }),
          windowFrom,
          topVoted: topVotedOf(tallies, (id) => scope.has(id)),
        }
      }
      case 'ask':
        return {
          sources: collectSources(shapes, wholeBoard(input.shapeIds), {
            action: 'ask',
            tokenBudget,
            query: input.question,
          }),
          windowFrom: null,
          topVoted: [],
        }
      case 'command':
        return {
          sources: collectIndex(shapes, wholeBoard(input.shapeIds), {
            tokenBudget,
            query: input.instruction,
          }),
          windowFrom: null,
          topVoted: [],
        }
      case 'actions':
        if (voted)
          return {
            // Only the voted objects, each with its votes and the theme it was grouped under.
            sources: collectSources(shapes, input.shapeIds, {
              action: 'actions',
              tokenBudget,
              only: (s) => (voted.get(s.id) ?? 0) > 0,
              extraOf: (s) => {
                const theme = themeLabelOf(shapes, s)
                return { votes: voted.get(s.id) ?? 0, ...(theme ? { theme } : {}) }
              },
            }),
            windowFrom: null,
            topVoted: [],
          }
        return {
          sources: collectSources(shapes, input.shapeIds, { action: 'actions', tokenBudget }),
          windowFrom: null,
          topVoted: [],
        }
      default:
        return {
          sources: collectSources(shapes, input.shapeIds, { action: input.action, tokenBudget }),
          windowFrom: null,
          topVoted: [],
        }
    }
  }

  async function run(
    client: OpenAiClient,
    input: LiveAiRunInput,
    access: BoardAccess,
    user: { id: string; name: string },
    reply: FastifyReply,
    voted: ReadonlyMap<string, number> | null,
  ): Promise<AiResult> {
    const userId = user.id
    // wave T: a storyboard breakdown reads nothing of the board (its script is the input), so no snapshot
    let shapes: ShapeMap = new Map()
    if (input.action !== 'storyboard') {
      let snapshot: BoardSnapshotJson
      try {
        snapshot = await ctx.sync.snapshot(access.board.id)
      } catch {
        throw new ApiError(
          503,
          AI_ERROR_CODES.unavailable,
          'Lobby couldn’t read the board just now. Try again in a moment.',
        )
      }
      shapes = shapesOf(snapshot)
    }
    const gathered = await gather(input, shapes, access.board.id, voted)
    let sources = gathered.sources
    let prompt: Prompt
    if (input.action === 'storyboard') {
      // the script is cut to what the input cap leaves (at a line break), and `truncated` says so
      const fit = fitScript(input.script, cfg.maxInputTokens - storyboardOverheadTokens(input))
      if (!fit.script) throw badRequest('script: nothing of the script fits the AI input limit')
      sources = { ...sources, truncated: fit.truncated }
      prompt = storyboardPrompt(input, fit.script)
    } else {
      // The input cap is a hard one: should the whole prompt still come out over it, items go from the
      // end (their aliases stay as they are) until it fits.
      prompt = buildPrompt(input, sources)
      while (promptTokens(prompt) > cfg.maxInputTokens && sources.items.length > 0) {
        sources = { ...sources, items: sources.items.slice(0, -1), truncated: true }
        prompt = buildPrompt(input, sources)
      }
      refuseEmpty(input, sources)
    }

    // The owner may have switched AI off while the board was being read (the gate ran before that):
    // read the switch again, so nothing is sent once it is off.
    if (!aiOn(await loadAiSwitches(db, access.board)))
      throw new ApiError(403, AI_ERROR_CODES.boardOff, BOARD_OFF_MESSAGE)

    // The input cap is checked against the estimate; the budgets reserve the worst case, which a board
    // full of token-dense text really reaches (prompt.ts), so a call never costs more than it reserved
    // and concurrent calls cannot together overrun a budget.
    const outputCap = Math.min(cfg.maxOutputTokens, prompt.maxOutputTokens ?? cfg.maxOutputTokens)
    const reserved = Math.max(promptTokens(prompt), promptTokensCeiling(prompt)) + outputCap
    const reservation = await ledger.reserve({
      workspaceId: access.board.workspace_id,
      boardId: access.board.id,
      userId,
      action: input.action,
      tokens: reserved,
    })
    // Reserved: the call happens. Everyone on the board may now see that it is under way (live.ts).
    const runId = newAiRunId()
    // ai.done goes out only after an ai.working was put on the hub (a failed name read publishes neither).
    let announced = false
    try {
      const name = await ticketName(db, user)
      announced = true
      publishWorking(events, access.board.id, {
        runId,
        name,
        action: input.action,
        rect: clampRect(input.at),
      })
    } catch {
      // Awareness is a hint: it never stops the call.
    }
    try {
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
          plan = toPlan(input, outcome.json, {
            sent: sources.items,
            voted,
            windowFrom: gathered.windowFrom,
            topVoted: gathered.topVoted,
          })
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
        reply.log.warn({ ai: { action: input.action, runId } }, 'ai usage settlement failed')
      }
      reply.log.info(
        {
          ai: {
            action: input.action,
            runId,
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
      // Sort and score (L1-6) move notes as themes does, under the same reason.
      if (MOVES_NOTES.has(plan.action))
        await checkpointBeforeChange(app, access.board.id, 'before_ai_themes', {
          notes: sources.items.filter((i) => i.kind === 'note').length,
          frame: sources.frames.length === 1 ? sources.frames[0] : undefined,
        })
      return {
        ...plan,
        truncated: sources.truncated,
        budget: await budgetFor(access),
        runId,
      } as AiResult
    } finally {
      try {
        if (announced) publishDone(events, access.board.id, runId)
      } catch {
        // a hint only
      }
    }
  }
}

/** A run with nothing (or too little) to work from is refused before anything is reserved or sent. */
function refuseEmpty(input: LiveAiRunInput, sources: Sources): void {
  const n = sources.items.length
  if ((input.action === 'themes' || input.action === 'sort') && n < 2)
    throw new ApiError(
      400,
      AI_ERROR_CODES.nothingToGroup,
      'Select at least two unlocked sticky notes with text, or a frame that holds them.',
    )
  if (input.action === 'score' && n < 1)
    throw new ApiError(
      400,
      AI_ERROR_CODES.nothingToGroup,
      'Select at least one unlocked sticky note with text, or a frame that holds them.',
    )
  if (n > 0 || input.action === 'ideas' || (input.action === 'diagram' && input.prompt !== undefined)) return
  if (input.action === 'recap' && input.scope.kind === 'since')
    throw new ApiError(
      400,
      AI_ERROR_CODES.nothingToSend,
      'Nothing with text was added or changed in that time.',
    )
  if (input.action === 'actions' && input.voteSessionId !== undefined)
    throw new ApiError(400, AI_ERROR_CODES.nothingToSend, 'None of the objects in the selection got a vote.')
  throw new ApiError(400, AI_ERROR_CODES.nothingToSend, 'There’s no text in the selection to send.')
}

function toPlan(input: LiveAiRunInput, json: unknown, c: PlanContext): AiPlan {
  switch (input.action) {
    case 'summarize':
      return { action: 'summarize', ...summaryPlan(json), sources: c.sent.length }
    case 'themes':
      return { action: 'themes', ...themesPlan(json, c.sent) }
    case 'actions':
      return c.voted
        ? { action: 'actions', ...votedActionsPlan(json, c.sent, c.voted) }
        : { action: 'actions', ...actionsPlan(json) }
    case 'ideas':
      return { action: 'ideas', ...ideasPlan(json, input.count) }
    case 'recap':
      return {
        action: 'recap',
        ...recapPlan(json, c.sent),
        topVoted: c.topVoted,
        windowFrom: c.windowFrom,
      }
    case 'ask':
      return { action: 'ask', ...askPlan(json, c.sent) }
    case 'command':
      return { action: 'command', ...commandPlan(json, c.sent, input.mode) }
    case 'diagram':
      return { action: 'diagram', ...diagramPlan(json, input.direction) }
    case 'sort':
      return { action: 'sort', lens: input.lens, ...sortPlan(json, c.sent) }
    case 'score':
      return { action: 'score', axes: input.axes, ...scorePlan(json, c.sent) }
    case 'storyboard':
      return { action: 'storyboard', ...storyboardPlan(json, input.maxPanels) }
  }
}
