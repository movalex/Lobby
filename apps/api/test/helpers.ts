// In-process API for tests: a cloned, migrated in-memory PGlite (or, with DRAFTROOM_TEST_DATABASE_URL
// set, a fresh schema on that real Postgres: packages/db/src/testing.ts), app.inject() (no ports), a
// recording sync notifier and a controllable clock.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BlobStore } from '@draftroom/blob-store'
import type { Me } from '@draftroom/contracts'
import type { Db } from '@draftroom/db'
import { openTestDb } from '@draftroom/db/testing'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { type ApiDeps, createApiServer } from '../src/app.ts'
import { type ApiConfig, loadConfig } from '../src/config.ts'
import { type AccessChange, createRecordingNotifier } from '../src/notifier.ts'

export const ORIGIN = 'http://127.0.0.1:5173'
// Test-only values (not the dev.env ones), long enough for checkSecret.
export const TICKET_SECRET = 'test-ticket-secret-0123456789abcdefghij'
export const INTERNAL_SECRET = 'test-internal-secret-0123456789abcdefghij'
export const WORKER_TOKEN = 'test-worker-token-0123456789abcdefghijklmn'

export function testEnv(dataDir: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    DRAFTROOM_DEV_AUTH: '1',
    DRAFTROOM_DATA_DIR: dataDir,
    PUBLIC_ORIGIN: ORIGIN,
    DRAFTROOM_TICKET_SECRET: TICKET_SECRET,
    DRAFTROOM_INTERNAL_SECRET: INTERNAL_SECRET,
    DRAFTROOM_WORKER_TOKEN: WORKER_TOKEN,
    AUTH_PROVIDER: 'dev',
    ...extra,
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface Client {
  me: Me
  userId: string
  /** The personal workspace created at first login. */
  personalWorkspaceId: string
  cookie: string
  req(
    method: Method,
    url: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<LightMyRequestResponse>
}

export interface TestApi {
  app: FastifyInstance
  db: Db
  /** The api's blob store (a temp directory unless a test injects one). */
  blobs: BlobStore
  config: ApiConfig
  notifications: AccessChange[]
  clock: { advance(ms: number): void; now(): Date }
  /** Dev login; the first login of an app owns Dev Studio. */
  login(handle: string, name?: string): Promise<Client>
  /** Requests without a session (still same-origin). */
  anon(
    method: Method,
    url: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<LightMyRequestResponse>
  close(): Promise<void>
}

export async function createTestApi(opts: { deps?: Partial<ApiDeps>; env?: Record<string, string> } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'dr-api-'))
  const config = loadConfig(testEnv(dataDir, opts.env))
  const db = await openTestDb()
  const notifier = createRecordingNotifier()
  let offset = 0
  const now = () => new Date(Date.now() + offset)
  const server = await createApiServer(config, { db, notifier, now, ...opts.deps })
  await server.app.ready()

  const inject = (
    method: Method,
    url: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<LightMyRequestResponse> =>
    server.app.inject({
      method,
      url,
      ...(body === undefined ? {} : { payload: body as object }),
      headers: { origin: ORIGIN, ...headers },
    })

  const api: TestApi = {
    app: server.app,
    db,
    blobs: server.blobs,
    config,
    notifications: notifier.calls,
    clock: {
      advance: (ms) => {
        offset += ms
      },
      now,
    },
    async login(handle, name) {
      const res = await inject('POST', '/api/auth/dev/login', name ? { handle, name } : { handle }, {})
      if (res.statusCode !== 200) throw new Error(`login ${handle} failed: ${res.statusCode} ${res.body}`)
      const cookie = res.cookies.find((c) => c.name === 'dr_session')
      if (!cookie) throw new Error('no session cookie')
      const me = res.json() as Me
      const personal = me.workspaces.find((w) => w.name.endsWith("'s workspace") && w.role === 'owner')
      return {
        me,
        userId: me.user.id,
        personalWorkspaceId: personal?.id ?? '',
        cookie: `dr_session=${cookie.value}`,
        req: (method, url, body, headers = {}) =>
          inject(method, url, body, { cookie: `dr_session=${cookie.value}`, ...headers }),
      }
    },
    anon: (method, url, body, headers = {}) => inject(method, url, body, headers),
    async close() {
      await server.close()
      await db.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
  return api
}

/** Creates a board through the API and returns its id. */
export async function createBoard(c: Client, workspaceId: string, title = 'Board'): Promise<string> {
  const res = await c.req('POST', `/api/workspaces/${workspaceId}/boards`, { title })
  if (res.statusCode !== 201) throw new Error(`create board failed: ${res.statusCode} ${res.body}`)
  return (res.json() as { id: string }).id
}

export const DEV_STUDIO = 'wsp_DevStudio00000000000'
