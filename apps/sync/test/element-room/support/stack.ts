// Per-test lifecycle for the ElementRoom protocol tests: the REAL sync server process (apps/sync/src/
// server.ts, through test/harness/server-process.ts) with DRAFTROOM_ENGINE=excalidraw and
// DRAFTROOM_TEST_HOOKS=1, a fake api (support/fake-api.ts) and raw WebSocket clients (support/client.ts).
// Every server, client, api and data dir a test creates is torn down after it. Ports: 0 (the OS picks a
// free ephemeral port), as §8.6.5 says for the sync protocol harness. DRAFTROOM_BACKUP_STORE=off.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TEST_HOOK_PATHS, type TestSnapshot } from '@draftroom/canvas-schema/protocol'
import { afterEach } from 'vitest'
import { type SyncServer, type SyncServerOptions, spawnSyncServer } from '../../harness/server-process.ts'
import { callInternal } from '../../harness/tickets.ts'
import { type ClientOptions, RawClient } from './client.ts'
import { type ElementFakeApi, startElementFakeApi } from './fake-api.ts'

export const newBoardId = () => `b-${Math.random().toString(36).slice(2, 12).padEnd(10, '0')}`

export interface ElementStack {
  readonly server: SyncServer
  readonly api: ElementFakeApi
  client(opts: Omit<ClientOptions, 'wsUrl'>): Promise<RawClient>
  /** a client that has opened its socket but not said hello */
  socket(opts: Omit<ClientOptions, 'wsUrl' | 'hello'>): Promise<RawClient>
  snapshot(boardId: string): Promise<TestSnapshot>
  leaseHook(boardId: string, body: unknown): Promise<void>
  failCommit(boardId: string, count: number): Promise<void>
}

export interface ElementHarness {
  stack(opts?: { env?: Record<string, string | undefined>; dataDir?: string }): Promise<ElementStack>
  dataDir(): string
}

export function useElementHarness(): ElementHarness {
  let servers: SyncServer[] = []
  let clients: RawClient[] = []
  let apis: ElementFakeApi[] = []
  let dirs: string[] = []
  afterEach(async () => {
    for (const c of clients) c.terminate()
    await Promise.all(servers.map((s) => s.kill('SIGKILL')))
    await Promise.all(apis.map((a) => a.close()))
    for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    servers = []
    clients = []
    apis = []
    dirs = []
  })
  const h: ElementHarness = {
    dataDir() {
      const d = mkdtempSync(join(tmpdir(), 'dr-element-'))
      dirs.push(d)
      return d
    },
    async stack(opts = {}) {
      const api = await startElementFakeApi()
      apis.push(api)
      const server = await spawnSyncServer({
        dataDir: opts.dataDir ?? h.dataDir(),
        env: {
          DRAFTROOM_ENGINE: 'excalidraw',
          DRAFTROOM_TEST_HOOKS: '1',
          DRAFTROOM_BACKUP_STORE: 'off',
          DRAFTROOM_API_INTERNAL_URL: api.url,
          ...opts.env,
        },
      } satisfies SyncServerOptions)
      servers.push(server)
      const post = async (path: string, body: unknown) => {
        const res = await callInternal(server.url, 'POST', path, { body })
        if (res.status !== 204) throw new Error(`${path}: ${res.status}`)
      }
      return {
        server,
        api,
        async client(o) {
          const c = await RawClient.connect({ wsUrl: server.wsUrl, ...o })
          clients.push(c)
          return c
        },
        async socket(o) {
          const c = await RawClient.connect({ wsUrl: server.wsUrl, ...o, hello: false })
          clients.push(c)
          return c
        },
        async snapshot(boardId) {
          const res = await callInternal(server.url, 'GET', TEST_HOOK_PATHS.snapshot(boardId))
          if (res.status !== 200) throw new Error(`test snapshot: ${res.status}`)
          return (await res.json()) as TestSnapshot
        },
        leaseHook: (boardId, body) => post(TEST_HOOK_PATHS.leaseHook(boardId), body),
        failCommit: (boardId, count) => post(TEST_HOOK_PATHS.failCommit(boardId), { count }),
      }
    },
  }
  return h
}
