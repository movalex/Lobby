// The one place feature modules are registered (integration owner). Each feature owns its folder.
import type { FastifyInstance } from 'fastify'
import { registerComments } from './comments/index.ts'
import type { FeatureContext } from './context.ts'
import { registerDashboard } from './dashboard/index.ts'
import { registerExportControl } from './export-control/index.ts'
import { registerGuests } from './guests/index.ts'
import { registerHistory } from './history/index.ts'
import { registerSearch } from './search/index.ts'
import { registerThumbnails } from './thumbnails/index.ts'
import { registerWorkshops } from './workshops/index.ts'

export async function registerFeatures(app: FastifyInstance, ctx: FeatureContext): Promise<void> {
  await registerComments(app, ctx)
  await registerHistory(app, ctx)
  await registerWorkshops(app, ctx)
  await registerDashboard(app, ctx)
  await registerGuests(app, ctx)
  await registerThumbnails(app, ctx)
  await registerExportControl(app, ctx)
  await registerSearch(app, ctx)
}
