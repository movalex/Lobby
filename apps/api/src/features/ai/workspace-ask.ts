// OWNER: W8 (wave M, M8-2 / L-AI-8). Ask across boards:
//
//   POST /api/workspaces/:wid/ai/ask  WorkspaceAskRequest → 200 WorkspaceAskResponse (@draftroom/contracts ai.ts)
//
// One question, answered from the canvas text of every board this person may open in the workspace right now,
// with citations that open the cited board at the cited objects. A permission-sensitive read, decided here,
// server-side, in this order:
// 1. a session (401). Name-only guests never get here: the guest guard refuses them before any read
//    (guests/guard.ts GUEST_REFUSED_ROUTES, 403 GUEST_ACCOUNT_REQUIRED);
// 2. the per-minute AI request limit, shared with POST /api/boards/:bid/ai/run (before any board is read);
// 3. the body (400); AI off for all of Lobby (503 AI_TURNED_OFF, as /ai/run); without an OpenAI key the route
//    does not exist (404, like an api without it: the web hides "All boards" for the tab, and the feature does
//    not exist for the web either: AiStatus says 'not-configured');
// 4. the workspace role: a stranger 404 (the workspace stays invisible), a workspace guest 403; owners, admins
//    and members ask;
// 5. the OpenAI notice, per person per workspace, the same acknowledgement as AI on a board (409
//    AI_NOTICE_REQUIRED until `acknowledged: true`, which is stored);
// 6. the in-flight limits shared with /ai/run (429 AI_BUSY).
// Retrieval: search's own permission filter (search/scope.ts searchScope: boards they can view, not trashed nor
// archived), the search index's CANVAS entries only (never comment threads, private-brainstorm drafts, authors
// or "Recently deleted": the index holds none of those), matched as a question (search/query.ts parseQuestion:
// any of its meaningful words) and ranked per board (search/store.ts rankedHits). Every candidate board then goes
// through aiGateFor (./index.ts: the board's AI switch, else the workspace default, and mayExport for this
// person): a board where AI is off for them is left out without a word, whatever it holds. At most
// WORKSPACE_ASK_MAX_BOARDS boards × WORKSPACE_ASK_MAX_ENTRIES_PER_BOARD entries within
// WORKSPACE_ASK_INPUT_CAP_CHARS and the input token cap, as aliases (./workspace-plan.ts). The AI switches are read
// again right before sending (a board switched off meanwhile sends nothing). The call is reserved and settled in
// the AI ledger like any other (action 'workspace-ask', board 'ws:<wid>'), under the same hourly and daily limits.
// The answer: only aliases this call sent map back; the scope is read again at answer time, so a board the person
// lost meanwhile is neither cited nor named, and the titles are the current ones. `exportAllowed` ("Add answer to
// board") is true only when EVERY board whose text was sent still allows this person to copy out of it
// (mayExport) and none is internal only (dashboard/outside.ts boardInternalOnly): the answer may carry any sent
// board's words, cited or not, and the board it would be added to may have people outside.
// Nothing found (no word to look for, no board left, no matching text): `found: 'no'` without any call or charge.
// Wave W (WS3, docs/WAVE-W-CONTRACTS.md §5): while DRAFTROOM_FILE_SEARCH is on, the pages of files the boards show are a
// third source, ranked with the canvas entries (search/store.ts FILE_HITS_CTE: the canvas shows the version and the board
// may serve it, now), at most FILE_TEXT_LIMITS.askShareChars of the input cap, only from boards that passed the gate
// AND mayExport for this person (said again for file text), sent as items `b<n>.f<k>` of type file whose text starts
// with "[Brief.pdf p.3]", and cited by the file hit's id `file:<ver>.p<page>`.
// Logs carry counts only: never the question, board text, titles, ids or the answer.

import {
  AI_ERROR_CODES,
  FILE_TEXT_LIMITS,
  parseFileHitObjectId,
  WORKSPACE_ASK_ELEMENT_ID_PATTERN,
  WORKSPACE_ASK_INPUT_CAP_CHARS,
  WORKSPACE_ASK_LEDGER_ACTION,
  WORKSPACE_ASK_MAX_BOARDS,
  WORKSPACE_ASK_MAX_ENTRIES_PER_BOARD,
  WORKSPACE_ASK_ROUTE,
  type WorkspaceAskCitation,
  WorkspaceAskRequest,
  type WorkspaceAskResponse,
} from '@draftroom/contracts'
import { can, type WorkspaceRole } from '@draftroom/permissions'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { type BoardAccess, loadBoardAccess, requireWorkspaceRole } from '../../access.ts'
import type { Params } from '../../context.ts'
import { ApiError, conflict, forbidden, notFound, parse } from '../../errors.ts'
import type { KeyedLimit } from '../../rate-limit.ts'
import type { FeatureContext } from '../context.ts'
import { boardInternalOnly } from '../dashboard/outside.ts'
import { mayExport } from '../export-control/policy.ts'
import { formatsOn } from '../formats/switch.ts'
import { isPendingRoute } from '../pending-routes.ts'
import { filePageBodies } from '../search/file-text.ts'
import { searchIndexerOf } from '../search/index.ts'
import { parseQuestion } from '../search/query.ts'
import { type ScopedBoard, searchScope } from '../search/scope.ts'
import { entryBodies, type RankedRow, rankedHits } from '../search/store.ts'
import type { AiLedger, InFlight } from './budget.ts'
import { aiConfigured } from './config.ts'
import type { AiLoaders } from './index.ts'
import type { ChatOutcome, OpenAiClient } from './openai.ts'
import { BadOutput } from './plan.ts'
import { promptTokens, promptTokensCeiling } from './prompt.ts'
import { aiOn, loadAiSwitches } from './settings.ts'
import { cleanText } from './sources.ts'
import {
  ASK_TITLE_MAX_CHARS,
  type AskBoard,
  type AskItem,
  buildWorkspacePrompt,
  chooseFileItems,
  chooseItems,
  type RankedBoardEntries,
  type RankedBoardFilePages,
  workspaceAskPlan,
} from './workspace-plan.ts'

/** What registerAi shares with this route: the same limits, ledger, model client and loaders as /ai/run. */
export interface WorkspaceAskDeps {
  runsPerUser: KeyedLimit
  inFlight: InFlight
  ledger: AiLedger
  client: OpenAiClient | null
  loaders: Pick<AiLoaders, 'aiGateFor' | 'noticeAccepted'>
}

/** Boards ranked before the AI gate: some may be left out by it, so a few more than are sent. */
export const WORKSPACE_ASK_CANDIDATE_BOARDS = WORKSPACE_ASK_MAX_BOARDS * 2
/** Wave W (WS3): file pages ranked per board (within FILE_TEXT_LIMITS.askShareChars in all). */
export const ASK_FILE_PAGES_PER_BOARD = 4

const ASKING_ROLES: ReadonlySet<WorkspaceRole> = new Set<WorkspaceRole>(['owner', 'admin', 'member'])
const WORKSPACE_GUEST_MESSAGE =
  'Asking across boards is for members of this workspace. Ask on a board instead, or ask an admin to make you a member.'
const NOTHING = 'None of the boards you can open in this workspace say anything about that.'

/** canvas-schema refs: a search entry's object id is `shape:<element id>`. */
const elementIdOf = (objectId: string): string | null => {
  const id = objectId.startsWith('shape:') ? objectId.slice('shape:'.length) : ''
  return WORKSPACE_ASK_ELEMENT_ID_PATTERN.test(id) ? id : null
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
      return badOutput()
  }
}

export function registerWorkspaceAsk(
  app: FastifyInstance,
  ctx: FeatureContext,
  deps: WorkspaceAskDeps,
): void {
  const { db, now } = ctx
  const cfg = ctx.config.ai

  // Registered unless listed in ../pending-routes.ts again: that would ship it hidden (the root 404, after which the
  // web hides All boards for the tab) without a change here.
  if (!isPendingRoute(`POST ${WORKSPACE_ASK_ROUTE}`))
    app.post(WORKSPACE_ASK_ROUTE, async (req, reply): Promise<WorkspaceAskResponse> => {
      const user = await ctx.requireUser(req)
      deps.runsPerUser.take(user.id)
      const input = parse(WorkspaceAskRequest, req.body)
      const { wid = '' } = req.params as Params
      if (!cfg.enabled)
        throw new ApiError(503, AI_ERROR_CODES.turnedOff, 'AI is turned off for Lobby right now.')
      const client = deps.client
      if (!aiConfigured(cfg) || !client) throw notFound()
      const workspaceRole = await requireWorkspaceRole(db, wid, user.id)
      if (!ASKING_ROLES.has(workspaceRole)) throw forbidden(WORKSPACE_GUEST_MESSAGE)

      if (input.acknowledged === true) {
        await db.query(
          `INSERT INTO ai_notice_acceptances (workspace_id, user_id, accepted_at) VALUES ($1, $2, $3)
         ON CONFLICT (workspace_id, user_id) DO NOTHING`,
          [wid, user.id, now()],
        )
      } else if (!(await deps.loaders.noticeAccepted(wid, user.id))) {
        throw conflict(
          AI_ERROR_CODES.noticeRequired,
          'Asking across boards sends the text of your boards to OpenAI. Confirm that before the first use.',
        )
      }

      const release = deps.inFlight.acquire(user.id, wid)
      if (!release)
        throw new ApiError(
          429,
          AI_ERROR_CODES.busy,
          'Lobby is still working on another AI request. Wait for it to finish.',
          { 'retry-after': '5' },
        )
      try {
        return await ask(client, { workspaceId: wid, userId: user.id, workspaceRole }, input.question, reply)
      } finally {
        release()
      }
    })

  interface Asker {
    workspaceId: string
    userId: string
    workspaceRole: WorkspaceRole
  }

  const scopeOf = (a: Asker) => searchScope(db, { ...a, status: 'active', projectId: null })
  // wave W (WS3): file pages are a source only while DRAFTROOM_FILE_SEARCH is on (read once at boot)
  const fileSearch = formatsOn(ctx, 'fileSearch')

  /** The boards to ask, best first: ranked within the scope, each through the per-board AI gate. */
  async function gather(
    a: Asker,
    question: string,
  ): Promise<{
    boards: AskBoard[]
    accesses: Map<string, BoardAccess>
    items: AskItem[]
    truncated: boolean
  }> {
    const none = { boards: [], accesses: new Map(), items: [], truncated: false }
    const query = parseQuestion(question)
    if (!query.simple) return none
    const scope = await scopeOf(a)
    if (!scope.length) return none
    // The index refreshes what is stale in this scope first, within its own bounds (as a search does).
    await searchIndexerOf(app)?.refreshForSearch(scope)
    const byId = new Map<string, ScopedBoard>(scope.map((b) => [b.id, b]))
    const ranked = await rankedHits(db, {
      workspaceId: a.workspaceId,
      boardIds: [...byId.keys()],
      query,
      boards: WORKSPACE_ASK_CANDIDATE_BOARDS,
      perBoard: WORKSPACE_ASK_MAX_ENTRIES_PER_BOARD,
      team: false, // canvas entries only: the comment rule never applies
      source: 'canvas',
      // wave W (WS3): and pages of the files the boards show, while file search runs (store.ts FILE_HITS_CTE)
      ...(fileSearch ? { files: { maxPerBoard: ASK_FILE_PAGES_PER_BOARD } } : {}),
    })
    const order: string[] = []
    const hitsOf = new Map<string, typeof ranked>()
    for (const r of ranked) {
      if (!byId.has(r.board_id) || (r.source !== 'canvas' && r.source !== 'file')) continue // by construction never
      if (!hitsOf.has(r.board_id)) {
        order.push(r.board_id)
        hitsOf.set(r.board_id, [])
      }
      hitsOf.get(r.board_id)?.push(r)
    }
    // The per-board AI gate, in rank order, until enough boards pass (the others are never read further).
    const boards: AskBoard[] = []
    const accesses = new Map<string, BoardAccess>()
    for (const boardId of order) {
      if (boards.length >= WORKSPACE_ASK_MAX_BOARDS) break
      const access = await loadBoardAccess(db, boardId, a.userId)
      if (!access || access.board.workspace_id !== a.workspaceId) continue
      if (!can(access.role, 'view', access.board.status)) continue
      if (!(await deps.loaders.aiGateFor(access, a.userId)).allowed) continue
      accesses.set(boardId, access)
      boards.push({
        alias: `b${boards.length + 1}`,
        boardId,
        title: cleanText(access.board.title, ASK_TITLE_MAX_CHARS, false) || 'Untitled board',
      })
    }
    if (!boards.length) return none
    const canvasHits = (boardId: string) => (hitsOf.get(boardId) ?? []).filter((h) => h.source === 'canvas')
    const keys = boards.flatMap((b) =>
      canvasHits(b.boardId).map((h) => ({
        boardId: b.boardId,
        source: 'canvas' as const,
        objectId: h.object_id,
      })),
    )
    const bodies = await entryBodies(db, a.workspaceId, keys)
    let k = 0
    const perBoard: RankedBoardEntries[] = boards.map((b) => {
      const entries: RankedBoardEntries['entries'][number][] = []
      for (const h of canvasHits(b.boardId)) {
        const body = bodies.get(k++)
        const elementId = elementIdOf(h.object_id)
        if (body === undefined || elementId === null) continue
        entries.push({ elementId, kind: h.kind, body })
      }
      return { board: b, entries }
    })
    // wave W (WS3): file pages, a capped share of the input (FILE_TEXT_LIMITS.askShareChars), only of boards whose
    // owner lets this person copy out of them (mayExport: aiGateFor checks it too; said again here for file text)
    const files = fileSearch ? await filePagesOf(a, boards, accesses, hitsOf) : []
    const fileChoice = chooseFileItems(files, FILE_TEXT_LIMITS.askShareChars)
    const canvasChoice = chooseItems(perBoard, WORKSPACE_ASK_INPUT_CAP_CHARS - fileChoice.used)
    return {
      boards,
      accesses,
      items: [...canvasChoice.items, ...fileChoice.items],
      truncated: canvasChoice.truncated || fileChoice.truncated,
    }
  }

  /** Wave W: the ranked file pages of the gated boards (those whose exports are on for the asker), with their text. */
  async function filePagesOf(
    a: Asker,
    boards: readonly AskBoard[],
    accesses: ReadonlyMap<string, BoardAccess>,
    hitsOf: ReadonlyMap<string, RankedRow[]>,
  ): Promise<RankedBoardFilePages[]> {
    const allowed: AskBoard[] = []
    for (const b of boards) {
      const access = accesses.get(b.boardId)
      if (access && (await mayExport(db, access, a.userId))) allowed.push(b)
    }
    const keys: { boardId: string; versionId: string; page: number }[] = []
    const of = new Map<string, { at: number; versionId: string; page: number }[]>()
    for (const b of allowed) {
      const list: { at: number; versionId: string; page: number }[] = []
      for (const h of hitsOf.get(b.boardId) ?? []) {
        const ref = h.source === 'file' ? parseFileHitObjectId(h.object_id) : null
        if (!ref) continue
        list.push({ at: keys.push({ boardId: b.boardId, ...ref }) - 1, ...ref })
      }
      of.set(b.boardId, list)
    }
    const texts = await filePageBodies(db, a.workspaceId, keys)
    return allowed.map((board) => ({
      board,
      pages: (of.get(board.boardId) ?? []).flatMap((p) => {
        const t = texts.get(p.at)
        return t ? [{ versionId: p.versionId, page: p.page, name: t.name, body: t.body }] : []
      }),
    }))
  }

  const nothing = (): WorkspaceAskResponse => ({
    answer: NOTHING,
    found: 'no',
    citations: [],
    exportAllowed: false,
  })

  async function ask(
    client: OpenAiClient,
    a: Asker,
    question: string,
    reply: FastifyReply,
  ): Promise<WorkspaceAskResponse> {
    const gathered = await gather(a, question)
    let items = gathered.items
    let truncated = gathered.truncated
    // The input cap is a hard one: items go from the end (the last taken, the least relevant) until it fits.
    let prompt = buildWorkspacePrompt(question, gathered.boards, items)
    while (promptTokens(prompt) > cfg.maxInputTokens && items.length > 0) {
      items = items.slice(0, -1)
      truncated = true
      prompt = buildWorkspacePrompt(question, gathered.boards, items)
    }
    // A board switched off while the boards were read sends nothing (the gate ran before that).
    const sentBoards = [...new Set(items.map((i) => i.boardId))]
    const stillOn = new Set<string>()
    for (const boardId of sentBoards) {
      const access = gathered.accesses.get(boardId)
      if (access && aiOn(await loadAiSwitches(db, access.board))) stillOn.add(boardId)
    }
    if (stillOn.size < sentBoards.length) {
      items = items.filter((i) => stillOn.has(i.boardId))
      prompt = buildWorkspacePrompt(question, gathered.boards, items)
    }
    if (!items.length) {
      reply.log.info(
        { ai: { action: WORKSPACE_ASK_LEDGER_ACTION, boards: 0, items: 0, outcome: 'nothing' } },
        'ai call',
      )
      return nothing()
    }

    const outputCap = Math.min(cfg.maxOutputTokens, prompt.maxOutputTokens ?? cfg.maxOutputTokens)
    const reserved = Math.max(promptTokens(prompt), promptTokensCeiling(prompt)) + outputCap
    const reservation = await deps.ledger.reserve({
      workspaceId: a.workspaceId,
      boardId: `ws:${a.workspaceId}`,
      userId: a.userId,
      action: WORKSPACE_ASK_LEDGER_ACTION,
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
    let result: WorkspaceAskResponse | null = null
    // what the route answers when there is no result: an unusable answer, the model's failure, or (wave N.1) any
    // error reading the scope again after the call, which is thrown only once the call is settled below
    let failure: unknown = outcome.ok ? badOutput() : upstreamError(outcome)
    let afterCall: 'bad-output' | 'error' = 'bad-output'
    if (outcome.ok) {
      try {
        result = await answerOf(a, outcome.json, items)
      } catch (e) {
        if (e instanceof BadOutput) failure = badOutput()
        else {
          failure = e
          afterCall = 'error'
        }
      }
    }
    try {
      await deps.ledger.settle(reservation.id, {
        status: result ? 'done' : 'failed',
        inputTokens: outcome.usage?.input ?? null,
        outputTokens: outcome.usage?.output ?? null,
        charged,
      })
    } catch {
      // The row keeps its full reservation: the budget stays conservative.
      reply.log.warn({ ai: { action: WORKSPACE_ASK_LEDGER_ACTION } }, 'ai usage settlement failed')
    }
    reply.log.info(
      {
        ai: {
          action: WORKSPACE_ASK_LEDGER_ACTION,
          boards: new Set(items.map((i) => i.boardId)).size,
          items: items.length,
          truncated,
          reserved,
          inputTokens: outcome.usage?.input ?? null,
          outputTokens: outcome.usage?.output ?? null,
          charged,
          ms: Date.now() - started,
          citations: result?.citations.length ?? 0,
          outcome: result ? 'ok' : outcome.ok ? afterCall : outcome.kind,
          upstreamStatus: outcome.ok ? null : outcome.status,
        },
      },
      'ai call',
    )
    if (!result) throw failure
    return result
  }

  /**
   * The answer under the scope as it is NOW: a board the person can no longer open is neither cited nor named,
   * titles are read now, and "Add answer to board" needs every sent board to still allow copying out of it.
   */
  async function answerOf(a: Asker, json: unknown, sent: readonly AskItem[]): Promise<WorkspaceAskResponse> {
    const scope = new Map((await scopeOf(a)).map((b) => [b.id, b]))
    const citable = sent.filter((i) => scope.has(i.boardId))
    const plan = workspaceAskPlan(json, citable)
    const citations: WorkspaceAskCitation[] = plan.citations.map((c) => ({
      boardId: c.boardId,
      boardTitle: scope.get(c.boardId)?.title ?? 'Untitled board',
      elementIds: c.elementIds,
    }))
    let exportAllowed = sent.length > 0
    for (const boardId of new Set(sent.map((i) => i.boardId))) {
      if (!exportAllowed) break
      const access = scope.has(boardId) ? await loadBoardAccess(db, boardId, a.userId) : null
      exportAllowed =
        !!access &&
        can(access.role, 'view', access.board.status) &&
        (await mayExport(db, access, a.userId)) &&
        (await boardInternalOnly(db, boardId)) === null
    }
    const answer = plan.answer || (plan.found === 'no' ? NOTHING : '')
    return { answer, found: plan.found, citations, exportAllowed }
  }
}
