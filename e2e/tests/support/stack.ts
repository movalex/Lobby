// Runs the REAL api, the REAL sync server and the REAL preview worker as child processes, so the browser
// suites exercise the same entry points as `pnpm dev`. The api and sync share one temporary
// DRAFTROOM_DATA_DIR (the api keeps its PGlite database and, in fs mode, its blobs under it); the worker
// is an HTTP client of the api (docs/M3-STORAGE-CONTRACTS.md §4-§5) and only gets the api's URL and a
// per-stack worker token. Tests can kill (SIGKILL / TerminateProcess) and restart any of them on demand.
//
// Blob store: fs by default. E2E_BLOB_STORE=r2 (opt-in, never in CI) points the api at a real R2 bucket
// using R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET (and optional R2_ENDPOINT)
// from the test runner's environment; only the api receives them, and only a bucket whose name says
// staging or test is accepted. The run's objects are NOT cleaned up here (the api has no key prefix):
// the caller lists the stack's asset rows (E2E_KEEP_DATA=1 keeps the database) and deletes them.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { API_PORT, API_URL, HOST, SYNC_PORT, SYNC_URL, WEB_URL } from './ports.ts'

export const REPO_ROOT = resolve(import.meta.dirname, '../../..')
export const FIXTURES_DIR = join(REPO_ROOT, 'tests/fixtures/generated')
const API_ENTRY = join(REPO_ROOT, 'apps/api/src/server.ts')
const SYNC_ENTRY = join(REPO_ROOT, 'apps/sync/src/server.ts')
const WORKER_ENTRY = join(REPO_ROOT, 'apps/worker/src/worker.ts')
const ORPHAN_GUARD = pathToFileURL(join(import.meta.dirname, 'orphan-guard.ts')).href

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Never leave a server or worker behind if the Playwright worker process dies mid-test.
const live = new Set<ChildProcess>()
process.once('exit', () => {
  for (const child of live) killNow(child, true)
})

function killNow(child: ChildProcess, tree: boolean) {
  // The worker has its own children (pdf renderer, ffprobe/ffmpeg); on Windows only taskkill /T
  // takes the whole tree down. Both paths are a hard kill: no shutdown code runs in the target.
  if (tree && process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } else {
    child.kill('SIGKILL')
  }
}

export interface ManagedProcess {
  readonly name: string
  start(): Promise<void>
  /** Hard kill (SIGKILL; TerminateProcess on Windows). Resolves once the process has exited. */
  kill(): Promise<void>
  restart(): Promise<void>
  running(): boolean
  pid(): number | undefined
  /** Everything the process printed, across restarts. */
  logs(): string
}

interface ProcessSpec {
  name: string
  entry: string
  env: () => NodeJS.ProcessEnv
  /** Output (since this start) proves the process is ready. */
  ready: (output: string) => boolean
  healthy?: () => Promise<boolean>
  preflight?: () => Promise<void>
  killTree: boolean
}

function managed(spec: ProcessSpec): ManagedProcess {
  let child: ChildProcess | null = null
  let exited: Promise<void> = Promise.resolve()
  let output = ''

  async function startOnce(): Promise<void> {
    await spec.preflight?.()
    output += `\n--- ${spec.name} start ---\n`
    const from = output.length
    const c = spawn(process.execPath, ['--import', ORPHAN_GUARD, spec.entry], {
      cwd: REPO_ROOT,
      env: spec.env(),
      // The IPC channel exists only so the child notices when this process dies (orphan-guard.ts).
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    })
    child = c
    live.add(c)
    c.stdout?.on('data', (d) => {
      output += String(d)
    })
    c.stderr?.on('data', (d) => {
      output += String(d)
    })
    exited = new Promise((resolveExit) => {
      c.once('exit', (code, signal) => {
        live.delete(c)
        if (child === c) child = null
        output += `\n--- ${spec.name} exit code=${code} signal=${signal} ---\n`
        resolveExit()
      })
    })
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (child !== c) throw new StartError(`${spec.name} exited during startup`, output.slice(from))
      if (spec.ready(output.slice(from)) && (!spec.healthy || (await spec.healthy()))) return
      await sleep(50)
    }
    await kill()
    throw new StartError(`${spec.name} did not become ready in 30 s`, output.slice(from))
  }

  async function start(): Promise<void> {
    if (child) throw new Error(`${spec.name} is already running`)
    // A listener that was just killed can hold the port for a moment on Windows.
    for (let attempt = 0; ; attempt++) {
      try {
        return await startOnce()
      } catch (e) {
        if (attempt < 10 && e instanceof StartError && /EADDRINUSE/.test(e.logs)) {
          await sleep(300)
          continue
        }
        throw e
      }
    }
  }

  async function kill(): Promise<void> {
    const c = child
    if (!c) return
    const done = exited
    killNow(c, spec.killTree)
    await done
  }

  return {
    name: spec.name,
    start,
    kill,
    restart: async () => {
      await kill()
      await start()
    },
    running: () => child !== null,
    pid: () => child?.pid,
    logs: () => output,
  }
}

class StartError extends Error {
  readonly logs: string
  constructor(message: string, logs: string) {
    super(`${message}\n${logs}`)
    this.logs = logs
  }
}

/** Resolves true when `path` on HOST:port answers 200. */
function answers200(port: number, path: string): Promise<boolean> {
  return new Promise((resolveHealth) => {
    const req = request({ host: HOST, port, path, timeout: 1000 }, (res) => {
      res.resume()
      resolveHealth(res.statusCode === 200)
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolveHealth(false))
    req.end()
  })
}
const syncHealthy = () => answers200(SYNC_PORT, '/healthz')
// Public, database-free and not rate limited (docs/M1-CONTRACTS.md §5).
const apiHealthy = () => answers200(API_PORT, '/api/auth/config')

/**
 * The children should behave like `pnpm dev`, not inherit the test runner's own Node settings or a
 * developer's shell configuration (a DATABASE_URL, a real Clerk key, another data dir...).
 */
function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (
      // Credentials and worker knobs too: storage keys reach the api only through blobStoreEnv().
      /^(DRAFTROOM_|CLERK_|R2_|CLOUDFLARE_|RENDER_|WORKER_|E2E_BLOB_STORE$)/.test(key) ||
      [
        'NODE_ENV',
        'NODE_OPTIONS',
        'IDLE_EVICT_MS',
        'TEXT_LEASE_MS',
        'ACCESS_RECHECK_MS',
        'PORT',
        'HOST',
        'DATABASE_URL',
        'PUBLIC_ORIGIN',
        'AUTH_PROVIDER',
        'LOG_LEVEL',
      ].includes(key)
    )
      delete env[key]
  }
  return env
}

const R2_KEYS = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'] as const

/** The api's blob-store settings: fs (default), or the opt-in real bucket (E2E_BLOB_STORE=r2). */
export function blobStoreEnv(): Record<string, string> {
  const mode = process.env.E2E_BLOB_STORE?.trim() || 'fs'
  if (mode === 'fs') return { DRAFTROOM_BLOB_STORE: 'fs' }
  if (mode !== 'r2') throw new Error('E2E_BLOB_STORE must be fs or r2')
  const missing = R2_KEYS.filter((k) => !process.env[k]?.trim())
  // Names only: values are credentials.
  if (missing.length) throw new Error(`E2E_BLOB_STORE=r2 needs ${missing.join(', ')} in the environment`)
  const env: Record<string, string> = { DRAFTROOM_BLOB_STORE: 'r2' }
  for (const k of R2_KEYS) env[k] = process.env[k]?.trim() ?? ''
  if (!/staging|test/.test(env.R2_BUCKET ?? '')) {
    throw new Error('E2E_BLOB_STORE=r2 only runs against a bucket whose name contains staging or test')
  }
  const endpoint = process.env.R2_ENDPOINT?.trim()
  if (endpoint) env.R2_ENDPOINT = endpoint
  return env
}

export interface StackOptions {
  /** Extra sync server env, e.g. { TEXT_LEASE_MS: '3000' }. */
  syncEnv?: Record<string, string>
}

export interface Stack {
  readonly dataDir: string
  readonly syncEnv: Readonly<Record<string, string>>
  readonly api: ManagedProcess
  readonly sync: ManagedProcess
  readonly worker: ManagedProcess
  /** Starts whichever process a previous test left stopped. */
  ensureRunning(): Promise<void>
  stop(): Promise<void>
}

export async function startStack(opts: StackOptions = {}): Promise<Stack> {
  const dataDir = mkdtempSync(join(tmpdir(), 'dr-e2e-'))
  const syncEnv = { ...opts.syncEnv }
  // Fresh secrets per stack, shared by exactly these two processes: a ticket minted by any other api
  // (a developer's `pnpm dev`, an earlier run) cannot open a board here.
  const secrets = {
    DRAFTROOM_TICKET_SECRET: randomBytes(32).toString('base64url'),
    DRAFTROOM_INTERNAL_SECRET: randomBytes(32).toString('base64url'),
  }
  // Likewise the preview worker's bearer token, shared by the api and the worker only (never sync).
  const workerToken = randomBytes(32).toString('base64url')
  const blobs = blobStoreEnv()
  // The worker's scratch files (downloaded originals, rendered derivatives) stay inside this stack.
  const workerTmp = join(dataDir, 'worker-tmp')

  const api = managed({
    name: 'api',
    entry: API_ENTRY,
    killTree: false,
    env: () => ({
      ...baseEnv(),
      ...secrets,
      PORT: String(API_PORT),
      HOST,
      DRAFTROOM_DATA_DIR: dataDir, // PGlite lives in <dataDir>/pg
      DRAFTROOM_DEV_AUTH: '1',
      AUTH_PROVIDER: 'dev',
      // The browser's origin, not the api's: Origin checks and invite links use it.
      PUBLIC_ORIGIN: WEB_URL,
      DRAFTROOM_SYNC_INTERNAL_URL: SYNC_URL,
      DRAFTROOM_WORKER_TOKEN: workerToken,
      ...blobs,
    }),
    ready: (out) => out.includes(`api listening on ${HOST}:${API_PORT} `),
    healthy: apiHealthy,
    preflight: async () => {
      if (await apiHealthy()) {
        throw new Error(`port ${API_PORT} already serves an api that this test run did not start`)
      }
    },
  })

  const sync = managed({
    name: 'sync',
    entry: SYNC_ENTRY,
    killTree: false,
    env: () => ({
      ...baseEnv(),
      ...syncEnv,
      ...secrets,
      PORT: String(SYNC_PORT),
      HOST,
      DRAFTROOM_DATA_DIR: dataDir,
      DRAFTROOM_API_INTERNAL_URL: API_URL,
    }),
    // The listening line proves THIS child owns the port; /healthz proves it serves requests.
    ready: (out) => out.includes(`sync listening on ${HOST}:${SYNC_PORT} `),
    healthy: syncHealthy,
    preflight: async () => {
      if (await syncHealthy()) {
        throw new Error(`port ${SYNC_PORT} already serves a sync server that this test run did not start`)
      }
    },
  })

  const worker = managed({
    name: 'worker',
    entry: WORKER_ENTRY,
    killTree: true,
    // HTTP mode, like `pnpm dev`: no data dir, no database, no storage credentials.
    env: () => ({
      ...baseEnv(),
      DRAFTROOM_API_URL: API_URL,
      DRAFTROOM_WORKER_TOKEN: workerToken,
      WORKER_ID: 'e2e-worker',
      WORKER_TMP_DIR: workerTmp,
      // Snappy idle polling (the default backoff grows to 15 s between polls).
      WORKER_POLL_MS: '100',
      WORKER_POLL_MAX_MS: '500',
    }),
    ready: (out) => out.includes(`[worker] started (api: ${API_URL}, `),
    preflight: async () => {
      for (const tool of ['ffprobe', 'ffmpeg']) {
        const r = spawnSync(tool, ['-version'], { stdio: 'ignore', windowsHide: true })
        if (r.status !== 0) throw new Error(`${tool} must be on PATH for the preview worker`)
      }
    },
  })

  const all = [api, sync, worker]
  const started: ManagedProcess[] = []
  try {
    for (const p of all) {
      await p.start()
      started.push(p)
    }
  } catch (e) {
    await Promise.all(started.map((p) => p.kill()))
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    throw e
  }

  return {
    dataDir,
    syncEnv,
    api,
    sync,
    worker,
    ensureRunning: async () => {
      for (const p of all) if (!p.running()) await p.start()
    },
    stop: async () => {
      await Promise.all(all.map((p) => p.kill()))
      if (process.env.E2E_KEEP_DATA !== '1') {
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      }
    },
  }
}
