// The API process (docs/M1-CONTRACTS.md §1–§7, docs/M3-STORAGE-CONTRACTS.md): Fastify 5 over Postgres
// (PGlite or pg), files in the blob store (local directory or R2), preview workers over /api/worker/*.
// createApiServer() builds a ready-to-inject app; tests use app.inject() and never bind a port.

import type { IncomingHttpHeaders } from 'node:http'
import { type AddressInfo, Socket } from 'node:net'
import { checkInternalSecret, INTERNAL_SECRET_HEADER } from '@draftroom/auth-tickets'
import type { Me } from '@draftroom/contracts'
import { type Db, isUniqueViolation, migrate, openDb } from '@draftroom/db'
import { dataLayout } from '@draftroom/dev-assets'
import fastifyCookie from '@fastify/cookie'
import fastifyRateLimit from '@fastify/rate-limit'
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify'
import { createClerkAuthProvider } from './auth/clerk.ts'
import { creatorLookup } from './auth/creator-sql.ts'
import { createDevAuthProvider } from './auth/dev.ts'
import { createEmailAuthProvider } from './auth/email.ts'
import { createIdentityService, type IdentityService } from './auth/identity.ts'
import type { AuthProvider, RouteRateLimit, SignInContext } from './auth/provider.ts'
import { createSessionStore } from './auth/session.ts'
import { createHttpSessionEndNotifier, type SessionEndNotifier } from './auth/session-sync.ts'
import { listUserWorkspaces } from './auth/users.ts'
import { type CanvasEngine, type CanvasEngineProbe, createCanvasEngineProbe } from './canvas-engine.ts'
import type { ApiConfig } from './config.ts'
import { type ApiLimits, type AppContext, DEFAULT_LIMITS, type InvitationRateLimits } from './context.ts'
import { badRequest, toErrorResponse, unauthenticated } from './errors.ts'
import { EventHub } from './events/hub.ts'
import { registerEventRoutes } from './events/routes.ts'
import type { FeatureContext } from './features/context.ts'
import { registerFeedback } from './features/feedback/index.ts'
import { INTERNAL_CHECKPOINT_POSTS } from './features/history/checkpoint-all.ts'
import { registerFeatures } from './features/index.ts'
import type { BlobStore } from './files/blobs.ts'
import { filesPlugin } from './files/plugin.ts'
import { registerStorage } from './files/storage-routes.ts'
import { openBlobStore } from './files/store.ts'
import { boardsShowingAsset, createFileAuthorizer } from './files-auth.ts'
import { createHealth, HEALTH_DEEP_ROUTE, type HealthOptions } from './health.ts'
import { createHttpSyncNotifier, fanOutAccessChanges, type SyncNotifier } from './notifier.ts'
import { registerAuthRoutes } from './routes/auth.ts'
import { registerBoardRoutes } from './routes/boards.ts'
import {
  ENGINE_INTERNAL_ROUTES,
  engineBadSecretBody,
  registerEngineInternalRoutes,
} from './routes/engine-internal.ts'
import { registerInvitationRoutes } from './routes/invitations.ts'
import { registerMemberRoutes } from './routes/members.ts'
import { PARTNER_PREFIX, partnerPlugin } from './routes/partner.ts'
import { registerTicketRoutes } from './routes/tickets.ts'
import { registerWorkspaceRoutes } from './routes/workspaces.ts'
import { sessionUserToUser } from './serialize.ts'
import { checkedSnapshots, createHttpSyncInternalClient, type SyncInternalClient } from './sync-internal.ts'
import type { VersionChange } from './worker/jobs.ts'
import { WORKER_PREFIX, type WorkerDeps, workerPlugin } from './worker/routes.ts'

/**
 * How long a request may take to ARRIVE (docs/SECURITY-REVIEW-2026-10-02.md M3-3). Fastify's own
 * `requestTimeout` was 0: a client could hold a socket for as long as it liked by sending a JSON body, or
 * an upload, a byte at a time. Node's timeout cannot tell an upload from a JSON call (one number for every
 * route, counted over the whole request), and an upload is long on purpose (a 500 MB video), so there are
 * three limits instead, none of them on how long a handler takes to answer:
 *  - `smallMs`: a request that declares no body, a small one (`largeBodyBytes` or less) or a chunked one
 *    must have arrived whole this long after its headers did, however steadily it trickles in;
 *  - `stallMs`: a request that declares a large body (an upload, a board import) has no total limit,
 *    but is cut when no byte of it arrives for this long;
 *  - `ceilingMs`: Node's own `requestTimeout`, the most any request may take to arrive, uploads
 *    included (60 minutes: what the review suggested; a slower upload is refused, never half-kept).
 * The first two answer 408 and close the connection (an upload's partial blob is deleted by its handler).
 */
export interface RequestTimeouts {
  smallMs: number
  stallMs: number
  ceilingMs: number
  /** A declared Content-Length above this makes a request a large one (the JSON routes stop at 256 KiB). */
  largeBodyBytes: number
}

export const DEFAULT_REQUEST_TIMEOUTS: RequestTimeouts = {
  smallMs: 60_000,
  stallMs: 60_000,
  ceilingMs: 60 * 60_000,
  largeBodyBytes: 1024 * 1024,
}

export interface ApiDeps {
  /** A migrated-or-empty database the caller owns (it is migrated here, never closed here). */
  db?: Db
  notifier?: SyncNotifier
  /** RT-01: tells the sync server whose sessions ended (auth/session-sync.ts; tests record instead). */
  sessionEnds?: SessionEndNotifier
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
  /**
   * TEST-ONLY seam: replaces the canvas engine probe built from `syncInternal.engine` (canvas-engine.ts).
   * The test helper passes TLDRAW_ONLY when it injects no sync client, as no test reaches a real sync.
   */
  canvasEngine?: CanvasEngineProbe
  /** Replaces the blob store chosen by config (tests inject fakes or a temp directory). */
  blobs?: BlobStore
  /** Request arrival limits (defaults: DEFAULT_REQUEST_TIMEOUTS; tests lower them). */
  timeouts?: Partial<RequestTimeouts>
  /** Worker route limits (tests lower them). */
  workerRateLimit?: WorkerDeps['rateLimit']
  /**
   * TEST-ONLY seam (docs/DOMAIN-ACCESS-CONTRACTS.md §11.1 creation matrix): false leaves the domain-access
   * root guard out, to prove the in-route creator checks hold on their own. Never set outside tests.
   */
  domainAccessGuard?: boolean
  /** GET /healthz/deep's thresholds and timeouts (health.ts DEFAULT_HEALTH; tests lower them). */
  health?: Partial<HealthOptions>
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

/** Whether a MATCHED route pattern is a server-to-server one (the web proxy never forwards `/internal`). */
const isInternalRoute = (pattern: string | undefined): pattern is string =>
  pattern !== undefined && (pattern === '/internal' || pattern.startsWith('/internal/'))

/**
 * AUDIT-INTERNAL-SCOPE: the ONE place the shared internal secret is checked. Every route whose pattern
 * is under `/internal` (the sync server's reports and pulls, the cut-over's checkpoint runs) is refused
 * with 401 before its handler, its parsing or its other hooks run, unless the request carries the
 * secret; no handler checks it by hand, so a future internal route cannot ship without it. Decided by
 * the matched route pattern (like the CSRF hook below), never by the raw URL. Add it before every
 * other hook: hooks run in registration order, and nothing may read a cookie or a body first.
 * The two routes with a typed contract (docs/EXCALIDRAW-MIGRATION.md §1, engine-internal.ts) answer in it.
 */
export function registerInternalSecretGuard(app: FastifyInstance, secret: string): void {
  app.addHook('onRequest', async (req, reply) => {
    const route = req.routeOptions.url
    if (!isInternalRoute(route)) return
    if (checkInternalSecret(req.headers[INTERNAL_SECRET_HEADER], secret)) return
    return reply
      .code(401)
      .send(
        ENGINE_INTERNAL_ROUTES.has(route)
          ? engineBadSecretBody()
          : { error: { code: 'NOT_AUTHENTICATED', message: 'Internal credentials required.' } },
      )
  })
}

const REQUEST_TIMEOUT_BODY = JSON.stringify({
  error: { code: 'REQUEST_TIMEOUT', message: 'The request took too long to arrive.' },
})
const REQUEST_TIMEOUT_RESPONSE = [
  'HTTP/1.1 408 Request Timeout',
  'Connection: close',
  'Content-Type: application/json; charset=utf-8',
  'Cache-Control: no-store',
  `Content-Length: ${Buffer.byteLength(REQUEST_TIMEOUT_BODY)}`,
  '',
  REQUEST_TIMEOUT_BODY,
].join('\r\n')

/** The body a request declares: 0 for none, null when it is not known up front (chunked). */
function declaredBodyLength(headers: IncomingHttpHeaders): number | null {
  if (headers['transfer-encoding'] !== undefined) return null
  const length = headers['content-length']
  if (length === undefined) return 0
  const n = Number(length)
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}

/**
 * The arrival limits of RequestTimeouts, as one onRequest hook (so it covers every route, the scopes of
 * the file routes and the worker included). A request that has no body to wait for costs nothing; one that
 * has gets a timer that is dropped as soon as the request has arrived (or its connection has gone), and
 * is `unref`ed so it never keeps the process alive. Real sockets only: app.inject() has nothing to time.
 * Decided by the declared Content-Length, not by a list of routes, so a new route that takes a large body
 * is not cut on a deadline it cannot meet, and one that takes a small body cannot be fed slowly. Time the
 * handler spends not reading what has already arrived is never held against the client.
 * The log line names the route pattern only (never the URL, which can hold a token).
 */
export function registerRequestTimeouts(app: FastifyInstance, t: RequestTimeouts): void {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const raw = req.raw
    const socket = raw.socket
    if (raw.complete || !(socket instanceof Socket)) return
    const declared = declaredBodyLength(raw.headers)
    if (declared === 0) return
    const large = declared !== null && declared > t.largeBodyBytes
    const limit = large ? t.stallMs : t.smallMs
    const startedAt = Date.now()
    let lastRead = socket.bytesRead
    let lastAt = startedAt

    const stop = () => {
      clearInterval(timer)
      raw.off('close', stop)
      socket.off('close', stop)
    }
    const cut = (reason: 'slow' | 'stalled') => {
      stop()
      if (socket.destroyed) return
      req.log.info(
        {
          evt: 'request.timeout',
          reason,
          route: req.routeOptions.url ?? '(no route)',
          ms: Date.now() - startedAt,
        },
        'request cut',
      )
      // what Node's own request timeout does: a 408 if no response has started, then the connection goes
      if (socket.writable && !reply.raw.headersSent) socket.write(REQUEST_TIMEOUT_RESPONSE)
      socket.destroySoon()
      setTimeout(() => socket.destroy(), 1_000).unref() // a client that never reads its answer
    }
    const timer = setInterval(
      () => {
        if (raw.complete || socket.destroyed) return stop()
        const now = Date.now()
        // Bytes the server has received and its handler has not read yet: the server is the slow side
        // (a store write, a database call), and Node has stopped reading the socket for it. Not a client's
        // fault, so not counted against it.
        if (raw.readableLength > 0) {
          lastAt = now
          return
        }
        if (!large) {
          if (now - startedAt >= limit) cut('slow')
          return
        }
        if (socket.bytesRead !== lastRead) {
          lastRead = socket.bytesRead
          lastAt = now
        } else if (now - lastAt >= limit) cut('stalled')
      },
      Math.max(10, Math.min(1_000, Math.floor(limit / 4))),
    )
    timer.unref()
    raw.once('close', stop)
    socket.once('close', stop)
  })
}

function defaultProvider(config: ApiConfig): AuthProvider {
  if (config.authProvider === 'dev') return createDevAuthProvider()
  if (config.authProvider === 'email') {
    if (!config.openSignin) throw new Error('AUTH_PROVIDER=email requires DRAFTROOM_OPEN_SIGNIN=1')
    return createEmailAuthProvider({
      workspaceName: config.openSignin.workspaceName,
      methods: config.openSignin.methods,
      googleClientId: config.openSignin.googleClientId,
    })
  }
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
  const timeouts: RequestTimeouts = { ...DEFAULT_REQUEST_TIMEOUTS, ...deps.timeouts }
  // Request logging is ours (onResponse below): route patterns only, never URLs, so invitation tokens
  // in paths and query strings never reach the logs.
  const app = Fastify({
    logger: deps.logger ?? false,
    logController: new Fastify.LogController({ disableRequestLogging: true }),
    return503OnClosing: true,
    // Node's own limit, as the ceiling for every request (RequestTimeouts above): never 0.
    requestTimeout: timeouts.ceilingMs,
    trustProxy: config.trustProxy, // req.ip (per-IP rate limits) behind proxies: TRUST_PROXY, docs/DEPLOY.md
    // CSD-4: router-level errors (a malformed or over-long URL) never reach setErrorHandler below, and
    // Fastify's own body repeats the requester's URL. They get the same generic body as every other refusal.
    frameworkErrors: (err, req, reply) => {
      const { status, body } = toErrorResponse(err)
      if (status >= 500) req.log.error({ err: { name: err.name, code: err.code } }, 'request failed')
      // The hook is generic over a route's Reply type; this answer has no route, so it is the plain reply.
      const res = reply as unknown as FastifyReply
      res
        .code(status)
        .header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff')
        .send(body)
    },
  })
  registerInternalSecretGuard(app, config.internalSecret)
  registerRequestTimeouts(app, timeouts) // reads no cookie and no body: after the guard, before the rest
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
  // RT-01: an ended session closes its person's board sockets (auth/session-sync.ts)
  const sessionEnds =
    deps.sessionEnds ??
    createHttpSessionEndNotifier({
      baseUrl: config.syncInternalUrl,
      secret: config.internalSecret,
      log: app.log,
    })
  sessions.onRevoked((_ids, userIds) => sessionEnds.ended(userIds))
  // Never an address: the domains and how many exceptions there are.
  app.log.info(
    provider.id === 'email'
      ? { creators: 'everyone (open email sign-in, docs/OPEN-SIGNIN.md)' }
      : { creators: { domains: [...config.creators.domains], exceptions: config.creators.emails.length } },
    'domain access policy',
  )
  const authRateLimit = deps.authRateLimit ?? { max: provider.id === 'dev' ? 600 : 60, timeWindow: 60_000 }
  const limits: ApiLimits = {
    ...DEFAULT_LIMITS,
    ...deps.limits,
    invitations: { ...DEFAULT_LIMITS.invitations, ...deps.limits?.invitations },
  }
  // Bridge release R0: a snapshot that is not a tldraw one is refused, never read as an empty board.
  const sync = checkedSnapshots(
    deps.syncInternal ??
      createHttpSyncInternalClient({ baseUrl: config.syncInternalUrl, secret: config.internalSecret }),
  )
  // R0's contracts (canvas-engine.ts): which canvas the sync runs decides what the api marks and refuses
  // K6-1: asked at start-up, again and again until sync answers; unknown until then (no guess).
  const canvas =
    deps.canvasEngine ??
    createCanvasEngineProbe(sync.engine ? () => (sync.engine as () => Promise<CanvasEngine>)() : undefined, {
      log: (m) => app.log.info(m),
      now: () => now().getTime(),
    })
  canvas.start?.()
  app.addHook('onClose', async () => canvas.stop?.())
  const ctx: AppContext = {
    config,
    db,
    sessions,
    notifier,
    now,
    authRateLimit,
    limits,
    identity,
    canvas,
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
  // not a browser route (Bearer token, cookies refused), and neither are the cut-over's checkpoint runs
  // (bridge release R0's run-all and the Excalidraw build's restore point, features/history/
  // checkpoint-all.ts: the internal secret, checked first; no cookie is read). Decided by the MATCHED
  // route pattern, never by the raw URL, so no path spelling can borrow the exemption for another route.
  app.addHook('onRequest', async (req, reply) => {
    if (req.routeOptions.url?.startsWith(WORKER_PREFIX)) return
    // Partner boards (routes/partner.ts): Bearer token, cookies refused; registered only with open sign-in.
    if (req.routeOptions.url?.startsWith(PARTNER_PREFIX)) return
    if (req.method === 'POST' && INTERNAL_CHECKPOINT_POSTS.has(req.routeOptions.url ?? '')) return
    if (MUTATING.has(req.method) && req.headers.origin !== config.publicOrigin) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Cross-origin request refused.' } })
    }
  })
  app.addHook('onSend', async (_req, reply, payload) => {
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store')
    if (!reply.hasHeader('x-content-type-options')) reply.header('x-content-type-options', 'nosniff')
    return payload
  })
  // M5-6: what /healthz/deep counts (5xx answers, the AI provider's failures), in memory only.
  const health = createHealth({ db, now: () => now().getTime(), options: deps.health })
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url
    health.record(req.method, route, reply.statusCode)
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
  // Partner boards (docs/OPEN-SIGNIN.md): only with open email sign-in and DRAFTROOM_PARTNER_TOKEN.
  if (config.openSignin?.partnerToken)
    await app.register(partnerPlugin, {
      ctx,
      token: config.openSignin.partnerToken,
      workspaceName: config.openSignin.workspaceName,
    })
  registerMemberRoutes(app, ctx)
  registerInvitationRoutes(app, ctx)
  registerTicketRoutes(app, ctx)
  // Excalidraw engine, A1 file-refs and A2 workshop-state (sync pulls; docs/EXCALIDRAW-MIGRATION.md §1);
  // bridge release R0 ships the same two routes (§5.10).
  registerEngineInternalRoutes(app, ctx)
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
  // Wave M (M5-6): for an outside monitor, public and without data: 200 'ok', or 503 with comma-separated reason
  // codes (db, 5xx, ai; health.ts). Render's healthCheckPath stays /healthz, so a deep failure never restarts the api.
  app.get(HEALTH_DEEP_ROUTE, async (_req, reply) => {
    const reasons = await health.reasons()
    return reply
      .code(reasons.length ? 503 : 200)
      .type('text/plain')
      .send(reasons.length ? reasons.join(',') : 'ok')
  })
  // S8: Render's deploy probe asks for GET / once per deploy; 204 instead of a 404 logged at warning level.
  app.get('/', async (_req, reply) => reply.code(204).send())

  // Stream diagnostic (no auth, no data): a 2 KB SSE comment, then three ticks one second apart, then
  // the end. It tells whether a proxy in front of the api (the static site's /api rewrite on Render)
  // passes an event stream through as it is written or holds it until the response ends: the board
  // event stream (events/routes.ts) depends on the former. Used by scripts/smoke/live-smoke.mjs.
  app.get('/api/diag/stream', async (_req, reply) => {
    reply.hijack()
    const res = reply.raw
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    })
    res.flushHeaders()
    res.write(`:${' '.repeat(2048)}

`)
    let n = 0
    const timer = setInterval(() => {
      n += 1
      res.write(`data: {"tick":${n}}

`)
      if (n >= 3) {
        clearInterval(timer)
        res.end()
      }
    }, 1_000)
    res.on('close', () => clearInterval(timer))
  })

  const layout = dataLayout(config.dataDir)
  const features: FeatureContext = {
    ...ctx,
    blobs,
    events,
    sync,
    layout,
  }
  registerEventRoutes(app, features)
  await registerFeatures(app, features, { domainAccessGuard: deps.domainAccessGuard !== false })
  // Wave J5: the Send feedback button's routes (POST /api/feedback, the inbox, GET /internal/feedback)
  await registerFeedback(app, ctx)
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
      await Promise.all([notifier.drain(), sessionEnds.drain()])
      if (ownsDb) await db.close()
    },
  }
}
