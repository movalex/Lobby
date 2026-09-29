// The API process (docs/M1-CONTRACTS.md §1–§7, docs/M3-STORAGE-CONTRACTS.md): Fastify 5 over Postgres
// (PGlite or pg), files in the blob store (local directory or R2), preview workers over /api/worker/*.
// createApiServer() builds a ready-to-inject app; tests use app.inject() and never bind a port.

import type { AddressInfo } from 'node:net'
import type { Me } from '@draftroom/contracts'
import { type Db, isUniqueViolation, migrate, openDb } from '@draftroom/db'
import { dataLayout } from '@draftroom/dev-assets'
import fastifyCookie from '@fastify/cookie'
import fastifyRateLimit from '@fastify/rate-limit'
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import { createClerkAuthProvider } from './auth/clerk.ts'
import { creatorLookup } from './auth/creator-sql.ts'
import { createDevAuthProvider } from './auth/dev.ts'
import { createIdentityService, type IdentityService } from './auth/identity.ts'
import type { AuthProvider, RouteRateLimit, SignInContext } from './auth/provider.ts'
import { createSessionStore } from './auth/session.ts'
import { listUserWorkspaces } from './auth/users.ts'
import type { ApiConfig } from './config.ts'
import { type ApiLimits, type AppContext, DEFAULT_LIMITS, type InvitationRateLimits } from './context.ts'
import { badRequest, toErrorResponse, unauthenticated } from './errors.ts'
import { EventHub } from './events/hub.ts'
import { registerEventRoutes } from './events/routes.ts'
import type { FeatureContext } from './features/context.ts'
import { registerFeatures } from './features/index.ts'
import type { BlobStore } from './files/blobs.ts'
import { filesPlugin } from './files/plugin.ts'
import { registerStorage } from './files/storage-routes.ts'
import { openBlobStore } from './files/store.ts'
import { boardsShowingAsset, createFileAuthorizer } from './files-auth.ts'
import { createHttpSyncNotifier, fanOutAccessChanges, type SyncNotifier } from './notifier.ts'
import { registerAuthRoutes } from './routes/auth.ts'
import { registerBoardRoutes } from './routes/boards.ts'
import { registerInvitationRoutes } from './routes/invitations.ts'
import { registerMemberRoutes } from './routes/members.ts'
import { registerTicketRoutes } from './routes/tickets.ts'
import { registerWorkspaceRoutes } from './routes/workspaces.ts'
import { sessionUserToUser } from './serialize.ts'
import { createHttpSyncInternalClient, type SyncInternalClient } from './sync-internal.ts'
import type { VersionChange } from './worker/jobs.ts'
import { WORKER_PREFIX, type WorkerDeps, workerPlugin } from './worker/routes.ts'

export interface ApiDeps {
  /** A migrated-or-empty database the caller owns (it is migrated here, never closed here). */
  db?: Db
  notifier?: SyncNotifier
  now?: () => Date
  logger?: FastifyServerOptions['logger']
  /** Replaces the provider chosen by config (tests inject a Clerk provider with fake verification). */
  authProvider?: AuthProvider
  /**
   * Sign-in attempts per client IP: every dev login, but only FAILED Clerk verifications (SCA-2).
   * Default 60 per minute; 600 with the dev provider, where every browser (and every e2e user)
   * arrives through the same local Vite proxy address. Invitations have their own limits (`limits`).
   */
  authRateLimit?: RouteRateLimit
  /** Keyed limits routes apply themselves (defaults: DEFAULT_LIMITS in context.ts; tests lower them). */
  limits?: {
    invitations?: Partial<InvitationRateLimits>
    streamOpens?: RouteRateLimit
    streamRecheckMs?: number
    revokeAll?: RouteRateLimit
  }
  /** Board event hub (tests subscribe to it directly, or pass one with lower stream caps). */
  events?: EventHub
  /** api -> sync snapshot/seed client (tests inject a fake). */
  syncInternal?: SyncInternalClient
  /** Replaces the blob store chosen by config (tests inject fakes or a temp directory). */
  blobs?: BlobStore
  /** Worker route limits (tests lower them). */
  workerRateLimit?: WorkerDeps['rateLimit']
  /**
   * TEST-ONLY seam (docs/DOMAIN-ACCESS-CONTRACTS.md §11.1 creation matrix): false leaves the domain-access
   * root guard out, to prove the in-route creator checks hold on their own. Never set outside tests.
   */
  domainAccessGuard?: boolean
}

export interface ApiServer {
  app: FastifyInstance
  db: Db
  blobs: BlobStore
  /** Domain access: creator status and identity refreshes (tests await identity.settled()). */
  identity: IdentityService
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
    const migrated = await migrate(db, { allowNewerSchema: config.allowNewerSchema })
    const blobs = deps.blobs ?? openBlobStore(config.blobStore)
    const server = await buildServer(config, deps, provider, db, ownsDb, blobs)
    // A rollback (docs/DEPLOY.md "Rollback"): say so on every start while the flag is on.
    if (migrated.newer.length)
      server.app.log.warn(
        { newerMigrations: migrated.newer },
        'DRAFTROOM_ALLOW_NEWER_SCHEMA=1: this build is running on a database with newer migrations than it knows. Deploy the newer build again (or fix forward) and remove the flag.',
      )
    else if (config.allowNewerSchema)
      server.app.log.warn(
        'DRAFTROOM_ALLOW_NEWER_SCHEMA=1 is set but the database has no newer migrations: remove the flag.',
      )
    return server
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
  blobs: BlobStore,
): Promise<ApiServer> {
  const now = deps.now ?? (() => new Date())
  // Request logging is ours (onResponse below): route patterns only, never URLs, so invitation tokens
  // in paths and query strings never reach the logs.
  const app = Fastify({
    logger: deps.logger ?? false,
    logController: new Fastify.LogController({ disableRequestLogging: true }),
    return503OnClosing: true,
    trustProxy: config.trustProxy, // req.ip (per-IP rate limits) behind proxies: TRUST_PROXY, docs/DEPLOY.md
  })
  const syncNotifier =
    deps.notifier ??
    createHttpSyncNotifier({ baseUrl: config.syncInternalUrl, secret: config.internalSecret, log: app.log })
  const events = deps.events ?? new EventHub()
  // Every "access changed" reaches the canvas sockets (sync) and the board event streams (authz-005).
  const notifier = fanOutAccessChanges(syncNotifier, events)
  // Domain access: only the RUNNING provider's stored addresses count (never the AUTH_PROVIDER variable).
  const creators = creatorLookup(config.creators, provider.id)
  const sessions = createSessionStore({
    db,
    secureCookies: config.publicOrigin.startsWith('https:'),
    now,
    creators,
  })
  const identity = createIdentityService({ db, sessions, provider, lookup: creators, now, log: app.log })
  // Never an address: the domains and how many exceptions there are.
  app.log.info(
    { creators: { domains: [...config.creators.domains], exceptions: config.creators.emails.length } },
    'domain access policy',
  )
  const authRateLimit = deps.authRateLimit ?? { max: provider.id === 'dev' ? 600 : 60, timeWindow: 60_000 }
  const limits: ApiLimits = {
    ...DEFAULT_LIMITS,
    ...deps.limits,
    invitations: { ...DEFAULT_LIMITS.invitations, ...deps.limits?.invitations },
  }
  const ctx: AppContext = {
    config,
    db,
    sessions,
    notifier,
    now,
    authRateLimit,
    limits,
    identity,
    async requireUser(req) {
      const user = await sessions.user(req)
      if (!user) throw unauthenticated()
      return user
    },
  }

  app.setErrorHandler((err, req, reply) => {
    const { status, body, headers } = toErrorResponse(err)
    if (headers) reply.headers(headers)
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
  // route scope's error handler can reshape the refusal. The worker protocol (M3 §4) is exempt: it is
  // not a browser route (Bearer token, cookies refused). Decided by the MATCHED route pattern, never by
  // the raw URL, so no path spelling can borrow the exemption for another route.
  app.addHook('onRequest', async (req, reply) => {
    if (req.routeOptions.url?.startsWith(WORKER_PREFIX)) return
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
    const route = req.routeOptions.url
    // An idle worker polls /claim every few seconds forever (204 = nothing to do): debug, not info, so
    // `pnpm dev` and production logs are not a wall of empty polls. Claims that hand out a job stay info.
    const idlePoll = route === `${WORKER_PREFIX}claim` && reply.statusCode === 204
    req.log[idlePoll ? 'debug' : 'info'](
      {
        method: req.method,
        route: route ?? '(no route)',
        status: reply.statusCode,
        ms: Math.round(reply.elapsedTime),
      },
      'request',
    )
  })

  const signIn: SignInContext = {
    rateLimit: authRateLimit,
    log: app.log,
    now,
    creators,
    async endBannedAccount(providerId, subject) {
      const row = await db.maybeOne<{ user_id: string }>(
        'SELECT user_id FROM identities WHERE provider = $1 AND subject = $2',
        [providerId, subject],
      )
      if (!row) return
      const ids = await sessions.revokeAll(row.user_id)
      app.log.info(
        { evt: 'identity.sessions_revoked', userId: row.user_id, outcome: 'banned', sessions: ids.length },
        'account ended',
      )
    },
    async signIn(req, reply, provision, opts = {}) {
      const run = () =>
        db.transaction(async (tx) => {
          const user = await provision(tx, now())
          const session = await sessions.create(tx, user.id, { clerkSessionId: opts.clerkSessionId ?? null })
          // Stored data only, which provisioning has just written (docs/DOMAIN-ACCESS-CONTRACTS.md §8).
          const access = await identity.status(user, tx)
          return { user, session, access, workspaces: await listUserWorkspaces(tx, user.id) }
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
      const me: Me = {
        user: sessionUserToUser(result.user),
        workspaces: result.workspaces,
        access: result.access,
      }
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
    db,
    blobs,
    authorize: createFileAuthorizer(db, sessions),
    now,
    // FC-1: per-workspace storage quota and per-user upload rate (DRAFTROOM_WORKSPACE_QUOTA_MB, …).
    uploads: {
      workspaceQuota: {
        maxBytes: config.uploads.workspaceQuotaBytes,
        maxFiles: config.uploads.workspaceMaxFiles,
      },
      perUser: { max: config.uploads.perUserPerMinute, timeWindow: 60_000 },
      guestQuota: config.storage.guestQuota, // SEAM-02: per name-only guest (DRAFTROOM_GUEST_QUOTA_MB, …)
    },
  })

  /** Board event 'assets.version' (M3 §4) on every board that can show the version, after commit. */
  const onVersionChange = async (c: VersionChange) => {
    try {
      const boards = await boardsShowingAsset(db, c.workspaceId, {
        assetId: c.assetId,
        versionId: c.versionId,
        ownerBoardId: c.boardId,
      })
      for (const boardId of boards)
        events.publish(boardId, {
          type: 'assets.version',
          data: { assetId: c.assetId, versionId: c.versionId, status: c.status },
        })
    } catch (err) {
      const e = err as { name?: unknown; message?: unknown }
      app.log.warn({ err: { name: e?.name, message: e?.message } }, 'assets.version event not published')
    }
  }
  await app.register(workerPlugin, {
    db,
    blobs,
    token: config.workerToken,
    now,
    onVersionChange,
    rateLimit: deps.workerRateLimit,
  })

  // Liveness only (no database, no auth): for Render health checks and local tooling.
  app.get('/healthz', async (_req, reply) => reply.type('text/plain').send('ok'))

  const layout = dataLayout(config.dataDir)
  const features: FeatureContext = {
    ...ctx,
    blobs,
    events,
    sync:
      deps.syncInternal ??
      createHttpSyncInternalClient({ baseUrl: config.syncInternalUrl, secret: config.internalSecret }),
    layout,
  }
  registerEventRoutes(app, features)
  await registerFeatures(app, features, { domainAccessGuard: deps.domainAccessGuard !== false })
  // Workspace storage and the unreferenced-file collector (UPL-1; DRAFTROOM_ASSET_GC, report-only by default).
  registerStorage(app, ctx, { blobs, sync: features.sync, dataRoot: layout.root })

  // Background identity refreshes finish before the database closes.
  app.addHook('onClose', async () => {
    await identity.settled()
  })

  return {
    app,
    db,
    blobs,
    identity,
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
