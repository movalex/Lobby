// API environment (docs/M1-CONTRACTS.md §1, docs/FEATURES-M2-CONTRACTS.md "platform", docs/DEPLOY.md).
// Refuses to produce a config for an unsafe combination: development sign-in or development secrets
// under NODE_ENV=production, and (production) loopback defaults that would silently break the api <-> sync
// private channel (access pushes; sync's periodic re-checks fail OPEN, so revocation would not apply).

import { isIP } from 'node:net'
import { join } from 'node:path'
import { checkSecret } from '@draftroom/auth-tickets'
import { resolveDataDir } from '@draftroom/dev-assets'

export type AuthProviderId = 'dev' | 'clerk'

/**
 * Fastify's `trustProxy` option, ready to pass through: `false` (default: the socket peer is the client),
 * `true` (trust every X-Forwarded-For entry: only behind a proxy that REPLACES the header), a list of
 * trusted proxy addresses/CIDRs/presets, or a hop count as a function (see `TRUST_PROXY` in .env.example).
 */
export type TrustProxy = boolean | string[] | ((address: string, hop: number) => boolean)

export interface ApiConfig {
  production: boolean
  host: string
  port: number
  /** Absolute DRAFTROOM_DATA_DIR (shared with sync + worker: rooms/, assets/, jobs/, pg/). */
  dataDir: string
  /** node-postgres connection string, or null to use PGlite at `pgliteDir`. */
  databaseUrl: string | null
  pgliteDir: string
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
}

type Env = Record<string, string | undefined>

// Empty values count as unset so `PORT=` in an env file falls back to the default.
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

/** Parses and validates the API environment. Throws an operator-facing message on bad input. */
export function loadConfig(env: Env = process.env): ApiConfig {
  const production = env.NODE_ENV === 'production'

  const devFlag = read(env, 'DRAFTROOM_DEV_AUTH')
  if (devFlag !== undefined && devFlag !== '1' && devFlag !== '0')
    throw new Error('DRAFTROOM_DEV_AUTH must be 1 (local development only) or unset')
  const devAuth = devFlag === '1'
  if (devAuth && production) throw new Error('DRAFTROOM_DEV_AUTH=1 is refused when NODE_ENV=production')

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

  const dataDir = resolveDataDir(env)
  return {
    production,
    host: read(env, 'HOST') ?? '127.0.0.1',
    port: int(env, 'PORT', 5859, 0, 65_535),
    dataDir,
    databaseUrl: read(env, 'DATABASE_URL') ?? null,
    pgliteDir: join(dataDir, 'pg'),
    devAuth,
    authProvider,
    clerk,
    publicOrigin: origin.origin,
    ticketSecret,
    internalSecret,
    syncInternalUrl,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
  }
}
