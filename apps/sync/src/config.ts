import { isIP } from 'node:net'
import { join } from 'node:path'
import { checkSecret } from '@draftroom/auth-tickets'
import { resolveDataDir } from '@draftroom/dev-assets'
import { BACKUP_DEFAULTS } from './backup/backup.ts'

export interface SyncConfig {
  host: string
  port: number
  /** Absolute path of DRAFTROOM_DATA_DIR (rooms/ lives under it). */
  dataDir: string
  idleEvictMs: number
  textLeaseMs: number
  /** Verifies board connection tickets signed by the API (docs/M1-CONTRACTS.md §6). */
  ticketSecret: string
  /** Shared with the API for the x-draftroom-internal header, both directions (§7, §8). */
  internalSecret: string
  /** Base URL of the API's internal endpoints, without a trailing slash. */
  apiInternalUrl: string
  /** How often every (board, user) with live sessions is re-validated against the API. */
  accessRecheckMs: number
  /**
   * ALLOWED_ORIGINS: the browser origins (scheme://host[:port]) whose pages may open a board WebSocket.
   * Checked before the upgrade, as defense in depth: the ticket stays the authentication. `null` or
   * absent = no Origin check, which loadConfig only allows outside production (the Vite proxy in dev).
   */
  allowedOrigins?: readonly string[] | null
  /**
   * TOUCH_INTERVAL_MS: at most one "this board was edited" report per board to the API per this many
   * ms (touch.ts; dashboard "Edited …"). Default 60 000.
   */
  touchIntervalMs?: number
  /**
   * DRAFTROOM_BACKUP_STORE (+ R2_*): where each local board backup is copied offsite
   * (backup/offsite.ts). Absent = off.
   */
  backupStore?: BackupStoreConfig
  /**
   * DRAFTROOM_BACKUP_INTERVAL_MS: how often open boards that changed are backed up, and how often the
   * offsite copy retries what is still missing. Default 15 minutes.
   */
  backupIntervalMs?: number
}

/**
 * Offsite copies of the board backups. `fs` writes under `${DRAFTROOM_DATA_DIR}/blobs` (the same root
 * as the api's fs blob store, so the key layout matches the one R2 bucket); it is for development and
 * tests, since the same disk is not offsite. `r2` is the staging/production setting.
 */
export type BackupStoreConfig =
  | { kind: 'off' }
  | { kind: 'fs'; root: string }
  | {
      kind: 'r2'
      accountId: string
      accessKeyId: string
      secretAccessKey: string
      bucket: string
      endpoint: string | null
    }

type Env = Record<string, string | undefined>

// Empty values count as unset so `PORT=` in an env file falls back to the default instead of failing.
const read = (env: Env, name: string): string | undefined => {
  const v = env[name]?.trim()
  return v ? v : undefined
}

function int(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = read(env, name)
  if (raw === undefined) return fallback
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer`)
  const n = Number(raw)
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}`)
  return n
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
 * only works when every process shares one machine, and a wrong target fails silently (access re-checks
 * fail OPEN by design, so revocation would never reach open boards).
 */
function internalBaseUrl(env: Env, name: string, fallback: string, production: boolean): string {
  const raw = read(env, name)
  if (raw === undefined && production)
    throw new Error(`${name} is required when NODE_ENV=production (an http(s) URL or host:port)`)
  const value = raw ?? fallback
  let url: URL
  try {
    url = new URL(HOSTPORT_RE.test(value) ? `http://${value}` : value)
  } catch {
    throw new Error(`${name} must be an http(s) URL or host:port`)
  }
  // A query or fragment would be silently merged into every internal request.
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error(`${name} must be an http(s) URL or host:port, without credentials, query or fragment`)
  if (production && isLoopbackHost(url.hostname))
    throw new Error(
      `${name} must not be a loopback address (${url.hostname}) when NODE_ENV=production: use the other service's private-network address`,
    )
  return url.href.replace(/\/+$/, '')
}

/**
 * ALLOWED_ORIGINS: comma- (or space-) separated exact origins. Each is normalized the way browsers
 * serialize the Origin header (lowercase host, default port dropped). Required in production, https only.
 */
function allowedOrigins(env: Env, production: boolean): string[] | null {
  const raw = read(env, 'ALLOWED_ORIGINS')
  if (raw === undefined) {
    if (production)
      throw new Error(
        'ALLOWED_ORIGINS is required when NODE_ENV=production (the web origin(s), e.g. https://draftroom.example)',
      )
    return null
  }
  const out: string[] = []
  for (const entry of raw.split(/[\s,]+/).filter(Boolean)) {
    let url: URL | null = null
    try {
      url = new URL(entry)
    } catch {}
    if (
      !url ||
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw new Error(
        `ALLOWED_ORIGINS entries must be origins only (scheme://host[:port]): ${entry.slice(0, 100)}`,
      )
    if (production && url.protocol !== 'https:')
      throw new Error(`ALLOWED_ORIGINS entries must be https when NODE_ENV=production: ${url.origin}`)
    if (!out.includes(url.origin)) out.push(url.origin)
  }
  if (out.length === 0) throw new Error('ALLOWED_ORIGINS must list at least one origin')
  return out
}

/**
 * The upgrade-time Origin check. With no allowlist (development) everything passes. With one, the
 * request's Origin header must equal an allowed origin exactly: a missing header, `null` (sandboxed or
 * file: pages) or any other origin is refused. Browsers always send Origin on WebSocket handshakes;
 * a non-browser client can forge it, which is why tickets, not this check, authenticate.
 */
export function isAllowedOrigin(
  allowed: readonly string[] | null | undefined,
  origin: string | string[] | undefined,
): boolean {
  if (!allowed) return true
  if (typeof origin !== 'string') return false
  return allowed.includes(origin.trim().toLowerCase())
}

const R2_KEYS = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'] as const
const R2_ACCOUNT_RE = /^[0-9a-f]{32}$/
// S3/R2 bucket names: 3-63 lowercase letters, digits and hyphens, starting and ending alphanumeric.
const R2_BUCKET_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/
// Credentials are opaque; this only rejects obvious paste mistakes (spaces, quotes, newlines).
const CREDENTIAL_RE = /^[A-Za-z0-9+/=_-]{16,256}$/

/**
 * DRAFTROOM_BACKUP_STORE=off|fs|r2 (default off, also in production: an unset value must not take the
 * boards down on a deploy; the server logs that offsite backups are off). `r2` needs the same four
 * R2_* values as the api (and accepts its optional R2_ENDPOINT). The rules match apps/api/src/config.ts
 * parseBlobStore. Messages name variables, never their values.
 */
export function parseBackupStore(env: Env, dataDir: string): BackupStoreConfig {
  const kind = read(env, 'DRAFTROOM_BACKUP_STORE') ?? 'off'
  if (kind === 'off') return { kind: 'off' }
  if (kind === 'fs') return { kind: 'fs', root: join(dataDir, 'blobs') }
  if (kind !== 'r2') throw new Error('DRAFTROOM_BACKUP_STORE must be off, fs or r2')
  const missing = R2_KEYS.filter((n) => read(env, n) === undefined)
  if (missing.length) throw new Error(`DRAFTROOM_BACKUP_STORE=r2 requires ${missing.join(', ')}`)
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
    let url: URL | null = null
    try {
      url = new URL(endpointRaw)
    } catch {}
    if (
      url?.protocol !== 'https:' ||
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

/** Parses and validates the sync server environment. Throws with an operator-facing message on bad input. */
export function loadConfig(env: Env = process.env): SyncConfig {
  const production = env.NODE_ENV === 'production'
  // checkSecret messages name the variable, never its value.
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
  // Same rule as the API: a leaked internal secret must not also mint connection tickets.
  if (ticketSecret === internalSecret)
    throw new Error('DRAFTROOM_TICKET_SECRET and DRAFTROOM_INTERNAL_SECRET must differ')
  const dataDir = resolveDataDir(env)
  return {
    host: read(env, 'HOST') ?? '127.0.0.1',
    port: int(env, 'PORT', 5858, 0, 65_535),
    dataDir,
    idleEvictMs: int(env, 'IDLE_EVICT_MS', 30_000, 0, 24 * 60 * 60_000),
    textLeaseMs: int(env, 'TEXT_LEASE_MS', 5_000, 1, 10 * 60_000),
    ticketSecret,
    internalSecret,
    apiInternalUrl: internalBaseUrl(env, 'DRAFTROOM_API_INTERNAL_URL', 'http://127.0.0.1:5859', production),
    accessRecheckMs: int(env, 'ACCESS_RECHECK_MS', 10_000, 50, 60 * 60_000),
    allowedOrigins: allowedOrigins(env, production),
    touchIntervalMs: int(env, 'TOUCH_INTERVAL_MS', 60_000, 0, 60 * 60_000),
    backupStore: parseBackupStore(env, dataDir),
    backupIntervalMs: int(
      env,
      'DRAFTROOM_BACKUP_INTERVAL_MS',
      BACKUP_DEFAULTS.intervalMs,
      1_000,
      24 * 60 * 60_000,
    ),
  }
}
