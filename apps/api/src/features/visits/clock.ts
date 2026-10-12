// The clock visit times are stored on (wave N.1, "one clock"): the sync server's, which stamps every element the
// page compares them with (../../sync-clock.ts says how the api measures it). While it is not known (an older sync,
// an unreachable one, the first moments after start) the api's own clock is used, as before wave N.1. The routes, the
// write interval and its tick all read this one clock, so their intervals agree.

import type { FastifyInstance } from 'fastify'
import { createSyncClock, type SyncClock } from '../../sync-clock.ts'
import type { FeatureContext } from '../context.ts'

const clocks = new WeakMap<FastifyInstance, SyncClock>()

/** The visits' clock of an app (tests: measure it before they look at a stored time). */
export const visitsClockOf = (app: FastifyInstance): SyncClock | undefined => clocks.get(app)

/** Creates the app's visits clock, measured from when the app is ready until it closes. */
export function startVisitsClock(app: FastifyInstance, ctx: Pick<FeatureContext, 'sync' | 'now'>): SyncClock {
  const read = ctx.sync.clock?.bind(ctx.sync)
  // the offset only, in ms: never an id or a visit time
  const clock = createSyncClock({ read, now: ctx.now, log: (m) => app.log.info(m) })
  clocks.set(app, clock)
  app.addHook('onReady', async () => clock.start())
  app.addHook('onClose', async () => clock.stop())
  return clock
}
