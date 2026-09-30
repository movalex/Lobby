// Test-only internal routes of the ElementRoom (mounted with the room's routes only when
// DRAFTROOM_TEST_HOOKS=1, which config.ts refuses under NODE_ENV=production), behind the internal secret.
// They let the room's protocol tests drive CR 2F-2 through the REAL server process, where the api's
// routes (room-internal/** on engine/excalidraw) are not built:
//
//   POST /internal/test/boards/:bid/prepare       → 200 {ready}          (the service's prepareBoard)
//   POST /internal/test/boards/:bid/server-write  TestServerWrite → 200 {clock, wrote}
//
// The server write is a canned `apply` (upserts, deletions, revivals, doc keys) that also knows how to
// break the contract on purpose (`fail`), so the tests can see the room refuse it. Everything it stores
// passes through the room's server-write path (server-write.ts), exactly as a real route's write does.

import type { ElementRoomService, InternalRoute, ServerWriteChange, ServerWriteTx } from '../engine-switch.ts'
import { readJson } from '../http/body.ts'
import { HttpError, sendJson } from '../http/respond.ts'
import { BOARD_ID_RE } from '../rooms.ts'
import type { El } from './merge.ts'

/** The body of the test server write. */
export interface TestServerWrite {
  /** elements to write as given (their version becomes max(stored, given) + 1) */
  put?: El[]
  /** ids of live elements to delete */
  delete?: string[]
  /** ids of deleted elements to bring back */
  revive?: string[]
  /** lb_doc keys to write (null = remove) */
  doc?: Record<string, unknown>
  /** break the contract on purpose, after writing */
  fail?: 'throw' | 'bad-clock' | 'unreported' | 'async' | 'stale-version'
}

const nonce = () => Math.floor(Math.random() * 2 ** 31)

/** The canned apply of TestServerWrite. */
export function testApply(body: TestServerWrite) {
  return (tx: ServerWriteTx) => {
    const changed: ServerWriteChange[] = []
    const write = (el: El, prev: El | null, first: boolean) => {
      const clock = body.fail === 'bad-clock' && first ? tx.clock - 1 : tx.clock
      // gclock and the tombstone fields are left to the room (it stamps them)
      tx.store.upsert({ el: el as never, clock, gclock: {}, deletedClock: null, deletedAt: null })
      changed.push({ before: (prev as never) ?? null, after: el as never })
    }
    let first = true
    for (const given of body.put ?? []) {
      const prev = (tx.store.get(given.id)?.el as El | undefined) ?? null
      const version =
        body.fail === 'stale-version'
          ? (prev?.version ?? 1)
          : Math.max(prev?.version ?? 0, given.version ?? 1) + 1
      write({ ...structuredClone(given), version, versionNonce: nonce(), updated: tx.now }, prev, first)
      first = false
    }
    for (const [ids, isDeleted] of [
      [body.delete ?? [], true],
      [body.revive ?? [], false],
    ] as const)
      for (const id of ids) {
        const prev = tx.store.get(id)?.el as El | undefined
        if (!prev || !!prev.isDeleted === isDeleted)
          throw new HttpError(409, 'test-state', 'Not in that state.')
        write(
          {
            ...structuredClone(prev),
            isDeleted,
            version: prev.version + 1,
            versionNonce: nonce(),
            updated: tx.now,
          },
          prev,
          first,
        )
        first = false
      }
    const doc: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(body.doc ?? {})) {
      tx.store.docSet(k, tx.clock, v)
      doc[k] = v
    }
    if (body.fail === 'throw') throw new HttpError(409, 'test-refused', 'Refused by the test write.')
    if (body.fail === 'unreported') changed.pop()
    const out = { changed, doc, result: { clock: tx.clock, wrote: changed.length } }
    return (body.fail === 'async' ? Promise.resolve(out) : out) as typeof out
  }
}

function boardParam(raw: string): string {
  const id = decodeURIComponent(raw)
  if (!BOARD_ID_RE.test(id)) throw new HttpError(400, 'bad-request', 'Invalid board id.')
  return id
}

export function testRoomRoutes(service: () => ElementRoomService): InternalRoute[] {
  return [
    {
      method: 'POST',
      path: /^\/internal\/test\/boards\/([^/]+)\/prepare$/,
      handle: async (_req, res, [raw = '']) => {
        const prepare = service().prepareBoard
        if (!prepare) throw new HttpError(404, 'NOT_FOUND', 'Not found.')
        sendJson(res, 200, { ready: await prepare(boardParam(raw)) })
      },
    },
    {
      method: 'POST',
      path: /^\/internal\/test\/boards\/([^/]+)\/server-write$/,
      handle: async (req, res, [raw = '']) => {
        const boardId = boardParam(raw)
        const body = (await readJson(req, 4 * 1024 * 1024)) as TestServerWrite
        const write = service().serverWrite
        if (!write) throw new HttpError(404, 'NOT_FOUND', 'Not found.')
        sendJson(res, 200, await write(boardId, testApply(body)))
      },
    },
  ]
}
