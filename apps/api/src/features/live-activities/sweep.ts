// OWNER: WS1 (wave V; the fix wave, review m2). The settle sweep of live activities: an activity whose end time passed
// on a board nobody reads is settled all the same (closed; an anonymous one's aggregate frozen and its answers
// deleted: store.ts settleActivity), so its answers do not wait for a read that may never come. Each activity is
// settled in its own short transaction under its row lock (the same lock every answer and transition takes). Runs
// while DRAFTROOM_LIVE_ACTIVITIES is on (off, the feature runs nothing: docs/WAVE-V-CONTRACTS.md §1.2; the next read
// or start after it is on again settles what ended meanwhile, and archiving or trashing a board always does).
// Logs a count, never a row.

import type { FastifyInstance } from 'fastify'
import type { FeatureContext } from '../context.ts'
import { settleActivity, unsettledActivities } from './store.ts'

/** Read when the feature registers (tests change them before building the app, like the visits sweep's). */
export const activitiesSweepSettings = { intervalMs: 60 * 1000, firstDelayMs: 30 * 1000, batch: 200 }

/** One pass: settles up to `batch` activities that need it. Returns the ids it changed. */
export async function sweepActivities(
  ctx: Pick<FeatureContext, 'db' | 'now'>,
  batch: number = activitiesSweepSettings.batch,
): Promise<string[]> {
  const changed: string[] = []
  for (const id of await unsettledActivities(ctx.db, ctx.now(), batch))
    if (await ctx.db.transaction((tx) => settleActivity(tx, id, ctx.now()))) changed.push(id)
  return changed
}

/** Runs sweepActivities on a timer while the app runs; `settled` hears what each pass changed (the tally). */
export function startActivitiesSweeper(
  app: FastifyInstance,
  ctx: FeatureContext,
  settled: (ids: string[]) => void,
): void {
  if (!ctx.config.live.activities) return
  const { intervalMs, firstDelayMs } = activitiesSweepSettings
  let first: ReturnType<typeof setTimeout> | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let running: Promise<void> | null = null
  const pass = () => {
    if (running) return
    running = sweepActivities(ctx)
      .then((ids) => {
        if (!ids.length) return
        settled(ids)
        app.log.info({ evt: 'activities.settled', count: ids.length }, 'ended activities settled')
      })
      .catch((e) => app.log.warn({ err: { name: (e as Error)?.name } }, 'activities sweep failed'))
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
