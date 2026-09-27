// Per-test lifecycle: every server, client and data dir a test creates is torn down after it, even
// when the test fails, so no child process outlives the run.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import type { ShapeRecord } from './records.ts'
import { type SyncServer, type SyncServerOptions, spawnSyncServer } from './server-process.ts'
import { NodeSyncClient, type SyncClientOptions } from './sync-client.ts'

export function newBoardId(): string {
  return `b-${Math.random().toString(36).slice(2, 12).padEnd(10, '0')}`
}

export function roomFiles(dataDir: string): string[] {
  try {
    return readdirSync(join(dataDir, 'rooms')).sort()
  } catch {
    return []
  }
}

export interface ProtocolHarness {
  dataDir(): string
  server(opts?: Partial<SyncServerOptions>): Promise<SyncServer>
  client(server: SyncServer, opts: Omit<SyncClientOptions, 'wsUrl'>): NodeSyncClient
  /** connect and wait until the client is synced */
  connected(server: SyncServer, opts: Omit<SyncClientOptions, 'wsUrl'>): Promise<NodeSyncClient>
  /** What a brand-new session (empty store, lastServerClock -1) is served for the board right now. */
  freshView(server: SyncServer, boardId: string): Promise<Map<string, ShapeRecord>>
}

export function useProtocolHarness(): ProtocolHarness {
  let servers: SyncServer[] = []
  let clients: NodeSyncClient[] = []
  let dirs: string[] = []

  afterEach(async () => {
    for (const c of clients) c.dispose()
    await Promise.all(servers.map((s) => s.kill('SIGKILL')))
    for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    servers = []
    clients = []
    dirs = []
  })

  const h: ProtocolHarness = {
    dataDir() {
      const d = mkdtempSync(join(tmpdir(), 'dr-protocol-'))
      dirs.push(d)
      return d
    },
    async server(opts = {}) {
      const s = await spawnSyncServer({ dataDir: opts.dataDir ?? h.dataDir(), ...opts })
      servers.push(s)
      return s
    },
    client(server, opts) {
      const c = new NodeSyncClient({ wsUrl: server.wsUrl, ...opts })
      clients.push(c)
      return c
    },
    async connected(server, opts) {
      const c = h.client(server, opts)
      await c.waitForSynced()
      return c
    },
    async freshView(server, boardId) {
      const c = await h.connected(server, { boardId, user: 'verifier', autoReconnect: false })
      const shapes = new Map(c.shapes().map((s) => [s.id as string, s as ShapeRecord]))
      c.dispose()
      return shapes
    },
  }
  return h
}
