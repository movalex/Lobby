// The purge of deleted library items (OWNER: WS2, wave Q; docs/WAVE-Q-CONTRACTS.md §2.4): a soft-deleted item is
// restorable for LIBRARY_LIMITS.restoreDays, then removed for good, with its library_item_files rows (they cascade).
// Until then those rows keep the versions it shows (files/gc.ts counts them as references), so a restore brings the
// images back. A place holds the item row FOR SHARE, so a purge waits for it (and a restore, which needs the item
// within the window, never meets a purge, which needs it past the window). One API instance (docs/DEPLOY.md): the
// sweeper runs hourly in this process; nothing is logged but the count.
//
// The same pass sweeps the links of places never confirmed (review fix; 0034, ./place.ts): a library_place_pending row
// older than PLACE_PENDING_MS is deleted, and its link with it unless the board shows that version now (sync's asset
// refs: its canvas or its "Recently deleted"; a push whose confirm was lost, then an undo, keeps its link). A board sync
// cannot read keeps its rows for the next pass (never a guess). Only links /place created have rows, so no link that
// existed before a place is ever removed. A confirm and the sweep both delete the pending row first: whichever comes
// second finds nothing (a confirm first: the link stays; the sweep first: the confirm is a no-op).

import type { Db, Queryable } from '@draftroom/db'
import type { FastifyInstance } from 'fastify'
import { parseBoardRefs } from '../../files/gc-refs.ts'
import type { FeatureContext } from '../context.ts'
import { restoreCutoff } from './model.ts'

export const PURGE_INTERVAL_MS = 60 * 60_000
/** Items per statement: a large backlog goes in several passes, never one long lock. */
const PURGE_BATCH = 500

/** Removes the items deleted before the restore window; returns how many. */
export async function purgeDeletedLibraryItems(q: Queryable, now: Date): Promise<number> {
  let total = 0
  for (;;) {
    const r = await q.query(
      `DELETE FROM library_items WHERE id IN (
         SELECT id FROM library_items WHERE deleted_at IS NOT NULL AND deleted_at <= $1
          ORDER BY deleted_at LIMIT ${PURGE_BATCH})`,
      [restoreCutoff(now)],
    )
    total += r.rowCount
    if (r.rowCount < PURGE_BATCH) return total
  }
}

/** How long a link /place made waits for its confirm. */
export const PLACE_PENDING_MS = 60 * 60_000
/** Boards per sweep (each one sync read). */
const SWEEP_BOARDS = 200

/** The versions a board shows (its canvas and "Recently deleted"), or null when that cannot be read. */
export type BoardShows = (boardId: string) => Promise<ReadonlySet<string> | null>

/** BoardShows through the sync server's asset refs (the file collector's source, files/gc.ts). */
export function boardShowsVia(sync: { assetRefs?(boardId: string): Promise<unknown> }): BoardShows {
  return async (boardId) => {
    if (!sync.assetRefs) return null
    try {
      const refs = parseBoardRefs(await sync.assetRefs(boardId), boardId)
      if (!refs || refs.partial) return null
      return new Set([
        ...refs.canvas.map((r) => r.versionId),
        ...refs.deleted.map((r) => r.versionId),
        ...refs.versions,
      ])
    } catch {
      return null
    }
  }
}

/** Removes the links of places older than PLACE_PENDING_MS that were never confirmed (see the module comment). */
export async function sweepPlacePending(
  db: Db,
  now: Date,
  shows: BoardShows,
): Promise<{ removed: number; kept: number; unread: number }> {
  const cutoff = new Date(now.getTime() - PLACE_PENDING_MS)
  const out = { removed: 0, kept: 0, unread: 0 }
  const boards = await db.query<{ board_id: string }>(
    `SELECT board_id FROM library_place_pending WHERE created_at <= $1
      GROUP BY board_id ORDER BY min(created_at) LIMIT ${SWEEP_BOARDS}`,
    [cutoff],
  )
  for (const { board_id: boardId } of boards.rows) {
    const shown = await shows(boardId)
    if (!shown) {
      out.unread++
      continue
    }
    await db.transaction(async (tx) => {
      // the pending rows first (a confirm deletes them too: one waits for the other), then the links
      const gone = await tx.query<{ asset_id: string; version_id: string }>(
        `DELETE FROM library_place_pending WHERE board_id = $1 AND created_at <= $2
         RETURNING asset_id, version_id`,
        [boardId, cutoff],
      )
      const drop = gone.rows.filter((r) => !shown.has(r.version_id))
      out.kept += gone.rows.length - drop.length
      if (!drop.length) return
      const r = await tx.query(
        `DELETE FROM board_asset_links
          WHERE board_id = $1 AND (asset_id, version_id) IN (SELECT * FROM unnest($2::text[], $3::text[]))`,
        [boardId, drop.map((d) => d.asset_id), drop.map((d) => d.version_id)],
      )
      out.removed += r.rowCount
    })
  }
  return out
}

export function startLibraryPurge(app: FastifyInstance, ctx: FeatureContext): void {
  let timer: ReturnType<typeof setInterval> | null = null
  let running: Promise<void> | null = null
  app.addHook('onReady', async () => {
    timer = setInterval(() => {
      if (running) return
      running = purgeDeletedLibraryItems(ctx.db, ctx.now())
        .then(async (n) => {
          if (n) app.log.info({ feature: 'library', purged: n }, 'library purge')
          const s = await sweepPlacePending(ctx.db, ctx.now(), boardShowsVia(ctx.sync))
          if (s.removed || s.unread)
            app.log.info({ feature: 'library', unconfirmedLinks: s.removed, unreadBoards: s.unread }, 'library sweep')
        })
        .catch((e) => app.log.warn({ err: { message: (e as Error)?.message } }, 'library purge failed'))
        .finally(() => {
          running = null
        })
    }, PURGE_INTERVAL_MS)
    timer.unref()
  })
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer)
    timer = null
    await running // the database closes after this hook
  })
}
