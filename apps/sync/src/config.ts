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

function httpUrl(env: Env, name: string, fallback: string): string {
  const raw = read(env, name) ?? fallback
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${name} must be an http(s) URL`)
  }
  // A query or fragment would be silently merged into every internal request.
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.search || url.hash || url.username)
    throw new Error(`${name} must be an http(s) URL without credentials, query or fragment`)
  return url.href.replace(/\/+$/, '')
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
    apiInternalUrl: httpUrl(env, 'DRAFTROOM_API_INTERNAL_URL', 'http://127.0.0.1:5859'),
    accessRecheckMs: int(env, 'ACCESS_RECHECK_MS', 10_000, 50, 60 * 60_000),
  }
}
