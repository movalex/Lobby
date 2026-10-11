// The retention sweep of board_visits: rows last seen more than DRAFTROOM_VISITS_RETENTION_DAYS ago (default 180) are
// deleted. A board's or an account's deletion needs no sweep (ON DELETE CASCADE, also the offboarding sweep's account
// deletion). A pass deletes in small batches (oldest first, board_visits_seen_idx) so it never holds the table; it
// returns a count and logs the same, never a row.
//
// There was no general retention sweeper to join (the guest and review-link sweepers each own one rule), so this is
// the same small timer: started when the app is ready, first pass after `firstDelayMs` (a deploy restarts the api
// often and the pilot's instance can sleep, so it is not left to the next hour), then every `intervalMs`.

import type { FastifyInstance } from 'fastify'
import type { FeatureContext } from '../context.ts'
import { pruneVisits } from './store.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const BATCH = 1_000
/** A pass stops after this many batches (50,000 rows); the next pass takes the rest. */
const MAX_BATCHES = 50

/** Read when the feature registers (tests raise or lower them before building the app, like the guest sweep's). */
export const visitsSweepSettings = { intervalMs: 60 * 60 * 1000, firstDelayMs: 5 * 60 * 1000 }

/** One pass: deletes the rows past the retention. Returns how many went. */
export async function sweepVisits(
  ctx: Pick<FeatureContext, 'db' | 'now' | 'config'>,
  retentionDays: number = ctx.config.visitsRetentionDays,
): Promise<number> {
  const cutoff = new Date(ctx.now().getTime() - retentionDays * DAY_MS)
  let total = 0
  for (let i = 0; i < MAX_BATCHES; i++) {
    const n = await pruneVisits(ctx.db, cutoff, BATCH)
    total += n
    if (n < BATCH) break
  }
  return total
}

/** Runs sweepVisits on a timer while the app runs. */
export function startVisitsSweeper(app: FastifyInstance, ctx: FeatureContext): void {
  const { intervalMs, firstDelayMs } = visitsSweepSettings
  let first: ReturnType<typeof setTimeout> | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let running: Promise<void> | null = null
  const pass = () => {
    if (running) return
    running = sweepVisits(ctx)
      .then((n) => {
        if (n > 0) app.log.info({ evt: 'visits.pruned', rows: n }, 'old visit markers deleted')
      })
      .catch((e) => app.log.warn({ err: { message: (e as Error)?.message } }, 'visits sweep failed'))
      .finally(() => {
        running = null
      })
  }
  app.addHook('onReady', async () => {
    first = setTimeout(pass, firstDelayMs)
    first.unref()
    timer = setInterval(pass, intervalMs)
    timer.unref()
  })
  app.addHook('onClose', async () => {
    if (first) clearTimeout(first)
    if (timer) clearInterval(timer)
    first = null
    timer = null
    await running // the database closes after this hook
  })
}
