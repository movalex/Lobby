import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type BlobStore, createFsBlobStore } from '@draftroom/blob-store'
import type { PgliteDb } from '@draftroom/db'
import { openTestDb } from '@draftroom/db/testing'
import { type DerivativeRecord, newId } from '@draftroom/dev-assets'
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from 'fastify'
import { derivativeKey } from '../../src/files/blobs.ts'
import type { FileAction, FileAuthorization, FilesDeps } from '../../src/files/deps.ts'
import { filesPlugin } from '../../src/files/plugin.ts'

export const ALICE = 'usr_aliceAAAAAAAAAAAAAAA'
export const BOB = 'usr_bobBBBBBBBBBBBBBBBBB'
export const WORKSPACE = 'wsp_filesWSPfilesWSP0000'

export type FakeRole = 'viewer' | 'editor'

export interface AuthCall {
  boardId: string
  action: FileAction
  /** Whether any request body byte had been consumed when authorize() was called. */
  bodyRead: boolean
  /** Files under the blob store's root at that moment. */
  blobsAtCall: string[]
}

/**
 * Stand-in for the API core's authorize(): a signed-in user (or none) with per-board roles, following
 * the deps.ts contract (401 signed out, 404 no view, 403 view but not edit). Mutable per test.
 */
export interface FakeAuth {
  userId: string | null
  roles: Record<string, FakeRole>
  calls: AuthCall[]
  /** When set, authorize() waits for it before answering. */
  gate: Promise<void> | null
  /** When set, authorize() rejects with it (the API core failing, e.g. the database is down). */
  failWith: Error | null
  authorize: FilesDeps['authorize']
}

function fakeAuth(blobRoot: string): FakeAuth {
  const auth: FakeAuth = {
    userId: ALICE,
    roles: { 'board-a': 'editor' },
    calls: [],
    gate: null,
    failWith: null,
    async authorize(req: FastifyRequest, boardId: string, action: FileAction): Promise<FileAuthorization> {
      auth.calls.push({
        boardId,
        action,
        bodyRead: req.raw.readableDidRead,
        blobsAtCall: listFiles(blobRoot),
      })
      if (auth.gate) await auth.gate
      if (auth.failWith) throw auth.failWith
      if (!auth.userId) return { ok: false, status: 401 }
      const role = auth.roles[boardId]
      if (!role) return { ok: false, status: 404 }
      if (action === 'edit' && role !== 'editor') return { ok: false, status: 403 }
      return { ok: true, userId: auth.userId, workspaceId: WORKSPACE }
    },
  }
  return auth
}

/** Users, one workspace and the boards the fake authorizer knows (asset rows reference boards). */
export async function seedBoards(db: PgliteDb, boards: string[] = ['board-a', 'board-b']) {
  await db.query(
    `INSERT INTO users (id, name, handle, color) VALUES ($1, 'Alice', 'alice', '#3355ff'), ($2, 'Bob', 'bob', '#33aa55')
     ON CONFLICT DO NOTHING`,
    [ALICE, BOB],
  )
  await db.query(
    `INSERT INTO workspaces (id, name, created_by) VALUES ($1, 'Files', $2) ON CONFLICT DO NOTHING`,
    [WORKSPACE, ALICE],
  )
  for (const b of boards)
    await db.query(
      `INSERT INTO boards (id, workspace_id, title, created_by) VALUES ($1, $2, $1, $3) ON CONFLICT DO NOTHING`,
      [b, WORKSPACE, ALICE],
    )
}

export interface TestApp {
  app: FastifyInstance
  port: number
  db: PgliteDb
  /** What the file routes use (the real fs store unless a test passes `wrap`). */
  blobs: BlobStore
  /** The fs store's root directory (every stored byte lives below it). */
  blobRoot: string
  auth: FakeAuth
  errors: unknown[]
  /** app.close(), once. */
  close(): Promise<void>
  /** close(), close the database and delete the data directory. */
  stop(): Promise<void>
}

/**
 * A host app shaped like the real API: its own parsers (Fastify's JSON + text/plain, plus a buffering
 * octet-stream one), its own error handler and a JSON route, with filesPlugin registered inside it,
 * over a migrated PGlite and the real fs blob store in a temp directory.
 * `direct` calls filesPlugin(app, deps) instead of app.register(filesPlugin, deps); `wrap` puts a
 * fault-injecting store in front of the real one.
 */
export async function startApp(
  opts: { direct?: boolean; wrap?: (store: BlobStore) => BlobStore } = {},
): Promise<TestApp> {
  const dataDir = mkdtempSync(join(tmpdir(), 'dr-api-files-'))
  const blobRoot = join(dataDir, 'blobs')
  const fsStore = createFsBlobStore(blobRoot)
  const blobs = opts.wrap ? opts.wrap(fsStore) : fsStore
  const db = await openTestDb()
  await seedBoards(db)
  const auth = fakeAuth(blobRoot)
  const errors: unknown[] = []
  const noop = (..._args: unknown[]) => {}
  // Captures error-level logs (the file routes log server errors through request.log).
  const logger: FastifyBaseLogger = {
    level: 'error',
    fatal: noop,
    error: (obj: unknown) => {
      errors.push(obj)
    },
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
    silent: noop,
    child: () => logger,
  }
  const app = Fastify({ loggerInstance: logger })
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) =>
    done(null, body),
  )
  app.setErrorHandler((_err, _req, reply) => reply.code(599).send({ host: true }))
  app.post('/host/echo', async (req) => ({ echoed: req.body }))
  app.get('/host/boom', async () => {
    throw new Error('host failure')
  })
  const deps: FilesDeps = { db, blobs, authorize: auth.authorize }
  if (opts.direct) await filesPlugin(app, deps)
  else await app.register(filesPlugin, deps)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = app.server.address() as AddressInfo
  let closing: Promise<void> | null = null
  const close = () => {
    closing ??= app.close()
    return closing
  }
  return {
    app,
    port,
    db,
    blobs,
    blobRoot,
    auth,
    errors,
    close,
    async stop() {
      await close()
      await db.close()
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
  name?: string
  type?: string
  body?: Buffer
  query?: string
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
  return req(port, {
    method: 'POST',
    path: `/api/boards/${o.board ?? 'board-a'}/assets${o.query ?? ''}`,
    headers,
    body,
  })
}

/** Raw bytes over a TCP socket; resolves with everything the server sent once it closes the socket. */
export function rawExchange(port: number, send: (sock: Socket) => void, timeoutMs = 5_000): Promise<string> {
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

/** Status line, headers (lowercased names) and JSON body of a raw HTTP/1.1 response. */
export function parseRaw(raw: string): { status: number; headers: Record<string, string>; json: JsonBody } {
  const [head = '', body = ''] = raw.split('\r\n\r\n')
  const [statusLine = '', ...lines] = head.split('\r\n')
  const headers: Record<string, string> = {}
  for (const l of lines) {
    const i = l.indexOf(':')
    headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim()
  }
  return { status: Number(statusLine.split(' ')[1]), headers, json: body ? JSON.parse(body) : null }
}

/**
 * Request head for a raw upload whose body the caller sends (or never sends). `close` asks the server
 * to hang up after responding (a client half-close would instead make Node abort the request).
 */
export const uploadHead = (o: {
  board?: string
  type?: string
  name?: string
  length: number | null
  close?: boolean
}) =>
  `POST /api/boards/${o.board ?? 'board-a'}/assets HTTP/1.1\r\nHost: x\r\n` +
  `Content-Type: ${o.type ?? 'image/png'}\r\nX-File-Name: ${o.name ?? 'a.png'}\r\n` +
  (o.length === null ? '' : `Content-Length: ${o.length}\r\n`) +
  (o.close ? 'Connection: close\r\n' : '') +
  '\r\n'

/** Every file (relative path) under a directory, recursively; [] when it does not exist. */
export function listFiles(dir: string): string[] {
  const out: string[] = []
  if (!existsSync(dir)) return out
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

export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

/** Row counts of the asset tables. */
export async function assetRows(db: PgliteDb) {
  const count = async (table: string) =>
    (await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).n
  return {
    versions: await count('asset_versions'),
    jobs: await count('preview_jobs'),
    derivatives: await count('asset_derivatives'),
  }
}

/** Nothing of an upload survived: no stored bytes (temp files included) and no rows. */
export async function nothingStored(t: Pick<TestApp, 'db' | 'blobRoot'>): Promise<void> {
  const files = listFiles(t.blobRoot)
  const rows = await assetRows(t.db)
  if (files.length || rows.versions || rows.jobs) {
    throw new Error(
      `expected nothing stored, found files=${JSON.stringify(files)} rows=${JSON.stringify(rows)}`,
    )
  }
}

/** Every stored upload: blob paths under the root (no temp files, which contain `~`). */
export const storedBlobs = (t: Pick<TestApp, 'blobRoot'>) => listFiles(t.blobRoot).sort()

/**
 * Plays the worker's end result (what `complete` writes): a derivative blob plus, when `publish`, its
 * asset_derivatives row. An unpublished blob is what a running job's reservation looks like.
 */
export async function addDerivative(
  t: Pick<TestApp, 'db' | 'blobs'>,
  m: { assetId: string; versionId: string },
  opts: { publish: boolean; mimeType?: 'image/webp' | 'image/png' } = { publish: true },
): Promise<{ id: string; bytes: Buffer; record: DerivativeRecord }> {
  const id = newId('drv')
  const mimeType = opts.mimeType ?? 'image/webp'
  const ext = mimeType === 'image/png' ? 'png' : 'webp'
  const bytes = Buffer.from(`${ext}-bytes-${id}`)
  const key = derivativeKey(m.assetId, m.versionId, id, ext)
  await t.blobs.put(key, bytes, { contentType: mimeType, contentLength: bytes.length })
  if (opts.publish) {
    const { n } = await t.db.one<{ n: number }>(
      'SELECT count(*)::int AS n FROM asset_derivatives WHERE version_id = $1',
      [m.versionId],
    )
    await t.db.query(
      `INSERT INTO asset_derivatives (id, version_id, position, role, page, width, height, mime_type, bytes, blob_key)
       VALUES ($1, $2, $3, 'thumb', NULL, 1, 1, $4, $5, $6)`,
      [id, m.versionId, n, mimeType, bytes.length, key],
    )
  }
  const record: DerivativeRecord = {
    id,
    role: 'thumb',
    page: null,
    width: 1,
    height: 1,
    mimeType,
    bytes: bytes.length,
    file: `${id}.${ext}`,
  }
  return { id, bytes, record }
}

/** A version's row changed the way the worker's `complete` would change it. */
export async function setVersion(
  db: PgliteDb,
  versionId: string,
  patch: { status?: string; mimeType?: string; error?: { code: string; message: string } | null },
) {
  await db.query(
    `UPDATE asset_versions SET status = COALESCE($2, status), mime_type = COALESCE($3, mime_type),
        error_code = CASE WHEN $4::boolean THEN $5 ELSE error_code END,
        error_message = CASE WHEN $4::boolean THEN $6 ELSE error_message END
      WHERE id = $1`,
    [
      versionId,
      patch.status ?? null,
      patch.mimeType ?? null,
      patch.error !== undefined,
      patch.error?.code ?? null,
      patch.error?.message ?? null,
    ],
  )
}

type Fault = (() => Error | null | undefined) | undefined

/**
 * A store in front of `inner` whose chosen operations fail while their fault function returns an
 * error (fault injection). A failing put destroys its body, as the real stores do.
 */
export function faultyStore(
  inner: BlobStore,
  faults: { put?: Fault; get?: Fault; head?: Fault; delete?: Fault },
): BlobStore {
  return {
    kind: inner.kind,
    put: (k, b, o) => {
      const f = faults.put?.()
      if (!f) return inner.put(k, b, o)
      const s = b as { destroy?: () => void }
      if (typeof s.destroy === 'function') s.destroy()
      return Promise.reject(f)
    },
    get: (k, o) => {
      const f = faults.get?.()
      return f ? Promise.reject(f) : inner.get(k, o)
    },
    head: (k) => {
      const f = faults.head?.()
      return f ? Promise.reject(f) : inner.head(k)
    },
    delete: (k) => {
      const f = faults.delete?.()
      return f ? Promise.reject(f) : inner.delete(k)
    },
    presignGet: (k, o) => inner.presignGet(k, o),
    presignPut: (k, o) => inner.presignPut(k, o),
  }
}
