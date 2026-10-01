// The cross-owner test hooks, server side (docs/EXCALIDRAW-MIGRATION.md §2.4.6, §8.6.2), frozen at the
// spike B contracts step C0 (docs/research/excalidraw/spike-b/CONTRACTS.md). Lead-owned.
//
// Only with DRAFTROOM_TEST_HOOKS=1 (config.ts refuses it at start-up with NODE_ENV=production, as the
// api refuses DRAFTROOM_DEV_AUTH) and only behind the internal secret (the router's check). Without the
// flag the routes do not exist: 404.
//
//   GET  /internal/test/boards/:bid/snapshot     → 200 TestSnapshot (live elements AND every tombstone, in (id) order)
//   POST /internal/test/boards/:bid/lease-hook   LeaseHookRequest  → 204 (B3 L12)
//   POST /internal/test/boards/:bid/fail-commit  FailCommitRequest → 204 (B4 D4)
//
// O1's ElementRoom implements them: its factory calls `registerTestHooks({snapshot, leaseHook,
// failCommit})` when created with the flag, and the returned function when it closes. The client side of
// these hooks (and the latency relay and socket cut, which need no server) is O3's
// `e2e/spike-b/support/**`, typed in `e2e/spike-b/support/types.ts`.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { FailCommitRequest, LeaseHookRequest, type TestSnapshot } from '@draftroom/canvas-schema/protocol'
import type { InternalRoute } from './engine-switch.ts'
import { readJson } from './http/body.ts'
import { HttpError, sendJson } from './http/respond.ts'
import { BOARD_ID_RE } from './rooms.ts'

export { FailCommitRequest, LeaseHookRequest, type TestSnapshot }

/** What O1's room provides. Each call is about one board. */
export interface TestHookImpl {
  /** The board's live elements and tombstones (null: no such board, 404). */
  snapshot(boardId: string): TestSnapshot | null | Promise<TestSnapshot | null>
  /** The next lease grants on this board are delayed, held until released, or normal again. */
  leaseHook(boardId: string, req: LeaseHookRequest): void
  /** The next `count` COMMITs of this board's room throw (the room then answers UNAVAILABLE and reopens). */
  failCommit(boardId: string, req: FailCommitRequest): void
}

let registered: TestHookImpl | null = null

/** O1's room registers its hooks (one set at a time). Returns the unregister function. */
export function registerTestHooks(impl: TestHookImpl): () => void {
  registered = impl
  return () => {
    if (registered === impl) registered = null
  }
}

/** The registered hooks (in-process tests call them directly), or null. */
export function testHooks(): TestHookImpl | null {
  return registered
}

const BODY_LIMIT = 4 * 1024

function boardParam(raw: string): string {
  if (!BOARD_ID_RE.test(raw)) throw new HttpError(400, 'bad-request', 'Invalid board id.')
  return raw
}
function hooksOr404(): TestHookImpl {
  if (!registered) throw new HttpError(404, 'NOT_FOUND', 'Not found.')
  return registered
}

/** The routes app.ts mounts when `config.testHooks` is true. */
export function testHookRoutes(): InternalRoute[] {
  return [
    {
      method: 'GET',
      path: /^\/internal\/test\/boards\/([^/]+)\/snapshot$/,
      handle: async (_req: IncomingMessage, res: ServerResponse, [raw = '']) => {
        const boardId = boardParam(raw)
        const snap = await hooksOr404().snapshot(boardId)
        if (!snap) throw new HttpError(404, 'board-not-found', 'No such board.')
        sendJson(res, 200, snap)
      },
    },
    {
      method: 'POST',
      path: /^\/internal\/test\/boards\/([^/]+)\/lease-hook$/,
      handle: async (req: IncomingMessage, res: ServerResponse, [raw = '']) => {
        const boardId = boardParam(raw)
        const hooks = hooksOr404()
        const body = LeaseHookRequest.safeParse(await readJson(req, BODY_LIMIT))
        if (!body.success) throw new HttpError(400, 'bad-request', 'Invalid lease hook.')
        hooks.leaseHook(boardId, body.data)
        res.writeHead(204, { 'Cache-Control': 'no-store' }).end()
      },
    },
    {
      method: 'POST',
      path: /^\/internal\/test\/boards\/([^/]+)\/fail-commit$/,
      handle: async (req: IncomingMessage, res: ServerResponse, [raw = '']) => {
        const boardId = boardParam(raw)
        const hooks = hooksOr404()
        const body = FailCommitRequest.safeParse(await readJson(req, BODY_LIMIT))
        if (!body.success) throw new HttpError(400, 'bad-request', 'Invalid fail-commit request.')
        hooks.failCommit(boardId, body.data)
        res.writeHead(204, { 'Cache-Control': 'no-store' }).end()
      },
    },
  ]
}
