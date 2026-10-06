// The Excalidraw-engine protocol harness (docs/EXCALIDRAW-MIGRATION.md §6.2): the REAL sync server process
// (apps/sync/src/server.ts through ./server-process.ts) with DRAFTROOM_ENGINE=excalidraw,
// DRAFTROOM_TEST_HOOKS=1 and backups off, a fake api (./element-api.ts: file-refs, workshop-state, access),
// raw protocol clients (./element-client.ts) and headless clients (O2's engine core on a Map scene, the
// client code browsers run). Ports: 0 (the OS picks one), as §8.6.5 says for the protocol harness.
//
//   const h = useElementStacks()                    // per test: everything torn down after each test
//   const st = await h.stack()
//   const a = await st.client({ boardId, user: 'alice' })         // raw frames
//   const b = await st.headless({ boardId, user: 'bob' })         // the engine core
//   await st.converged(boardId, [a, b])                            // every map hashes = the test snapshot
//
// or, for a file of independent tests on fresh boards, one stack for the file:
//
//   const shared = sharedElementStack()             // beforeAll / afterAll
//   it('…', async () => { const st = shared.get(); … })
//
// The tldraw engine's harness (./fixture.ts, ./sync-client.ts, ./tldraw-runtime.ts) is unchanged.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TicketRole } from '@draftroom/auth-tickets'
import { hashElements } from '@draftroom/canvas-schema/hash'
import { checkInvariants } from '@draftroom/canvas-schema/invariants'
import { type LeaseHookRequest, TEST_HOOK_PATHS, TestSnapshot } from '@draftroom/canvas-schema/protocol'
import { afterAll, afterEach, beforeAll } from 'vitest'
import {
  createLobbyHeadlessClient,
  type LobbyHeadlessClient,
} from '../../../web/src/canvas/sync/headless/index.ts'
import { type ElementApi, startElementApi } from './element-api.ts'
import { elementTicket, ProtocolClient, type ProtocolClientOptions } from './element-client.ts'
import type { El } from './elements.ts'
import { type SyncServer, spawnSyncServer } from './server-process.ts'
import { callInternal, TicketWebSocket } from './tickets.ts'
import { sleep } from './wait.ts'

/** The sync env every Excalidraw-engine stack starts with (a test's `env` goes on top). */
export const ELEMENT_ENGINE_ENV: Readonly<Record<string, string>> = {
  DRAFTROOM_ENGINE: 'excalidraw',
  DRAFTROOM_TEST_HOOKS: '1',
  // until 2B ports the backup job to lb_* files (docs/EXCALIDRAW-CONTRACTS.md §9.3)
  DRAFTROOM_BACKUP_STORE: 'off',
}

/** A fresh board id of the api's shape (`b-` + 10 characters). */
export const newBoardId = () => `b-${Math.random().toString(36).slice(2, 12).padEnd(10, '0')}`

export interface HeadlessOptions {
  readonly boardId: string
  readonly user: string
  readonly role?: TicketRole
  readonly guest?: boolean
  readonly tab?: string
  /** connect and wait for the welcome (default true) */
  readonly connect?: boolean
}

/** Anything whose element map can be hashed: a protocol client or a headless client. */
export interface Hashable {
  hash(): Promise<string>
}

export interface ElementStack {
  readonly server: SyncServer
  readonly api: ElementApi
  /** a raw protocol client that has said hello (unless `hello: false`) */
  client(opts: Omit<ProtocolClientOptions, 'wsUrl'>): Promise<ProtocolClient>
  /** a raw protocol client whose socket is open but that has not said hello */
  socket(opts: Omit<ProtocolClientOptions, 'wsUrl' | 'hello'>): Promise<ProtocolClient>
  /** O2's headless client (the engine core), connected and welcomed */
  headless(opts: HeadlessOptions): Promise<LobbyHeadlessClient & Hashable>
  /** the test snapshot: live elements AND tombstones, `(id)` order (§2.4.6) */
  snapshot(boardId: string): Promise<TestSnapshot>
  /** one stored element (tombstones included), or undefined */
  stored(boardId: string, id: string): Promise<El | undefined>
  /** the lease-grant hook (B3 L12) */
  leaseHook(boardId: string, body: LeaseHookRequest): Promise<void>
  /** the room's next `count` COMMITs throw (D4) */
  failCommit(boardId: string, count: number): Promise<void>
  /** the api's A2 push of the vote state (and the state its pull answers from now on) */
  setWorkshop(boardId: string, s: { voteOpen: boolean; anonymous: boolean }): Promise<void>
  /**
   * Waits until every client's map hashes equal to the test snapshot's (tombstones included) and the
   * invariant checker finds nothing; throws with the hashes otherwise.
   */
  converged(boardId: string, clients: readonly Hashable[], timeoutMs?: number): Promise<TestSnapshot>
  dispose(): Promise<void>
}

export interface ElementStackOptions {
  /** extra sync env; `undefined` removes a key */
  readonly env?: Record<string, string | undefined>
  /** reuse a data dir (a restart on the same board files); default: a fresh temp dir, removed on dispose */
  readonly dataDir?: string
}

export async function createElementStack(opts: ElementStackOptions = {}): Promise<ElementStack> {
  const ownDir = opts.dataDir === undefined
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'dr-element-'))
  const api = await startElementApi()
  let server: SyncServer
  try {
    server = await spawnSyncServer({
      dataDir,
      env: { ...ELEMENT_ENGINE_ENV, DRAFTROOM_API_INTERNAL_URL: api.url, ...opts.env },
    })
  } catch (e) {
    await api.close()
    if (ownDir) rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    throw e
  }
  const clients: ProtocolClient[] = []
  const headless: LobbyHeadlessClient[] = []

  const post = async (path: string, body: unknown) => {
    const res = await callInternal(server.url, 'POST', path, { body })
    if (res.status !== 204) throw new Error(`${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
  }
  const snapshot = async (boardId: string) => {
    const res = await callInternal(server.url, 'GET', TEST_HOOK_PATHS.snapshot(boardId))
    if (res.status !== 200) throw new Error(`test snapshot of ${boardId}: HTTP ${res.status}`)
    return TestSnapshot.parse(await res.json())
  }

  /** Waits until a client's clock reaches the server's (the catch-up after a cached snapshot, §2.4.5). */
  const caughtUp = async (boardId: string, clock: () => number, who: string) => {
    const target = (await snapshot(boardId)).clock
    const deadline = Date.now() + 10_000
    while (clock() < target && Date.now() < deadline) await sleep(10)
    if (clock() < target) throw new Error(`${who}: at clock ${clock()}, the board is at ${target}`)
  }

  const stack: ElementStack = {
    server,
    api,
    async client(o) {
      const c = await ProtocolClient.connect({ wsUrl: server.wsUrl, ...o })
      clients.push(c)
      if (o.hello !== false && c.isOpen) await caughtUp(o.boardId, () => c.clock, o.user)
      return c
    },
    async socket(o) {
      const c = await ProtocolClient.connect({ wsUrl: server.wsUrl, ...o, hello: false })
      clients.push(c)
      return c
    },
    async headless(o) {
      const c = createLobbyHeadlessClient({
        syncUrl: server.wsUrl,
        boardId: o.boardId,
        tab: o.tab ?? `hl-${o.user}`,
        ticket: elementTicket(o.boardId, o.user, o.role, o.guest),
        refreshTicket: async () => elementTicket(o.boardId, o.user, o.role, o.guest),
        // L7-tail: the ticket in the offered subprotocol, as the browsers send it
        WebSocketImpl: TicketWebSocket,
      })
      headless.push(c)
      const withHash = Object.assign(c, { hash: () => hashElements(c.core.elements().values()) })
      if (o.connect !== false) {
        await c.connect()
        // A joiner gets the room's cached snapshot plus a catch-up since its clock (§2.4.5), so the
        // welcome and its snapshot can be older than the board: wait until the core has caught up with
        // the server's clock, so a test's first read or edit sees the whole board
        await caughtUp(o.boardId, () => c.core.clock, `headless ${o.user}`)
      }
      return withHash
    },
    snapshot,
    async stored(boardId, id) {
      return (await snapshot(boardId)).elements.find((e) => e.id === id) as El | undefined
    },
    leaseHook: (boardId, body) => post(TEST_HOOK_PATHS.leaseHook(boardId), body),
    failCommit: (boardId, count) => post(TEST_HOOK_PATHS.failCommit(boardId), { count }),
    async setWorkshop(boardId, s) {
      api.setWorkshop(boardId, s)
      await post(`/internal/boards/${encodeURIComponent(boardId)}/workshop-state`, s)
    },
    async converged(boardId, list, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const snap = await snapshot(boardId)
        const want = await hashElements(snap.elements)
        const got = await Promise.all(list.map((c) => c.hash()))
        if (got.every((h) => h === want)) {
          const violations = checkInvariants(snap.elements)
          if (violations.length)
            throw new Error(`invariant violations on ${boardId}: ${JSON.stringify(violations.slice(0, 5))}`)
          return snap
        }
        if (Date.now() > deadline)
          throw new Error(`${boardId}: maps differ from the snapshot (${want}): ${JSON.stringify(got)}`)
        await sleep(50)
      }
    },
    async dispose() {
      for (const c of clients.splice(0)) c.terminate()
      await Promise.all(headless.splice(0).map((c) => c.close().catch(() => {})))
      await server.kill('SIGKILL')
      await api.close()
      if (ownDir) rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    },
  }
  return stack
}

/** Per-test stacks: every stack a test creates is disposed after it. */
export function useElementStacks(): { stack(opts?: ElementStackOptions): Promise<ElementStack> } {
  let stacks: ElementStack[] = []
  afterEach(async () => {
    const all = stacks
    stacks = []
    await Promise.all(all.map((s) => s.dispose()))
  })
  return {
    async stack(opts) {
      const s = await createElementStack(opts)
      stacks.push(s)
      return s
    },
  }
}

/** One stack for a whole file (fresh boards per test keep tests independent). */
export function sharedElementStack(opts: ElementStackOptions = {}): { get(): ElementStack } {
  let st: ElementStack | null = null
  beforeAll(async () => {
    st = await createElementStack(opts)
  })
  afterAll(async () => {
    await st?.dispose()
    st = null
  })
  return {
    get() {
      if (!st) throw new Error('sharedElementStack: used outside a test')
      return st
    },
  }
}
