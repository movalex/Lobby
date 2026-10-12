// Runs the REAL sync server entrypoint (`node apps/sync/src/server.ts`) as a child process, so tests
// exercise the same upgrade handler, registry, storage pragmas and shutdown path as `pnpm dev`.
import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { TEST_INTERNAL_SECRET, TEST_TICKET_SECRET } from './tickets.ts'
import { sleep } from './wait.ts'

export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const SERVER_ENTRY = fileURLToPath(new URL('../../src/server.ts', import.meta.url))
const PRELOAD = pathToFileURL(fileURLToPath(new URL('./signal-preload.ts', import.meta.url))).href

/** A closed local port (discard service): connections are refused. */
export const UNREACHABLE_API = 'http://127.0.0.1:9'

export type StopSignal = 'SIGKILL' | 'SIGINT' | 'SIGTERM'

export interface ExitInfo {
  code: number | null
  signal: NodeJS.Signals | null
}

export interface SyncServerOptions {
  dataDir: string
  /** Extra env for the child, e.g. { IDLE_EVICT_MS: '200', TEXT_LEASE_MS: '1500' }. `undefined` removes a key. */
  env?: Record<string, string | undefined>
  startTimeoutMs?: number
  /**
   * Another build's sync entrypoint (its `apps/sync/src/server.ts`, with its own node_modules), run from its repo
   * root (the folder three levels above it): the rollback pairs run a previous deployed sync (wave N: 104c6e0, from
   * `git archive`) on a board file this build wrote. Default: this tree's.
   */
  entry?: string
}

export interface SyncServer {
  readonly port: number
  /** http://127.0.0.1:<port> */
  readonly url: string
  /** ws://127.0.0.1:<port> */
  readonly wsUrl: string
  readonly dataDir: string
  pid(): number | undefined
  /** null while the current child is running */
  exitInfo(): ExitInfo | null
  /**
   * SIGKILL = TerminateProcess/kill -9 (no shutdown code runs). SIGINT/SIGTERM run the server's own
   * signal handlers (re-emitted over IPC on Windows, where Node cannot deliver them).
   */
  kill(signal?: StopSignal): Promise<ExitInfo>
  /** Start again on the same port and data dir (kills the current child first if it still runs). */
  restart(): Promise<void>
  /** stdout+stderr of every start of this server, in order. */
  logs(): string
}

const live = new Set<ChildProcess>()
process.once('exit', () => {
  for (const child of live) child.kill('SIGKILL')
})

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      srv.close(() => (addr && typeof addr === 'object' ? resolve(addr.port) : reject(new Error('no port'))))
    })
  })
}

function childEnv(port: number, opts: SyncServerOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  // The child should behave like `pnpm dev`, not like a vitest worker (NODE_ENV=test changes tldraw
  // scheduling) and must not inherit this shell's own server config.
  for (const key of Object.keys(env)) {
    if (key === 'NODE_ENV' || key === 'NODE_OPTIONS' || key.startsWith('VITEST')) delete env[key]
  }
  for (const key of [
    'IDLE_EVICT_MS',
    'TEXT_LEASE_MS',
    'DRAFTROOM_SYNC_ORIGIN',
    'ACCESS_RECHECK_MS',
    'DRAFTROOM_API_INTERNAL_URL',
    'DRAFTROOM_TICKET_SECRET',
    'DRAFTROOM_INTERNAL_SECRET',
    'DRAFTROOM_BACKUP_SIGNING_SECRET',
    'DRAFTROOM_DEV_AUTH',
  ])
    delete env[key]
  Object.assign(env, {
    PORT: String(port),
    HOST: '127.0.0.1',
    DRAFTROOM_DATA_DIR: opts.dataDir,
    DRAFTROOM_TICKET_SECRET: TEST_TICKET_SECRET,
    DRAFTROOM_INTERNAL_SECRET: TEST_INTERNAL_SECRET,
    // Nothing listens here: access re-checks fail open (sessions stay), which is what suites that
    // are not about access want. Access suites point this at a fake API.
    DRAFTROOM_API_INTERNAL_URL: UNREACHABLE_API,
  })
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return env
}

async function healthy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: '/healthz', timeout: 1000 }, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(false))
    req.end()
  })
}

export async function spawnSyncServer(opts: SyncServerOptions): Promise<SyncServer> {
  let output = ''
  let child: ChildProcess | null = null
  let exit: ExitInfo | null = null
  let exited: Promise<ExitInfo> = Promise.resolve({ code: null, signal: null })

  const start = async (port: number): Promise<void> => {
    output += `\n--- start port=${port} ---\n`
    const startedAt = output.length
    exit = null
    const entry = opts.entry ?? SERVER_ENTRY
    const c = spawn(process.execPath, ['--import', PRELOAD, entry], {
      cwd: opts.entry ? fileURLToPath(new URL('../../../', pathToFileURL(opts.entry))) : REPO_ROOT,
      env: childEnv(port, opts),
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
    exited = new Promise((resolve) => {
      c.once('exit', (code, signal) => {
        live.delete(c)
        exit = { code, signal }
        output += `\n--- exit code=${code} signal=${signal} ---\n`
        resolve(exit)
      })
    })
    c.on('error', (e) => {
      output += `\n--- spawn error ${e.message} ---\n`
    })
    // The listening line proves THIS child owns the port (a /healthz answer alone could come from
    // another test's server that grabbed the port first); /healthz then proves it serves requests.
    const listening = `sync listening on 127.0.0.1:${port} `
    const deadline = Date.now() + (opts.startTimeoutMs ?? 20_000)
    while (Date.now() < deadline) {
      if (exit) throw new StartError(`sync server exited during startup (${JSON.stringify(exit)})`, output)
      if (output.includes(listening, startedAt) && (await healthy(port))) return
      await sleep(50)
    }
    c.kill('SIGKILL')
    throw new StartError('sync server did not become healthy in time', output)
  }

  // freePort() can race with other test files; retry with a new port if bind fails.
  let port = 0
  for (let attempt = 0; ; attempt++) {
    port = await freePort()
    try {
      await start(port)
      break
    } catch (e) {
      if (attempt < 3 && e instanceof StartError && /EADDRINUSE/.test(e.logs)) continue
      throw e
    }
  }

  const kill = async (signal: StopSignal = 'SIGKILL'): Promise<ExitInfo> => {
    const c = child
    if (!c || exit) return exit ?? { code: null, signal: null }
    if (signal === 'SIGKILL') c.kill('SIGKILL')
    else if (process.platform === 'win32')
      c.send({ type: 'signal', signal }, () => {}) // errors: it is exiting anyway
    else c.kill(signal)
    const result = await Promise.race([exited, sleep(15_000).then(() => null)])
    if (result) return result
    c.kill('SIGKILL')
    throw new Error(`sync server ignored ${signal} for 15 s (killed)\n${output}`)
  }

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    dataDir: opts.dataDir,
    pid: () => child?.pid,
    exitInfo: () => exit,
    kill,
    restart: async () => {
      await kill('SIGKILL')
      // The port was ours a moment ago; on Windows a just-closed listener can take a beat to free.
      for (let attempt = 0; ; attempt++) {
        try {
          return await start(port)
        } catch (e) {
          if (attempt < 10 && e instanceof StartError && /EADDRINUSE/.test(e.logs)) {
            await sleep(200)
            continue
          }
          throw e
        }
      }
    },
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

/** Sends a raw WebSocket upgrade request and reports the HTTP status (101 = upgraded). */
export async function upgradeStatus(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
      },
    })
    req.on('upgrade', (_res, socket) => {
      socket.destroy()
      resolve(101)
    })
    req.on('response', (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
}
