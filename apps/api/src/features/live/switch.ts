// Wave V (docs/WAVE-V-CONTRACTS.md §1): the "Live sessions+" kill switches on the api. OWNER: the wave V lead (WS1,
// WS3 and WS4 register their routes through liveRoute and never edit this file).
//
// A switch is read once, at boot (ApiConfig.live: DRAFTROOM_LIVE_ACTIVITIES, DRAFTROOM_JOIN_CODES,
// DRAFTROOM_BREAKOUTS; config.ts parseOnOff, fail closed). While it is off, every route of its feature answers exactly
// like an unknown route (the root 404 NOT_FOUND "Not found."), for EVERY caller: the gate is the route's own onRequest
// hook, which runs before the body is parsed and before the root preHandler guards (the guest refusals, the creator
// rule), so neither a guest's 403 nor a creator check tells anyone the feature exists, and nothing is read or written.
// Its events are never published (nothing runs) and its open-state part is null (its loader calls liveOn).
//
// A route is registered only when it is not pending (../pending-routes.ts): the foundation lands every wave V route
// pending, so until its owner implements it, it answers as an unknown route whatever the switch says.

import type { LiveSwitch } from '@draftroom/contracts'
import type { FastifyInstance, onRequestHookHandler, RouteHandlerMethod } from 'fastify'
import type { ApiConfig } from '../../config.ts'
import { ApiError, notFound } from '../../errors.ts'
import { isPendingRoute, PENDING_ROUTES, type PendingMethod, type PendingRoute } from '../pending-routes.ts'

/** What the gate reads: the config's switches (a FeatureContext has them). */
export interface LiveSwitchSource {
  readonly config: Pick<ApiConfig, 'live'>
}

/** Whether a wave V feature runs on this api. */
export const liveOn = (ctx: LiveSwitchSource, s: LiveSwitch): boolean => ctx.config.live[s] === true

/** Throws the unknown route's 404 while the switch is off (for code paths outside a route: a loader, a sweep). */
export function requireLive(ctx: LiveSwitchSource, s: LiveSwitch): void {
  if (!liveOn(ctx, s)) throw notFound()
}

/** The onRequest gate of one feature's routes. */
export const liveGate =
  (ctx: LiveSwitchSource, s: LiveSwitch): onRequestHookHandler =>
  async () => {
    requireLive(ctx, s)
  }

/**
 * Registers `handler` for `method url` behind switch `s`, unless the route is pending (then nothing is registered and the
 * path stays an unknown route). Returns whether it registered. `pending` is for tests.
 */
export function liveRoute(
  app: FastifyInstance,
  ctx: LiveSwitchSource,
  s: LiveSwitch,
  method: PendingMethod,
  url: string,
  handler: RouteHandlerMethod,
  pending: Readonly<Record<string, PendingRoute>> = PENDING_ROUTES,
): boolean {
  if (isPendingRoute(`${method} ${url}`, pending)) return false
  app.route({ method, url, onRequest: liveGate(ctx, s), handler })
  return true
}

/**
 * The foundation's stub handler: 501 NOT_IMPLEMENTED. Only reachable with the route taken off the pending list AND its
 * switch on, which no deployment has before its owner replaces the stub (the stubs' test registers them that way).
 */
export const liveStub: RouteHandlerMethod = async () => {
  throw new ApiError(501, 'NOT_IMPLEMENTED', 'This is not ready yet.')
}
