import type { Db } from '@draftroom/db'
import type { FastifyRequest } from 'fastify'
import type { IdentityService } from './auth/identity.ts'
import type { SessionStore, SessionUser } from './auth/session.ts'
import type { CanvasEngineProbe } from './canvas-engine.ts'
import type { ApiConfig } from './config.ts'
import type { SyncNotifier } from './notifier.ts'
import type { RouteRateLimit } from './rate-limit.ts'

/** Invitation links (docs/SECURITY-REVIEW-2026-09-27.md SCA-2: never one bucket for a whole office). */
export interface InvitationRateLimits {
  /** GET /api/invitations/:token, per link (its token's hash): a workshop link opened by a room. */
  previewPerToken: RouteRateLimit
  /** GET /api/invitations/:token, per client IP: a backstop against floods of made-up tokens. */
  previewPerIp: RouteRateLimit
  /** POST /api/invitations/:token/accept, per signed-in user. */
  acceptPerUser: RouteRateLimit
}

/** Keyed limits that routes apply themselves (tests lower them through ApiDeps.limits). */
export interface ApiLimits {
  invitations: InvitationRateLimits
  /** Board event stream opens per signed-in user (authz-003). */
  streamOpens: RouteRateLimit
  /** Periodic re-check of every open event stream, session and board access (authz-005); ≤ 10 s. */
  streamRecheckMs: number
  /** POST /api/auth/sessions/revoke-all per signed-in user (each may call the identity provider). */
  revokeAll: RouteRateLimit
  /**
   * GET /api/boards/:bid/open-state per signed-in user (wave N.1): one READ ONLY transaction over eight panel reads,
   * asked once per board open. A refusal (429) leaves the web on the parts' own routes.
   */
  openStates: RouteRateLimit
}

const MINUTE = 60_000

export const DEFAULT_LIMITS: ApiLimits = {
  // 25 people behind one NAT opening one workshop link fetch its preview ~75 times a minute.
  invitations: {
    previewPerToken: { max: 300, timeWindow: MINUTE },
    previewPerIp: { max: 600, timeWindow: MINUTE },
    acceptPerUser: { max: 30, timeWindow: MINUTE },
  },
  streamOpens: { max: 120, timeWindow: MINUTE },
  streamRecheckMs: 10_000,
  revokeAll: { max: 10, timeWindow: MINUTE },
  // asked once per board open (a re-entry within the answer's lifetime, OPEN_STATE_TTL_MS, asks nothing): a board a
  // second is far past what anyone opens by hand; half the stream opens' 120, which count reconnects too
  openStates: { max: 60, timeWindow: MINUTE },
}

/** Everything a route module needs; passed explicitly instead of Fastify decorators. */
export interface AppContext {
  config: ApiConfig
  db: Db
  sessions: SessionStore
  /** Tells the sync server AND this process's event streams (notifier.ts fanOutAccessChanges). */
  notifier: SyncNotifier
  now: () => Date
  /** The signed-in user or a 401. Authorship always comes from here, never from a request body. */
  requireUser(req: FastifyRequest): Promise<SessionUser>
  /** Sign-in attempts per client IP (see SignInContext.rateLimit). */
  authRateLimit: RouteRateLimit
  limits: ApiLimits
  /**
   * Domain access (docs/DOMAIN-ACCESS-CONTRACTS.md §3.4, §4.1): creator status, identity freshness and
   * the one creator check (requireCreator).
   */
  identity: IdentityService
  /**
   * Which canvas the sync server runs (canvas-engine.ts): on the new canvas the api marks what it makes
   * (`boards.new_canvas`, `body_version` 2) and R0's refusals of it do not apply. Absent = tldraw.
   */
  canvas?: CanvasEngineProbe
}

/** Route params arrive untyped; every route validates them (a malformed id is a 404, like a missing one). */
export type Params = Record<string, string | undefined>
