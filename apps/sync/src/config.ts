import { resolveDataDir } from '@draftroom/dev-assets'

export interface SyncConfig {
  /** Always true: there is no real auth before milestone 1, so the server refuses to start without the dev guard. */
  devAuth: true
  host: string
  port: number
  /** Absolute path of DRAFTROOM_DATA_DIR (rooms/, assets/, jobs/ live under it). */
  dataDir: string
  idleEvictMs: number
  textLeaseMs: number
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

/** Parses and validates the sync server environment. Throws with an operator-facing message on bad input. */
export function loadConfig(env: Env = process.env): SyncConfig {
  // Development identities (?devUser=) and the /dev-api + /files routes exist ONLY behind this flag.
  if (env.DRAFTROOM_DEV_AUTH !== '1') {
    throw new Error('No real auth yet: set DRAFTROOM_DEV_AUTH=1 for local development only')
  }
  return {
    devAuth: true,
    host: read(env, 'HOST') ?? '127.0.0.1',
    port: int(env, 'PORT', 5858, 0, 65_535),
    dataDir: resolveDataDir(env),
    idleEvictMs: int(env, 'IDLE_EVICT_MS', 30_000, 0, 24 * 60 * 60_000),
    textLeaseMs: int(env, 'TEXT_LEASE_MS', 5_000, 1, 10 * 60_000),
  }
}
