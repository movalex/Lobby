// Starred boards (DSH-01): per-user stars, a starred list per workspace, and a `starred` flag on
// M1's board list (GET /api/workspaces/:wid/boards) added by a serialization hook.

import { type BoardWithStar, ListBoardsQuery } from '@draftroom/contracts'
import { type BoardRole, can, resolveBoardRole } from '@draftroom/permissions'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { BOARD_COLUMNS, type BoardRow, requireBoardAction, requireWorkspaceRole } from '../../access.ts'
import { showsR0Marks } from '../../canvas-engine.ts'
import type { Params } from '../../context.ts'
import { parse } from '../../errors.ts'
import { toBoardWithRole } from '../../serialize.ts'
import type { FeatureContext } from '../context.ts'

const MAX_STARRED = 500
const LIST_ROUTE = '/api/workspaces/:wid/boards'

export function registerStarRoutes(app: FastifyInstance, ctx: FeatureContext): void {
  const { db, now } = ctx

  app.put('/api/boards/:bid/star', async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const access = await requireBoardAction(db, bid, user.id, 'view')
    await db.query(
      `INSERT INTO board_stars (user_id, board_id, workspace_id, created_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, board_id) DO NOTHING`,
      [user.id, access.board.id, access.board.workspace_id, now()],
    )
    return { boardId: access.board.id, starred: true }
  })

  app.delete('/api/boards/:bid/star', async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const access = await requireBoardAction(db, bid, user.id, 'view')
    await db.query('DELETE FROM board_stars WHERE user_id = $1 AND board_id = $2', [user.id, access.board.id])
    return { boardId: access.board.id, starred: false }
  })

  // Starred boards the caller can still open, most recently starred first. Stars on boards they lost
  // access to stay in the table but are never listed (and reveal nothing).
  app.get('/api/workspaces/:wid/boards/starred', async (req) => {
    const user = await ctx.requireUser(req)
    const { wid = '' } = req.params as Params
    const query = parse(ListBoardsQuery.pick({ status: true }), req.query)
    const status = query.status ?? 'active'
    const workspaceRole = await requireWorkspaceRole(db, wid, user.id)
    const rows = await db.query<BoardRow & { board_grant: BoardRole | null }>(
      `SELECT ${BOARD_COLUMNS}, bm.role AS board_grant
         FROM board_stars s
         JOIN boards b ON b.id = s.board_id AND b.workspace_id = s.workspace_id
         LEFT JOIN board_members bm ON bm.board_id = b.id AND bm.user_id = $2
        WHERE s.user_id = $2 AND s.workspace_id = $1 AND b.status = $3
        ORDER BY s.created_at DESC, b.id
        LIMIT ${MAX_STARRED}`,
      [wid, user.id, status],
    )
    const boards: BoardWithStar[] = []
    const marks = { newCanvas: await showsR0Marks(ctx) } // R0's badge only on a sync known to be tldraw
    for (const { board_grant, ...board } of rows.rows) {
      const role = resolveBoardRole({ workspaceRole, boardGrant: board_grant, visibility: board.visibility })
      const listed = status === 'trashed' ? can(role, 'restore', status) : can(role, 'view', status)
      if (role && listed) boards.push({ ...toBoardWithRole(board, role, marks), starred: true })
    }
    return { boards }
  })

  // Adds `starred` to M1's list response. Root-level hooks bind to every route at ready time, so this
  // reaches the M1 route without editing it; anything unexpected leaves the payload untouched.
  app.addHook('preSerialization', async (req: FastifyRequest, reply, payload) => {
    if (req.method !== 'GET' || req.routeOptions.url !== LIST_ROUTE || reply.statusCode !== 200)
      return payload
    const boards = (payload as { boards?: unknown } | null)?.boards
    if (!Array.isArray(boards)) return payload
    try {
      const user = await ctx.sessions.user(req)
      if (!user) return payload
      const ids = boards.map((b) => (b as { id?: unknown }).id).filter((id) => typeof id === 'string')
      const starred = new Set<string>()
      if (ids.length) {
        const rows = await db.query<{ board_id: string }>(
          'SELECT board_id FROM board_stars WHERE user_id = $1 AND board_id = ANY($2::text[])',
          [user.id, ids],
        )
        for (const r of rows.rows) starred.add(r.board_id)
      }
      return {
        ...(payload as object),
        boards: boards.map((b) => ({ ...(b as object), starred: starred.has((b as { id: string }).id) })),
      }
    } catch (e) {
      req.log.warn({ err: { message: (e as Error)?.message } }, 'starred flag not added')
      return payload
    }
  })
}
