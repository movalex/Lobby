// B8's sync processes (docs/EXCALIDRAW-MIGRATION.md §8.3 B8 "The R0 stand-in", §8.6.5, §8.6.7). O4.
//
// `startSync` runs the spike branch's REAL sync entry (`apps/sync/src/server.ts`) as a child process:
//  - engine `tldraw` (DRAFTROOM_ENGINE unset): the R0 stand-in (today's tldraw sync plus O4's born-after
//    check, registered by `loadEngine('tldraw')`);
//  - engine `excalidraw`: the Excalidraw build's sync (O1's room; available from M1).
// Every run: DRAFTROOM_BACKUP_STORE=off, every DRAFTROOM_* and R2_* variable of this shell stripped, and a
// refusal to start when an R2_* or DRAFTROOM_BACKUP_R2_* variable is set anyway. Secrets are per run
// (random) except the ticket secret, which is the sync test harness's test-only constant so the Node
// tldraw client (apps/sync/test/harness/sync-client.ts) can mint tickets. Output is kept in memory and,
// with `logFile`, written there (inside SPIKE_B8_DIR for staging runs); it is never printed.

import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TEST_TICKET_SECRET } from '../../../apps/sync/test/harness/tickets.ts'
import { INTERNAL_SECRET_HEADER } from '../../../packages/auth-tickets/src/index.ts'

export const REPO_ROOT = resolve(import.meta.dirname, '../../..')
const SYNC_ENTRY = join(REPO_ROOT, 'apps/sync/src/server.ts')
// the sync harness's preload: SIGINT over IPC on Windows, and exit when this process goes away
const PRELOAD = pathToFileURL(join(REPO_ROOT, 'apps/sync/test/harness/signal-preload.ts')).href

/** Refuses to run when an R2 credential is in the environment (§8.6.7 "No offsite backup, ever"). */
export function assertNoR2(env: NodeJS.ProcessEnv = process.env): void {
  const bad = Object.keys(env).filter((k) => /^R2_/.test(k) || /^DRAFTROOM_BACKUP_R2_/.test(k))
  if (bad.length)
    throw new Error(`refusing to start: ${bad.length} R2 variable(s) are set in this environment`)
}

export interface SyncProcess {
  readonly port: number
  readonly url: string
  readonly wsUrl: string
  readonly dataDir: string
  readonly internalSecret: string
  readonly ticketSecret: string
  logs(): string
  /** SIGKILL (default) or SIGINT (the server's own shutdown: rooms closed, files flushed) */
  stop(signal?: 'SIGKILL' | 'SIGINT'): Promise<void>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function healthy(port: number): Promise<boolean> {
  return new Promise((done) => {
    const req = request({ host: '127.0.0.1', port, path: '/healthz', timeout: 1000 }, (res) => {
      res.resume()
      done(res.statusCode === 200)
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => done(false))
    req.end()
  })
}

export async function startSync(opts: {
  port: number
  /** DRAFTROOM_DATA_DIR (board files in <dataDir>/rooms) */
  dataDir: string
  engine: 'tldraw' | 'excalidraw'
  /** TEMP/TMP of the child (inside SPIKE_B8_DIR for staging runs) */
  tempDir?: string
  logFile?: string
  env?: Record<string, string>
}): Promise<SyncProcess> {
  assertNoR2()
  if (opts.port < 7900 || opts.port > 7909) throw new Error('O4 stacks use ports 7900-7909 only (§8.6.5)')
  if (await healthy(opts.port)) throw new Error(`port ${opts.port} already serves something`)
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env))
    if (
      !/^(DRAFTROOM_|R2_|CLERK_|OPENAI_|RENDER_|CLOUDFLARE_)/.test(k) &&
      !['NODE_ENV', 'NODE_OPTIONS', 'PORT', 'HOST'].includes(k)
    )
      env[k] = v
  const internalSecret = randomBytes(32).toString('base64url')
  Object.assign(env, {
    PORT: String(opts.port),
    HOST: '127.0.0.1',
    DRAFTROOM_DATA_DIR: opts.dataDir,
    DRAFTROOM_TICKET_SECRET: TEST_TICKET_SECRET,
    DRAFTROOM_INTERNAL_SECRET: internalSecret,
    DRAFTROOM_API_INTERNAL_URL: 'http://127.0.0.1:9',
    DRAFTROOM_BACKUP_STORE: 'off',
    ...(opts.engine === 'excalidraw' ? { DRAFTROOM_ENGINE: 'excalidraw', DRAFTROOM_TEST_HOOKS: '1' } : {}),
    ...(opts.tempDir ? { TEMP: opts.tempDir, TMP: opts.tempDir, TMPDIR: opts.tempDir } : {}),
    ...opts.env,
  })
  if (opts.tempDir) mkdirSync(opts.tempDir, { recursive: true })
  let output = ''
  const child: ChildProcess = spawn(process.execPath, ['--import', PRELOAD, SYNC_ENTRY], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  })
  child.stdout?.on('data', (d) => {
    output += String(d)
  })
  child.stderr?.on('data', (d) => {
    output += String(d)
  })
  let exited = false
  const exit = new Promise<void>((r) =>
    child.once('exit', () => {
      exited = true
      r()
    }),
  )
  const flush = () => {
    if (!opts.logFile) return
    mkdirSync(dirname(opts.logFile), { recursive: true })
    writeFileSync(opts.logFile, output)
  }
  const deadline = Date.now() + 30_000
  for (;;) {
    if (exited) {
      flush()
      throw new Error('sync exited during start-up (see its log file)')
    }
    if (output.includes(`sync listening on 127.0.0.1:${opts.port} `) && (await healthy(opts.port))) break
    if (Date.now() > deadline) {
      child.kill('SIGKILL')
      flush()
      throw new Error('sync did not become healthy in 30 s')
    }
    await sleep(50)
  }
  return {
    port: opts.port,
    url: `http://127.0.0.1:${opts.port}`,
    wsUrl: `ws://127.0.0.1:${opts.port}`,
    dataDir: opts.dataDir,
    internalSecret,
    ticketSecret: TEST_TICKET_SECRET,
    logs: () => output,
    stop: async (signal = 'SIGKILL') => {
      if (!exited) {
        if (signal === 'SIGINT' && process.platform === 'win32')
          child.send?.({ type: 'signal', signal: 'SIGINT' })
        else child.kill(signal)
        const t = setTimeout(() => child.kill('SIGKILL'), 15_000)
        await exit
        clearTimeout(t)
      }
      flush()
    },
  }
}

/** A fetch against the process's internal routes (the per-run secret in its header). */
export function callInternal(
  sync: SyncProcess,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${sync.url}${path}`, {
    method,
    headers: {
      [INTERNAL_SECRET_HEADER]: sync.internalSecret,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}
