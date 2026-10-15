// POST /api/boards/:bid/library/items/:id/place (OWNER: WS2, wave Q; docs/WAVE-Q-CONTRACTS.md §2.2, §2.5): an item's
// elements for this board, its files linked into the board first.
//
// - The caller edits the board (requireBoardAction 'edit': 404 when they cannot see it, 403 for a viewer, a commenter
//   or an archived board; a trashed board is invisible), is an owner, admin or member of ITS workspace (a board-only
//   collaborator, a workspace guest: 403) and reads the item there: the item is looked up in the board's workspace
//   only, so an item of another workspace is the same 404 as a missing one (no leak, and files never cross a
//   workspace).
// - IO-1's rule for content leaving an internal-only scope: an internal-only item goes onto a board outside every
//   internal-only scope (no internal-only project, the workspace not internal only) only for a workspace owner or admin
//   who is a creator; anyone else gets 409 INTERNAL_ONLY with the project's words.
// - In one transaction: the item row FOR SHARE (a delete, which takes it FOR UPDATE after the workspace row, runs
//   before or after, never between: deleted first, this answers 404 and links nothing), then a board_asset_links row
//   for each version the item shows that the board does not own, so the sync's file-refs check (A1) and /files serve
//   them on this board, and the caller's Recents mark. The client calls this BEFORE it pushes the elements (sync caches
//   a negative file-refs answer for 30 s).
// - Per person 120 a minute (LIBRARY_RATE_LIMITS.place).

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
import { type BoardRow, requireBoardAction } from '../../access.ts'
import type { Params } from '../../context.ts'
import { conflict, notFound } from '../../errors.ts'
import type { KeyedLimit } from '../../rate-limit.ts'
import type { FeatureContext } from '../context.ts'
import { guestRefused, LIBRARY_GUESTS } from '../guests/guard.ts'
import { stampUse } from './marks.ts'
import { findItem, isLiveLibraryRoute, libraryCaller } from './model.ts'

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
  limits: { place: KeyedLimit },
): void {
  const { db } = ctx
  if (!isLiveLibraryRoute(`POST ${R.place}`)) return

  app.post(R.place, async (req): Promise<PlaceLibraryItemResponse> => {
    const user = await ctx.requireUser(req)
    if (user.kind === 'guest') throw guestRefused(LIBRARY_GUESTS)
    limits.place.take(user.id)
    const { bid = '', id = '' } = req.params as Params
    const access = await requireBoardAction(db, bid, user.id, 'edit')
    const wid = access.board.workspace_id
    const caller = await libraryCaller(ctx, db, wid, user)
    const peek = await findItem(db, caller, id, { state: 'live', now: ctx.now() })
    if (!peek) throw notFound()
    if (
      peek.internal_only &&
      !(caller.manager && caller.creator) &&
      !(await insideInternalOnly(db, access.board))
    )
      throw conflict(INTERNAL_ONLY_CODE, INTERNAL_ONLY_MESSAGES.project)
    return db.transaction(async (tx) => {
      const item = await findItem(tx, caller, id, { state: 'live', now: ctx.now(), lock: 'share' })
      if (!item) throw notFound()
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
      if (linked.length)
        await tx.query(
          `INSERT INTO board_asset_links (workspace_id, board_id, asset_id, version_id, created_at)
           SELECT $1, $2, a, v, $5 FROM unnest($3::text[], $4::text[]) AS t(a, v)
           ON CONFLICT (board_id, asset_id, version_id) DO NOTHING`,
          [wid, bid, linked.map((f) => f.asset_id), linked.map((f) => f.id), ctx.now()],
        )
      await stampUse(tx, caller, libraryMarkKey({ source: 'item', id }), ctx.now())
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
}
