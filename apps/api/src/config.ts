// API environment (docs/M1-CONTRACTS.md §1, docs/FEATURES-M2-CONTRACTS.md "platform", docs/DEPLOY.md,
// docs/M3-STORAGE-CONTRACTS.md §6 blob store + worker token).
// Refuses to produce a config for an unsafe combination: development sign-in or development secrets
// under NODE_ENV=production, and (production) loopback defaults that would silently break the api <-> sync
// private channel (access pushes; sync's periodic re-checks fail OPEN, so revocation would not apply).

import { isIP } from 'node:net'
import { join } from 'node:path'
import { checkSecret } from '@draftroom/auth-tickets'
import {
  LIVE_SWITCH_ENV,
  LIVE_SWITCHES,
  type LiveSwitches,
  VISITS_RETENTION_DAYS_DEFAULT,
} from '@draftroom/contracts'
import { resolveDataDir } from '@draftroom/dev-assets'
import { type CreatorPolicy, parseCreatorPolicy } from './auth/creators.ts'
import { type AiConfig, parseAiConfig } from './features/ai/config.ts'
import { parseFeedbackAdmins } from './features/feedback/admins.ts'
import { parseStorageConfig, type StorageConfig } from './files/storage-config.ts'

export type AuthProviderId = 'dev' | 'clerk' | 'email'
export type OpenSigninMethod = 'email' | 'google'
const GOOGLE_CLIENT_ID_RE = /^[0-9]+-[a-z0-9]+.apps.googleusercontent.com$/

/**
 * Fastify's `trustProxy` option, ready to pass through: `false` (default: the socket peer is the client),
 * `true` (trust every X-Forwarded-For entry: only behind a proxy that REPLACES the header), a list of
 * trusted proxy addresses/CIDRs/presets, or a hop count as a function (see `TRUST_PROXY` in .env.example).
 */
export type TrustProxy = boolean | string[] | ((address: string, hop: number) => boolean)

/**
 * Where uploaded files live (docs/M3-STORAGE-CONTRACTS.md §1, §6). `fs`: a local directory (dev, e2e,
 * single-host deployments with a volume). `r2`: a Cloudflare R2 bucket (Render: the api has no disk).
 */
export type BlobStoreConfig =
  | { kind: 'fs'; root: string }
  | {
      kind: 'r2'
      accountId: string
      accessKeyId: string
      secretAccessKey: string
      bucket: string
      /** Override of https://<account>.r2.cloudflarestorage.com (e.g. a jurisdiction endpoint); null = default. */
      endpoint: string | null
    }

export interface ApiConfig {
  production: boolean
  /** NODE_ENV as checked by `parseNodeEnv` (M2): production, development or test, nothing else boots. */
  nodeEnv: NodeEnv
  host: string
  port: number
  /** Absolute DRAFTROOM_DATA_DIR (shared with sync + worker: rooms/, assets/, jobs/, pg/). */
  dataDir: string
  /** node-postgres connection string, or null to use PGlite at `pgliteDir`. */
  databaseUrl: string | null
  pgliteDir: string
  /**
   * DRAFTROOM_ALLOW_NEWER_SCHEMA=1: start although the database recorded migrations newer than this
   * build (a rollback; docs/DEPLOY.md "Rollback"), with a warning. Off by default: an older build
   * refuses a newer schema. Unknown older migrations and checksum mismatches are refused either way.
   */
  allowNewerSchema: boolean
  /** DRAFTROOM_DEV_AUTH=1: development identities exist only behind this explicit guard. */
  devAuth: boolean
  authProvider: AuthProviderId
  clerk: { secretKey: string; publishableKey: string } | null
  /**
   * Open email sign-in (docs/OPEN-SIGNIN.md), set exactly when AUTH_PROVIDER=email: the shared workspace
   * everyone joins (DRAFTROOM_SHARED_WORKSPACE_NAME) and the partner token (DRAFTROOM_PARTNER_TOKEN, null
   * when unset: no /api/partner routes).
   */
  openSignin: {
    workspaceName: string
    partnerToken: string | null
    /** DRAFTROOM_OPEN_SIGNIN_METHODS: typed address and/or Google (default email). */
    methods: OpenSigninMethod[]
    /** DRAFTROOM_GOOGLE_CLIENT_ID: required exactly when methods include google. */
    googleClientId: string | null
  } | null
  /** Exact browser origin (scheme://host[:port]) for Origin checks, cookie `Secure` and invite links. */
  publicOrigin: string
  /**
   * DRAFTROOM_EVENTS_ORIGIN: this api's own public origin (scheme://host[:port]), where browsers open the
   * board event stream directly with a ticket (events/tickets.ts) instead of through PUBLIC_ORIGIN's /api
   * rewrite, which holds a streamed response until it ends (Render static sites, measured 2026-10-05).
   * null (unset): pages keep the same-origin cookie stream (dev, e2e by default, a single-origin edge).
   */
  eventsOrigin: string | null
  ticketSecret: string
  internalSecret: string
  /** Base URL of the sync server's internal endpoints (no trailing slash). */
  syncInternalUrl: string
  /** How `req.ip` (and so every per-IP rate limit) is derived behind reverse proxies. */
  trustProxy: TrustProxy
  /** DRAFTROOM_BLOB_STORE and R2_*: where originals and derivatives are stored. */
  blobStore: BlobStoreConfig
  /**
   * DRAFTROOM_WORKER_TOKEN: the Bearer token preview workers present on /api/worker/* (≥ 32 chars; the
   * dev placeholder is refused in production). A capability to read queued originals and write
   * derivatives, nothing else.
   */
  workerToken: string
  /**
   * Upload limits (docs/SECURITY-REVIEW-2026-09-27.md FC-1): per-workspace storage quota over every
   * stored original (DRAFTROOM_WORKSPACE_QUOTA_MB, DRAFTROOM_WORKSPACE_MAX_FILES) and uploads per
   * signed-in user per minute (DRAFTROOM_UPLOADS_PER_MINUTE).
   */
  uploads: UploadLimitsConfig
  /** Per-guest uploads, boards per workspace, the unreferenced-file collector (files/storage-config.ts). */
  storage: StorageConfig
  /** AI on the board: OPENAI_* and DRAFTROOM_AI_* (features/ai/config.ts), with its hard cost limits. */
  ai: AiConfig
  /**
   * Domain access (docs/DOMAIN-ACCESS-CONTRACTS.md §2): DRAFTROOM_CREATOR_DOMAINS (default darkburn.com,
   * trailerparkgroup.com, trailerpark.com) and DRAFTROOM_CREATOR_EMAILS (the exceptions; default none). Always on.
   */
  creators: CreatorPolicy
  /**
   * DRAFTROOM_LINK_PREVIEW_TEST_ORIGINS (comma-separated exact origins): the e2e fixture server on
   * loopback that link previews (features/link-preview) may fetch from, which their network rules
   * refuse otherwise. Local development only: it requires DRAFTROOM_DEV_AUTH=1 (refused in production).
   */
  linkPreviewTestOrigins: readonly string[]
  /**
   * Wave R: DRAFTROOM_DESIGN_PREVIEWS ("on" only; unset, empty or "off" is off). On: Photoshop, Illustrator and TIFF uploads
   * are classified for flattened-page previews (kind 'pdf', dev-assets DESIGN_FORMATS). Off: they are plain attachments
   * (kind 'other'), as before wave R. Turn it on only once the preview worker handles those files. Also told to the web
   * (GET /api/auth/config).
   */
  designPreviews: boolean
  /**
   * Wave V (docs/WAVE-V-CONTRACTS.md §1): the "Live sessions+" kill switches, each "on" only (unset, empty or "off" is
   * off; anything else refuses to start): DRAFTROOM_LIVE_ACTIVITIES (polls, scales, word clouds), DRAFTROOM_JOIN_CODES
   * (join codes), DRAFTROOM_BREAKOUTS (breakouts). Off: every route of that feature answers as an unknown route
   * (features/live/switch.ts). Also told to the web (GET /api/auth/config `live`).
   */
  live: LiveSwitches
  /** Wave R: DRAFTROOM_MIRO_TEST_ORIGINS (local dev only): the fake Miro server's origins, or null. */
  miroTestOrigins: { api: string; files: string | null } | null
  /** Wave R: DRAFTROOM_CHAT_HOOK_TEST_ORIGINS (local dev only): the fake webhook receiver's origins, or null. */
  chatHookTestOrigins: { slack: string; teams: string | null } | null
  /**
   * Wave R: DRAFTROOM_WEBHOOK_SECRET (and _PREVIOUS while rotating): the key chat hook URLs are sealed with. null when
   * unset: chat hooks are off (fail closed).
   */
  webhookSecret: { current: string; previous: string | null } | null
  /**
   * DRAFTROOM_FEEDBACK_ADMINS (wave J5, features/feedback/admins.ts): normalised verified addresses of the
   * people who read the feedback inbox and mark items done. Empty (unset): nobody does through the app.
   */
  feedbackAdmins: readonly string[]
  /**
   * DRAFTROOM_VISITS_RETENTION_DAYS (wave N, N4-1, features/visits/sweep.ts): per-person board visit times older than
   * this many days are deleted. Default 180.
   */
  visitsRetentionDays: number
}

export interface UploadLimitsConfig {
  workspaceQuotaBytes: number
  workspaceMaxFiles: number
  perUserPerMinute: number
}

const MiB = 1024 * 1024
/**
 * Staging defaults: 2 GB and 5,000 files per workspace (a handful of workspaces fit R2's free 10 GB),
 * and 120 uploads a minute per person (a 100-image drop goes through in one go).
 */
export const DEFAULT_UPLOAD_LIMITS: Readonly<UploadLimitsConfig> = {
  workspaceQuotaBytes: 2048 * MiB,
  workspaceMaxFiles: 5_000,
  perUserPerMinute: 120,
}

type Env = Record<string, string | undefined>

// Empty values count as unset so `PORT=` in an env file falls back to the default.
const read = (env: Env, name: string): string | undefined => {
  const v = env[name]?.trim()
  return v ? v : undefined
}

export type NodeEnv = 'production' | 'development' | 'test'
/**
 * NODE_ENV, checked (security audit M2). Every guard of the unsafe features (dev sign-in, the `dev-only-`
 * placeholder secrets, loopback defaults, an http OPENAI_BASE_URL) keys on the exact string `production`,
 * so any other value (`staging` typed into the Render dashboard) turned them all off together, silently.
 * Only Node's three conventions are accepted; unset or empty reads as development.
 */
export function parseNodeEnv(env: Env): NodeEnv {
  const raw = read(env, 'NODE_ENV') ?? 'development'
  if (raw === 'production' || raw === 'development' || raw === 'test') return raw
  throw new Error(
    `NODE_ENV must be production, development or test, not ${JSON.stringify(raw.slice(0, 32))}: every production guard keys on NODE_ENV=production, so an unknown value would turn them all off`,
  )
}

function int(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = read(env, name)
  if (raw === undefined) return fallback
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer`)
  const n = Number(raw)
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}`)
  return n
}

function httpUrl(name: string, raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${name} must be http(s)`)
  return url
}

/**
 * True when a URL hostname can only mean "this machine" (or "any local address"): `localhost` and
 * `*.localhost`, 127.0.0.0/8, 0.0.0.0/8, `::1`, `::` and IPv4-mapped loopback. Hostnames arrive already
 * normalized by WHATWG URL (so `127.1`, `2130706433` and `[0:0::1]` are covered).
 */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  const v = isIP(h)
  if (v === 4) return h.startsWith('127.') || h.startsWith('0.')
  if (v === 6) return h === '::1' || h === '::' || /^::ffff:(7f[0-9a-f]{2}:|0:|127\.|0\.)/.test(h)
  return false
}

// Render's `fromService.property: hostport` value ("my-service:10000"): no scheme, port required.
const HOSTPORT_RE = /^(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?):\d{1,5}$/i

/**
 * A base URL for server-to-server calls: a full http(s) URL, or `host:port` (Render Blueprints can only
 * inject that form), which becomes `http://host:port` (private-network traffic is plain HTTP). Under
 * NODE_ENV=production the value is required and must not be a loopback address: the loopback default
 * only works when every process shares one machine, and a wrong target fails silently.
 */
export function internalBaseUrl(env: Env, name: string, fallback: string, production: boolean): string {
  const raw = read(env, name)
  if (raw === undefined && production)
    throw new Error(`${name} is required when NODE_ENV=production (an http(s) URL or host:port)`)
  const value = raw ?? fallback
  let url: URL
  try {
    url = new URL(HOSTPORT_RE.test(value) ? `http://${value}` : value)
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL or host:port`)
  }
  // A query or fragment would be merged into every internal request; credentials would be logged by proxies.
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error(
      `${name} must be an absolute http(s) URL or host:port, without credentials, query or fragment`,
    )
  if (production && isLoopbackHost(url.hostname))
    throw new Error(
      `${name} must not be a loopback address (${url.hostname}) when NODE_ENV=production: use the other service's private-network address`,
    )
  return url.href.replace(/\/+$/, '')
}

const TRUST_PRESETS = new Set(['loopback', 'linklocal', 'uniquelocal'])
const MAX_TRUSTED_HOPS = 10

function isTrustEntry(entry: string): boolean {
  if (TRUST_PRESETS.has(entry)) return true
  const [addr, prefix, ...rest] = entry.split('/')
  if (rest.length > 0 || !addr) return false
  const v = isIP(addr)
  if (v === 0) return false
  if (prefix === undefined) return true
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (v === 4 ? 32 : 128)
}

/**
 * TRUST_PROXY: unset / `false` / `0` = trust no proxy; `true` = trust every hop; an integer N = the N
 * nearest hops are proxies (the address N entries back from the socket is the client); otherwise a
 * comma-separated list of proxy IPs, CIDRs and the presets loopback / linklocal / uniquelocal.
 */
export function parseTrustProxy(raw: string | undefined): TrustProxy {
  const v = raw?.trim()
  const word = v?.toLowerCase()
  if (!v || word === 'false' || v === '0') return false
  if (word === 'true') return true
  if (/^\d+$/.test(v)) {
    const hops = Number(v)
    if (hops > MAX_TRUSTED_HOPS)
      throw new Error(`TRUST_PROXY hop count must be between 0 and ${MAX_TRUSTED_HOPS}`)
    // A function, because Fastify 5.12 deliberately treats a numeric trustProxy as "trust nothing" (a
    // hop count cannot tell a proxy from a direct client). Only correct when EVERY request reaches the
    // api through exactly this many proxies that append to X-Forwarded-For (Render: see docs/DEPLOY.md).
    return (_address: string, hop: number) => hop < hops
  }
  const entries = v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const bad = entries.find((e) => !isTrustEntry(e))
  if (bad !== undefined || entries.length === 0)
    throw new Error(
      'TRUST_PROXY must be true, false, a hop count, or a comma-separated list of IPs, CIDRs, loopback, linklocal or uniquelocal',
    )
  return entries
}

const R2_ACCOUNT_RE = /^[0-9a-f]{32}$/
// S3/R2 bucket names: 3-63 lowercase letters, digits and hyphens, starting and ending alphanumeric.
const R2_BUCKET_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/
// Credentials are opaque to us; this only rejects obvious paste mistakes (spaces, quotes, newlines).
const CREDENTIAL_RE = /^[A-Za-z0-9+/=_-]{16,256}$/

/**
 * DRAFTROOM_BLOB_STORE=fs|r2. Default `fs` (`${DRAFTROOM_DATA_DIR}/blobs`) outside production; in
 * production the choice must be explicit, because a silent local-disk default on a host without a
 * persistent disk (Render's api has none) loses every upload on the next deploy. Error messages name
 * variables, never their values.
 */
export function parseBlobStore(env: Env, dataDir: string, production: boolean): BlobStoreConfig {
  const raw = read(env, 'DRAFTROOM_BLOB_STORE')
  if (raw === undefined && production)
    throw new Error(
      'DRAFTROOM_BLOB_STORE is required when NODE_ENV=production (r2, or fs with a persistent disk)',
    )
  const kind = raw ?? 'fs'
  if (kind === 'fs') return { kind: 'fs', root: join(dataDir, 'blobs') }
  if (kind !== 'r2') throw new Error('DRAFTROOM_BLOB_STORE must be fs or r2')
  const missing = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'].filter(
    (n) => read(env, n) === undefined,
  )
  if (missing.length) throw new Error(`DRAFTROOM_BLOB_STORE=r2 requires ${missing.join(', ')}`)
  const accountId = read(env, 'R2_ACCOUNT_ID') ?? ''
  const accessKeyId = read(env, 'R2_ACCESS_KEY_ID') ?? ''
  const secretAccessKey = read(env, 'R2_SECRET_ACCESS_KEY') ?? ''
  const bucket = read(env, 'R2_BUCKET') ?? ''
  if (!R2_ACCOUNT_RE.test(accountId)) throw new Error('R2_ACCOUNT_ID must be the 32-character hex account id')
  if (!CREDENTIAL_RE.test(accessKeyId)) throw new Error('R2_ACCESS_KEY_ID is malformed')
  if (!CREDENTIAL_RE.test(secretAccessKey)) throw new Error('R2_SECRET_ACCESS_KEY is malformed')
  if (accessKeyId === secretAccessKey)
    throw new Error('R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY must differ')
  if (!R2_BUCKET_RE.test(bucket) || bucket.includes('--'))
    throw new Error('R2_BUCKET must be a valid bucket name (3-63 lowercase letters, digits and hyphens)')
  let endpoint: string | null = null
  const endpointRaw = read(env, 'R2_ENDPOINT')
  if (endpointRaw !== undefined) {
    let url: URL
    try {
      url = new URL(endpointRaw)
    } catch {
      throw new Error('R2_ENDPOINT must be an absolute https URL')
    }
    if (
      url.protocol !== 'https:' ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw new Error(
        'R2_ENDPOINT must be an https origin (scheme://host[:port]) without credentials or path',
      )
    endpoint = url.origin
  }
  return { kind: 'r2', accountId, accessKeyId, secretAccessKey, bucket, endpoint }
}

/** A list of exact http(s) origins in `name`, behind the local-dev guard only (an e2e fixture server's seam). */
function parseTestOrigins(
  env: Env,
  name: string,
  devAuth: boolean,
  max = Number.POSITIVE_INFINITY,
): string[] {
  const raw = read(env, name)
  if (raw === undefined) return []
  if (!devAuth) throw new Error(`${name} requires DRAFTROOM_DEV_AUTH=1`)
  const out: string[] = []
  for (const part of raw.split(',')) {
    const v = part.trim()
    if (!v) continue
    let url: URL
    try {
      url = new URL(v)
    } catch {
      throw new Error(`${name} must list http(s) origins (scheme://host:port)`)
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== v.replace(/\/$/, ''))
      throw new Error(`${name} must list http(s) origins (scheme://host:port)`)
    out.push(url.origin)
  }
  if (out.length > max) throw new Error(`${name} lists at most ${max} origins`)
  return out
}

/** A fail-closed switch: "on" turns it on; unset, empty or "off" are off; anything else is refused (any case, trimmed). */
export function parseOnOff(env: Env, name: string): boolean {
  const raw = read(env, name)?.toLowerCase() ?? 'off'
  if (raw !== 'on' && raw !== 'off') throw new Error(`${name} must be on or off`)
  return raw === 'on'
}

/** DRAFTROOM_DESIGN_PREVIEWS: "on" turns it on; unset, empty or "off" are off; anything else is refused. */
export const parseDesignPreviews = (env: Env): boolean => parseOnOff(env, 'DRAFTROOM_DESIGN_PREVIEWS')

/** Wave V: DRAFTROOM_LIVE_ACTIVITIES, DRAFTROOM_JOIN_CODES, DRAFTROOM_BREAKOUTS, each as parseOnOff. */
export function parseLiveSwitches(env: Env): LiveSwitches {
  return Object.fromEntries(
    LIVE_SWITCHES.map((s) => [s, parseOnOff(env, LIVE_SWITCH_ENV[s])]),
  ) as LiveSwitches
}

/** DRAFTROOM_LINK_PREVIEW_TEST_ORIGINS: exact http(s) origins, behind the local-dev guard only. */
export function parseLinkPreviewTestOrigins(env: Env, devAuth: boolean): string[] {
  return parseTestOrigins(env, 'DRAFTROOM_LINK_PREVIEW_TEST_ORIGINS', devAuth)
}

/**
 * Wave R: the fake Miro server's two origins (e2e/tests/support/miro.ts), `<api>,<files>`: the first stands for
 * https://api.miro.com, the second for the signed-download host. Behind the local-dev guard only.
 */
export function parseMiroTestOrigins(env: Env, devAuth: boolean): ApiConfig['miroTestOrigins'] {
  const list = parseTestOrigins(env, 'DRAFTROOM_MIRO_TEST_ORIGINS', devAuth, 2)
  return list[0] ? { api: list[0], files: list[1] ?? null } : null
}

/**
 * Wave R: the fake webhook receiver (e2e/tests/support/chat-hooks.ts), `<slack>[,<teams>]`: each origin stands for
 * that provider's webhook host; its path and query rules still apply. Behind the local-dev guard only.
 */
export function parseChatHookTestOrigins(env: Env, devAuth: boolean): ApiConfig['chatHookTestOrigins'] {
  const list = parseTestOrigins(env, 'DRAFTROOM_CHAT_HOOK_TEST_ORIGINS', devAuth, 2)
  return list[0] ? { slack: list[0], teams: list[1] ?? null } : null
}

/**
 * Wave R: DRAFTROOM_WEBHOOK_SECRET, the key chat hook URLs are sealed with (crypto/sealed.ts), and
 * DRAFTROOM_WEBHOOK_SECRET_PREVIOUS, the one being rotated away from (it only opens). Unset: null, and chat hooks are
 * off (fail closed: no hook can be saved, sent to or read). Each is checkSecret-validated (at least 32 characters, no
 * development placeholder in production) and must differ from every other secret of the api.
 */
export function parseWebhookSecret(
  env: Env,
  production: boolean,
  others: readonly string[],
): ApiConfig['webhookSecret'] {
  const raw = read(env, 'DRAFTROOM_WEBHOOK_SECRET')
  const previousRaw = read(env, 'DRAFTROOM_WEBHOOK_SECRET_PREVIOUS')
  if (raw === undefined) {
    if (previousRaw !== undefined)
      throw new Error('DRAFTROOM_WEBHOOK_SECRET_PREVIOUS is set but DRAFTROOM_WEBHOOK_SECRET is not')
    return null
  }
  const current = checkSecret('DRAFTROOM_WEBHOOK_SECRET', raw, production)
  if (others.includes(current))
    throw new Error('DRAFTROOM_WEBHOOK_SECRET must differ from every other secret of the api')
  let previous: string | null = null
  if (previousRaw !== undefined) {
    previous = checkSecret('DRAFTROOM_WEBHOOK_SECRET_PREVIOUS', previousRaw, production)
    if (previous === current || others.includes(previous))
      throw new Error(
        'DRAFTROOM_WEBHOOK_SECRET_PREVIOUS must differ from DRAFTROOM_WEBHOOK_SECRET and the other secrets',
      )
  }
  return { current, previous }
}

/**
 * DRAFTROOM_EVENTS_ORIGIN (optional): an origin only, https in production. Browsers fetch the event stream
 * from it cross-origin, so the web's CSP connect-src must name it (render.yaml), and the api answers CORS
 * for exactly PUBLIC_ORIGIN on that one route (events/routes.ts).
 */
export function parseEventsOrigin(env: Env, production: boolean): string | null {
  const raw = read(env, 'DRAFTROOM_EVENTS_ORIGIN')
  if (raw === undefined) return null
  const url = httpUrl('DRAFTROOM_EVENTS_ORIGIN', raw)
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password)
    throw new Error('DRAFTROOM_EVENTS_ORIGIN must be an origin only (scheme://host[:port])')
  if (production && url.protocol !== 'https:')
    throw new Error('DRAFTROOM_EVENTS_ORIGIN must be https in production')
  return url.origin
}

/**
 * Open email sign-in (docs/OPEN-SIGNIN.md). AUTH_PROVIDER=email lets anyone sign in as any address, so it
 * needs DRAFTROOM_OPEN_SIGNIN=1 as well (and the flag means nothing without it). It is allowed in
 * production on purpose: it is for a deployment with nothing private on it. The partner token is read
 * here and checked with the other secrets in loadConfig. null for every other provider.
 */
export function parseOpenSignin(
  env: Env,
  authProvider: AuthProviderId,
): {
  workspaceName: string
  partnerTokenRaw: string | undefined
  methods: OpenSigninMethod[]
  googleClientId: string | null
} | null {
  const flag = read(env, 'DRAFTROOM_OPEN_SIGNIN')
  if (flag !== undefined && flag !== '1' && flag !== '0')
    throw new Error('DRAFTROOM_OPEN_SIGNIN must be 1 (anyone may sign in as any email address) or unset')
  const open = flag === '1'
  const nameRaw = read(env, 'DRAFTROOM_SHARED_WORKSPACE_NAME')
  const partnerTokenRaw = read(env, 'DRAFTROOM_PARTNER_TOKEN')
  const methodsRaw = read(env, 'DRAFTROOM_OPEN_SIGNIN_METHODS')
  const googleRaw = read(env, 'DRAFTROOM_GOOGLE_CLIENT_ID')
  if (authProvider !== 'email') {
    if (methodsRaw !== undefined)
      throw new Error('DRAFTROOM_OPEN_SIGNIN_METHODS requires AUTH_PROVIDER=email')
    if (googleRaw !== undefined) throw new Error('DRAFTROOM_GOOGLE_CLIENT_ID requires AUTH_PROVIDER=email')
    if (open) throw new Error('DRAFTROOM_OPEN_SIGNIN=1 requires AUTH_PROVIDER=email')
    if (nameRaw !== undefined) throw new Error('DRAFTROOM_SHARED_WORKSPACE_NAME requires AUTH_PROVIDER=email')
    if (partnerTokenRaw !== undefined) throw new Error('DRAFTROOM_PARTNER_TOKEN requires AUTH_PROVIDER=email')
    return null
  }
  if (!open)
    throw new Error(
      'AUTH_PROVIDER=email lets anyone sign in as any email address: it requires DRAFTROOM_OPEN_SIGNIN=1',
    )
  const workspaceName = nameRaw ?? 'Lobby'
  if (workspaceName.length > 120) throw new Error('DRAFTROOM_SHARED_WORKSPACE_NAME must be 1-120 characters')
  // email: any typed address (nothing verified); google: "Sign in with Google" (the address Google verified).
  const methods: OpenSigninMethod[] = []
  for (const m of (methodsRaw ?? 'email')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)) {
    if (m !== 'email' && m !== 'google')
      throw new Error('DRAFTROOM_OPEN_SIGNIN_METHODS must list email and/or google (comma-separated)')
    if (!methods.includes(m)) methods.push(m)
  }
  if (!methods.length) throw new Error('DRAFTROOM_OPEN_SIGNIN_METHODS lists no method')
  let googleClientId: string | null = null
  if (methods.includes('google')) {
    if (googleRaw === undefined || !GOOGLE_CLIENT_ID_RE.test(googleRaw))
      throw new Error(
        'DRAFTROOM_OPEN_SIGNIN_METHODS=google needs DRAFTROOM_GOOGLE_CLIENT_ID (<number>-<id>.apps.googleusercontent.com)',
      )
    googleClientId = googleRaw
  } else if (googleRaw !== undefined)
    throw new Error(
      'DRAFTROOM_GOOGLE_CLIENT_ID is set but DRAFTROOM_OPEN_SIGNIN_METHODS does not include google',
    )
  return { workspaceName, partnerTokenRaw, methods, googleClientId }
}

/** Parses and validates the API environment. Throws an operator-facing message on bad input. */
export function loadConfig(env: Env = process.env): ApiConfig {
  const nodeEnv = parseNodeEnv(env)
  const production = nodeEnv === 'production'

  const devFlag = read(env, 'DRAFTROOM_DEV_AUTH')
  if (devFlag !== undefined && devFlag !== '1' && devFlag !== '0')
    throw new Error('DRAFTROOM_DEV_AUTH must be 1 (local development only) or unset')
  const devAuth = devFlag === '1'
  if (devAuth && production) throw new Error('DRAFTROOM_DEV_AUTH=1 is refused when NODE_ENV=production')

  const newerSchemaFlag = read(env, 'DRAFTROOM_ALLOW_NEWER_SCHEMA')
  if (newerSchemaFlag !== undefined && newerSchemaFlag !== '1' && newerSchemaFlag !== '0')
    throw new Error('DRAFTROOM_ALLOW_NEWER_SCHEMA must be 1 (a rollback, docs/DEPLOY.md) or unset')

  const providerRaw = read(env, 'AUTH_PROVIDER') ?? (devAuth ? 'dev' : 'clerk')
  if (providerRaw !== 'dev' && providerRaw !== 'clerk' && providerRaw !== 'email')
    throw new Error('AUTH_PROVIDER must be dev, clerk or email')
  const authProvider: AuthProviderId = providerRaw
  if (authProvider === 'dev' && production)
    throw new Error('AUTH_PROVIDER=dev is refused when NODE_ENV=production')
  if (authProvider === 'dev' && !devAuth) throw new Error('AUTH_PROVIDER=dev requires DRAFTROOM_DEV_AUTH=1')

  let clerk: ApiConfig['clerk'] = null
  if (authProvider === 'clerk') {
    const secretKey = read(env, 'CLERK_SECRET_KEY')
    const publishableKey = read(env, 'CLERK_PUBLISHABLE_KEY')
    if (!secretKey || !publishableKey)
      throw new Error('AUTH_PROVIDER=clerk requires CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY')
    clerk = { secretKey, publishableKey }
  }

  const openSigninRaw = parseOpenSignin(env, authProvider)

  // No default in production: the local default would make every mutation a 403 (Origin check) and
  // write loopback invite links.
  const originRaw = read(env, 'PUBLIC_ORIGIN')
  if (originRaw === undefined && production)
    throw new Error('PUBLIC_ORIGIN is required when NODE_ENV=production (the https origin users open)')
  const origin = httpUrl('PUBLIC_ORIGIN', originRaw ?? 'http://127.0.0.1:5173')
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password)
    throw new Error('PUBLIC_ORIGIN must be an origin only (scheme://host[:port])')
  if (production && origin.protocol !== 'https:') throw new Error('PUBLIC_ORIGIN must be https in production')

  const eventsOrigin = parseEventsOrigin(env, production)

  const syncInternalUrl = internalBaseUrl(
    env,
    'DRAFTROOM_SYNC_INTERNAL_URL',
    'http://127.0.0.1:5858',
    production,
  )

  const ticketSecret = checkSecret(
    'DRAFTROOM_TICKET_SECRET',
    read(env, 'DRAFTROOM_TICKET_SECRET'),
    production,
  )
  const internalSecret = checkSecret(
    'DRAFTROOM_INTERNAL_SECRET',
    read(env, 'DRAFTROOM_INTERNAL_SECRET'),
    production,
  )
  // Separate keys: whoever can mint tickets must not also be able to call internal endpoints.
  if (ticketSecret === internalSecret)
    throw new Error('DRAFTROOM_TICKET_SECRET and DRAFTROOM_INTERNAL_SECRET must differ')
  // Workers run on other machines (the NAS): their token must not also mint tickets or call sync.
  const workerToken = checkSecret('DRAFTROOM_WORKER_TOKEN', read(env, 'DRAFTROOM_WORKER_TOKEN'), production)
  if (workerToken === ticketSecret || workerToken === internalSecret)
    throw new Error(
      'DRAFTROOM_WORKER_TOKEN must differ from DRAFTROOM_TICKET_SECRET and DRAFTROOM_INTERNAL_SECRET',
    )

  let openSignin: ApiConfig['openSignin'] = null
  if (openSigninRaw) {
    const { workspaceName, partnerTokenRaw, methods, googleClientId } = openSigninRaw
    let partnerToken: string | null = null
    if (partnerTokenRaw !== undefined) {
      partnerToken = checkSecret('DRAFTROOM_PARTNER_TOKEN', partnerTokenRaw, production)
      // A partner app holds this token on another server: it must not also mint tickets, call sync or
      // act as a preview worker.
      if (partnerToken === ticketSecret || partnerToken === internalSecret || partnerToken === workerToken)
        throw new Error(
          'DRAFTROOM_PARTNER_TOKEN must differ from DRAFTROOM_TICKET_SECRET, DRAFTROOM_INTERNAL_SECRET and DRAFTROOM_WORKER_TOKEN',
        )
    }
    openSignin = { workspaceName, partnerToken, methods, googleClientId }
  }

  // The inbox readers are matched against verified addresses; open email sign-in verifies none (anyone
  // could type a reader's address), so the two never run together.
  const feedbackAdmins = parseFeedbackAdmins(env)
  if (authProvider === 'email' && feedbackAdmins.length)
    throw new Error(
      'DRAFTROOM_FEEDBACK_ADMINS needs a provider that verifies addresses: AUTH_PROVIDER=email lets anyone sign in as any address',
    )

  const webhookSecret = parseWebhookSecret(env, production, [
    ticketSecret,
    internalSecret,
    workerToken,
    ...(openSignin?.partnerToken ? [openSignin.partnerToken] : []),
  ])

  const dataDir = resolveDataDir(env)
  return {
    production,
    nodeEnv,
    host: read(env, 'HOST') ?? '127.0.0.1',
    port: int(env, 'PORT', 5859, 0, 65_535),
    dataDir,
    databaseUrl: read(env, 'DATABASE_URL') ?? null,
    pgliteDir: join(dataDir, 'pg'),
    allowNewerSchema: newerSchemaFlag === '1',
    devAuth,
    authProvider,
    clerk,
    openSignin,
    publicOrigin: origin.origin,
    eventsOrigin,
    ticketSecret,
    internalSecret,
    syncInternalUrl,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    blobStore: parseBlobStore(env, dataDir, production),
    workerToken,
    uploads: {
      workspaceQuotaBytes:
        int(
          env,
          'DRAFTROOM_WORKSPACE_QUOTA_MB',
          DEFAULT_UPLOAD_LIMITS.workspaceQuotaBytes / MiB,
          1,
          10_000_000,
        ) * MiB,
      workspaceMaxFiles: int(
        env,
        'DRAFTROOM_WORKSPACE_MAX_FILES',
        DEFAULT_UPLOAD_LIMITS.workspaceMaxFiles,
        1,
        100_000_000,
      ),
      perUserPerMinute: int(
        env,
        'DRAFTROOM_UPLOADS_PER_MINUTE',
        DEFAULT_UPLOAD_LIMITS.perUserPerMinute,
        1,
        100_000,
      ),
    },
    storage: parseStorageConfig(env),
    ai: parseAiConfig(env, production),
    creators: parseCreatorPolicy(env),
    linkPreviewTestOrigins: parseLinkPreviewTestOrigins(env, devAuth),
    designPreviews: parseDesignPreviews(env),
    live: parseLiveSwitches(env),
    miroTestOrigins: parseMiroTestOrigins(env, devAuth),
    chatHookTestOrigins: parseChatHookTestOrigins(env, devAuth),
    webhookSecret,
    feedbackAdmins,
    visitsRetentionDays: int(env, 'DRAFTROOM_VISITS_RETENTION_DAYS', VISITS_RETENTION_DAYS_DEFAULT, 1, 3650),
  }
}
