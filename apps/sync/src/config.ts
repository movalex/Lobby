import { isIP } from 'node:net'
import { checkSecret } from '@draftroom/auth-tickets'
import { resolveDataDir } from '@draftroom/dev-assets'

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
  return {
    host: read(env, 'HOST') ?? '127.0.0.1',
    port: int(env, 'PORT', 5858, 0, 65_535),
    dataDir: resolveDataDir(env),
    idleEvictMs: int(env, 'IDLE_EVICT_MS', 30_000, 0, 24 * 60 * 60_000),
    textLeaseMs: int(env, 'TEXT_LEASE_MS', 5_000, 1, 10 * 60_000),
    ticketSecret,
    internalSecret,
    apiInternalUrl: internalBaseUrl(env, 'DRAFTROOM_API_INTERNAL_URL', 'http://127.0.0.1:5859', production),
    accessRecheckMs: int(env, 'ACCESS_RECHECK_MS', 10_000, 50, 60 * 60_000),
    allowedOrigins: allowedOrigins(env, production),
  }
}
