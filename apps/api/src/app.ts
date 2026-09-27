// The API process (docs/M1-CONTRACTS.md §1–§7): Fastify 5 over Postgres (PGlite or pg).
// createApiServer() builds a ready-to-inject app; tests use app.inject() and never bind a port.

import type { AddressInfo } from 'node:net'
import type { Me } from '@draftroom/contracts'
import { type Db, isUniqueViolation, migrate, openDb } from '@draftroom/db'
import { dataLayout } from '@draftroom/dev-assets'
import fastifyCookie from '@fastify/cookie'
import fastifyRateLimit from '@fastify/rate-limit'
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import { createClerkAuthProvider } from './auth/clerk.ts'
import { createDevAuthProvider } from './auth/dev.ts'
import type { AuthProvider, RouteRateLimit, SignInContext } from './auth/provider.ts'
import { createSessionStore } from './auth/session.ts'
import { listUserWorkspaces } from './auth/users.ts'
import type { ApiConfig } from './config.ts'
import type { AppContext } from './context.ts'
import { badRequest, toErrorResponse, unauthenticated } from './errors.ts'
import { filesPlugin } from './files/plugin.ts'
import { createFileAuthorizer } from './files-auth.ts'
import { createHttpSyncNotifier, type SyncNotifier } from './notifier.ts'
import { registerAuthRoutes } from './routes/auth.ts'
import { registerBoardRoutes } from './routes/boards.ts'
import { registerInvitationRoutes } from './routes/invitations.ts'
import { registerMemberRoutes } from './routes/members.ts'
import { registerTicketRoutes } from './routes/tickets.ts'
import { registerWorkspaceRoutes } from './routes/workspaces.ts'
import { sessionUserToUser } from './serialize.ts'

export interface ApiDeps {
  /** A migrated-or-empty database the caller owns (it is migrated here, never closed here). */
  db?: Db
  notifier?: SyncNotifier
  now?: () => Date
  logger?: FastifyServerOptions['logger']
  /** Replaces the provider chosen by config (tests inject a Clerk provider with fake verification). */
  authProvider?: AuthProvider
  /**
   * Sign-in / invitation route limit per client IP. Default 30 per minute; 600 with the dev provider,
   * where every browser (and every e2e user) arrives through the same local Vite proxy address.
   */
  authRateLimit?: RouteRateLimit
}

export interface ApiServer {
  app: FastifyInstance
  db: Db
  /** Binds config.host:config.port; resolves with the bound port (useful with PORT=0). */
  listen(): Promise<{ host: string; port: number }>
  /** Stops accepting, finishes in-flight requests and sync notifications, closes the database if owned. */
  close(): Promise<void>
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const JSON_BODY_LIMIT = 256 * 1024

function defaultProvider(config: ApiConfig): AuthProvider {
  if (config.authProvider === 'dev') return createDevAuthProvider()
  if (!config.clerk) throw new Error('AUTH_PROVIDER=clerk requires Clerk keys')
  return createClerkAuthProvider({ ...config.clerk, publicOrigin: config.publicOrigin })
}

export async function createApiServer(config: ApiConfig, deps: ApiDeps = {}): Promise<ApiServer> {
  const provider = deps.authProvider ?? defaultProvider(config)
  // Second line of defense behind loadConfig: development identities only behind the explicit guard.
  if (provider.id === 'dev' && (!config.devAuth || config.production))
    throw new Error('dev sign-in requires DRAFTROOM_DEV_AUTH=1 and is refused in production')

  const ownsDb = !deps.db
  const db =
    deps.db ??
    (await openDb(
      config.databaseUrl
        ? { kind: 'pg', connectionString: config.databaseUrl }
        : { kind: 'pglite', dataDir: config.pgliteDir },
    ))
  try {
    await migrate(db)
    return await buildServer(config, deps, provider, db, ownsDb)
  } catch (e) {
    if (ownsDb) await db.close()
    throw e
  }
}

async function buildServer(
  config: ApiConfig,
  deps: ApiDeps,
  provider: AuthProvider,
  db: Db,
  ownsDb: boolean,
): Promise<ApiServer> {
  const now = deps.now ?? (() => new Date())
  // Request logging is ours (onResponse below): route patterns only, never URLs, so invitation tokens
  // in paths and query strings never reach the logs.
  const app = Fastify({
    logger: deps.logger ?? false,
    logController: new Fastify.LogController({ disableRequestLogging: true }),
    return503OnClosing: true,
  })
  const notifier =
    deps.notifier ??
    createHttpSyncNotifier({ baseUrl: config.syncInternalUrl, secret: config.internalSecret, log: app.log })
  const sessions = createSessionStore({ db, secureCookies: config.publicOrigin.startsWith('https:'), now })
  const authRateLimit = deps.authRateLimit ?? { max: provider.id === 'dev' ? 600 : 30, timeWindow: 60_000 }
  const ctx: AppContext = {
    config,
    db,
    sessions,
    notifier,
    now,
    authRateLimit,
    async requireUser(req) {
      const user = await sessions.user(req)
      if (!user) throw unauthenticated()
      return user
    },
  }

  app.setErrorHandler((err, req, reply) => {
    const { status, body } = toErrorResponse(err)
    if (status >= 500) {
      // Name/message/code/stack only: driver errors also carry the statement's parameters.
      const e = err as { name?: unknown; message?: unknown; code?: unknown; stack?: unknown }
      req.log.error(
        {
          err: { name: e?.name, message: e?.message, code: e?.code, stack: e?.stack },
          route: req.routeOptions.url,
        },
        'request failed',
      )
    }
    return reply.code(status).send(body)
  })
  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } }),
  )

  // CSRF (§4): mutations carry a JSON body or none. Only application/json is parsed here; any other
  // Content-Type is a 415. (The file routes install their own parser in their own scope.)
  app.removeAllContentTypeParsers()
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string', bodyLimit: JSON_BODY_LIMIT },
    (_req, body, done) => {
      if (body === '') return done(null, undefined)
      try {
        done(null, JSON.parse(body as string))
      } catch {
        done(badRequest('The body is not valid JSON.'), undefined)
      }
    },
  )

  await app.register(fastifyCookie)
  await app.register(fastifyRateLimit, {
    global: false,
    errorResponseBuilder: () => ({
      statusCode: 429,
      code: 'RATE_LIMITED',
      message: 'Too many requests. Wait a moment and try again.',
    }),
  })

  // CSRF (§4): every mutation must come from the web origin. Answered here directly, not thrown, so no
  // route scope's error handler can reshape the refusal.
  app.addHook('onRequest', async (req, reply) => {
    if (MUTATING.has(req.method) && req.headers.origin !== config.publicOrigin) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Cross-origin request refused.' } })
    }
  })
  app.addHook('onSend', async (_req, reply, payload) => {
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store')
    if (!reply.hasHeader('x-content-type-options')) reply.header('x-content-type-options', 'nosniff')
    return payload
  })
  app.addHook('onResponse', async (req, reply) => {
    req.log.info(
      {
        method: req.method,
        route: req.routeOptions.url ?? '(no route)',
        status: reply.statusCode,
        ms: Math.round(reply.elapsedTime),
      },
      'request',
    )
  })

  const signIn: SignInContext = {
    rateLimit: authRateLimit,
    log: app.log,
    async signIn(req, reply, provision) {
      const run = () =>
        db.transaction(async (tx) => {
          const user = await provision(tx, now())
          const session = await sessions.create(tx, user.id)
          return { user, session, workspaces: await listUserWorkspaces(tx, user.id) }
        })
      let result: Awaited<ReturnType<typeof run>>
      try {
        result = await run()
      } catch (e) {
        // Two first sign-ins for one identity raced; the second attempt finds the winner's rows.
        if (!isUniqueViolation(e)) throw e
        result = await run()
      }
      // A new sign-in in this browser ends the session it had (e.g. switching dev users).
      await sessions.revoke(req)
      sessions.setCookie(reply, result.session.token, result.session.expiresAt)
      const me: Me = { user: sessionUserToUser(result.user), workspaces: result.workspaces }
      return me
    },
  }

  registerAuthRoutes(app, ctx, provider)
  provider.register(app, signIn)
  registerWorkspaceRoutes(app, ctx)
  registerBoardRoutes(app, ctx)
  registerMemberRoutes(app, ctx)
  registerInvitationRoutes(app, ctx)
  registerTicketRoutes(app, ctx)
  await app.register(filesPlugin, {
    layout: dataLayout(config.dataDir),
    authorize: createFileAuthorizer(db, sessions),
  })

  return {
    app,
    db,
    async listen() {
      await app.listen({ host: config.host, port: config.port })
      return { host: config.host, port: (app.server.address() as AddressInfo).port }
    },
    async close() {
      await app.close()
      await notifier.drain()
      if (ownsDb) await db.close()
    },
  }
}
