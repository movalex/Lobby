// The library's folders (OWNER: WS2, wave Q; docs/WAVE-Q-CONTRACTS.md §2.1, §2.3): flat, one level, per scope (the
// workspace library's, or a person's own). Listing is for every member (their own personal folders, the workspace's);
// making one in the workspace scope needs a creator, and a workspace folder is renamed, reordered or deleted by its
// maker or a workspace owner or admin (creators). A name is unique per scope whatever its case (409
// LIBRARY_FOLDER_EXISTS); 200 folders per workspace, 50 per person (409 LIBRARY_FULL). Deleting a folder keeps its
// items, folderless (0033's ON DELETE SET NULL (folder_id)). Every write holds the workspace row first, so the name
// check and the cap cannot race, and a folder never vanishes under a save that checked it.

import {
  CreateLibraryFolderInput,
  LIBRARY_CODES,
  LIBRARY_ROUTES,
  type LibraryFolder,
  ListLibraryFoldersQuery,
  type ListLibraryFoldersResponse,
  PatchLibraryFolderInput,
} from '@draftroom/contracts'
import { isUniqueViolation, type Queryable } from '@draftroom/db'
import type { FastifyInstance } from 'fastify'
import { requireCreatingRoleLocked } from '../../access.ts'
import { audit } from '../../audit.ts'
import type { Params } from '../../context.ts'
import { conflict, forbidden, notFound, parse } from '../../errors.ts'
import type { FeatureContext } from '../context.ts'
import {
  canEditFolder,
  FOLDER_COLUMNS,
  type FolderRow,
  findFolder,
  folderCap,
  ITEM_FROM,
  isLiveLibraryRoute,
  type LibraryCaller,
  libraryCaller,
  libraryFull,
  newLibraryId,
  requireScopeWriter,
  scopeOf,
  toFolder,
  visibleItems,
} from './model.ts'

const R = LIBRARY_ROUTES
const NOT_YOURS = 'Only its maker or a workspace owner or admin can change this folder.'
const nameTaken = () =>
  conflict(LIBRARY_CODES.folderExists, 'A folder of that name is already in this library.')

/** Live items per folder that this caller sees (an outsider's counts leave internal-only items out). */
async function itemCounts(q: Queryable, caller: LibraryCaller, scope: 'workspace' | 'personal') {
  const params: unknown[] = []
  const where = visibleItems(scope, caller, params)
  const rows = await q.query<{ folder_id: string; n: number }>(
    `SELECT i.folder_id, count(*)::int AS n ${ITEM_FROM}
      WHERE ${where} AND i.deleted_at IS NULL AND i.folder_id IS NOT NULL
      GROUP BY i.folder_id`,
    params,
  )
  return new Map(rows.rows.map((r) => [r.folder_id, Number(r.n)]))
}

/** The folder with this caller's count. */
async function folderOut(q: Queryable, caller: LibraryCaller, row: FolderRow): Promise<LibraryFolder> {
  return toFolder(row, (await itemCounts(q, caller, scopeOf(row))).get(row.id) ?? 0, caller)
}

/** Whether another folder of the scope has this name, whatever its case. */
async function nameExists(
  q: Queryable,
  caller: LibraryCaller,
  row: { owner_id: string | null },
  name: string,
  except?: string,
) {
  const params: unknown[] = [caller.workspaceId, name, except ?? '']
  let owner = 'owner_id IS NULL'
  if (row.owner_id !== null) {
    params.push(row.owner_id)
    owner = 'owner_id = $4'
  }
  const hit = await q.maybeOne(
    `SELECT 1 AS hit FROM library_folders
      WHERE workspace_id = $1 AND ${owner} AND lower(name) = lower($2) AND id <> $3`,
    params,
  )
  return hit !== null
}

/** A unique-name race the lock should prevent, answered as the conflict it is anyway. */
async function nameRace<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (isUniqueViolation(err)) throw nameTaken()
    throw err
  }
}

export function registerLibraryFolders(app: FastifyInstance, ctx: FeatureContext): void {
  const { db } = ctx

  /** A folder this caller may change, for a write: may see it (else 404), may write its scope, and is its editor. */
  async function editableFolder(caller: LibraryCaller, fid: string, route: string): Promise<FolderRow> {
    const row = await findFolder(db, caller, fid)
    if (!row) throw notFound()
    await requireScopeWriter(ctx, db, caller, scopeOf(row), route)
    if (!canEditFolder(row, caller)) throw forbidden(NOT_YOURS)
    return row
  }

  if (isLiveLibraryRoute(`GET ${R.folders}`))
    app.get(R.folders, async (req): Promise<ListLibraryFoldersResponse> => {
      const user = await ctx.requireUser(req)
      const { wid = '' } = req.params as Params
      const caller = await libraryCaller(ctx, db, wid, user)
      const { scope } = parse(ListLibraryFoldersQuery, req.query ?? {})
      const rows =
        scope === 'workspace'
          ? await db.query<FolderRow>(
              `SELECT ${FOLDER_COLUMNS} FROM library_folders f WHERE f.workspace_id = $1 AND f.owner_id IS NULL
                ORDER BY f.position, lower(f.name), f.id`,
              [wid],
            )
          : await db.query<FolderRow>(
              `SELECT ${FOLDER_COLUMNS} FROM library_folders f WHERE f.workspace_id = $1 AND f.owner_id = $2
                ORDER BY f.position, lower(f.name), f.id`,
              [wid, user.id],
            )
      const counts = await itemCounts(db, caller, scope)
      return { folders: rows.rows.map((r) => toFolder(r, counts.get(r.id) ?? 0, caller)) }
    })

  if (isLiveLibraryRoute(`POST ${R.folders}`))
    app.post(R.folders, async (req, reply): Promise<LibraryFolder> => {
      const user = await ctx.requireUser(req)
      const { wid = '' } = req.params as Params
      const input = parse(CreateLibraryFolderInput, req.body)
      const caller = await libraryCaller(ctx, db, wid, user)
      await requireScopeWriter(ctx, db, caller, input.scope, req.routeOptions.url ?? '')
      const owner = input.scope === 'personal' ? user.id : null
      const row = await nameRace(() =>
        db.transaction(async (tx) => {
          await requireCreatingRoleLocked(tx, wid, user.id)
          const { n, top } = await tx.one<{ n: number; top: number | null }>(
            `SELECT count(*)::int AS n, max(position) AS top FROM library_folders
              WHERE workspace_id = $1 AND owner_id IS NOT DISTINCT FROM $2`,
            [wid, owner],
          )
          if (n >= folderCap(input.scope)) throw libraryFull('folders', input.scope)
          if (await nameExists(tx, caller, { owner_id: owner }, input.name)) throw nameTaken()
          const id = newLibraryId('lbf')
          const at = ctx.now()
          const made = await tx.one<FolderRow>(
            `INSERT INTO library_folders (id, workspace_id, owner_id, name, position, created_by, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id, workspace_id, owner_id, name, position, created_by`,
            [id, wid, owner, input.name, Math.min(10_000, top === null ? 0 : Number(top) + 1), user.id, at],
          )
          await audit(tx, {
            workspaceId: wid,
            actorId: user.id,
            action: 'library.folder.create',
            target: id,
            detail: { scope: input.scope },
            at,
          })
          return made
        }),
      )
      reply.code(201)
      return toFolder(row, 0, caller)
    })

  if (isLiveLibraryRoute(`PATCH ${R.folder}`))
    app.patch(R.folder, async (req): Promise<LibraryFolder> => {
      const user = await ctx.requireUser(req)
      const { wid = '', fid = '' } = req.params as Params
      const input = parse(PatchLibraryFolderInput, req.body)
      const caller = await libraryCaller(ctx, db, wid, user)
      await editableFolder(caller, fid, req.routeOptions.url ?? '')
      const row = await nameRace(() =>
        db.transaction(async (tx) => {
          await requireCreatingRoleLocked(tx, wid, user.id)
          const cur = await findFolder(tx, caller, fid, { lock: true })
          if (!cur) throw notFound()
          if (!canEditFolder(cur, caller)) throw forbidden(NOT_YOURS)
          if (input.name !== undefined && (await nameExists(tx, caller, cur, input.name, cur.id)))
            throw nameTaken()
          return tx.one<FolderRow>(
            `UPDATE library_folders SET name = COALESCE($2, name), position = COALESCE($3, position)
              WHERE id = $1 RETURNING id, workspace_id, owner_id, name, position, created_by`,
            [fid, input.name ?? null, input.position ?? null],
          )
        }),
      )
      return folderOut(db, caller, row)
    })

  if (isLiveLibraryRoute(`DELETE ${R.folder}`))
    app.delete(R.folder, async (req, reply) => {
      const user = await ctx.requireUser(req)
      const { wid = '', fid = '' } = req.params as Params
      const caller = await libraryCaller(ctx, db, wid, user)
      await editableFolder(caller, fid, req.routeOptions.url ?? '')
      await db.transaction(async (tx) => {
        await requireCreatingRoleLocked(tx, wid, user.id)
        const cur = await findFolder(tx, caller, fid, { lock: true })
        if (!cur) throw notFound()
        if (!canEditFolder(cur, caller)) throw forbidden(NOT_YOURS)
        // its items stay, folderless (the foreign key sets only folder_id to NULL)
        await tx.query('DELETE FROM library_folders WHERE id = $1', [fid])
        await audit(tx, {
          workspaceId: wid,
          actorId: user.id,
          action: 'library.folder.delete',
          target: fid,
          detail: { scope: scopeOf(cur) },
          at: ctx.now(),
        })
      })
      reply.code(204)
      return null
    })
}
