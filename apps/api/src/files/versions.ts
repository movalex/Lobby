// OWNER: WS2 (wave S, versions of a deliverable; the stub landed by the wave S foundation). The version list
// (@draftroom/contracts asset-versions.ts; docs/WAVE-S-CONTRACTS.md §3):
//
//   GET /api/boards/:bid/asset-versions/:ast   the asset's versions servable on this board, oldest first        S2-1
//
// What WS2 builds here: the list (view access through the board, as the files plugin's meta route; `n` counts only
// the versions servable on this board, files-auth.ts; threads counted as the caller may see them, team-only ones only
// for the team); and, in ./upload.ts, the X-Lobby-Supersedes header (dev-assets SUPERSEDES_HEADER) parsed before any
// body byte is read and after the edit check, the superseded row read FOR SHARE in the upload's transaction (so the
// collector cannot delete it under the new version), the refusals of asset-versions.ts, and the review reset
// (../features/review/hooks.ts resetForNewVersion) in the same transaction. A separate path, so the files plugin's
// /api/boards/:bid/assets/:ast/:ver routes and their 405 catch-alls stay as they are. Pending
// (../features/pending-routes.ts): not registered until WS2 implements it.

import { ASSET_VERSION_ROUTE_KEYS } from '@draftroom/contracts'
import type { FastifyInstance } from 'fastify'
import { notFound } from '../errors.ts'
import type { FeatureContext } from '../features/context.ts'
import { type PendingMethod, routeUnlessPending } from '../features/pending-routes.ts'

export async function registerAssetVersions(app: FastifyInstance, _ctx: FeatureContext): Promise<void> {
  const stub = async () => {
    throw notFound()
  }
  for (const key of ASSET_VERSION_ROUTE_KEYS) {
    const [method, url] = key.split(' ') as [PendingMethod, string]
    routeUnlessPending(app, method, url, stub)
  }
}
