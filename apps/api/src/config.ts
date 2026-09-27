// API environment (docs/M1-CONTRACTS.md §1). Refuses to produce a config for an unsafe combination:
// development sign-in or development secrets under NODE_ENV=production.

import { join } from 'node:path'
import { checkSecret } from '@draftroom/auth-tickets'
import { resolveDataDir } from '@draftroom/dev-assets'

export type AuthProviderId = 'dev' | 'clerk'

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

  const origin = httpUrl('PUBLIC_ORIGIN', read(env, 'PUBLIC_ORIGIN') ?? 'http://127.0.0.1:5173')
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password)
    throw new Error('PUBLIC_ORIGIN must be an origin only (scheme://host[:port])')
  if (production && origin.protocol !== 'https:') throw new Error('PUBLIC_ORIGIN must be https in production')

  const sync = httpUrl(
    'DRAFTROOM_SYNC_INTERNAL_URL',
    read(env, 'DRAFTROOM_SYNC_INTERNAL_URL') ?? 'http://127.0.0.1:5858',
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
    syncInternalUrl: sync.href.replace(/\/+$/, ''),
  }
}
