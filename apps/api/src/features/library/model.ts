// The element library's shared pieces (OWNER: WS2, wave Q; docs/WAVE-Q-CONTRACTS.md §2): who the caller is to a
// workspace's library, which items and folders they may see and change, the rows and their contract shapes, the
// list cursor and the ids. Every route of ./index.ts goes through here, so the rules live in one place:
//
// - a name-only guest: 403 GUEST_ACCOUNT_REQUIRED (the guest guard answers first; this is the route's own check);
// - a stranger to the workspace: 404 (it stays invisible); a workspace guest, which is what a board-only
//   collaborator is: 403;
// - owners, admins and members read the workspace library, except that a caller who is not a creator (stored
//   status) never sees an internal-only item: one saved from an internal-only project or workspace (the stored
//   flag), or whose source board is in an internal-only project now;
// - writes in the workspace scope need a creator (identity.requireCreator, in the route); a workspace item or folder
//   is changed by its author or by a workspace owner or admin (both creators);
// - a personal library is its owner's alone: anyone else gets the 404 of a missing item.

import { randomBytes } from 'node:crypto'
import {
  LIBRARY_FOLDER_ID_PATTERN,
  LIBRARY_ITEM_ID_PATTERN,
  LIBRARY_LIMITS,
  LIBRARY_ROUTE_KEYS,
  type LibraryFolder,
  type LibraryItemSummary,
  type LibraryRouteKey,
  type LibraryScope,
} from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import { canManageWorkspace, type WorkspaceRole } from '@draftroom/permissions'
import { requireWorkspaceRole } from '../../access.ts'
import type { SessionUser } from '../../auth/session.ts'
import { ApiError, badRequest, forbidden } from '../../errors.ts'
import type { FeatureContext } from '../context.ts'
import { guestRefused, LIBRARY_GUESTS } from '../guests/guard.ts'
import { isPendingRoute } from '../pending-routes.ts'

const DAY = 86_400_000
const MEMBERS_ONLY = 'The element library is for members of this workspace.'
const LIBRARY_ROLES: ReadonlySet<WorkspaceRole> = new Set<WorkspaceRole>(['owner', 'admin', 'member'])

/** Whether a library route is live (not listed in ../pending-routes.ts: adding a key back ships it hidden). */
export const isLiveLibraryRoute = (key: LibraryRouteKey) =>
  (LIBRARY_ROUTE_KEYS as readonly string[]).includes(key) && !isPendingRoute(key)

export interface LibraryCaller {
  userId: string
  workspaceId: string
  role: WorkspaceRole
  /** a workspace owner or admin */
  manager: boolean
  /** a creator by stored status (an unconfirmed account is not one) */
  creator: boolean
}

/** The caller as the library sees them, or the refusal (see the module comment). */
export async function libraryCaller(
  ctx: FeatureContext,
  q: Queryable,
  workspaceId: string,
  user: SessionUser,
): Promise<LibraryCaller> {
  if (user.kind === 'guest') throw guestRefused(LIBRARY_GUESTS)
  const role = await requireWorkspaceRole(q, workspaceId, user.id)
  if (!LIBRARY_ROLES.has(role)) throw forbidden(MEMBERS_ONLY)
  return {
    userId: user.id,
    workspaceId,
    role,
    manager: canManageWorkspace(role),
    creator: await ctx.identity.isCreatorUser(q, user.id),
  }
}

/** A write in `scope`: the workspace library needs a creator (403 CREATOR_REQUIRED); a personal one does not. */
export async function requireScopeWriter(
  ctx: FeatureContext,
  q: Queryable,
  caller: LibraryCaller,
  scope: LibraryScope,
  route: string,
): Promise<void> {
  if (scope === 'workspace')
    await ctx.identity.requireCreator(q, caller.userId, 'create', { route, by: 'route' })
}

/** The live item limit of a scope, and its folder limit. */
export const itemCap = (scope: LibraryScope) =>
  scope === 'workspace' ? LIBRARY_LIMITS.workspaceItems : LIBRARY_LIMITS.personalItems
export const folderCap = (scope: LibraryScope) =>
  scope === 'workspace' ? LIBRARY_LIMITS.workspaceFolders : LIBRARY_LIMITS.personalFolders

export const libraryFull = (what: 'items' | 'folders', scope: LibraryScope) =>
  new ApiError(
    409,
    'LIBRARY_FULL',
    `This ${scope === 'workspace' ? 'workspace' : 'personal'} library holds at most ${
      what === 'items' ? itemCap(scope) : folderCap(scope)
    } ${what === 'items' ? 'items' : 'folders'}. Delete some first.`,
  )

/** The workspace row, FOR NO KEY UPDATE: the first lock of every library write (access.ts lock order, step 0). */
export const lockWorkspace = (q: Queryable, workspaceId: string) =>
  q.query('SELECT id FROM workspaces WHERE id = $1 FOR NO KEY UPDATE', [workspaceId])

/** When a deleted item stops being restorable (and the purge may remove it). */
export const restoreCutoff = (now: Date) => new Date(now.getTime() - LIBRARY_LIMITS.restoreDays * DAY)

// ---- ids --------------------------------------------------------------------------------------------------

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** `lbi_…` / `lbf_…` + 20 base62 characters (the shape of packages/db newId; rejection sampling, no bias). */
export function newLibraryId(prefix: 'lbi' | 'lbf'): string {
  let out = ''
  while (out.length < 20)
    for (const b of randomBytes(32)) {
      if (b >= 248) continue
      out += BASE62[b % 62]
      if (out.length === 20) break
    }
  return `${prefix}_${out}`
}

export const isItemId = (v: unknown): v is string => typeof v === 'string' && LIBRARY_ITEM_ID_PATTERN.test(v)
export const isFolderId = (v: unknown): v is string =>
  typeof v === 'string' && LIBRARY_FOLDER_ID_PATTERN.test(v)

// ---- items ------------------------------------------------------------------------------------------------

export interface ItemRow {
  id: string
  workspace_id: string
  owner_id: string | null
  folder_id: string | null
  name: string
  tags: string[]
  element_count: number
  image_count: number
  width: number
  height: number
  source: unknown
  /** effective: the stored flag, or the source board's project is internal only now */
  internal_only: boolean
  revision: number
  created_by: string | null
  created_by_name: string | null
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
  /** updated_at as Postgres prints it (exact, for the cursor) */
  cursor_at: string
}

/** The source board's current project (alias sp) decides with the stored flag. */
const INTERNAL_EFFECTIVE = '(i.internal_only OR COALESCE(sp.internal_only, false))'

export const ITEM_COLUMNS = `i.id, i.workspace_id, i.owner_id, i.folder_id, i.name, i.tags, i.element_count,
  i.image_count, i.width::float8 AS width, i.height::float8 AS height, i.source, ${INTERNAL_EFFECTIVE} AS internal_only,
  i.revision, i.created_by, u.name AS created_by_name, i.created_at, i.updated_at, i.deleted_at,
  i.updated_at::text AS cursor_at`

export const ITEM_FROM = `FROM library_items i
  LEFT JOIN users u ON u.id = i.created_by
  LEFT JOIN boards sb ON i.source ->> 'kind' = 'board' AND sb.id = i.source ->> 'boardId'
                     AND sb.workspace_id = i.workspace_id
  LEFT JOIN projects sp ON sp.id = sb.project_id AND sp.workspace_id = i.workspace_id`

/**
 * The SQL condition (alias i, with ITEM_FROM's joins) for the items of `scope` this caller may see, live or not;
 * its parameters are appended to `params`.
 */
export function visibleItems(scope: LibraryScope, caller: LibraryCaller, params: unknown[]): string {
  params.push(caller.workspaceId)
  const w = `$${params.length}`
  if (scope === 'personal') {
    params.push(caller.userId)
    return `i.workspace_id = ${w} AND i.owner_id = $${params.length}`
  }
  return `i.workspace_id = ${w} AND i.owner_id IS NULL${caller.creator ? '' : ` AND NOT ${INTERNAL_EFFECTIVE}`}`
}

/** Whether the caller may rename, retag, move, change, delete or restore the item. */
export function canEditItem(row: Pick<ItemRow, 'owner_id' | 'created_by'>, caller: LibraryCaller): boolean {
  if (row.owner_id !== null) return row.owner_id === caller.userId
  return caller.creator && (caller.manager || row.created_by === caller.userId)
}

export const scopeOf = (row: { owner_id: string | null }): LibraryScope =>
  row.owner_id === null ? 'workspace' : 'personal'

const sourceKindOf = (source: unknown): 'board' | 'excalidrawlib' =>
  typeof source === 'object' && source !== null && (source as { kind?: unknown }).kind === 'excalidrawlib'
    ? 'excalidrawlib'
    : 'board'

const round2 = (n: number) => Math.max(0, Math.round(Number(n) * 100) / 100)

export function toSummary(r: ItemRow, caller: LibraryCaller): LibraryItemSummary {
  return {
    id: r.id,
    scope: scopeOf(r),
    folderId: r.folder_id,
    name: r.name,
    tags: r.tags,
    elementCount: Number(r.element_count),
    imageCount: Number(r.image_count),
    width: round2(r.width),
    height: round2(r.height),
    internalOnly: r.internal_only,
    revision: Number(r.revision),
    sourceKind: sourceKindOf(r.source),
    // NULL once the account is gone (0033: ON DELETE SET NULL)
    createdBy:
      r.created_by && r.created_by_name !== null ? { id: r.created_by, name: r.created_by_name } : null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    deletedAt: r.deleted_at ? r.deleted_at.toISOString() : null,
    canEdit: canEditItem(r, caller),
  }
}

export type ItemState = 'live' | 'restorable'

/**
 * The item `id` of the caller's workspace if they may see it (any scope), in `state`; null otherwise (the route
 * answers 404: a missing item, another person's personal one and an internal-only one look the same). `lock` takes
 * the item row (FOR SHARE: a place; FOR UPDATE: a change), after the workspace row in a write.
 */
export async function findItem(
  q: Queryable,
  caller: LibraryCaller,
  id: string,
  opts: { state: ItemState; now: Date; lock?: 'share' | 'update' },
): Promise<ItemRow | null> {
  if (!isItemId(id)) return null
  const params: unknown[] = [id]
  const ws = visibleItems('workspace', caller, params)
  const mine = visibleItems('personal', caller, params)
  let state = 'i.deleted_at IS NULL'
  if (opts.state === 'restorable') {
    params.push(restoreCutoff(opts.now))
    state = `i.deleted_at IS NOT NULL AND i.deleted_at > $${params.length}`
  }
  const lock = opts.lock === 'share' ? ' FOR SHARE OF i' : opts.lock === 'update' ? ' FOR UPDATE OF i' : ''
  return q.maybeOne<ItemRow>(
    `SELECT ${ITEM_COLUMNS} ${ITEM_FROM}
      WHERE i.id = $1 AND ((${ws}) OR (${mine})) AND ${state}${lock}`,
    params,
  )
}

// ---- folders ----------------------------------------------------------------------------------------------

export interface FolderRow {
  id: string
  workspace_id: string
  owner_id: string | null
  name: string
  position: number
  created_by: string | null
}

export const FOLDER_COLUMNS = 'f.id, f.workspace_id, f.owner_id, f.name, f.position, f.created_by'

export function canEditFolder(
  row: Pick<FolderRow, 'owner_id' | 'created_by'>,
  caller: LibraryCaller,
): boolean {
  if (row.owner_id !== null) return row.owner_id === caller.userId
  return caller.creator && (caller.manager || row.created_by === caller.userId)
}

export const toFolder = (r: FolderRow, itemCount: number, caller: LibraryCaller): LibraryFolder => ({
  id: r.id,
  scope: scopeOf(r),
  name: r.name,
  position: Number(r.position),
  itemCount,
  canEdit: canEditFolder(r, caller),
})

/** The folder `id` of `scope` the caller may see (a workspace folder, or their own personal one), or null. */
export async function findFolder(
  q: Queryable,
  caller: LibraryCaller,
  id: string,
  opts: { scope?: LibraryScope; lock?: boolean } = {},
): Promise<FolderRow | null> {
  if (!isFolderId(id)) return null
  const params: unknown[] = [id, caller.workspaceId]
  let scope = 'f.owner_id IS NULL'
  if (opts.scope !== 'workspace') {
    params.push(caller.userId)
    scope = opts.scope === 'personal' ? 'f.owner_id = $3' : '(f.owner_id IS NULL OR f.owner_id = $3)'
  }
  return q.maybeOne<FolderRow>(
    `SELECT ${FOLDER_COLUMNS} FROM library_folders f
      WHERE f.id = $1 AND f.workspace_id = $2 AND ${scope}${opts.lock ? ' FOR UPDATE' : ''}`,
    params,
  )
}

/** One item by id, whoever asks (a route that just wrote it, or already decided it may be seen). */
export const itemById = (q: Queryable, id: string) =>
  q.one<ItemRow>(`SELECT ${ITEM_COLUMNS} ${ITEM_FROM} WHERE i.id = $1`, [id])

/** Whether `scope` has room for `n` more live items (409 LIBRARY_FULL otherwise). Under the workspace row lock. */
export async function requireItemRoom(
  q: Queryable,
  caller: LibraryCaller,
  scope: LibraryScope,
  n: number,
): Promise<number> {
  const left = itemCap(scope) - (await liveItemCount(q, caller, scope))
  if (left < n) throw libraryFull('items', scope)
  return left
}

export async function liveItemCount(q: Queryable, caller: LibraryCaller, scope: LibraryScope) {
  const { n } =
    scope === 'workspace'
      ? await q.one<{ n: number }>(
          `SELECT count(*)::int AS n FROM library_items
            WHERE workspace_id = $1 AND owner_id IS NULL AND deleted_at IS NULL`,
          [caller.workspaceId],
        )
      : await q.one<{ n: number }>(
          `SELECT count(*)::int AS n FROM library_items
            WHERE workspace_id = $1 AND owner_id = $2 AND deleted_at IS NULL`,
          [caller.workspaceId, caller.userId],
        )
  return n
}

/** A folder id from a request body: one of the item's own scope, else 400 (it came from the caller). */
export async function requireFolderIn(
  q: Queryable,
  caller: LibraryCaller,
  folderId: string | null,
  scope: LibraryScope,
): Promise<void> {
  if (folderId === null) return
  if (!(await findFolder(q, caller, folderId, { scope })))
    throw badRequest('folderId: no such folder in this library')
}

// ---- the list cursor ----------------------------------------------------------------------------------------

/** Postgres' text form of a timestamptz (ISO DateStyle), e.g. `2026-10-15 07:00:00.123456+00`. */
const PG_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:[+-]\d{2}(?::?\d{2}){0,2})?$/

export const encodeCursor = (row: Pick<ItemRow, 'cursor_at' | 'id'>) =>
  Buffer.from(JSON.stringify([row.cursor_at, row.id])).toString('base64url')

/** The (updated_at text, id) a cursor names; 400 when it is not one this api made. */
export function decodeCursor(cursor: string): { at: string; id: string } {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    value = null
  }
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== 'string' ||
    !PG_TIMESTAMP.test(value[0]) ||
    !isItemId(value[1])
  )
    throw badRequest('cursor: not valid')
  return { at: value[0], id: value[1] }
}

/** `%…%` for LIKE, with the caller's own `%`, `_` and `\` matched literally (ESCAPE '\'). */
export const likeContains = (text: string) => `%${text.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`
