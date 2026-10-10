// OWNER: W8 (wave M, M8-3 / WS-TEMPLATES). Workspace templates: a board a workspace's creators saved as a team
// template ("our retro", "our kickoff"), and new boards started from a copy of it.
//
//   GET    /api/workspaces/:wid/templates            → ListWorkspaceTemplatesResponse (members, no guests)
//   POST   /api/workspaces/:wid/templates            AddWorkspaceTemplateInput → 201 WorkspaceTemplate
//                                                    (a creator who is a workspace owner or admin)
//   DELETE /api/workspaces/:wid/templates/:bid       → 204 (the same)
//   POST   /api/workspaces/:wid/templates/:bid/use   UseWorkspaceTemplateInput → 201 HistoryBoardCreated
//                                                    (a member who is a creator)
//
// Rows in workspace_templates (migration 0030). Decisions, all server-side:
// - Name-only guests are refused before anything by the guest guard (guests/guard.ts GUEST_REFUSED_ROUTES, 403
//   GUEST_ACCOUNT_REQUIRED); a stranger gets 404 (the workspace stays invisible), a workspace guest 403.
// - Saving, removing and using need a creator (docs/DOMAIN-ACCESS-CONTRACTS.md): the domain-access guard refuses a
//   non-creator first (domain-access/guard.ts CREATOR_ROUTES, refuse 'always'), and each route checks again itself,
//   failing closed (identity.requireCreator, stored status only).
// - "Use" is allowed because the board is a template of THIS workspace and the caller is a member who may create
//   boards and a creator; never because they can view the source board (most templates are private boards). The
//   copy is a new private board owned by the caller (history/new-board.ts createBoardFrom): its content and files
//   come over through the sync's own snapshot and seed (only the sync writes board files), the template's grants,
//   links, visibility and export policy never do (an AI-off template gives an AI-off copy, AIPV-04).
// - Lock order (access.ts): the workspace row first. Use takes it in createBoardFrom's transaction and reads the
//   template row again under it (FOR SHARE), before the board row and its owner grant are written; DELETE takes the
//   same row before it deletes, so a removal and a use run one after the other: removed first, the use answers 404
//   and makes no board; used first, the copy is made and the removal waits. A member removal also holds the
//   workspace row, so a use never leaves an owner grant for someone who is no member any more.
// - A trashed template board is gone for every route (its row stays until the board is deleted for good, 0030).
// - Nothing here publishes board events or logs names.

import {
  AddWorkspaceTemplateInput,
  type ListWorkspaceTemplatesResponse,
  UseWorkspaceTemplateInput,
  type WorkspaceTemplate,
  WS_TEMPLATE_ROUTE,
  WS_TEMPLATE_USE_ROUTE,
  WS_TEMPLATES_MAX,
  WS_TEMPLATES_ROUTE,
  type WsTemplateCategory,
} from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import { canCreateInWorkspace, canManageWorkspace, type WorkspaceRole } from '@draftroom/permissions'
import type { FastifyInstance } from 'fastify'
import {
  type BoardRow,
  isBoardId,
  loadBoardAccess,
  requireProjectInWorkspace,
  requireWorkspaceRole,
} from '../../access.ts'
import { lobbySnapshotOf } from '../../canvas/lobby-elements.ts'
import { onNewCanvas, showsR0Marks } from '../../canvas-engine.ts'
import type { Params } from '../../context.ts'
import { conflict, forbidden, notFound, parse } from '../../errors.ts'
import type { FeatureContext } from '../context.ts'
import { mayExport } from '../export-control/policy.ts'
import { filesShownOn, referencedElementFiles, referencedFiles } from '../history/files.ts'
import { contentOf, created, recordsOf } from '../history/index.ts'
import { createBoardFrom, newCanvasBoard, viaSync } from '../history/new-board.ts'

/** A full board copy each (as duplicate): per client, per minute. */
const HEAVY = { config: { rateLimit: { max: 60, timeWindow: 60_000 } } }
const LISTING_ROLES: ReadonlySet<WorkspaceRole> = new Set<WorkspaceRole>(['owner', 'admin', 'member'])

const MEMBERS_ONLY = 'Workspace templates are for members of this workspace.'
const ADMINS_ONLY = 'Only workspace owners and admins can save or remove workspace templates.'
const CREATE_MEMBERS = 'Only workspace members can create boards.'

interface TemplateRow {
  board_id: string
  name: string
  category: WsTemplateCategory
  added_at: Date
  added_by: string | null
  added_by_name: string | null
}

const TEMPLATE_SELECT = `SELECT t.board_id, t.name, t.category, t.added_at, t.added_by, u.name AS added_by_name
   FROM workspace_templates t
   JOIN boards b ON b.id = t.board_id AND b.workspace_id = t.workspace_id
   LEFT JOIN users u ON u.id = t.added_by`

const toTemplate = (r: TemplateRow): WorkspaceTemplate => ({
  boardId: r.board_id,
  name: r.name,
  category: r.category,
  // 0030: added_by is NULL once the account is gone (the contract's null)
  addedBy: r.added_by && r.added_by_name !== null ? { id: r.added_by, name: r.added_by_name } : null,
  addedAt: r.added_at.toISOString(),
})

/** The template of this workspace whose board is `boardId` and not trashed; `lock` reads it FOR SHARE. */
async function liveTemplate(
  q: Queryable,
  workspaceId: string,
  boardId: string,
  lock = false,
): Promise<(TemplateRow & Pick<BoardRow, 'new_canvas'>) | null> {
  if (!isBoardId(boardId)) return null
  return q.maybeOne<TemplateRow & Pick<BoardRow, 'new_canvas'>>(
    `${TEMPLATE_SELECT.replace('SELECT ', 'SELECT b.new_canvas, ')}
     WHERE t.workspace_id = $1 AND t.board_id = $2 AND b.status <> 'trashed'${lock ? ' FOR SHARE OF t' : ''}`,
    [workspaceId, boardId],
  )
}

const lockWorkspace = (q: Queryable, workspaceId: string) =>
  q.query('SELECT id FROM workspaces WHERE id = $1 FOR NO KEY UPDATE', [workspaceId])

export async function registerWsTemplates(app: FastifyInstance, ctx: FeatureContext): Promise<void> {
  const { db } = ctx
  const warn = (message: string) => app.log.warn({ feature: 'ws-templates' }, message)

  /** A creator who is a workspace owner or admin (saving, removing). */
  async function requireTemplateAdmin(workspaceId: string, userId: string, route: string) {
    const role = await requireWorkspaceRole(db, workspaceId, userId)
    if (!canManageWorkspace(role)) throw forbidden(ADMINS_ONLY)
    await ctx.identity.requireCreator(db, userId, 'create', { route, by: 'route' })
  }

  app.get(WS_TEMPLATES_ROUTE, async (req): Promise<ListWorkspaceTemplatesResponse> => {
    const user = await ctx.requireUser(req)
    const { wid = '' } = req.params as Params
    const role = await requireWorkspaceRole(db, wid, user.id)
    if (!LISTING_ROLES.has(role)) throw forbidden(MEMBERS_ONLY)
    const rows = await db.query<TemplateRow>(
      `${TEMPLATE_SELECT}
       WHERE t.workspace_id = $1 AND b.status <> 'trashed'
       ORDER BY t.added_at DESC, t.board_id
       LIMIT ${WS_TEMPLATES_MAX}`,
      [wid],
    )
    return { templates: rows.rows.map(toTemplate) }
  })

  app.post(WS_TEMPLATES_ROUTE, async (req, reply): Promise<WorkspaceTemplate> => {
    const user = await ctx.requireUser(req)
    const { wid = '' } = req.params as Params
    const input = parse(AddWorkspaceTemplateInput, req.body)
    await requireTemplateAdmin(wid, user.id, req.routeOptions.url ?? '')
    // A board of this workspace that is not in the trash (an owner or admin can open every one of them).
    const access = await loadBoardAccess(db, input.boardId, user.id)
    if (!access || access.board.workspace_id !== wid || access.board.status === 'trashed') throw notFound()
    // Its content is offered to every member as a copy: whoever saves it must be allowed to copy out of it.
    if (!(await mayExport(db, access, user.id)))
      throw forbidden('Copying from this board is turned off for you, so it cannot be a workspace template.')
    const row = await db.transaction(async (tx) => {
      await lockWorkspace(tx, wid)
      const exists = await tx.maybeOne(
        'SELECT 1 AS ok FROM workspace_templates WHERE workspace_id = $1 AND board_id = $2',
        [wid, input.boardId],
      )
      if (!exists) {
        const { n } = await tx.one<{ n: number }>(
          'SELECT count(*)::int AS n FROM workspace_templates WHERE workspace_id = $1',
          [wid],
        )
        if (n >= WS_TEMPLATES_MAX)
          throw conflict(
            'WS_TEMPLATES_LIMIT',
            `A workspace keeps at most ${WS_TEMPLATES_MAX} templates. Remove one first.`,
          )
      }
      // The board may have been deleted for good since it was read: the composite foreign key refuses the row.
      const saved = await tx.maybeOne<{ board_id: string }>(
        `INSERT INTO workspace_templates (workspace_id, board_id, name, category, added_by, added_at)
         SELECT $1, b.id, $3, $4, $5, $6 FROM boards b
          WHERE b.id = $2 AND b.workspace_id = $1 AND b.status <> 'trashed'
         ON CONFLICT (workspace_id, board_id) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category
         RETURNING board_id`,
        [wid, input.boardId, input.name, input.category, user.id, ctx.now()],
      )
      if (!saved) throw notFound()
      return tx.one<TemplateRow>(`${TEMPLATE_SELECT} WHERE t.workspace_id = $1 AND t.board_id = $2`, [
        wid,
        input.boardId,
      ])
    })
    reply.code(201)
    return toTemplate(row)
  })

  app.delete(WS_TEMPLATE_ROUTE, async (req, reply) => {
    const user = await ctx.requireUser(req)
    const { wid = '', bid = '' } = req.params as Params
    await requireTemplateAdmin(wid, user.id, req.routeOptions.url ?? '')
    if (!isBoardId(bid)) throw notFound()
    const removed = await db.transaction(async (tx) => {
      // The workspace row first (the lock order): a use under way finishes before this removal, or sees it.
      await lockWorkspace(tx, wid)
      const r = await tx.query('DELETE FROM workspace_templates WHERE workspace_id = $1 AND board_id = $2', [
        wid,
        bid,
      ])
      return r.rowCount
    })
    if (!removed) throw notFound()
    reply.code(204)
    return null
  })

  app.post(WS_TEMPLATE_USE_ROUTE, HEAVY, async (req, reply) => {
    const user = await ctx.requireUser(req)
    const { wid = '', bid = '' } = req.params as Params
    const input = parse(UseWorkspaceTemplateInput, req.body ?? {})
    // A member who may create boards, and a creator: before anything is read of the template.
    const role = await requireWorkspaceRole(db, wid, user.id)
    if (!canCreateInWorkspace(role)) throw forbidden(CREATE_MEMBERS)
    await ctx.identity.requireCreator(db, user.id, 'create', {
      route: req.routeOptions.url ?? '',
      by: 'route',
    })
    const template = await liveTemplate(db, wid, bid)
    if (!template) throw notFound()
    const projectId = input.projectId ?? null
    if (projectId) await requireProjectInWorkspace(db, projectId, wid)
    // bridge release R0: a board of the new canvas is copied only by an api whose sync runs it
    if (template.new_canvas && !(await onNewCanvas(ctx))) throw newCanvasBoard()
    const snap = await viaSync(() => ctx.sync.snapshot(bid))
    const lobby = lobbySnapshotOf(snap)
    const { shown, notShown } = await filesShownOn(
      db,
      wid,
      bid,
      lobby ? await referencedElementFiles(db, lobby.elements) : referencedFiles(recordsOf(snap)),
    )
    const { row: board } = await createBoardFrom(
      ctx,
      {
        userId: user.id,
        workspaceId: wid,
        projectId,
        title: input.title ?? template.name,
        content: contentOf(snap),
        files: shown,
        via: 'template',
        from: { boardId: bid },
        // Under the workspace row lock: the template must still be one (a removal that went first wins).
        inTx: async (tx) => {
          if (!(await liveTemplate(tx, wid, bid, true))) throw notFound()
        },
      },
      warn,
    )
    reply.code(201)
    return created(board, shown.length, notShown, !(await showsR0Marks(ctx)))
  })
}
