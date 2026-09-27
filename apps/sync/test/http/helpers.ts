import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type DataLayout, dataLayout } from '@draftroom/dev-assets'
import { createSyncServer, type SyncServer } from '../../src/app.ts'

export interface TestServer {
  port: number
  server: SyncServer
  layout: DataLayout
  logs: string[]
  stop(): Promise<void>
}

export async function startServer(): Promise<TestServer> {
  const dataDir = mkdtempSync(join(tmpdir(), 'dr-sync-http-'))
  const logs: string[] = []
  const server = createSyncServer(
    { devAuth: true, host: '127.0.0.1', port: 0, dataDir, idleEvictMs: 50, textLeaseMs: 5_000 },
    { log: (...a) => logs.push(a.map(String).join(' ')) },
  )
  const { port } = await server.listen()
  return {
    port,
    server,
    layout: dataLayout(dataDir),
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
    // An early server response + close legitimately resets our unfinished upload.
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

export interface UploadOpts {
  board?: string
  user?: string
  name?: string
  type?: string
  body?: Buffer
  headers?: Record<string, string>
}

export function upload(port: number, o: UploadOpts = {}): Promise<Res> {
  const body = o.body ?? Buffer.from('hello world')
  const headers: Record<string, string> = {
    'Content-Type': o.type ?? 'image/png',
    'Content-Length': String(body.length),
    'X-File-Name': encodeURIComponent(o.name ?? 'pic.png'),
    ...o.headers,
  }
  const user = o.user === undefined ? '?devUser=alice' : o.user ? `?devUser=${o.user}` : ''
  return req(port, {
    method: 'POST',
    path: `/dev-api/boards/${o.board ?? 'board-a'}/assets${user}`,
    headers,
    body,
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

/** Every file (relative path) under a directory, recursively. */
export function listFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string, rel: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) walk(p, rel ? `${rel}/${n}` : n)
      else out.push(rel ? `${rel}/${n}` : n)
    }
  }
  walk(dir, '')
  return out
}

export async function waitFor(check: () => boolean, timeoutMs = 5_000, what = 'condition'): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}
