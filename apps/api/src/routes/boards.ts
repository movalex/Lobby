// Boards: list/create/get/patch and archive/trash/restore (docs/M1-CONTRACTS.md §5).

import { checkInternalSecret, INTERNAL_SECRET_HEADER } from '@draftroom/auth-tickets'
import { CreateBoardInput, ListBoardsQuery, PatchBoardInput } from '@draftroom/contracts'
import { newBoardId } from '@draftroom/db'
import {
  type BoardRole,
  type BoardStatus,
  can,
  canCreateInWorkspace,
  resolveBoardRole,
} from '@draftroom/permissions'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  BOARD_COLUMNS,
  BOARD_RETURNING,
  type BoardRow,
  isBoardId,
  requireBoardAction,
  requireProjectInWorkspace,
  requireVisibleBoard,
  requireWorkspaceRole,
  roleOf,
} from '../access.ts'
import { audit } from '../audit.ts'
import type { AppContext, Params } from '../context.ts'
import { ApiError, conflict, forbidden, notFound, parse } from '../errors.ts'
import { toBoard, toBoardWithRole } from '../serialize.ts'

const MAX_LISTED = 500
/** `at`: epoch ms of the board's latest accepted canvas write (sync's clock; clamped to ours). */
const TouchedQuery = z.object({ at: z.coerce.number().int().min(0).max(8.64e15).optional() })
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)

const TRANSITIONS = { archive: 'archived', trash: 'trashed', restore: 'active' } as const satisfies Record<
  string,
  BoardStatus
>

export function registerBoardRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, notifier, now } = ctx

  app.get('/api/workspaces/:wid/boards', async (req) => {
    const user = await ctx.requireUser(req)
    const { wid = '' } = req.params as Params
    const query = parse(ListBoardsQuery, req.query)
    const workspaceRole = await requireWorkspaceRole(db, wid, user.id)
    const status = query.status ?? 'active'
    const q = query.q?.trim()
    // The WHERE clause only narrows candidates cheaply; resolveBoardRole/can below make the decision.
    const rows = await db.query<BoardRow & { board_grant: BoardRole | null }>(
      `SELECT ${BOARD_COLUMNS}, bm.role AS board_grant
         FROM boards b
         LEFT JOIN board_members bm ON bm.board_id = b.id AND bm.user_id = $2
        WHERE b.workspace_id = $1 AND b.status = $3
          AND ($4::text IS NULL OR b.project_id = $4::text)
          AND ($5::text IS NULL OR b.title ILIKE $5::text ESCAPE '\\')
          AND ($6::boolean OR bm.role IS NOT NULL OR ($7::boolean AND b.visibility <> 'private'))
        ORDER BY GREATEST(b.last_opened_at, b.updated_at) DESC, b.id
        LIMIT ${MAX_LISTED}`,
      [
        wid,
        user.id,
        status,
        query.projectId ?? null,
        q ? `%${escapeLike(q)}%` : null,
        workspaceRole === 'owner' || workspaceRole === 'admin',
        workspaceRole === 'member',
      ],
    )
    const boards = []
    for (const { board_grant, ...board } of rows.rows) {
      const role = resolveBoardRole({ workspaceRole, boardGrant: board_grant, visibility: board.visibility })
      // Trash lists what the caller could restore; nobody can open a trashed board.
      const listed = status === 'trashed' ? can(role, 'restore', status) : can(role, 'view', status)
      if (role && listed) boards.push(toBoardWithRole(board, role))
    }
    return { boards }
  })

  app.post('/api/workspaces/:wid/boards', async (req, reply) => {
    const user = await ctx.requireUser(req)
    const { wid = '' } = req.params as Params
    const input = parse(CreateBoardInput, req.body)
    const row = await db.transaction(async (tx) => {
      const workspaceRole = await requireWorkspaceRole(tx, wid, user.id)
      if (!canCreateInWorkspace(workspaceRole)) throw forbidden()
      const projectId = input.projectId ?? null
      if (projectId) await requireProjectInWorkspace(tx, projectId, wid)
      const at = now()
      for (let attempt = 0; attempt < 5; attempt++) {
        const created = await tx.maybeOne<BoardRow>(
          `INSERT INTO boards (id, workspace_id, project_id, title, created_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $6) ON CONFLICT (id) DO NOTHING RETURNING ${BOARD_RETURNING}`,
          [newBoardId(), wid, projectId, input.title, user.id, at],
        )
        if (!created) continue // id collision (36^10 space): draw another
        await tx.query(
          "INSERT INTO board_members (board_id, user_id, role, added_by, created_at) VALUES ($1, $2, 'owner', $2, $3)",
          [created.id, user.id, at],
        )
        await audit(tx, {
          workspaceId: wid,
          actorId: user.id,
          action: 'board.create',
          target: created.id,
          at,
        })
        return created
      }
      throw new Error('could not allocate a board id')
    })
    reply.code(201)
    return toBoardWithRole(row, 'owner')
  })

  app.get('/api/boards/:bid', async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const access = await requireBoardAction(db, bid, user.id, 'view')
    // Opening a board is not an edit: last_opened_at moves, updated_at does not.
    const row = await db.one<BoardRow>(
      `UPDATE boards SET last_opened_at = $2 WHERE id = $1 RETURNING ${BOARD_RETURNING}`,
      [bid, now()],
    )
    return {
      board: toBoard(row),
      role: roleOf(access),
      workspace: { id: access.board.workspace_id, name: access.workspaceName },
    }
  })

  app.patch('/api/boards/:bid', async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const input = parse(PatchBoardInput, req.body)
    const result = await db.transaction(async (tx) => {
      const access = await requireVisibleBoard(tx, bid, user.id, 'view', { forUpdate: true })
      const { status, workspace_id } = access.board
      if ((input.title !== undefined || input.projectId !== undefined) && !can(access.role, 'rename', status))
        throw forbidden()
      if (input.visibility !== undefined && !can(access.role, 'change_visibility', status)) throw forbidden()
      if (input.projectId) await requireProjectInWorkspace(tx, input.projectId, workspace_id)
      const at = now()
      const row = await tx.one<BoardRow>(
        `UPDATE boards
            SET title = COALESCE($2::text, title),
                project_id = CASE WHEN $3::boolean THEN $4::text ELSE project_id END,
                visibility = COALESCE($5::text, visibility),
                updated_at = $6
          WHERE id = $1 RETURNING ${BOARD_RETURNING}`,
        [
          bid,
          input.title ?? null,
          input.projectId !== undefined,
          input.projectId ?? null,
          input.visibility ?? null,
          at,
        ],
      )
      const visibilityChanged = row.visibility !== access.board.visibility
      if (visibilityChanged)
        await audit(tx, {
          workspaceId: workspace_id,
          actorId: user.id,
          action: 'board.visibility',
          target: bid,
          detail: { from: access.board.visibility, to: row.visibility },
          at,
        })
      return { row, role: roleOf(access), visibilityChanged }
    })
    if (result.visibilityChanged) notifier.accessChanged({ boardId: bid })
    return toBoardWithRole(result.row, result.role)
  })

  // Server-to-server only (the web proxy never forwards /internal): the sync server reports the time
  // of a board's latest accepted canvas write, at most once a minute per board (apps/sync/src/touch.ts),
  // so the dashboard's "Edited …" and "Last edited" sort include canvas edits (RETRO-19). A GET: the
  // root CSRF hook refuses POSTs without the web Origin, and the update is idempotent (updated_at only
  // moves forward, and never past this server's clock).
  app.get('/internal/boards/:bid/touched', async (req, reply) => {
    if (!checkInternalSecret(req.headers[INTERNAL_SECRET_HEADER], ctx.config.internalSecret))
      throw new ApiError(401, 'NOT_AUTHENTICATED', 'Internal credentials required.')
    const { bid = '' } = req.params as Params
    const { at } = parse(TouchedQuery, req.query)
    if (!isBoardId(bid)) throw notFound()
    const current = now()
    const when = new Date(Math.min(at ?? current.getTime(), current.getTime()))
    // Trashed boards keep the time they were trashed (the trash list shows it).
    await db.query(
      `UPDATE boards SET updated_at = $2 WHERE id = $1 AND updated_at < $2 AND status <> 'trashed'`,
      [bid, when],
    )
    return reply.code(204).send()
  })

  for (const action of ['archive', 'trash', 'restore'] as const) {
    app.post(`/api/boards/:bid/${action}`, async (req) => {
      const user = await ctx.requireUser(req)
      const { bid = '' } = req.params as Params
      const target = TRANSITIONS[action]
      const result = await db.transaction(async (tx) => {
        const access = await requireVisibleBoard(tx, bid, user.id, action, { forUpdate: true })
        const role = roleOf(access)
        const from = access.board.status
        if (from === target) {
          // Repeating a transition is a no-op for owners (double clicks, retries after a timeout).
          if (role !== 'owner') throw forbidden()
          return { row: access.board, role, changed: false }
        }
        if (!can(role, action, from)) {
          if (role === 'owner') throw conflict('INVALID_STATE', 'Restore the board before archiving it.')
          throw forbidden()
        }
        const at = now()
        const row = await tx.one<BoardRow>(
          `UPDATE boards SET status = $2, trashed_at = $3, updated_at = $4 WHERE id = $1 RETURNING ${BOARD_RETURNING}`,
          [bid, target, target === 'trashed' ? at : null, at],
        )
        await audit(tx, {
          workspaceId: access.board.workspace_id,
          actorId: user.id,
          action: `board.${action}`,
          target: bid,
          detail: { from, to: target },
          at,
        })
        return { row, role, changed: true }
      })
      if (result.changed) notifier.accessChanged({ boardId: bid })
      return toBoardWithRole(result.row, result.role)
    })
  }
}
