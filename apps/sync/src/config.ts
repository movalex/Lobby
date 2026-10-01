import { isIP } from 'node:net'
import { join } from 'node:path'
import { checkSecret } from '@draftroom/auth-tickets'
import { resolveDataDir } from '@draftroom/dev-assets'
import { BACKUP_DEFAULTS } from './backup/backup.ts'
import { parseEngine, type SyncEngine } from './engine-switch.ts'

export interface SyncConfig {
  /** NODE_ENV as checked by `parseNodeEnv` (M2): production, development or test, nothing else boots. */
  nodeEnv: NodeEnv
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
   * DRAFTROOM_BACKUP_STORE (+ DRAFTROOM_BACKUP_R2_*, falling back to R2_*): where each local board
   * backup is copied offsite (backup/offsite.ts), signed with a key derived from `internalSecret`
   * (backup/signing.ts). Absent = off.
   */
  backupStore?: BackupStoreConfig
  /**
   * DRAFTROOM_BACKUP_INTERVAL_MS: how often open boards that changed are backed up, and how often the
   * offsite copy retries what is still missing. Default 15 minutes.
   */
  backupIntervalMs?: number
  /**
   * DRAFTROOM_ENGINE (spike B, engine-switch.ts): `tldraw` (default: TLSocketRoom) or `excalidraw` (the
   * ElementRoom). Absent in configs built by hand = tldraw.
   */
  engine?: SyncEngine
  /**
   * DRAFTROOM_TEST_HOOKS=1 (spike B, test-hooks.ts): serve the test-only routes behind the internal secret.
   * Refused at start-up with NODE_ENV=production. Absent = off.
   */
  testHooks?: boolean
  /**
   * DRAFTROOM_BOOT_MAINTENANCE=1 (docs/EXCALIDRAW-MIGRATION.md open item 11, §7.5 steps 6 and rollback 2):
   * the server starts with maintenance ON, so a build deployed into the cut-over's (or a rollback's)
   * maintenance window refuses every socket from its first second. `POST /internal/maintenance {on}`
   * switches it as before (off ends the window). R0's switch alone is a runtime POST: a redeploy started
   * with it off. Absent or 0 = off.
   */
  bootMaintenance?: boolean
}

/**
 * Offsite copies of the board backups. `fs` writes under `${DRAFTROOM_DATA_DIR}/blobs` (the same root
 * as the api's fs blob store, so the key layout matches the one R2 bucket); it is for development and
 * tests, since the same disk is not offsite. `r2` is the staging/production setting: the backup bucket
 * and token (DRAFTROOM_BACKUP_R2_*) when they are set, else the api's shared R2_* values.
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
      /**
       * Whether the bucket and the token are the backup's own (DRAFTROOM_BACKUP_R2_*, and not the same
       * values as R2_*), or shared with the api. For the startup log only.
       */
      dedicated: { bucket: boolean; credentials: boolean }
    }

type Env = Record<string, string | undefined>

// Empty values count as unset so `PORT=` in an env file falls back to the default instead of failing.
const read = (env: Env, name: string): string | undefined => {
  const v = env[name]?.trim()
  return v ? v : undefined
}

export type NodeEnv = 'production' | 'development' | 'test'
/**
 * NODE_ENV, checked (security audit M2). Every guard of the unsafe features (the `dev-only-` placeholder
 * secrets, test hooks, an optional Origin check, loopback internal URLs) keys on the exact string
 * `production`, so any other value (`staging` typed into the Render dashboard) turned them all off together,
 * silently. Only Node's three conventions are accepted; unset or empty reads as development.
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
type R2Key = (typeof R2_KEYS)[number] | 'R2_ENDPOINT'
/** The backup-only counterpart of a shared R2_* variable (SEAM-09). */
const backupKey = (k: R2Key) => `DRAFTROOM_BACKUP_${k}` as const
const R2_ACCOUNT_RE = /^[0-9a-f]{32}$/
// S3/R2 bucket names: 3-63 lowercase letters, digits and hyphens, starting and ending alphanumeric.
const R2_BUCKET_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/
// Credentials are opaque; this only rejects obvious paste mistakes (spaces, quotes, newlines).
const CREDENTIAL_RE = /^[A-Za-z0-9+/=_-]{16,256}$/

/**
 * DRAFTROOM_BACKUP_STORE=off|fs|r2 (default off, also in production: an unset value must not take the
 * boards down on a deploy; the server logs that offsite backups are off). The rules match
 * apps/api/src/config.ts parseBlobStore. Messages name variables, never their values.
 *
 * `r2` takes each value from its backup-only variable when it is set, else from the api's shared one,
 * so a least-privilege bucket and token can be plugged in without a code change (docs/DEPLOY.md
 * "Backups"):
 *   DRAFTROOM_BACKUP_R2_BUCKET         else R2_BUCKET
 *   DRAFTROOM_BACKUP_R2_ACCESS_KEY_ID  else R2_ACCESS_KEY_ID      (the two credentials come as a pair,
 *   DRAFTROOM_BACKUP_R2_SECRET_ACCESS_KEY else R2_SECRET_ACCESS_KEY  never one of each)
 *   DRAFTROOM_BACKUP_R2_ACCOUNT_ID     else R2_ACCOUNT_ID         (a bucket in another account)
 *   DRAFTROOM_BACKUP_R2_ENDPOINT       else R2_ENDPOINT, but only for the same account
 * With all backup-only values set, sync needs none of the api's R2_* values.
 */
export function parseBackupStore(env: Env, dataDir: string): BackupStoreConfig {
  const kind = read(env, 'DRAFTROOM_BACKUP_STORE') ?? 'off'
  if (kind === 'off') return { kind: 'off' }
  if (kind === 'fs') return { kind: 'fs', root: join(dataDir, 'blobs') }
  if (kind !== 'r2') throw new Error('DRAFTROOM_BACKUP_STORE must be off, fs or r2')
  const ownKeyId = read(env, backupKey('R2_ACCESS_KEY_ID')) !== undefined
  if (ownKeyId !== (read(env, backupKey('R2_SECRET_ACCESS_KEY')) !== undefined))
    throw new Error(
      `${backupKey('R2_ACCESS_KEY_ID')} and ${backupKey('R2_SECRET_ACCESS_KEY')} must be set together`,
    )
  const missing = R2_KEYS.filter((n) => read(env, n) === undefined && read(env, backupKey(n)) === undefined)
  if (missing.length)
    throw new Error(
      `DRAFTROOM_BACKUP_STORE=r2 requires ${missing.map((n) => `${n} (or ${backupKey(n)})`).join(', ')}`,
    )
  // Which variable each value is read from (and named by in every message).
  const from = (k: R2Key, own = read(env, backupKey(k)) !== undefined) => (own ? backupKey(k) : k)
  const names = {
    accountId: from('R2_ACCOUNT_ID'),
    accessKeyId: from('R2_ACCESS_KEY_ID', ownKeyId),
    secretAccessKey: from('R2_SECRET_ACCESS_KEY', ownKeyId),
    bucket: from('R2_BUCKET'),
  }
  const accountId = read(env, names.accountId) ?? ''
  const accessKeyId = read(env, names.accessKeyId) ?? ''
  const secretAccessKey = read(env, names.secretAccessKey) ?? ''
  const bucket = read(env, names.bucket) ?? ''
  if (!R2_ACCOUNT_RE.test(accountId))
    throw new Error(`${names.accountId} must be the 32-character hex account id`)
  if (!CREDENTIAL_RE.test(accessKeyId)) throw new Error(`${names.accessKeyId} is malformed`)
  if (!CREDENTIAL_RE.test(secretAccessKey)) throw new Error(`${names.secretAccessKey} is malformed`)
  if (accessKeyId === secretAccessKey)
    throw new Error(`${names.accessKeyId} and ${names.secretAccessKey} must differ`)
  if (!R2_BUCKET_RE.test(bucket) || bucket.includes('--'))
    throw new Error(
      `${names.bucket} must be a valid bucket name (3-63 lowercase letters, digits and hyphens)`,
    )
  // R2_ENDPOINT names the shared account's endpoint (a jurisdiction): not for a bucket in another one.
  const otherAccount = accountId !== read(env, 'R2_ACCOUNT_ID')
  const endpointName =
    read(env, backupKey('R2_ENDPOINT')) !== undefined
      ? backupKey('R2_ENDPOINT')
      : otherAccount
        ? null
        : 'R2_ENDPOINT'
  let endpoint: string | null = null
  const endpointRaw = endpointName ? read(env, endpointName) : undefined
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
        `${endpointName} must be an https origin (scheme://host[:port]) without credentials or path`,
      )
    endpoint = url.origin
  }
  return {
    kind: 'r2',
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket,
    endpoint,
    dedicated: {
      bucket: names.bucket !== 'R2_BUCKET' && (otherAccount || bucket !== read(env, 'R2_BUCKET')),
      credentials: ownKeyId && accessKeyId !== read(env, 'R2_ACCESS_KEY_ID'),
    },
  }
}

/**
 * The secret offsite backups are signed with (backup/signing.ts), for the restore tools: the sync
 * server's own DRAFTROOM_INTERNAL_SECRET (a Render Shell of the sync service has it; `pnpm` scripts
 * read apps/sync/dev.env). Same rules as loadConfig; messages name the variable, never its value.
 */
export function backupSigningSecret(env: Env): string {
  const value = read(env, 'DRAFTROOM_INTERNAL_SECRET')
  if (value === undefined)
    throw new Error(
      'DRAFTROOM_INTERNAL_SECRET is required to verify offsite backups (the sync server signs them with it)',
    )
  return checkSecret('DRAFTROOM_INTERNAL_SECRET', value, parseNodeEnv(env) === 'production')
}

/** DRAFTROOM_TEST_HOOKS: `1` on, unset/`0` off; never with NODE_ENV=production (like DRAFTROOM_DEV_AUTH in the api). */
export function parseTestHooks(env: Env): boolean {
  const raw = read(env, 'DRAFTROOM_TEST_HOOKS')
  if (raw === undefined || raw === '0') return false
  if (raw !== '1') throw new Error('DRAFTROOM_TEST_HOOKS must be 1 or 0')
  if (parseNodeEnv(env) === 'production')
    throw new Error('DRAFTROOM_TEST_HOOKS is refused when NODE_ENV=production')
  return true
}

/** Parses and validates the sync server environment. Throws with an operator-facing message on bad input. */
export function loadConfig(env: Env = process.env): SyncConfig {
  const nodeEnv = parseNodeEnv(env)
  const production = nodeEnv === 'production'
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
    nodeEnv,
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
    engine: parseEngine(read(env, 'DRAFTROOM_ENGINE')),
    testHooks: parseTestHooks(env),
    bootMaintenance: parseBootMaintenance(env),
  }
}

/** DRAFTROOM_BOOT_MAINTENANCE: 1 = start in maintenance, 0 or absent = start serving. */
export function parseBootMaintenance(env: Env): boolean {
  const raw = read(env, 'DRAFTROOM_BOOT_MAINTENANCE')
  if (raw === undefined || raw === '0') return false
  if (raw !== '1') throw new Error('DRAFTROOM_BOOT_MAINTENANCE must be 1 or 0')
  return true
}
