// Worker environment (docs/M3-STORAGE-CONTRACTS.md §5). The worker's only secret is
// DRAFTROOM_WORKER_TOKEN: it holds no database or object-storage credentials and needs no data dir.
// Refuses unsafe combinations with an operator-facing message that names the variable, never its value.
import { isIP } from 'node:net'
import { hostname, tmpdir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { LIMITS } from '@draftroom/dev-assets'
import { PREVIEW, WORKER } from './config.ts'

type Env = Record<string, string | undefined>

export interface WorkerEnv {
  production: boolean
  /** API origin without a trailing slash, e.g. `https://draftroom-api.onrender.com`. Safe to log. */
  apiUrl: string
  token: string
  workerId: string
  concurrency: number
  pollMs: number
  pollMaxMs: number
  pdfHeapMb: number
  shutdownGraceMs: number
  tmpDir: string
  ffmpegPath: string | undefined
  ffprobePath: string | undefined
  office: OfficeEnv
  /** Names (never values) of credentials present in the environment that the worker never uses. */
  unusedSecrets: string[]
}

/**
 * Office previews (office.ts). `socket`: the LibreOffice sidecar at OFFICE_SOCKET, with documents staged
 * in OFFICE_JOBS_DIR (production). `local`: soffice as the worker's own child (development only).
 * `off`: Office documents fail with OFFICE_UNAVAILABLE and stay downloadable.
 */
export type OfficeEnv =
  | { mode: 'off'; timeoutMs: number }
  | { mode: 'local'; sofficePath: string | undefined; timeoutMs: number }
  | { mode: 'socket'; socketPath: string; jobsDir: string; timeoutMs: number }

export const MIN_TOKEN_LENGTH = 32
const DEV_PREFIX = 'dev-only-'
const WORKER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
// Render Blueprints can only inject a service address as host:port (fromService property: hostport).
const HOSTPORT_RE = /^(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?):\d{1,5}$/i
const FOREIGN_SECRETS = [
  'DATABASE_URL',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'CLOUDFLARE_ACCOUNT_ID',
  'DRAFTROOM_TICKET_SECRET',
  'DRAFTROOM_INTERNAL_SECRET',
  'CLERK_SECRET_KEY',
  'RENDER_API_KEY',
]

const read = (env: Env, name: string) => {
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

/** Loopback, RFC 1918 / link-local / ULA literals, and single-label names (a Docker or Render private network). */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal')) return true
  const v = isIP(h)
  if (v === 4) {
    const [a = 0, b = 0] = h.split('.').map(Number)
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    )
  }
  if (v === 6) return h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h)
  return !h.includes('.')
}

export function parseApiUrl(raw: string | undefined, production: boolean): string {
  if (raw === undefined)
    throw new Error('DRAFTROOM_API_URL is required (the api origin, e.g. https://api.example.com)')
  let url: URL
  try {
    url = new URL(HOSTPORT_RE.test(raw) ? `http://${raw}` : raw)
  } catch {
    throw new Error('DRAFTROOM_API_URL must be an absolute http(s) URL or host:port')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('DRAFTROOM_API_URL must be http(s)')
  if (url.username || url.password) throw new Error('DRAFTROOM_API_URL must not contain credentials')
  if (url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('DRAFTROOM_API_URL must be an origin only (no path, query or fragment)')
  }
  // The bearer token rides on every request: plain http is only acceptable on a private network.
  if (production && url.protocol === 'http:' && !isPrivateHost(url.hostname)) {
    throw new Error(
      'DRAFTROOM_API_URL must use https when NODE_ENV=production (http only on a private network)',
    )
  }
  return url.origin
}

export function defaultWorkerId(host = hostname()): string {
  const id = host
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 64)
  return id || 'worker'
}

const NAMED_PIPE_RE = /^\\\\[.?]\\pipe\\/i

export function loadOfficeEnv(env: Env, production: boolean): OfficeEnv {
  const timeoutMs = int(env, 'WORKER_OFFICE_TIMEOUT_MS', LIMITS.officeConvertTimeoutMs, 1_000, 600_000)
  const socketPath = read(env, 'OFFICE_SOCKET')
  const raw = read(env, 'WORKER_OFFICE')
  const mode = raw ?? (socketPath ? 'socket' : production ? 'off' : 'local')
  switch (mode) {
    case 'off':
      return { mode, timeoutMs }
    case 'local':
      if (production) {
        throw new Error(
          'WORKER_OFFICE=local is for development: in production Office documents are converted by the office sidecar (OFFICE_SOCKET)',
        )
      }
      return { mode, sofficePath: read(env, 'SOFFICE_PATH'), timeoutMs }
    case 'socket': {
      if (!socketPath || !(isAbsolute(socketPath) || NAMED_PIPE_RE.test(socketPath))) {
        throw new Error('OFFICE_SOCKET must be an absolute path when WORKER_OFFICE=socket')
      }
      const jobsDir = read(env, 'OFFICE_JOBS_DIR')
      if (!jobsDir || !isAbsolute(jobsDir)) {
        throw new Error(
          'OFFICE_JOBS_DIR must be an absolute path (the volume shared with the office sidecar)',
        )
      }
      return { mode, socketPath, jobsDir: resolve(jobsDir), timeoutMs }
    }
    default:
      throw new Error('WORKER_OFFICE must be off, local or socket')
  }
}

export function loadWorkerEnv(env: Env = process.env): WorkerEnv {
  const production = env.NODE_ENV === 'production'
  const apiUrl = parseApiUrl(read(env, 'DRAFTROOM_API_URL'), production)

  const token = env.DRAFTROOM_WORKER_TOKEN ?? ''
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`DRAFTROOM_WORKER_TOKEN is required and must be at least ${MIN_TOKEN_LENGTH} characters`)
  }
  if (/\s/.test(token)) throw new Error('DRAFTROOM_WORKER_TOKEN must not contain whitespace')
  if (production && token.startsWith(DEV_PREFIX)) {
    throw new Error('DRAFTROOM_WORKER_TOKEN is a development placeholder (refused when NODE_ENV=production)')
  }

  const workerId = read(env, 'WORKER_ID') ?? defaultWorkerId()
  if (!WORKER_ID_RE.test(workerId)) {
    throw new Error('WORKER_ID must be 1-64 characters: letters, digits, dot, underscore, hyphen')
  }

  const pollMs = int(env, 'WORKER_POLL_MS', WORKER.pollMs, 10, 600_000) // 0 would spin the CPU
  const tmpRaw = read(env, 'WORKER_TMP_DIR')
  if (tmpRaw !== undefined && !isAbsolute(tmpRaw)) throw new Error('WORKER_TMP_DIR must be an absolute path')

  return {
    production,
    apiUrl,
    token,
    workerId,
    concurrency: int(env, 'WORKER_CONCURRENCY', WORKER.concurrency, 1, 16),
    pollMs,
    pollMaxMs: int(env, 'WORKER_POLL_MAX_MS', Math.max(pollMs, WORKER.pollMaxMs), pollMs, 600_000),
    pdfHeapMb: int(env, 'WORKER_PDF_HEAP_MB', PREVIEW.pdfChildHeapMb, 64, 16_384),
    shutdownGraceMs: int(env, 'WORKER_SHUTDOWN_GRACE_MS', WORKER.shutdownGraceMs, 0, 600_000),
    tmpDir: tmpRaw ? resolve(tmpRaw) : tmpdir(),
    ffmpegPath: read(env, 'FFMPEG_PATH'),
    ffprobePath: read(env, 'FFPROBE_PATH'),
    office: loadOfficeEnv(env, production),
    unusedSecrets: FOREIGN_SECRETS.filter((n) => read(env, n) !== undefined),
  }
}
