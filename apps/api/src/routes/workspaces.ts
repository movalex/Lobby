// Workspace members and projects (docs/M1-CONTRACTS.md §5). "member+" = owner, admin or member:
// guests belong to a workspace only to reach the boards they were invited to.

import { CreateProjectInput, PatchProjectInput, ProjectId, type WorkspaceMember } from '@draftroom/contracts'
import { newId } from '@draftroom/db'
import { canCreateInWorkspace, WORKSPACE_ROLES, type WorkspaceRole } from '@draftroom/permissions'
import type { FastifyInstance } from 'fastify'
import { requireWorkspaceRole } from '../access.ts'
import type { AppContext, Params } from '../context.ts'
import { badRequest, forbidden, notFound, parse } from '../errors.ts'
import { type ProjectRow, toProject, toUser, type UserRow } from '../serialize.ts'

const PROJECT_COLUMNS = 'id, workspace_id, name, created_at, archived_at'
const WS_RANK = Object.fromEntries(WORKSPACE_ROLES.map((r, i) => [r, i])) as Record<WorkspaceRole, number>

export function registerWorkspaceRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, now } = ctx

  app.get('/api/workspaces/:wid/members', async (req) => {
    const user = await ctx.requireUser(req)
    const { wid = '' } = req.params as Params
    const role = await requireWorkspaceRole(db, wid, user.id)
    if (!canCreateInWorkspace(role)) throw forbidden()
    // Wave 3: name-only guests (users.kind 'guest') are left out. They reach boards only through guest
    // links, so this list (the Share dialog's picker) could only offer an add the server refuses.
    const rows = await db.query<UserRow & { role: WorkspaceRole }>(
      `SELECT u.id, u.name, u.handle, u.color, u.avatar_url, m.role
         FROM workspace_members m JOIN users u ON u.id = m.user_id AND u.kind <> 'guest'
        WHERE m.workspace_id = $1`,
      [wid],
    )
    const members: WorkspaceMember[] = rows.rows.map(({ role, ...u }) => ({ user: toUser(u), role }))
    members.sort((a, b) => WS_RANK[a.role] - WS_RANK[b.role] || a.user.name.localeCompare(b.user.name))
    return { members }
  })

  app.get('/api/workspaces/:wid/projects', async (req) => {
    const user = await ctx.requireUser(req)
    const { wid = '' } = req.params as Params
    const role = await requireWorkspaceRole(db, wid, user.id)
    if (!canCreateInWorkspace(role)) throw forbidden()
    const rows = await db.query<ProjectRow>(
      `SELECT ${PROJECT_COLUMNS} FROM projects WHERE workspace_id = $1 ORDER BY created_at, id`,
      [wid],
    )
    return { projects: rows.rows.map(toProject) }
  })

  app.post('/api/workspaces/:wid/projects', async (req, reply) => {
    const user = await ctx.requireUser(req)
    const { wid = '' } = req.params as Params
    const input = parse(CreateProjectInput, req.body)
    const role = await requireWorkspaceRole(db, wid, user.id)
    if (!canCreateInWorkspace(role)) throw forbidden()
    const row = await db.one<ProjectRow>(
      `INSERT INTO projects (id, workspace_id, name, created_at) VALUES ($1, $2, $3, $4) RETURNING ${PROJECT_COLUMNS}`,
      [newId('prj'), wid, input.name, now()],
    )
    reply.code(201)
    return toProject(row)
  })

  app.patch('/api/projects/:pid', async (req) => {
    const user = await ctx.requireUser(req)
    const { pid = '' } = req.params as Params
    const input = parse(PatchProjectInput, req.body)
    if (input.name === undefined && input.archived === undefined) throw badRequest('nothing to update')
    if (!ProjectId.safeParse(pid).success) throw notFound()
    const row = await db.transaction(async (tx) => {
      const project = await tx.maybeOne<{ workspace_id: string; role: WorkspaceRole | null }>(
        `SELECT p.workspace_id, m.role FROM projects p
           LEFT JOIN workspace_members m ON m.workspace_id = p.workspace_id AND m.user_id = $2
          WHERE p.id = $1 FOR UPDATE OF p`,
        [pid, user.id],
      )
      // Guests cannot list projects, so for them a project id is as invisible as another tenant's.
      if (!project || !canCreateInWorkspace(project.role)) throw notFound()
      return tx.one<ProjectRow>(
        `UPDATE projects
            SET name = COALESCE($2::text, name),
                archived_at = CASE WHEN $3::boolean IS NULL THEN archived_at
                                   WHEN $3::boolean THEN COALESCE(archived_at, $4) ELSE NULL END
          WHERE id = $1 RETURNING ${PROJECT_COLUMNS}`,
        [pid, input.name ?? null, input.archived ?? null, now()],
      )
    })
    return toProject(row)
  })
}
