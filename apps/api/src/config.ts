// API environment (docs/M1-CONTRACTS.md §1, docs/FEATURES-M2-CONTRACTS.md "platform", docs/DEPLOY.md,
// docs/M3-STORAGE-CONTRACTS.md §6 blob store + worker token).
// Refuses to produce a config for an unsafe combination: development sign-in or development secrets
// under NODE_ENV=production, and (production) loopback defaults that would silently break the api <-> sync
// private channel (access pushes; sync's periodic re-checks fail OPEN, so revocation would not apply).

import { isIP } from 'node:net'
import { join } from 'node:path'
import { checkSecret } from '@draftroom/auth-tickets'
import { resolveDataDir } from '@draftroom/dev-assets'
import { type CreatorPolicy, parseCreatorPolicy } from './auth/creators.ts'
import { type AiConfig, parseAiConfig } from './features/ai/config.ts'
import { parseStorageConfig, type StorageConfig } from './files/storage-config.ts'

export type AuthProviderId = 'dev' | 'clerk'

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
  /** Exact browser origin (scheme://host[:port]) for Origin checks, cookie `Secure` and invite links. */
  publicOrigin: string
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
   * trailerparkgroup.com) and DRAFTROOM_CREATOR_EMAILS (the exceptions; default none). Always on.
   */
  creators: CreatorPolicy
  /**
   * DRAFTROOM_LINK_PREVIEW_TEST_ORIGINS (comma-separated exact origins): the e2e fixture server on
   * loopback that link previews (features/link-preview) may fetch from, which their network rules
   * refuse otherwise. Local development only: it requires DRAFTROOM_DEV_AUTH=1 (refused in production).
   */
  linkPreviewTestOrigins: readonly string[]
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

/** DRAFTROOM_LINK_PREVIEW_TEST_ORIGINS: exact http(s) origins, behind the local-dev guard only. */
export function parseLinkPreviewTestOrigins(env: Env, devAuth: boolean): string[] {
  const raw = read(env, 'DRAFTROOM_LINK_PREVIEW_TEST_ORIGINS')
  if (raw === undefined) return []
  if (!devAuth) throw new Error('DRAFTROOM_LINK_PREVIEW_TEST_ORIGINS requires DRAFTROOM_DEV_AUTH=1')
  const out: string[] = []
  for (const part of raw.split(',')) {
    const v = part.trim()
    if (!v) continue
    let url: URL
    try {
      url = new URL(v)
    } catch {
      throw new Error('DRAFTROOM_LINK_PREVIEW_TEST_ORIGINS must list http(s) origins (scheme://host:port)')
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== v.replace(/\/$/, ''))
      throw new Error('DRAFTROOM_LINK_PREVIEW_TEST_ORIGINS must list http(s) origins (scheme://host:port)')
    out.push(url.origin)
  }
  return out
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
  if (providerRaw !== 'dev' && providerRaw !== 'clerk') throw new Error('AUTH_PROVIDER must be dev or clerk')
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

  // No default in production: the local default would make every mutation a 403 (Origin check) and
  // write loopback invite links.
  const originRaw = read(env, 'PUBLIC_ORIGIN')
  if (originRaw === undefined && production)
    throw new Error('PUBLIC_ORIGIN is required when NODE_ENV=production (the https origin users open)')
  const origin = httpUrl('PUBLIC_ORIGIN', originRaw ?? 'http://127.0.0.1:5173')
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password)
    throw new Error('PUBLIC_ORIGIN must be an origin only (scheme://host[:port])')
  if (production && origin.protocol !== 'https:') throw new Error('PUBLIC_ORIGIN must be https in production')

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
    publicOrigin: origin.origin,
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
  }
}
