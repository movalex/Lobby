// The library's items (OWNER: WS2, wave Q; docs/WAVE-Q-CONTRACTS.md §2.1-§2.5): list and search, one item, save a
// selection, change, delete (soft) and restore, and the thumb of a version an item shows. The rules are model.ts';
// the element and file checks elements.ts'.
//
// Saving (POST, and PATCH with new elements) needs view access to the source board, in this workspace, and the board's
// export policy (export-control mayExport, as workspace templates read it): else 403 LIBRARY_EXPORT_REFUSED. A save
// from a board of an internal-only project (or workspace) makes an internal-only item, decided under the workspace
// row lock the switch takes. Every write takes the workspace row first (requireCreatingRoleLocked: the caller's
// membership is read again under it, so a member removal and a save run one after the other), then the item row.
// Audit rows (ids, scopes and counts only) for create, delete and restore. Nothing here logs names or content.

import {
  CreateLibraryItemInput,
  LIBRARY_CODES,
  LIBRARY_LIMITS,
  LIBRARY_ROUTES,
  LIBRARY_VERSION_ID_PATTERN,
  type LibraryItem,
  type LibraryItemSummary,
  type LibraryScope,
  ListLibraryQuery,
  type ListLibraryResponse,
  PatchLibraryItemInput,
} from '@draftroom/contracts'
import { pgErrorCode, type Queryable } from '@draftroom/db'
import { can } from '@draftroom/permissions'
import type { FastifyInstance } from 'fastify'
import { type BoardAccess, loadBoardAccess, requireCreatingRoleLocked } from '../../access.ts'
import { audit } from '../../audit.ts'
import type { Params } from '../../context.ts'
import { ApiError, conflict, forbidden, notFound, parse } from '../../errors.ts'
import { DERIVATIVE_MIMES } from '../../files/mime.ts'
import type { KeyedLimit } from '../../rate-limit.ts'
import type { FeatureContext } from '../context.ts'
import { mayExport } from '../export-control/policy.ts'
import {
  fileNotServable,
  insertItemFiles,
  type PreparedItem,
  problemError,
  savedInternalOnly,
  serializeReceived,
  withServableFiles,
} from './elements.ts'
import {
  canEditItem,
  decodeCursor,
  encodeCursor,
  findItem,
  ITEM_COLUMNS,
  ITEM_FROM,
  type ItemRow,
  isLiveLibraryRoute,
  itemById,
  type LibraryCaller,
  libraryCaller,
  likeContains,
  newLibraryId,
  requireFolderIn,
  requireItemRoom,
  requireScopeWriter,
  restoreCutoff,
  scopeOf,
  toSummary,
  visibleItems,
} from './model.ts'

const R = LIBRARY_ROUTES
/** A save's body: the elements (≤ 256 KiB once serialized) and a small envelope, with room for the client's form. */
export const SAVE_BODY_LIMIT = 2 * LIBRARY_LIMITS.itemBytes
const FOREIGN_KEY_VIOLATION = '23503'

const NOT_YOURS = 'Only its author or a workspace owner or admin can change this library item.'
const EXPORT_REFUSED =
  'Copying from this board is limited to its editors, so its content cannot be saved to the library.'

export const exportRefused = () => new ApiError(403, LIBRARY_CODES.exportRefused, EXPORT_REFUSED)
const staleRevision = () =>
  conflict(
    LIBRARY_CODES.staleRevision,
    'Someone changed this library item meanwhile. Reload it and try again.',
  )

/** The board a save copies from: one of this workspace the caller can view, whose export policy lets them copy. */
export async function sourceBoard(
  q: Queryable,
  workspaceId: string,
  boardId: string,
  userId: string,
): Promise<BoardAccess> {
  const access = await loadBoardAccess(q, boardId, userId)
  if (!access || access.board.workspace_id !== workspaceId || !can(access.role, 'view', access.board.status))
    throw notFound()
  if (!(await mayExport(q, access, userId))) throw exportRefused()
  return access
}

/** The checked elements of a save from `boardId` (serializer, then the file checks). */
async function prepare(q: Queryable, workspaceId: string, boardId: string, elements: readonly unknown[]) {
  const result = await serializeReceived(elements)
  if (!result.ok) throw problemError(result.problem, result.count)
  return withServableFiles(q, workspaceId, boardId, result.item)
}

/** A version removed by the file collector between the check and the write: the save refuses as unservable. */
async function mapFileRace<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (pgErrorCode(err) === FOREIGN_KEY_VIOLATION) throw fileNotServable()
    throw err
  }
}

/** The caller of a write to an existing item: may see it (else 404), may write its scope, and may change it. */
async function editableItem(
  ctx: FeatureContext,
  caller: LibraryCaller,
  id: string,
  state: 'live' | 'restorable',
  route: string,
): Promise<ItemRow> {
  const row = await findItem(ctx.db, caller, id, { state, now: ctx.now() })
  if (!row) throw notFound()
  await requireScopeWriter(ctx, ctx.db, caller, scopeOf(row), route)
  if (!canEditItem(row, caller)) throw forbidden(NOT_YOURS)
  return row
}

export function registerLibraryItems(
  app: FastifyInstance,
  ctx: FeatureContext,
  limits: { save: KeyedLimit },
): void {
  const { db } = ctx

  if (isLiveLibraryRoute(`GET ${R.list}`))
    app.get(R.list, async (req): Promise<ListLibraryResponse> => {
      const user = await ctx.requireUser(req)
      const { wid = '' } = req.params as Params
      const caller = await libraryCaller(ctx, db, wid, user)
      const query = parse(ListLibraryQuery, req.query ?? {})
      const params: unknown[] = []
      const where = [visibleItems(query.scope, caller, params)]
      if (query.deleted) {
        // "Recently deleted": what this caller could restore
        if (query.scope === 'workspace' && !caller.creator) return { items: [], nextCursor: null }
        params.push(restoreCutoff(ctx.now()))
        where.push(`i.deleted_at IS NOT NULL AND i.deleted_at > $${params.length}`)
        if (query.scope === 'workspace' && !caller.manager) {
          params.push(caller.userId)
          where.push(`i.created_by = $${params.length}`)
        }
      } else where.push('i.deleted_at IS NULL')
      if (query.folder === 'none') where.push('i.folder_id IS NULL')
      else if (query.folder) {
        params.push(query.folder)
        where.push(`i.folder_id = $${params.length}`)
      }
      if (query.tag) {
        params.push(query.tag)
        where.push(`$${params.length} = ANY (i.tags)`)
      }
      if (query.q) {
        params.push(likeContains(query.q))
        const p = `$${params.length}`
        where.push(
          `(lower(i.name) LIKE ${p} ESCAPE '\\' OR EXISTS (SELECT 1 FROM unnest(i.tags) AS t(tag) WHERE t.tag LIKE ${p} ESCAPE '\\'))`,
        )
      }
      if (query.cursor) {
        const c = decodeCursor(query.cursor)
        params.push(c.at, c.id)
        where.push(`(i.updated_at, i.id) < ($${params.length - 1}::timestamptz, $${params.length})`)
      }
      const rows = (
        await db.query<ItemRow>(
          `SELECT ${ITEM_COLUMNS} ${ITEM_FROM}
            WHERE ${where.join(' AND ')}
            ORDER BY i.updated_at DESC, i.id DESC
            LIMIT ${LIBRARY_LIMITS.pageSize + 1}`,
          params,
        )
      ).rows
      const page = rows.slice(0, LIBRARY_LIMITS.pageSize)
      const last = page.at(-1)
      return {
        items: page.map((r) => toSummary(r, caller)),
        nextCursor: rows.length > LIBRARY_LIMITS.pageSize && last ? encodeCursor(last) : null,
      }
    })

  if (isLiveLibraryRoute(`GET ${R.item}`))
    app.get(R.item, async (req): Promise<LibraryItem> => {
      const user = await ctx.requireUser(req)
      const { wid = '', id = '' } = req.params as Params
      const caller = await libraryCaller(ctx, db, wid, user)
      const row = await findItem(db, caller, id, { state: 'live', now: ctx.now() })
      if (!row) throw notFound()
      const { elements } = await db.one<{ elements: Record<string, unknown>[] }>(
        'SELECT elements FROM library_items WHERE id = $1',
        [id],
      )
      const files = await db.query<{ asset_id: string; version_id: string }>(
        'SELECT asset_id, version_id FROM library_item_files WHERE item_id = $1 ORDER BY version_id',
        [id],
      )
      return {
        ...toSummary(row, caller),
        elements,
        files: files.rows.map((f) => ({ assetId: f.asset_id, versionId: f.version_id })),
        source: await sourceFor(db, row, user.id),
      }
    })

  if (isLiveLibraryRoute(`POST ${R.items}`))
    app.route({
      method: 'POST',
      url: R.items,
      bodyLimit: SAVE_BODY_LIMIT,
      handler: async (req, reply): Promise<LibraryItemSummary> => {
        const user = await ctx.requireUser(req)
        const { wid = '' } = req.params as Params
        limits.save.take(user.id)
        const input = parse(CreateLibraryItemInput, req.body)
        const caller = await libraryCaller(ctx, db, wid, user)
        await requireScopeWriter(ctx, db, caller, input.scope, req.routeOptions.url ?? '')
        const board = await sourceBoard(db, wid, input.sourceBoardId, user.id)
        const item = await prepare(db, wid, board.board.id, input.elements)
        const row = await mapFileRace(() =>
          db.transaction(async (tx) => {
            await requireCreatingRoleLocked(tx, wid, user.id)
            await requireFolderIn(tx, caller, input.folderId, input.scope)
            await requireItemRoom(tx, caller, input.scope, 1)
            const id = newLibraryId('lbi')
            await insertItem(tx, {
              id,
              caller,
              scope: input.scope,
              folderId: input.folderId,
              name: input.name,
              tags: input.tags,
              item,
              source: { kind: 'board', boardId: board.board.id },
              internalOnly: await savedInternalOnly(tx, board.board.id),
              at: ctx.now(),
            })
            await audit(tx, {
              workspaceId: wid,
              actorId: user.id,
              action: 'library.item.create',
              target: id,
              detail: {
                scope: input.scope,
                sourceBoardId: board.board.id,
                elements: item.elementCount,
                images: item.imageCount,
              },
              at: ctx.now(),
            })
            return itemById(tx, id)
          }),
        )
        reply.code(201)
        return toSummary(row, caller)
      },
    })

  if (isLiveLibraryRoute(`PATCH ${R.item}`))
    app.route({
      method: 'PATCH',
      url: R.item,
      bodyLimit: SAVE_BODY_LIMIT,
      handler: async (req): Promise<LibraryItemSummary> => {
        const user = await ctx.requireUser(req)
        const { wid = '', id = '' } = req.params as Params
        const input = parse(PatchLibraryItemInput, req.body)
        if (input.elements) limits.save.take(user.id)
        const caller = await libraryCaller(ctx, db, wid, user)
        const peek = await editableItem(ctx, caller, id, 'live', req.routeOptions.url ?? '')
        const scope = scopeOf(peek)
        let replaced: { item: PreparedItem; boardId: string } | null = null
        if (input.elements && input.sourceBoardId) {
          const board = await sourceBoard(db, wid, input.sourceBoardId, user.id)
          replaced = {
            item: await prepare(db, wid, board.board.id, input.elements),
            boardId: board.board.id,
          }
        }
        const row = await mapFileRace(() =>
          db.transaction(async (tx) => {
            await requireCreatingRoleLocked(tx, wid, user.id)
            const cur = await findItem(tx, caller, id, { state: 'live', now: ctx.now(), lock: 'update' })
            if (!cur) throw notFound()
            if (!canEditItem(cur, caller)) throw forbidden(NOT_YOURS)
            if (Number(cur.revision) !== input.revision) throw staleRevision()
            const params: unknown[] = [id, ctx.now(), user.id]
            const sets = ['revision = revision + 1', 'updated_at = $2', 'updated_by = $3']
            const set = (sql: string, value: unknown) => {
              params.push(value)
              sets.push(sql.replace('?', `$${params.length}`))
            }
            if (input.name !== undefined) set('name = ?', input.name)
            if (input.tags !== undefined) set('tags = ?::text[]', input.tags)
            if (input.folderId !== undefined) {
              await requireFolderIn(tx, caller, input.folderId, scope)
              set('folder_id = ?', input.folderId)
            }
            if (replaced) {
              const { item, boardId } = replaced
              set('elements = ?::jsonb', JSON.stringify(item.elements))
              set('element_count = ?', item.elementCount)
              set('image_count = ?', item.imageCount)
              set('bytes = ?', item.bytes)
              set('width = ?', item.width)
              set('height = ?', item.height)
              set('source = ?::jsonb', JSON.stringify({ kind: 'board', boardId }))
              // new content from an internal-only board makes the item internal; it never becomes less so
              set('internal_only = internal_only OR ?', await savedInternalOnly(tx, boardId))
            }
            await tx.query(`UPDATE library_items SET ${sets.join(', ')} WHERE id = $1`, params)
            if (replaced) {
              await tx.query('DELETE FROM library_item_files WHERE item_id = $1', [id])
              await insertItemFiles(tx, id, wid, replaced.item.files)
            }
            return itemById(tx, id)
          }),
        )
        return toSummary(row, caller)
      },
    })

  if (isLiveLibraryRoute(`DELETE ${R.item}`))
    app.delete(R.item, async (req, reply) => {
      const user = await ctx.requireUser(req)
      const { wid = '', id = '' } = req.params as Params
      const caller = await libraryCaller(ctx, db, wid, user)
      await editableItem(ctx, caller, id, 'live', req.routeOptions.url ?? '')
      await db.transaction(async (tx) => {
        // the workspace row first, then the item (a place holds the item FOR SHARE: they run one after the other)
        await requireCreatingRoleLocked(tx, wid, user.id)
        const cur = await findItem(tx, caller, id, { state: 'live', now: ctx.now(), lock: 'update' })
        if (!cur) throw notFound()
        if (!canEditItem(cur, caller)) throw forbidden(NOT_YOURS)
        const at = ctx.now()
        await tx.query(
          `UPDATE library_items SET deleted_at = $2, updated_at = $2, updated_by = $3, revision = revision + 1
            WHERE id = $1`,
          [id, at, user.id],
        )
        await audit(tx, {
          workspaceId: wid,
          actorId: user.id,
          action: 'library.item.delete',
          target: id,
          detail: { scope: scopeOf(cur) },
          at,
        })
      })
      reply.code(204)
      return null
    })

  if (isLiveLibraryRoute(`POST ${R.restore}`))
    app.post(R.restore, async (req): Promise<LibraryItemSummary> => {
      const user = await ctx.requireUser(req)
      const { wid = '', id = '' } = req.params as Params
      const caller = await libraryCaller(ctx, db, wid, user)
      await editableItem(ctx, caller, id, 'restorable', req.routeOptions.url ?? '')
      const row = await db.transaction(async (tx) => {
        await requireCreatingRoleLocked(tx, wid, user.id)
        const cur = await findItem(tx, caller, id, { state: 'restorable', now: ctx.now(), lock: 'update' })
        if (!cur) throw notFound()
        if (!canEditItem(cur, caller)) throw forbidden(NOT_YOURS)
        await requireItemRoom(tx, caller, scopeOf(cur), 1)
        const at = ctx.now()
        await tx.query(
          `UPDATE library_items SET deleted_at = NULL, updated_at = $2, updated_by = $3, revision = revision + 1
            WHERE id = $1`,
          [id, at, user.id],
        )
        await audit(tx, {
          workspaceId: wid,
          actorId: user.id,
          action: 'library.item.restore',
          target: id,
          detail: { scope: scopeOf(cur) },
          at,
        })
        return itemById(tx, id)
      })
      return toSummary(row, caller)
    })

  if (isLiveLibraryRoute(`GET ${R.thumb}`))
    app.get(R.thumb, async (req, reply) => {
      const user = await ctx.requireUser(req)
      const { wid = '', id = '', ver = '' } = req.params as Params
      const caller = await libraryCaller(ctx, db, wid, user)
      // a live item, or one in the caller's "Recently deleted"
      const now = ctx.now()
      const deleted = await findItem(db, caller, id, { state: 'restorable', now })
      const row =
        (await findItem(db, caller, id, { state: 'live', now })) ??
        (deleted && canEditItem(deleted, caller) ? deleted : null)
      if (!row || !LIBRARY_VERSION_ID_PATTERN.test(ver)) throw notFound()
      // only a version the item shows (library_item_files), of the item's own workspace, and only its published thumb
      const d = await db.maybeOne<{ blob_key: string; mime_type: string; bytes: number }>(
        `SELECT d.blob_key, d.mime_type, d.bytes::float8 AS bytes
           FROM library_item_files f
           JOIN asset_versions v ON v.asset_id = f.asset_id AND v.id = f.version_id AND v.workspace_id = f.workspace_id
           JOIN asset_derivatives d ON d.version_id = v.id AND d.role = 'thumb'
          WHERE f.item_id = $1 AND f.version_id = $2 AND f.workspace_id = $3
          ORDER BY d.position LIMIT 1`,
        [id, ver, wid],
      )
      if (!d || !DERIVATIVE_MIMES.includes(d.mime_type)) throw notFound()
      const obj = await ctx.blobs.get(d.blob_key)
      if (!obj) throw notFound()
      reply.headers({
        'Content-Type': d.mime_type,
        'Content-Length': String(obj.contentLength),
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "sandbox; default-src 'none'",
        // access can change (a removal, an item made internal): a short private cache only
        'Cache-Control': 'private, max-age=300',
      })
      if (req.method === 'HEAD') {
        ;(obj.body as { destroy?: () => void }).destroy?.()
        return reply.send()
      }
      return reply.send(obj.body)
    })
}

/** An item's source as its reader may see it: a board's id only while they can view that board. */
async function sourceFor(q: Queryable, row: ItemRow, userId: string): Promise<LibraryItem['source']> {
  const source = row.source as LibraryItem['source']
  if (source.kind !== 'board') return source
  const access = source.boardId ? await loadBoardAccess(q, source.boardId, userId) : null
  const visible =
    !!access &&
    access.board.workspace_id === row.workspace_id &&
    can(access.role, 'view', access.board.status)
  return { kind: 'board', boardId: visible ? source.boardId : null }
}

/** One new item row (the caller's transaction holds the workspace row and checked the room). */
export async function insertItem(
  tx: Queryable,
  v: {
    id: string
    caller: LibraryCaller
    scope: LibraryScope
    folderId: string | null
    name: string
    tags: string[]
    item: PreparedItem
    source: Record<string, unknown>
    internalOnly: boolean
    at: Date
  },
): Promise<void> {
  const { caller, item } = v
  await tx.query(
    `INSERT INTO library_items (id, workspace_id, owner_id, folder_id, name, tags, elements, element_count,
       image_count, bytes, width, height, source, internal_only, revision, created_by, updated_by, created_at,
       updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::text[], $7::jsonb, $8, $9, $10, $11, $12, $13::jsonb, $14, 1, $15, $15, $16, $16)`,
    [
      v.id,
      caller.workspaceId,
      v.scope === 'personal' ? caller.userId : null,
      v.folderId,
      v.name,
      v.tags,
      JSON.stringify(item.elements),
      item.elementCount,
      item.imageCount,
      item.bytes,
      item.width,
      item.height,
      JSON.stringify(v.source),
      v.internalOnly,
      caller.userId,
      v.at,
    ],
  )
  await insertItemFiles(tx, v.id, caller.workspaceId, item.files)
}
