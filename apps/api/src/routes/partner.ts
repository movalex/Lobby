// Partner boards (docs/OPEN-SIGNIN.md): an outside app (the theaitre-bot admin) asks for "the board for
// <its own key>" and gets one board in the shared workspace, created on the first call and the same one
// on every later call. Registered only when the server runs open email sign-in AND has
// DRAFTROOM_PARTNER_TOKEN.
//
// Not a browser route, like the worker protocol (worker/auth.ts): `Authorization: Bearer
// <DRAFTROOM_PARTNER_TOKEN>` compared in constant time, exempt from the Origin check (app.ts), and any
// request carrying a cookie is refused, so a browser session can never reach it.
//
// The board is owned by the shared workspace's built-in owner and is `workspace_edit`: every member
// edits it, and nobody who signs in can trash it or change who sees it.

import { PARTNER_REF_PATTERN, type PartnerBoard, PartnerBoardInput } from '@draftroom/contracts'
import { isUniqueViolation, newBoardId, type Queryable } from '@draftroom/db'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { audit } from '../audit.ts'
import { ensureSharedWorkspace, SHARED_OWNER_ID, SHARED_WORKSPACE_ID } from '../auth/shared-workspace.ts'
import { onNewCanvas } from '../canvas-engine.ts'
import type { AppContext, Params } from '../context.ts'
import { ApiError, badRequest, forbidden, parse } from '../errors.ts'
import { assertBoardRoom } from '../files/usage.ts'
import { bearerToken, carriesCookie, createTokenCheck } from '../worker/auth.ts'

export const PARTNER_PREFIX = '/api/partner/'

export interface PartnerDeps {
  ctx: AppContext
  token: string
  workspaceName: string
  /** Default 600 a minute with the token, 60 without (per address). */
  rateLimit?: { max: number; anonMax: number; timeWindow: number }
}

interface ExistingRow {
  id: string
  title: string
}

export async function partnerPlugin(app: FastifyInstance, deps: PartnerDeps): Promise<void> {
  const { ctx, workspaceName } = deps
  const tokenOk = createTokenCheck(deps.token)
  const valid = (req: FastifyRequest) => tokenOk(bearerToken(req.headers.authorization))
  const limit = deps.rateLimit ?? { max: 600, anonMax: 60, timeWindow: 60_000 }
  if (typeof app.createRateLimit !== 'function')
    throw new Error('partnerPlugin needs @fastify/rate-limit registered before it')
  const limiter = app.createRateLimit({
    timeWindow: limit.timeWindow,
    keyGenerator: (req) => (valid(req) ? 'partner-token' : `partner-anon:${req.ip}`),
    max: (req) => (valid(req) ? limit.max : limit.anonMax),
  })

  app.addHook('onRequest', async (req, reply) => {
    const r = await limiter(req)
    if (!r.isAllowed && r.isExceeded) {
      reply.header('retry-after', String(r.ttlInSeconds))
      throw new ApiError(429, 'RATE_LIMITED', 'Too many requests. Wait a moment and try again.')
    }
    if (carriesCookie(req.headers.cookie)) throw forbidden('Partner routes do not accept browser cookies.')
    if (!valid(req)) {
      reply.header('www-authenticate', 'Bearer')
      throw new ApiError(401, 'NOT_AUTHENTICATED', 'A valid partner token is required.')
    }
  })

  const ensure = (ref: string, title: string, now: Date) =>
    ctx.db.transaction(async (tx): Promise<{ id: string; title: string; created: boolean }> => {
      await ensureSharedWorkspace(tx, workspaceName, now)
      const existing = await findByRef(tx, ref)
      if (existing) {
        if (existing.title !== title)
          await tx.query('UPDATE boards SET title = $2, updated_at = $3 WHERE id = $1', [
            existing.id,
            title,
            now,
          ])
        return { id: existing.id, title, created: false }
      }
      await assertBoardRoom(tx, SHARED_WORKSPACE_ID, ctx.config.storage.maxBoardsPerWorkspace)
      const newCanvas = await onNewCanvas(ctx)
      for (let attempt = 0; attempt < 5; attempt++) {
        const created = await tx.maybeOne<{ id: string }>(
          `INSERT INTO boards (id, workspace_id, project_id, title, visibility, created_by, created_at, updated_at,
                              new_canvas, external_ref)
           VALUES ($1, $2, NULL, $3, 'workspace_edit', $4, $5, $5, $6, $7) ON CONFLICT (id) DO NOTHING RETURNING id`,
          [newBoardId(), SHARED_WORKSPACE_ID, title, SHARED_OWNER_ID, now, newCanvas, ref],
        )
        if (!created) continue // id collision: draw another
        await tx.query(
          "INSERT INTO board_members (board_id, user_id, role, added_by, created_at) VALUES ($1, $2, 'owner', $2, $3)",
          [created.id, SHARED_OWNER_ID, now],
        )
        await audit(tx, {
          workspaceId: SHARED_WORKSPACE_ID,
          actorId: SHARED_OWNER_ID,
          action: 'board.create',
          target: created.id,
          detail: { partnerRef: ref },
          at: now,
        })
        return { id: created.id, title, created: true }
      }
      throw new Error('could not allocate a board id')
    })

  app.put(`${PARTNER_PREFIX}boards/:ref`, async (req, reply): Promise<PartnerBoard> => {
    const { ref = '' } = req.params as Params
    if (!PARTNER_REF_PATTERN.test(ref))
      throw badRequest('The board key must be 1-120 lowercase letters, digits, ":", ".", "_" or "-".')
    const { title } = parse(PartnerBoardInput, req.body)
    let board: Awaited<ReturnType<typeof ensure>>
    try {
      board = await ensure(ref, title, ctx.now())
    } catch (e) {
      // Two first calls for one key raced: the loser's insert hit the unique index; it now finds the winner's.
      if (!isUniqueViolation(e)) throw e
      board = await ensure(ref, title, ctx.now())
    }
    if (board.created) reply.code(201)
    return {
      boardId: board.id,
      ref,
      title: board.title,
      url: `${ctx.config.publicOrigin}/b/${encodeURIComponent(board.id)}`,
      created: board.created,
    }
  })
}

async function findByRef(tx: Queryable, ref: string): Promise<ExistingRow | null> {
  return tx.maybeOne<ExistingRow>(
    'SELECT id, title FROM boards WHERE workspace_id = $1 AND external_ref = $2 FOR UPDATE',
    [SHARED_WORKSPACE_ID, ref],
  )
}
