// OWNER: WS1 (wave R, import from Miro; stubs landed by the wave R foundation). The Miro routes (@draftroom/contracts
// miro-import.ts; docs/WAVE-R-CONTRACTS.md §3; AGENTS.md "Server egress exception: Miro import"):
//
//   POST /api/workspaces/:wid/imports/miro/boards   check the token, list the boards it can see (nothing kept)  R1-1
//   POST /api/workspaces/:wid/imports/miro          start a job (202 StartImportResponse)                        R1-2
//
// What WS1 builds here (and only here, plus packages/miro-import and sync's convert-miro): the Miro client over the
// egress module (../../../egress: miroEgressPolicy(ctx.config.miroTestOrigins), MIRO_EGRESS_USER_AGENT, the token as a
// RedactedSecret taken from the body by splitMiroToken, never parsed by a schema), pacing and 429 waits (MIRO_RATE),
// and the 'miro' import source registered on the runner (importRunnerOf(app).useSource; ../runner.ts ImportStep).
// The guard rows are in place: a name-only guest is refused (guests/guard.ts), and both routes need a creator
// ('always', purpose create: domain-access/guard.ts); the route checks again that the caller may create in the
// workspace and the project. Pending (../../pending-routes.ts): none is registered until WS1 implements it.

import { MIRO_IMPORT_ROUTE_KEYS } from '@draftroom/contracts'
import type { FastifyInstance } from 'fastify'
import { notFound } from '../../../errors.ts'
import type { FeatureContext } from '../../context.ts'
import { type PendingMethod, routeUnlessPending } from '../../pending-routes.ts'

export async function registerMiroImport(app: FastifyInstance, _ctx: FeatureContext): Promise<void> {
  const stub = async () => {
    throw notFound()
  }
  for (const key of MIRO_IMPORT_ROUTE_KEYS) {
    const [method, url] = key.split(' ') as [PendingMethod, string]
    routeUnlessPending(app, method, url, stub)
  }
}
