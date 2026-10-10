import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AccessClient } from '../../src/access.ts'
import { createSyncServer, type SyncServer } from '../../src/app.ts'
import type { SyncConfig } from '../../src/config.ts'
import { loadEngine } from '../../src/engine-switch.ts'
import type { TouchClient } from '../../src/touch.ts'
import { UNREACHABLE_API } from '../harness/server-process.ts'
import { TEST_INTERNAL_SECRET, TEST_TICKET_SECRET } from '../harness/tickets.ts'

export interface TestServer {
  port: number
  url: string
  wsUrl: string
  server: SyncServer
  dataDir: string
  roomsDir: string
  logs: string[]
  stop(): Promise<void>
}

export function testConfig(dataDir: string, over: Partial<SyncConfig> = {}): SyncConfig {
  return {
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 0,
    dataDir,
    idleEvictMs: 50,
    textLeaseMs: 5_000,
    ticketSecret: TEST_TICKET_SECRET,
    internalSecret: TEST_INTERNAL_SECRET,
    apiInternalUrl: UNREACHABLE_API,
    accessRecheckMs: 60_000, // tests that exercise the periodic round lower it
    // M7-4/M7-6: a disk with room to spare whatever the test machine's (GET /healthz/deep reads it)
    testDiskFree: 0.9,
    ...over,
  }
}

export async function startServer(
  opts: { config?: Partial<SyncConfig>; accessClient?: AccessClient; touchClient?: TouchClient } = {},
): Promise<TestServer> {
  const dataDir = mkdtempSync(join(tmpdir(), 'dr-sync-http-'))
  const logs: string[] = []
  await loadEngine() // the ElementRoom registers itself (idempotent)
  const server = createSyncServer(testConfig(dataDir, opts.config), {
    log: (...a) => logs.push(a.map(String).join(' ')),
    accessClient: opts.accessClient,
    touchClient: opts.touchClient,
  })
  const { port } = await server.listen()
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    server,
    dataDir,
    roomsDir: join(dataDir, 'rooms'),
    logs,
    async stop() {
      await server.close()
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    },
  }
}

// biome-ignore lint/suspicious/noExplicitAny: test-only view of arbitrary JSON response bodies
type JsonBody = any

export interface Res {
  status: number
  headers: IncomingHttpHeaders
  body: Buffer
  /** Parsed JSON body; untyped by default because tests assert on arbitrary shapes. */
  json<T = JsonBody>(): T
}

const toRes = (status: number, headers: IncomingHttpHeaders, body: Buffer): Res => ({
  status,
  headers,
  body,
  json: () => JSON.parse(body.toString('utf8')),
})

/**
 * node:http client request (fetch cannot omit Content-Length, send raw header bytes, or stop
 * mid-body). `body: 'none'` sends the headers only and returns as soon as a response arrives.
 */
export function req(
  port: number,
  opts: {
    method?: string
    path: string
    headers?: Record<string, string>
    body?: Buffer | 'none' | Buffer[]
  },
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: opts.method ?? 'GET',
        path: opts.path,
        headers: opts.headers,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve(toRes(res.statusCode ?? 0, res.headers, Buffer.concat(chunks))))
        res.on('error', reject)
      },
    )
    // An early server response + close legitimately resets our unfinished body.
    r.on('error', (e: NodeJS.ErrnoException) => {
      if (opts.body !== 'none') reject(e)
    })
    if (opts.body === 'none') r.flushHeaders()
    else if (Array.isArray(opts.body)) {
      for (const b of opts.body) r.write(b)
      r.end()
    } else r.end(opts.body)
  })
}

/** Raw bytes over a TCP socket; resolves with everything the server sent once it closes the socket. */
export function rawExchange(
  port: number,
  send: (sock: import('node:net').Socket) => void,
  timeoutMs = 5_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1')
    const chunks: Buffer[] = []
    const t = setTimeout(() => {
      sock.destroy()
      reject(new Error('raw exchange timed out'))
    }, timeoutMs)
    sock.on('data', (c) => chunks.push(c))
    sock.on('error', () => {}) // resets after the server closes are expected here
    sock.on('close', () => {
      clearTimeout(t)
      resolve(Buffer.concat(chunks).toString('latin1'))
    })
    sock.on('connect', () => send(sock))
  })
}

/** Every file (relative path) under a directory, recursively; [] if it does not exist. */
export function listFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string, rel: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) walk(p, rel ? `${rel}/${n}` : n)
      else out.push(rel ? `${rel}/${n}` : n)
    }
  }
  try {
    walk(dir, '')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  return out
}

export async function waitFor(check: () => boolean, timeoutMs = 5_000, what = 'condition'): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** An AccessClient whose answers a test controls; unknown pairs throw (= API cannot answer). */
export function fakeAccess(): AccessClient & {
  roles: Map<string, 'owner' | 'editor' | 'commenter' | 'viewer' | null>
  calls: string[]
  set(boardId: string, userId: string, role: 'owner' | 'editor' | 'commenter' | 'viewer' | null): void
  gate: Promise<void> | null
} {
  const f = {
    roles: new Map<string, 'owner' | 'editor' | 'commenter' | 'viewer' | null>(),
    calls: [] as string[],
    gate: null as Promise<void> | null,
    set(boardId: string, userId: string, role: 'owner' | 'editor' | 'commenter' | 'viewer' | null) {
      f.roles.set(`${boardId}/${userId}`, role)
    },
    async getRole(boardId: string, userId: string) {
      const k = `${boardId}/${userId}`
      f.calls.push(k)
      const answer = f.roles.get(k) // read BEFORE waiting: a gated call answers from the old state
      const known = f.roles.has(k)
      if (f.gate) await f.gate
      if (!known) throw new Error('unknown pair')
      return answer ?? null
    },
  }
  return f
}
