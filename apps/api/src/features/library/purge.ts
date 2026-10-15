// The purge of deleted library items (OWNER: WS2, wave Q; docs/WAVE-Q-CONTRACTS.md §2.4): a soft-deleted item is
// restorable for LIBRARY_LIMITS.restoreDays, then removed for good, with its library_item_files rows (they cascade).
// Until then those rows keep the versions it shows (files/gc.ts counts them as references), so a restore brings the
// images back. A place holds the item row FOR SHARE, so a purge waits for it (and a restore, which needs the item
// within the window, never meets a purge, which needs it past the window). One API instance (docs/DEPLOY.md): the
// sweeper runs hourly in this process; nothing is logged but the count.

import type { Queryable } from '@draftroom/db'
import type { FastifyInstance } from 'fastify'
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

export function startLibraryPurge(app: FastifyInstance, ctx: FeatureContext): void {
  let timer: ReturnType<typeof setInterval> | null = null
  let running: Promise<void> | null = null
  app.addHook('onReady', async () => {
    timer = setInterval(() => {
      if (running) return
      running = purgeDeletedLibraryItems(ctx.db, ctx.now())
        .then((n) => {
          if (n) app.log.info({ feature: 'library', purged: n }, 'library purge')
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
