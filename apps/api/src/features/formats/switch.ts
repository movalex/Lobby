// Wave W (docs/WAVE-W-CONTRACTS.md §1): the "Formats" kill switches on the api. OWNER: the wave W lead (WS2, WS4 and WS5
// register their routes through formatsRoute and never edit this file). A copy of features/live/switch.ts.
//
// A switch is read once, at boot (ApiConfig.formats: DRAFTROOM_DOC_CARDS, DRAFTROOM_REMOVE_BACKGROUND,
// DRAFTROOM_FILE_SEARCH, DRAFTROOM_DECK_IMPORT, DRAFTROOM_WORKSPACE_ADMIN; config.ts parseOnOff, fail closed). While it
// is off, every route of its feature answers exactly like an unknown route (the root 404 NOT_FOUND "Not found."), for
// EVERY caller: the gate is the route's own onRequest hook, which runs before the body is parsed and before the root
// preHandler guards, so no guest refusal tells anyone the feature exists, and nothing is read or written. No op of its
// kind is handed to a worker (worker/ops-jobs.ts claimOp) and none is enqueued (each enqueue calls formatsOn).
//
// A route is registered only when it is not pending (../pending-routes.ts): the foundation lands every wave W route
// pending, so until its owner implements it, it answers as an unknown route whatever the switch says.
//
// DRAFTROOM_DOC_CARDS gates no route (doc cards are canvas elements; the web reads AuthConfig.formats.docCards).

import type { FormatSwitch } from '@draftroom/contracts'
import type { FastifyInstance, onRequestHookHandler, RouteHandlerMethod } from 'fastify'
import type { ApiConfig } from '../../config.ts'
import { ApiError, notFound } from '../../errors.ts'
import { isPendingRoute, PENDING_ROUTES, type PendingMethod, type PendingRoute } from '../pending-routes.ts'

/** What the gate reads: the config's switches (a FeatureContext has them). */
export interface FormatSwitchSource {
  readonly config: Pick<ApiConfig, 'formats'>
}

/** One switch, or several of which any one being on opens the route (the op state and cancel routes). */
export type FormatGate = FormatSwitch | readonly FormatSwitch[]

const listOf = (g: FormatGate): readonly FormatSwitch[] => (typeof g === 'string' ? [g] : g)

/** Whether a wave W feature (or any of several) runs on this api. */
export const formatsOn = (ctx: FormatSwitchSource, g: FormatGate): boolean =>
  listOf(g).some((s) => ctx.config.formats[s] === true)

/** Throws the unknown route's 404 while the switch is off (for code paths outside a route: a sweep, an enqueue). */
export function requireFormats(ctx: FormatSwitchSource, g: FormatGate): void {
  if (!formatsOn(ctx, g)) throw notFound()
}

/** The onRequest gate of one feature's routes. */
export const formatsGate =
  (ctx: FormatSwitchSource, g: FormatGate): onRequestHookHandler =>
  async () => {
    requireFormats(ctx, g)
  }

/**
 * Registers `handler` for `method url` behind `gate`, unless the route is pending (then nothing is registered and the
 * path stays an unknown route). Returns whether it registered. `pending` is for tests.
 */
export function formatsRoute(
  app: FastifyInstance,
  ctx: FormatSwitchSource,
  gate: FormatGate,
  method: PendingMethod,
  url: string,
  handler: RouteHandlerMethod,
  pending: Readonly<Record<string, PendingRoute>> = PENDING_ROUTES,
): boolean {
  if (isPendingRoute(`${method} ${url}`, pending)) return false
  app.route({ method, url, onRequest: formatsGate(ctx, gate), handler })
  return true
}

/**
 * The foundation's stub handler: 501 NOT_IMPLEMENTED. Only reachable with the route taken off the pending list AND its
 * switch on, which no deployment has before its owner replaces the stub.
 */
export const formatsStub: RouteHandlerMethod = async () => {
  throw new ApiError(501, 'NOT_IMPLEMENTED', 'This is not ready yet.')
}
