import type { Db } from '@draftroom/db'
import type { FastifyRequest } from 'fastify'
import type { RouteRateLimit } from './auth/provider.ts'
import type { SessionStore, SessionUser } from './auth/session.ts'
import type { ApiConfig } from './config.ts'
import type { SyncNotifier } from './notifier.ts'

/** Everything a route module needs; passed explicitly instead of Fastify decorators. */
export interface AppContext {
  config: ApiConfig
  db: Db
  sessions: SessionStore
  notifier: SyncNotifier
  now: () => Date
  /** The signed-in user or a 401. Authorship always comes from here, never from a request body. */
  requireUser(req: FastifyRequest): Promise<SessionUser>
  authRateLimit: RouteRateLimit
}

/** Route params arrive untyped; every route validates them (a malformed id is a 404, like a missing one). */
export type Params = Record<string, string | undefined>
