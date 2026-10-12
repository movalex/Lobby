// OWNER: WS5 (wave N, N5-1, Capture the room). A photo of sticky notes or of a diagram, an image already on the board,
// or a meeting transcript becomes a board (@draftroom/contracts ai.ts "Capture the room"):
//
//   POST /api/boards/:bid/ai/capture/photo?mode=notes|diagram|auto   raw image body → CaptureResponse
//   POST /api/boards/:bid/ai/capture/board-image                     CaptureBoardImageRequest → CaptureResponse
//   POST /api/boards/:bid/ai/capture/transcript                      CaptureTranscriptRequest → CaptureResponse
//
// Registered from registerAi, under the same per-minute limit, in-flight limits, ledger and gate as the board's AI.
// The checks, in order, all before anything of the board is read:
// - a session (401), then name-only guests refused (403 GUEST_ACCOUNT_REQUIRED; the root guest guard says the same
//   later, this route says it before the photo body is read), then the per-minute limit (429);
// - AI off for Lobby (DRAFTROOM_AI=off) or not configured: 404, as if the routes did not exist (the web hides them);
//   the photo routes also need DRAFTROOM_AI_VISION=on (else 404 while the transcript route works);
// - view access to the board (404), then aiGateFor: the board's AI switch (403 AI_BOARD_OFF), the export policy
//   (403 AI_EXPORT_DISABLED) and an edit role on an active board (403): what is captured is added to the board.
// The photo route has a scope of its own (no app.ts change): its body is a raw JPEG, PNG or WebP image, buffered up
// to CAPTURE_PHOTO_MAX_BYTES (413 past it, before a byte more is read) and checked by its magic bytes and header
// (capture-image.ts: 415, or 413 past CAPTURE_PHOTO_MAX_SIDE). The checks above run in its onRequest hook, so a
// refused caller never gets as far as sending the image. A board image is the board's own stored display copy of an
// image element on this board (or one this board holds a history link to); anything else is a 404.
//
// The image goes to chat/completions in that one request body, as a data URL (openai.ts); it is never stored,
// logged or cached, and the bytes are dropped with the request. A transcript is read in at most 4 parts of at most
// the input cap each (map calls, in parallel) and their answers merged by normalised text, then one reduce call
// names the themes over the whole meeting when there was more than one part (capture-plan.ts).
//
// Cost (budget.ts): ONE ledger row per capture, 'capture-photo' or 'capture-transcript', whatever number of calls it
// makes, reserved for the worst case of all of them (each prompt at a token per UTF-8 byte, the image at
// CAPTURE_IMAGE_TOKENS_RESERVE, each call's output cap) before any call, under the same lock as the token budgets,
// and with the per-day caps (DRAFTROOM_AI_VISION_USER_DAILY / _GLOBAL_DAILY, DRAFTROOM_AI_TRANSCRIPT_USER_DAILY:
// 429 AI_CAPTURE_DAILY_CAP) counted from the same rows. The row is settled with what the calls cost, success or not
// (a failed call keeps its row and its charge). Logs hold counts and the run id only: never the image, the
// transcript, the title or the answer.

import {
  AI_ERROR_CODES,
  CAPTURE_BOARD_IMAGE_ROUTE,
  CAPTURE_LEDGER_ACTIONS,
  CAPTURE_PHOTO_MAX_BYTES,
  CAPTURE_PHOTO_MIME_TYPES,
  CAPTURE_PHOTO_ROUTE,
  CAPTURE_TITLE_MAX_CHARS,
  CAPTURE_TRANSCRIPT_MAX_CALLS,
  CAPTURE_TRANSCRIPT_ROUTE,
  CaptureBoardImageRequest,
  type CaptureMode,
  CapturePhotoQuery,
  type CaptureQuota,
  type CaptureResponse,
  type CaptureResult,
  CaptureTranscriptRequest,
} from '@draftroom/contracts'
import { newId } from '@draftroom/db'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { type BoardAccess, requireBoardAction } from '../../access.ts'
import { userKind } from '../../auth/users.ts'
import { liveElements, lobbySnapshotOf, versionOf } from '../../canvas/lobby-elements.ts'
import type { Params } from '../../context.ts'
import { ApiError, badRequest, forbidden, notFound, parse } from '../../errors.ts'
import { isAssetLinked } from '../../files-auth.ts'
import type { KeyedLimit } from '../../rate-limit.ts'
import type { FeatureContext } from '../context.ts'
import { CAPTURE_GUESTS, guestRefused } from '../guests/guard.ts'
import { isPendingRoute, PENDING_ROUTES, type PendingRoute } from '../pending-routes.ts'
import { type AiLedger, dailyCapReached, type InFlight } from './budget.ts'
import {
  badImage,
  type CheckedImage,
  checkCaptureImage,
  imageTooLarge,
  mediaTypeOf,
  TOO_MANY_BYTES,
} from './capture-image.ts'
import {
  type MeetingPart,
  meetingPart,
  mergeMeeting,
  normKey,
  photoResult,
  reduceItems,
  reduceThemes,
  transcriptChunks,
  transcriptResult,
} from './capture-plan.ts'
import { meetingOverhead, meetingPrompt, photoPrompt, themesPrompt } from './capture-prompt.ts'
import { aiConfigured } from './config.ts'
import type { AiLoaders } from './index.ts'
import type { ChatOutcome, OpenAiClient } from './openai.ts'
import { badOutput, chargedFor, NETWORK_OUTCOME, upstreamError } from './outcome.ts'
import { BadOutput } from './plan.ts'
import { promptTokens, promptTokensCeiling } from './prompt.ts'
import { aiOn, loadAiSwitches } from './settings.ts'
import { cleanText } from './sources.ts'

/**
 * What one image may cost in input tokens, reserved for every photo (the ledger then charges what OpenAI reports):
 * above the high-detail cost of every current patch-based model for a 2048 px image, with room to spare.
 */
export const CAPTURE_IMAGE_TOKENS_RESERVE = 10_000
/** Most transcript parts (map calls); the reduce call makes CAPTURE_TRANSCRIPT_MAX_CALLS. */
export const CAPTURE_TRANSCRIPT_MAX_PARTS = CAPTURE_TRANSCRIPT_MAX_CALLS - 1
/** Most notes the reduce call is sent (its prompt is also cut to the input cap). */
const REDUCE_MAX_NOTES = 200

const BOARD_OFF_MESSAGE = 'AI is turned off on this board. Its owner can turn it back on in the board menu.'
const EXPORT_MESSAGE =
  'The board owner turned off copying and exporting for you, so AI is off on this board too.'

export interface CaptureDeps {
  runsPerUser: KeyedLimit
  inFlight: InFlight
  ledger: AiLedger
  /** the text client (transcripts); null without OPENAI_API_KEY */
  client: OpenAiClient | null
  /** the vision client (photos); null without a key or with DRAFTROOM_AI_VISION off */
  visionClient: OpenAiClient | null
  loaders: AiLoaders
  /** the pending-route list (index.ts aiSettings.capturePending); default PENDING_ROUTES */
  pending?: Readonly<Record<string, PendingRoute>>
}

type CaptureKind = 'photo' | 'boardimage' | 'transcript'

interface Caller {
  user: { id: string; name: string }
  access: BoardAccess
}

const newRunId = (): string => newId('air')

/**
 * The board image’s 404, in words of its own: the web tells it from the unknown route’s "Not found." (a capture route
 * that is not there, or vision off), which hides the photo entries.
 */
export const BOARD_IMAGE_MISSING = 'That image isn’t on this board, or Lobby can’t read it.'
const noBoardImage = () => new ApiError(404, 'NOT_FOUND', BOARD_IMAGE_MISSING)

/**
 * An answer cut off at the capture's output cap (DRAFTROOM_AI_CAPTURE_MAX_OUTPUT_TOKENS): what was asked holds more
 * than one answer can carry, so the person is told what to send instead (a retry of the same would end the same).
 */
export const PHOTO_TOO_MUCH = {
  notes: 'There are too many notes in this photo to read at once. Try a closer photo of part of the wall.',
  diagram: 'This diagram is too big to read at once. Try a closer photo of part of it.',
  auto: 'There’s too much in this photo to read at once. Try a closer photo of part of it.',
} as const satisfies Record<CaptureMode, string>
export const TRANSCRIPT_TOO_MUCH =
  'There’s too much in this meeting to read at once. Try a shorter part of the transcript.'

/** A failed capture call in the person's words (outcome.ts upstreamError, but for an answer cut off). */
function callFailure(
  outcome: Extract<ChatOutcome, { ok: false }>,
  what: CaptureMode | 'transcript',
): ApiError {
  if (outcome.kind !== 'truncated') return upstreamError(outcome)
  const message = what === 'transcript' ? TRANSCRIPT_TOO_MUCH : PHOTO_TOO_MUCH[what]
  return new ApiError(502, AI_ERROR_CODES.badOutput, message)
}

export async function registerCapture(
  app: FastifyInstance,
  ctx: FeatureContext,
  deps: CaptureDeps,
): Promise<void> {
  const { db } = ctx
  const cfg = ctx.config.ai
  const cap = cfg.capture
  const { runsPerUser, inFlight, ledger, loaders } = deps
  const pending = deps.pending ?? PENDING_ROUTES
  const live = (method: 'POST', url: string) => !isPendingRoute(`${method} ${url}`, pending)

  /** The checks before anything of the board is read (see the header); returns the signed-in person. */
  async function admit(req: FastifyRequest, opts: { vision: boolean }) {
    const user = await ctx.requireUser(req)
    if ((await userKind(db, user.id)) === 'guest') throw guestRefused(CAPTURE_GUESTS)
    runsPerUser.take(user.id)
    if (!cfg.enabled || !aiConfigured(cfg) || !deps.client) throw notFound()
    if (opts.vision && (!cap.vision || !deps.visionClient)) throw notFound()
    return user
  }

  /** View access, then the gate: AI on for this board and this person, and allowed to add to it. */
  async function boardFor(bid: string, userId: string): Promise<BoardAccess> {
    const access = await requireBoardAction(db, bid, userId, 'view')
    const g = await loaders.aiGateFor(access, userId)
    if (g.reason === 'turned-off' || g.reason === 'not-configured') throw notFound()
    if (g.reason === 'guest') throw guestRefused(CAPTURE_GUESTS)
    if (g.reason === 'board-off') throw new ApiError(403, AI_ERROR_CODES.boardOff, BOARD_OFF_MESSAGE)
    if (g.reason === 'export-policy') throw new ApiError(403, AI_ERROR_CODES.exportDisabled, EXPORT_MESSAGE)
    if (!g.canInsert) throw forbidden('Only editors can add AI results to this board.')
    return access
  }

  /**
   * The day's cap, checked once more before anything heavy (a photo body, a board's snapshot): a person over it is
   * told at once. The reservation checks it again, atomically, and is what decides; a failed read decides nothing.
   */
  async function precheck(kind: 'photo' | 'transcript', userId: string): Promise<void> {
    let n: Awaited<ReturnType<AiLedger['captureCounts']>>
    try {
      n = await ledger.captureCounts(userId)
    } catch {
      return
    }
    const now = ctx.now()
    if (kind === 'photo') {
      const c = { user: cap.visionUserDaily, what: 'photo captures' }
      if (n.photoUser >= cap.visionUserDaily) throw dailyCapReached(c, 'user', now)
      if (n.photoAll >= cap.visionGlobalDaily) throw dailyCapReached(c, 'global', now)
    } else if (n.transcriptUser >= cap.transcriptUserDaily)
      throw dailyCapReached({ user: cap.transcriptUserDaily, what: 'transcript captures' }, 'user', now)
  }

  function acquire(caller: Caller): () => void {
    const release = inFlight.acquire(caller.user.id, caller.access.board.workspace_id)
    if (!release)
      throw new ApiError(
        429,
        AI_ERROR_CODES.busy,
        'Lobby is still working on another AI request. Wait for it to finish.',
        { 'retry-after': '5' },
      )
    return release
  }

  /** The owner may have switched AI off while the request was under way: nothing is sent once it is off. */
  async function stillOn(access: BoardAccess): Promise<void> {
    if (!aiOn(await loadAiSwitches(db, access.board)))
      throw new ApiError(403, AI_ERROR_CODES.boardOff, BOARD_OFF_MESSAGE)
  }

  /** How many captures this person has left today; null where no cap applies (photos with vision off). */
  async function quotaFor(userId: string): Promise<CaptureQuota> {
    try {
      const n = await ledger.captureCounts(userId)
      return {
        photosLeftToday: cap.vision
          ? Math.max(0, Math.min(cap.visionUserDaily - n.photoUser, cap.visionGlobalDaily - n.photoAll))
          : null,
        transcriptsLeftToday: Math.max(0, cap.transcriptUserDaily - n.transcriptUser),
      }
    } catch {
      return { photosLeftToday: null, transcriptsLeftToday: null }
    }
  }

  async function settle(
    reply: FastifyReply,
    reservationId: string,
    s: {
      ok: boolean
      input: number | null
      output: number | null
      charged: number
      kind: CaptureKind
      runId: string
    },
  ) {
    try {
      await ledger.settle(reservationId, {
        status: s.ok ? 'done' : 'failed',
        inputTokens: s.input,
        outputTokens: s.output,
        charged: s.charged,
      })
    } catch {
      // The row keeps its full reservation: the budget stays conservative.
      reply.log.warn({ ai: { action: `capture-${s.kind}`, runId: s.runId } }, 'ai usage settlement failed')
    }
  }

  // ---- photos (and board images) -------------------------------------------------------------------------------

  async function photoCall(
    caller: Caller,
    image: CheckedImage,
    mode: CaptureMode,
    kind: 'photo' | 'boardimage',
    reply: FastifyReply,
  ): Promise<CaptureResponse> {
    const client = deps.visionClient
    if (!client) throw notFound()
    await stillOn(caller.access)
    const prompt = photoPrompt(mode)
    // the capture's own output cap (a wall of notes is a long answer), as the vision client sends it
    const outputCap = Math.min(cap.maxOutputTokens, prompt.maxOutputTokens ?? cap.maxOutputTokens)
    const reserved =
      Math.max(promptTokens(prompt), promptTokensCeiling(prompt)) + CAPTURE_IMAGE_TOKENS_RESERVE + outputCap
    const reservation = await ledger.reserve({
      workspaceId: caller.access.board.workspace_id,
      boardId: caller.access.board.id,
      userId: caller.user.id,
      action: CAPTURE_LEDGER_ACTIONS.photo,
      tokens: reserved,
      dailyCap: { user: cap.visionUserDaily, global: cap.visionGlobalDaily, what: 'photo captures' },
    })
    const runId = newRunId()
    const started = Date.now()
    const outcome: ChatOutcome = await client
      .chat({ ...prompt, image: { mimeType: image.mimeType, bytes: image.bytes } })
      .catch((): ChatOutcome => NETWORK_OUTCOME)
    const charged = chargedFor(outcome, reserved)
    let result: CaptureResult | null = null
    let failure: ApiError = outcome.ok ? badOutput() : callFailure(outcome, mode)
    if (outcome.ok) {
      try {
        result = photoResult(mode, outcome.json)
      } catch (e) {
        if (!(e instanceof BadOutput)) throw e
        failure = badOutput()
      }
    }
    await settle(reply, reservation.id, {
      ok: result !== null,
      input: outcome.usage?.input ?? null,
      output: outcome.usage?.output ?? null,
      charged,
      kind,
      runId,
    })
    reply.log.info(
      {
        ai: {
          action: `capture-${kind}`,
          runId,
          mode,
          bytes: image.bytes.byteLength,
          width: image.width,
          height: image.height,
          result: result?.kind ?? null,
          notes: result?.kind === 'notes' ? result.notes.length : null,
          nodes: result?.kind === 'diagram' ? result.nodes.length : null,
          edges: result?.kind === 'diagram' ? result.edges.length : null,
          reserved,
          inputTokens: outcome.usage?.input ?? null,
          outputTokens: outcome.usage?.output ?? null,
          charged,
          ms: Date.now() - started,
          outcome: result ? 'ok' : outcome.ok ? 'bad-output' : outcome.kind,
          upstreamStatus: outcome.ok ? null : outcome.status,
        },
      },
      'ai capture',
    )
    if (!result) throw failure
    return { runId, result, quota: await quotaFor(caller.user.id) }
  }

  if (live('POST', CAPTURE_PHOTO_ROUTE)) {
    await app.register(async (scope) => {
      // The photo is a raw image body: only the three image types are parsed here (buffered, capped at
      // CAPTURE_PHOTO_MAX_BYTES, which is the only reason buffering is fine), anything else is a 415. This scope
      // holds only this route, so the rest of the api keeps its JSON-only parser and its 256 KiB limit.
      scope.removeAllContentTypeParsers()
      scope.addContentTypeParser(
        [...CAPTURE_PHOTO_MIME_TYPES],
        { parseAs: 'buffer', bodyLimit: CAPTURE_PHOTO_MAX_BYTES },
        (_req, body, done) => done(null, body),
      )
      scope.addContentTypeParser('*', (_req, _payload, done) => done(badImage(), undefined))
      // Past the body limit: the contract's own code (the framework's 413 would say only "too large").
      scope.setErrorHandler((err) => {
        if ((err as { code?: unknown }).code === 'FST_ERR_CTP_BODY_TOO_LARGE')
          throw imageTooLarge(TOO_MANY_BYTES)
        throw err
      })
      // A refusal sent before the body was read must not keep the connection (the client may still be sending
      // up to 4 MiB we are not going to read).
      scope.addHook('onSend', async (req, reply, payload) => {
        if (reply.statusCode >= 400 && !req.raw.complete) reply.header('connection', 'close')
        return payload
      })
      const callers = new WeakMap<FastifyRequest, Caller & { mode: CaptureMode }>()
      scope.route({
        method: 'POST',
        url: CAPTURE_PHOTO_ROUTE,
        // every check that needs no body, before a byte of it is read
        onRequest: async (req) => {
          const user = await admit(req, { vision: true })
          const { mode } = parse(CapturePhotoQuery, req.query ?? {})
          const { bid = '' } = req.params as Params
          const access = await boardFor(bid, user.id)
          await precheck('photo', user.id)
          callers.set(req, { user, access, mode })
        },
        handler: async (req, reply): Promise<CaptureResponse> => {
          const caller = callers.get(req)
          if (!caller) throw notFound() // unreachable: the onRequest hook ran
          const body = req.body
          if (!Buffer.isBuffer(body)) throw badImage('Send the photo as the request body.')
          const image = checkCaptureImage(body, mediaTypeOf(req.headers['content-type']))
          const release = acquire(caller)
          try {
            return await photoCall(caller, image, caller.mode, 'photo', reply)
          } finally {
            release()
          }
        },
      })
    })
  }

  if (live('POST', CAPTURE_BOARD_IMAGE_ROUTE))
    app.post(CAPTURE_BOARD_IMAGE_ROUTE, async (req, reply): Promise<CaptureResponse> => {
      const user = await admit(req, { vision: true })
      const input = parse(CaptureBoardImageRequest, req.body)
      const { bid = '' } = req.params as Params
      const access = await boardFor(bid, user.id)
      await precheck('photo', user.id)
      const caller = { user, access }
      const release = acquire(caller)
      try {
        const image = await boardImage(access, input.elementId)
        return await photoCall(caller, image, input.mode, 'boardimage', reply)
      } finally {
        release()
      }
    })

  /** The board's own stored display copy of image element `elementId` (see the header), checked like a photo. */
  async function boardImage(access: BoardAccess, elementId: string): Promise<CheckedImage> {
    let snapshot: unknown
    try {
      snapshot = await ctx.sync.snapshot(access.board.id)
    } catch {
      throw new ApiError(
        503,
        AI_ERROR_CODES.unavailable,
        'Lobby couldn’t read the board just now. Try again in a moment.',
      )
    }
    const els = liveElements(lobbySnapshotOf(snapshot)?.elements ?? [])
    const el = els.find((e) => e.id === elementId)
    const versionId = el ? versionOf(el) : null
    // an image of the board only: a PDF page or a file card is not a photo
    if (!el || !versionId || typeof el.fileId !== 'string' || el.fileId !== versionId) throw noBoardImage()
    const row = await db.maybeOne<{ asset_id: string; board_id: string; kind: string }>(
      'SELECT v.asset_id, v.board_id, v.kind FROM asset_versions v WHERE v.id = $1',
      [versionId],
    )
    if (row?.kind !== 'image') throw noBoardImage()
    if (
      row.board_id !== access.board.id &&
      !(await isAssetLinked(db, access.board.workspace_id, access.board.id, {
        assetId: row.asset_id,
        versionId,
        ownerBoardId: row.board_id,
      }))
    )
      throw noBoardImage()
    const display = await db.maybeOne<{ blob_key: string; bytes: number }>(
      `SELECT d.blob_key, d.bytes::float8 AS bytes FROM asset_derivatives d
        WHERE d.version_id = $1 AND d.role = 'display' ORDER BY d.position LIMIT 1`,
      [versionId],
    )
    if (!display)
      throw new ApiError(
        404,
        'NOT_FOUND',
        'Lobby has no readable copy of this image yet. Try again once it has loaded on the board.',
      )
    if (display.bytes > CAPTURE_PHOTO_MAX_BYTES) throw imageTooLarge(TOO_MANY_BYTES)
    const bytes = await readBlob(ctx, display.blob_key)
    return checkCaptureImage(bytes)
  }

  // ---- transcripts ---------------------------------------------------------------------------------------------

  if (live('POST', CAPTURE_TRANSCRIPT_ROUTE))
    app.post(CAPTURE_TRANSCRIPT_ROUTE, async (req, reply): Promise<CaptureResponse> => {
      const user = await admit(req, { vision: false })
      const input = parse(CaptureTranscriptRequest, req.body)
      const { bid = '' } = req.params as Params
      const access = await boardFor(bid, user.id)
      await precheck('transcript', user.id)
      const caller = { user, access }
      const release = acquire(caller)
      try {
        return await transcriptCall(caller, input, reply)
      } finally {
        release()
      }
    })

  async function transcriptCall(
    caller: Caller,
    input: CaptureTranscriptRequest,
    reply: FastifyReply,
  ): Promise<CaptureResponse> {
    const client = deps.client
    if (!client) throw notFound()
    const text = input.text.slice(0, cap.transcriptMaxChars)
    const title = cleanText(input.title ?? '', CAPTURE_TITLE_MAX_CHARS, false) || undefined
    const overhead = meetingOverhead(CAPTURE_TRANSCRIPT_MAX_PARTS, title)
    // every part's prompt within the input cap (prompt.ts estimates a token per 3 bytes), with a margin
    const partBytes = (cfg.maxInputTokens - overhead.tokens - 32) * 3
    if (partBytes < 600)
      throw new ApiError(
        503,
        AI_ERROR_CODES.unavailable,
        'Lobby’s AI input cap is too small for a transcript.',
      )
    const { parts, truncated } = transcriptChunks(text, partBytes, CAPTURE_TRANSCRIPT_MAX_PARTS)
    if (!parts.length) throw badRequest('There’s no text in the transcript to send.')
    await stillOn(caller.access)
    const prompts = parts.map((p, i) => meetingPrompt(p, i + 1, parts.length, title))
    // the capture's own output cap, as its transcript client sends it (index.ts)
    const outputCap = cap.maxOutputTokens
    const mapReserve = prompts.map((p) => Math.max(promptTokens(p), promptTokensCeiling(p)) + outputCap)
    // the reduce call's prompt is cut to 3 bytes a token of the input cap (so its estimate is within the cap, as
    // every part's is) and its reservation is that many bytes, a token each: its worst case
    const reduceBytes = cfg.maxInputTokens * 3
    const reduceReserve = parts.length > 1 ? reduceBytes + 256 + outputCap : 0
    const reserved = mapReserve.reduce((a, b) => a + b, 0) + reduceReserve
    const reservation = await ledger.reserve({
      workspaceId: caller.access.board.workspace_id,
      boardId: caller.access.board.id,
      userId: caller.user.id,
      action: CAPTURE_LEDGER_ACTIONS.transcript,
      tokens: reserved,
      dailyCap: { user: cap.transcriptUserDaily, global: null, what: 'transcript captures' },
    })
    const runId = newRunId()
    const started = Date.now()
    const outcomes = await Promise.all(
      prompts.map((p) => client.chat(p).catch((): ChatOutcome => NETWORK_OUTCOME)),
    )
    let charged = outcomes.reduce((sum, o, i) => sum + chargedFor(o, mapReserve[i] ?? 0), 0)
    let input_ = outcomes.reduce<number | null>((s, o) => (o.usage ? (s ?? 0) + o.usage.input : s), null)
    let output_ = outcomes.reduce<number | null>((s, o) => (o.usage ? (s ?? 0) + o.usage.output : s), null)
    let calls = outcomes.length
    let failure: ApiError | null = null
    const key = normKey(text)
    const answers: MeetingPart[] = []
    for (const o of outcomes) {
      if (!o.ok) {
        failure ??= callFailure(o, 'transcript')
        continue
      }
      try {
        answers.push(meetingPart(o.json, key))
      } catch (e) {
        if (!(e instanceof BadOutput)) throw e
        failure ??= badOutput()
      }
    }
    let result: CaptureResult | null = null
    let reduced: 'none' | 'ok' | 'failed' = 'none'
    if (!failure) {
      let merged = mergeMeeting(answers)
      if (parts.length > 1 && merged.themes.length) {
        // one reduce call names the themes over the whole meeting; its prompt is cut to its reservation
        let items = reduceItems(merged, REDUCE_MAX_NOTES)
        let prompt = themesPrompt(items)
        while (items.length > 1 && promptTokensCeiling(prompt) > reduceBytes + 256) {
          items = items.slice(0, Math.max(1, Math.floor(items.length * 0.8)))
          prompt = themesPrompt(items)
        }
        if (promptTokensCeiling(prompt) <= reduceBytes + 256) {
          calls++
          const o = await client.chat(prompt).catch((): ChatOutcome => NETWORK_OUTCOME)
          charged += chargedFor(o, reduceReserve)
          if (o.usage) {
            input_ = (input_ ?? 0) + o.usage.input
            output_ = (output_ ?? 0) + o.usage.output
          }
          reduced = 'failed'
          if (o.ok) {
            try {
              merged = { ...merged, themes: reduceThemes(o.json, merged, items) }
              reduced = 'ok'
            } catch (e) {
              if (!(e instanceof BadOutput)) throw e
              // the parts' own themes stand
            }
          }
        }
      }
      try {
        result = transcriptResult(merged)
      } catch (e) {
        if (!(e instanceof BadOutput)) throw e
        failure = badOutput()
      }
    }
    await settle(reply, reservation.id, {
      ok: result !== null,
      input: input_,
      output: output_,
      charged,
      kind: 'transcript',
      runId,
    })
    reply.log.info(
      {
        ai: {
          action: 'capture-transcript',
          runId,
          chars: text.length,
          parts: parts.length,
          truncated,
          calls,
          reduce: reduced,
          themes: result?.kind === 'transcript' ? result.themes.length : null,
          decisions: result?.kind === 'transcript' ? result.decisions.length : null,
          actions: result?.kind === 'transcript' ? result.actions.length : null,
          reserved,
          inputTokens: input_,
          outputTokens: output_,
          charged,
          ms: Date.now() - started,
          outcome: result ? 'ok' : 'failed',
        },
      },
      'ai capture',
    )
    if (!result) throw failure ?? badOutput()
    return { runId, result, quota: await quotaFor(caller.user.id) }
  }
}

/** A stored blob as bytes, refusing (and dropping the stream) past CAPTURE_PHOTO_MAX_BYTES. */
async function readBlob(ctx: FeatureContext, key: string): Promise<Uint8Array> {
  const obj = await ctx.blobs.get(key)
  if (!obj) throw noBoardImage()
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of obj.body as AsyncIterable<Buffer | string>) {
      const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      size += b.byteLength
      if (size > CAPTURE_PHOTO_MAX_BYTES) throw imageTooLarge(TOO_MANY_BYTES)
      chunks.push(b)
    }
  } finally {
    ;(obj.body as { destroy?: () => void }).destroy?.()
  }
  return Buffer.concat(chunks)
}
