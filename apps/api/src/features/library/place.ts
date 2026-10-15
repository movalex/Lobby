// POST /api/boards/:bid/library/items/:id/place (OWNER: WS2, wave Q; docs/WAVE-Q-CONTRACTS.md §2.2, §2.5, §9): an
// item's elements for this board, its files linked into the board first; and POST …/place/confirm once the client's
// push of those elements succeeded.
//
// - The caller edits the board (requireBoardAction 'edit': 404 when they cannot see it, 403 for a viewer, a commenter
//   or an archived board; a trashed board is invisible), is an owner, admin or member of ITS workspace (a board-only
//   collaborator, a workspace guest: 403) and reads the item there: the item is looked up in the board's workspace
//   only, so an item of another workspace is the same 404 as a missing one (no leak, and files never cross a
//   workspace).
// - One transaction, in the lock order (access.ts): the workspace row FOR SHARE first (the Internal only switch, a
//   member removal and every library write take it FOR NO KEY UPDATE, so they run before or after this place, never
//   between its checks and its links), the caller's membership read again under it, then the item row FOR SHARE (a
//   delete, which takes it FOR UPDATE after the workspace row, runs before or after: deleted first, this answers 404
//   and links nothing). Every rule below is decided there, on what is committed.
// - IO-1's rule for content leaving an internal-only scope: an internal-only item goes onto a board outside every
//   internal-only scope (no internal-only project, the workspace not internal only) only for a workspace owner or admin
//   who is a creator; anyone else gets 409 INTERNAL_ONLY with the project's words.
// - The source board's export policy (review fix): while the board an item was saved from exists, a caller whom its
//   policy does not let copy from it (policy 'editors', below editor on it, or no access at all) gets 403
//   EXPORT_DISABLED, as a duplicate or a workspace template does. Once that board is gone, an item saved under such a
//   limit (library_items.source_export_limited, captured at save) is placed only by the person who saved it. What
//   this cannot catch: shapes and words cannot be fingerprinted, so whoever may copy them can redraw them anywhere.
// - Then a board_asset_links row for each version the item shows that the board does not own, so the sync's
//   file-refs check (A1) and /files serve them on this board, and the caller's Recents mark. The client calls this
//   BEFORE it pushes the elements (sync caches a negative file-refs answer for 30 s).
// - Each link this place CREATES (never one that was there) gets a library_place_pending row (0034); one that is still
//   pending gets a fresh one hour. The client confirms after its push (POST …/place/confirm deletes the rows); the
//   hourly sweep (./purge.ts sweepPlacePending) removes a link whose row is older than an hour and that the board does
//   not show. An undo after a successful push keeps the link, as an upload's file stays.
// - Per person 120 a minute each (LIBRARY_RATE_LIMITS.place).

import {
  INTERNAL_ONLY_CODE,
  INTERNAL_ONLY_MESSAGES,
  LIBRARY_ROUTES,
  type LibraryFileFacts,
  libraryMarkKey,
  type PlaceLibraryItemResponse,
} from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import type { FastifyInstance } from 'fastify'
import { type BoardRow, loadBoardAccess, requireBoardAction } from '../../access.ts'
import type { Params } from '../../context.ts'
import { conflict, notFound } from '../../errors.ts'
import type { KeyedLimit } from '../../rate-limit.ts'
import type { FeatureContext } from '../context.ts'
import { exportDisabled, loadExportPolicy, mayExport } from '../export-control/policy.ts'
import { guestRefused, LIBRARY_GUESTS } from '../guests/guard.ts'
import { stampUse } from './marks.ts'
import { findItem, type ItemRow, isItemId, isLiveLibraryRoute, libraryCaller } from './model.ts'

const R = LIBRARY_ROUTES

/** Whether a board is inside an internal-only scope (its project, or its whole workspace). */
async function insideInternalOnly(q: Queryable, board: Pick<BoardRow, 'id'>): Promise<boolean> {
  const r = await q.maybeOne<{ inside: boolean }>(
    `SELECT (w.internal_only OR COALESCE(p.internal_only, false)) AS inside
       FROM boards b JOIN workspaces w ON w.id = b.workspace_id
       LEFT JOIN projects p ON p.id = b.project_id AND p.workspace_id = b.workspace_id
      WHERE b.id = $1`,
    [board.id],
  )
  return r?.inside ?? false
}

/**
 * 403 EXPORT_DISABLED unless the caller may copy out of the item's source board (see the module comment): its policy
 * read now while it exists, the policy captured at save once it is gone.
 */
async function requireSourceExport(q: Queryable, item: ItemRow, userId: string): Promise<void> {
  const source = item.source as { kind?: unknown; boardId?: unknown } | null
  if (source?.kind !== 'board' || typeof source.boardId !== 'string') return
  const board = await q.maybeOne<{ id: string }>(
    'SELECT id FROM boards WHERE id = $1 AND workspace_id = $2',
    [source.boardId, item.workspace_id],
  )
  if (!board) {
    if (item.source_export_limited && item.created_by !== userId) throw exportDisabled()
    return
  }
  if ((await loadExportPolicy(q, board.id)) !== 'editors') return
  const access = await loadBoardAccess(q, board.id, userId)
  if (!access || !(await mayExport(q, access, userId))) throw exportDisabled()
}

interface FileRow {
  id: string
  asset_id: string
  board_id: string
  name: string
  mime_type: string
  kind: LibraryFileFacts['kind']
  size_bytes: number
}

export function registerLibraryPlace(
  app: FastifyInstance,
  ctx: FeatureContext,
  limits: { place: KeyedLimit; confirm: KeyedLimit },
): void {
  const { db } = ctx

  if (isLiveLibraryRoute(`POST ${R.place}`))
    app.post(R.place, async (req): Promise<PlaceLibraryItemResponse> => {
      const user = await ctx.requireUser(req)
      if (user.kind === 'guest') throw guestRefused(LIBRARY_GUESTS)
      limits.place.take(user.id)
      const { bid = '', id = '' } = req.params as Params
      const access = await requireBoardAction(db, bid, user.id, 'edit')
      const wid = access.board.workspace_id
      // the refusals that need no lock first (a stranger, a workspace guest)
      await libraryCaller(ctx, db, wid, user)
      return db.transaction(async (tx) => {
        await tx.query('SELECT id FROM workspaces WHERE id = $1 FOR SHARE', [wid])
        const caller = await libraryCaller(ctx, tx, wid, user)
        const now = ctx.now()
        const item = await findItem(tx, caller, id, { state: 'live', now, lock: 'share' })
        if (!item) throw notFound()
        if (
          item.internal_only &&
          !(caller.manager && caller.creator) &&
          !(await insideInternalOnly(tx, access.board))
        )
          throw conflict(INTERNAL_ONLY_CODE, INTERNAL_ONLY_MESSAGES.project)
        await requireSourceExport(tx, item, user.id)
        const { elements } = await tx.one<{ elements: Record<string, unknown>[] }>(
          'SELECT elements FROM library_items WHERE id = $1',
          [id],
        )
        const files = (
          await tx.query<FileRow>(
            `SELECT v.id, v.asset_id, v.board_id, v.name, v.mime_type, v.kind, v.size_bytes::float8 AS size_bytes
               FROM library_item_files f
               JOIN asset_versions v ON v.asset_id = f.asset_id AND v.id = f.version_id AND v.workspace_id = f.workspace_id
              WHERE f.item_id = $1 AND f.workspace_id = $2
              ORDER BY v.id`,
            [id, wid],
          )
        ).rows
        const linked = files.filter((f) => f.board_id !== bid)
        if (linked.length) {
          const assets = linked.map((f) => f.asset_id)
          const versions = linked.map((f) => f.id)
          // a link that is still pending (an earlier place not confirmed yet) gets a fresh hour. First, so a sweep
          // removing it (it holds the pending row, then the link) runs before this, and the link is then made anew
          // below; the sweep's order, pending row then link, is this one's too.
          await tx.query(
            `UPDATE library_place_pending SET created_at = $4
              WHERE board_id = $1 AND (asset_id, version_id) IN (SELECT * FROM unnest($2::text[], $3::text[]))`,
            [bid, assets, versions, now],
          )
          const made = await tx.query<{ asset_id: string; version_id: string }>(
            `INSERT INTO board_asset_links (workspace_id, board_id, asset_id, version_id, created_at)
             SELECT $1, $2, a, v, $5 FROM unnest($3::text[], $4::text[]) AS t(a, v)
             ON CONFLICT (board_id, asset_id, version_id) DO NOTHING
             RETURNING asset_id, version_id`,
            [wid, bid, assets, versions, now],
          )
          if (made.rows.length)
            await tx.query(
              `INSERT INTO library_place_pending (board_id, asset_id, version_id, created_at)
               SELECT $1, a, v, $4 FROM unnest($2::text[], $3::text[]) AS t(a, v)`,
              [bid, made.rows.map((r) => r.asset_id), made.rows.map((r) => r.version_id), now],
            )
        }
        await stampUse(tx, caller, libraryMarkKey({ source: 'item', id }), now)
        return {
          item: { id: item.id, name: item.name, revision: Number(item.revision) },
          elements,
          files: files.map((f) => ({
            assetId: f.asset_id,
            versionId: f.id,
            kind: f.kind,
            name: f.name.slice(0, 255),
            mimeType: f.mime_type,
            sizeBytes: Number(f.size_bytes),
          })),
        }
      })
    })

  // The push of a place's elements succeeded: the links that place made on this board stay. Whoever may edit the
  // board and use the library confirms (the links serve that board only; confirming early only keeps them, as the
  // push would). Always 204: it says nothing about the item.
  if (isLiveLibraryRoute(`POST ${R.placeConfirm}`))
    app.post(R.placeConfirm, async (req, reply) => {
      const user = await ctx.requireUser(req)
      if (user.kind === 'guest') throw guestRefused(LIBRARY_GUESTS)
      limits.confirm.take(user.id)
      const { bid = '', id = '' } = req.params as Params
      const access = await requireBoardAction(db, bid, user.id, 'edit')
      const wid = access.board.workspace_id
      await libraryCaller(ctx, db, wid, user)
      if (isItemId(id))
        await db.transaction((tx) => confirmPlace(tx, { boardId: bid, workspaceId: wid, itemId: id }))
      reply.code(204)
      return null
    })
}

/** Deletes the pending rows of the links a place of `itemId` made on `boardId` (they stay); how many. */
export async function confirmPlace(
  q: Queryable,
  v: { boardId: string; workspaceId: string; itemId: string },
): Promise<number> {
  const r = await q.query(
    `DELETE FROM library_place_pending p
      USING library_item_files f
      WHERE p.board_id = $1 AND f.item_id = $2 AND f.workspace_id = $3
        AND p.asset_id = f.asset_id AND p.version_id = f.version_id`,
    [v.boardId, v.itemId, v.workspaceId],
  )
  return r.rowCount
}
