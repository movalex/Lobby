// Runs the REAL sync server and the REAL preview worker as child processes against one temporary
// DRAFTROOM_DATA_DIR, so the browser suites exercise the same entry points as `pnpm dev`. Tests can
// kill (SIGKILL / TerminateProcess) and restart either process on demand.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const REPO_ROOT = resolve(import.meta.dirname, '../../..')
export const FIXTURES_DIR = join(REPO_ROOT, 'tests/fixtures/generated')
const SYNC_ENTRY = join(REPO_ROOT, 'apps/sync/src/server.ts')
const WORKER_ENTRY = join(REPO_ROOT, 'apps/worker/src/worker.ts')

/** Fixed: the web preview server (playwright.config.ts) proxies /connect, /files and /dev-api here. */
export const SYNC_PORT = Number(process.env.E2E_SYNC_PORT ?? '5881')
const SYNC_HOST = '127.0.0.1'

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
    const c = spawn(process.execPath, [spec.entry], {
      cwd: REPO_ROOT,
      env: spec.env(),
      stdio: ['ignore', 'pipe', 'pipe'],
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

async function syncHealthy(): Promise<boolean> {
  return new Promise((resolveHealth) => {
    const req = request({ host: SYNC_HOST, port: SYNC_PORT, path: '/healthz', timeout: 1000 }, (res) => {
      res.resume()
      resolveHealth(res.statusCode === 200)
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolveHealth(false))
    req.end()
  })
}

/** The child should behave like `pnpm dev`, not inherit the test runner's own Node settings. */
function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of ['NODE_ENV', 'NODE_OPTIONS', 'IDLE_EVICT_MS', 'TEXT_LEASE_MS', 'PORT', 'HOST'])
    delete env[key]
  return env
}

export interface StackOptions {
  /** Extra sync server env, e.g. { TEXT_LEASE_MS: '3000' }. */
  syncEnv?: Record<string, string>
}

export interface Stack {
  readonly dataDir: string
  readonly syncEnv: Readonly<Record<string, string>>
  readonly sync: ManagedProcess
  readonly worker: ManagedProcess
  /** Starts whichever process a previous test left stopped. */
  ensureRunning(): Promise<void>
  stop(): Promise<void>
}

export async function startStack(opts: StackOptions = {}): Promise<Stack> {
  const dataDir = mkdtempSync(join(tmpdir(), 'dr-e2e-'))
  const syncEnv = { ...opts.syncEnv }

  const sync = managed({
    name: 'sync',
    entry: SYNC_ENTRY,
    killTree: false,
    env: () => ({
      ...baseEnv(),
      ...syncEnv,
      PORT: String(SYNC_PORT),
      HOST: SYNC_HOST,
      DRAFTROOM_DATA_DIR: dataDir,
      DRAFTROOM_DEV_AUTH: '1',
    }),
    // The listening line proves THIS child owns the port; /healthz proves it serves requests.
    ready: (out) => out.includes(`sync listening on ${SYNC_HOST}:${SYNC_PORT} `),
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
    env: () => ({ ...baseEnv(), DRAFTROOM_DATA_DIR: dataDir, WORKER_POLL_MS: '100' }),
    ready: (out) => out.includes('[worker] started (data: '),
    preflight: async () => {
      for (const tool of ['ffprobe', 'ffmpeg']) {
        const r = spawnSync(tool, ['-version'], { stdio: 'ignore', windowsHide: true })
        if (r.status !== 0) throw new Error(`${tool} must be on PATH for the preview worker`)
      }
    },
  })

  await sync.start()
  try {
    await worker.start()
  } catch (e) {
    await sync.kill()
    throw e
  }

  return {
    dataDir,
    syncEnv,
    sync,
    worker,
    ensureRunning: async () => {
      if (!sync.running()) await sync.start()
      if (!worker.running()) await worker.start()
    },
    stop: async () => {
      await Promise.all([sync.kill(), worker.kill()])
      if (process.env.E2E_KEEP_DATA !== '1') {
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      }
    },
  }
}
