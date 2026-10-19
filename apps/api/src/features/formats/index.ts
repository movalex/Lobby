// Wave W, "Formats" (docs/WAVE-W-CONTRACTS.md). OWNER: the wave W lead (this file and ./switch.ts, ./offer.ts); the
// route modules are their workstreams': ./remove-bg (WS2), ./ops (WS2), ./deck (WS4). Search inside files (WS3) has no
// route of its own (it lives in features/search and the worker ops), and doc cards (WS1) none at all.

import type { FastifyInstance } from 'fastify'
import type { FeatureContext } from '../context.ts'
import { PENDING_ROUTES, type PendingRoute } from '../pending-routes.ts'
import { registerDeckImport } from './deck/index.ts'
import { registerFileOps } from './ops/index.ts'
import { registerRemoveBackground } from './remove-bg/index.ts'

export async function registerFormats(
  app: FastifyInstance,
  // WS2: the landed routes read the database, the session and the clock (lazily, in their handlers)
  ctx: FeatureContext,
  pending: Readonly<Record<string, PendingRoute>> = PENDING_ROUTES,
): Promise<void> {
  await registerRemoveBackground(app, ctx, pending)
  await registerFileOps(app, ctx, pending)
  await registerDeckImport(app, ctx, pending)
}
