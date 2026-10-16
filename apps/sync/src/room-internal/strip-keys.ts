// The strip-keys maintenance route (wave N, N2-5; @draftroom/contracts sync-internal.ts):
//
//   POST /internal/maintenance/strip-keys  StripKeysRequest {prefix: 'react:'} → 200 StripKeysAnswer
//
// Internal secret only (the router's check, like every internal route), refused while maintenance is on (a board
// write). The rollback step for reactions: a sync below wave N runs `checkElement` on every element a push touches
// (merge.ts) and its key registry has no `react:` spec, so it refuses every edit of a reacted note INVALID, every
// undo of the delete of one, and every "Recently deleted" restore of one. The documented rollback below wave N is
// DRAFTROOM_REACTIONS=off (restart), this route, then the older sync (docs/DEPLOY.md). Wave T's rollback below 14 is
// the same for each planning class (`card:`, `sb:`, `kanban`, `timeline`) after DRAFTROOM_PLANNING=off.
//
// Every board file of this server, one at a time:
//  - read first, read-only (room-internal/board.ts `readBoardFile`): a board none of whose elements (live or
//    tombstones) or "Recently deleted" rows holds a key with the prefix is never opened for a write, so it is not
//    rewritten (and a second run is a no-op);
//  - otherwise ONE server write in its room (board.ts `writeBoard` → the room's `serverWrite`, CR 2F-2): every
//    stored element with such a key gets it removed (an emptied lobby, then an emptied customData, left out), its
//    version raised and a new nonce, and nothing else of it changes; the room checks it to the server-write
//    contract, stamps the `c:<key>` group clocks and broadcasts it in a normal commit, so every open tab converges
//    (a reader below 13 gets each live one as the `c` op of the stored element, a tombstone redacted). The
//    "Recently deleted" rows' copies lose the keys in the same transaction (lb_deleted, written only by this sync).
//    Only lb_* tables are written; never the tldraw tables nor dr_deleted_*.
// It logs counts only, and a board that failed by id with its error code (never board content). Only this sync
// process writes the board files; a board file in another state (tldraw only, unknown) cannot hold such a key.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WireElement } from '@draftroom/canvas-schema/elements'
import {
  STRIP_KEYS_PREFIXES,
  STRIP_KEYS_ROUTE,
  type StripKeysAnswer,
  StripKeysRequest,
} from '@draftroom/contracts'
import type {
  InternalRoute,
  RoomExtensionContext,
  ServerWriteChange,
  ServerWriteTx,
} from '../engine-switch.ts'
import { readJson } from '../http/body.ts'
import { HttpError, sendJson } from '../http/respond.ts'
import { boardFileState } from '../room/migrate/index.ts'
import { boardFileIds } from '../rooms.ts'
import { boardPath, hasTable, readBoardFile, writeBoard } from './board.ts'
import { type El, parseElement, withoutLobbyKeys } from './elements.ts'

const BODY_LIMIT_BYTES = 1024
const ROUTE_RE = new RegExp(`^${STRIP_KEYS_ROUTE.replace(/\//g, '\\/')}$`)

const nonce = () => Math.floor(Math.random() * 2 ** 31)

/** The JSON a row holds when one of its `customData.lobby` keys starts with `prefix` (a filter; parsed to be sure). */
const needleOf = (prefix: string) => JSON.stringify(prefix).slice(0, -1)

/** How many keys with `prefix` a row's element holds (0 when it does not parse). */
const keysIn = (data: string, prefix: string): number => {
  const el = parseElement(data)
  return el ? withoutLobbyKeys(el, prefix).removed : 0
}

/** The board's keys with `prefix`, read-only: in its stored elements and in its "Recently deleted" rows. */
function countKeys(path: string, prefix: string): number {
  const needle = needleOf(prefix)
  return readBoardFile(path, (db) => {
    let n = 0
    for (const r of db.prepare('SELECT data FROM lb_elements WHERE instr(data, ?) > 0').all(needle) as {
      data: string
    }[])
      n += keysIn(r.data, prefix)
    if (hasTable(db, 'lb_deleted'))
      for (const r of db.prepare('SELECT data FROM lb_deleted WHERE instr(data, ?) > 0').all(needle) as {
        data: string
      }[])
        n += keysIn(r.data, prefix)
    return n
  })
}

/** What one board's strip wrote. */
interface BoardStrip {
  readonly elements: number
  readonly keys: number
  readonly deletedRows: number
}

/** The strip of one board as a server write (synchronous, inside the room's drain). */
export function applyStripKeys(tx: ServerWriteTx, prefix: string) {
  const { store } = tx
  const needle = needleOf(prefix)
  const changed: ServerWriteChange[] = []
  let keys = 0
  for (const id of store.elementIdsWith(needle)) {
    const row = store.get(id)
    if (!row) continue
    const { el, removed } = withoutLobbyKeys(row.el as unknown as El, prefix)
    if (!removed) continue
    const after = {
      ...el,
      version: row.el.version + 1,
      versionNonce: nonce(),
      updated: tx.now,
    } as unknown as WireElement
    store.upsert({
      el: after,
      clock: tx.clock,
      gclock: row.gclock,
      deletedClock: row.deletedClock,
      deletedAt: row.deletedAt,
    })
    changed.push({ before: row.el, after })
    keys += removed
  }
  let deletedRows = 0
  for (const r of store.deletedRowsWith(needle)) {
    const el = parseElement(r.data)
    if (!el) continue
    const { el: next, removed } = withoutLobbyKeys(el, prefix)
    if (!removed) continue
    store.rewriteDeletedData(r.seq, JSON.stringify(next))
    deletedRows++
    keys += removed
  }
  const result: BoardStrip = { elements: changed.length, keys, deletedRows }
  return { changed, doc: {}, result }
}

/** Strips every key with `prefix` from every board file of this server, one board at a time. */
export async function stripKeys(ctx: RoomExtensionContext, prefix: string): Promise<StripKeysAnswer> {
  const answer = { boards: 0, rewritten: 0, elements: 0, keys: 0, failed: 0 }
  for (const boardId of boardFileIds(ctx.deps.dataDir)) {
    answer.boards++
    try {
      const path = boardPath(ctx, boardId)
      const state = boardFileState(path)
      if (state !== 'element' && state !== 'converted' && state !== 'rollforward-needed') continue
      if (countKeys(path, prefix) === 0) continue
      const done = await writeBoard(ctx, boardId, (tx) => applyStripKeys(tx, prefix))
      if (done.elements || done.deletedRows) answer.rewritten++
      answer.elements += done.elements
      answer.keys += done.keys
    } catch (e) {
      answer.failed++
      const code = e instanceof HttpError ? e.code : ((e as Error)?.name ?? 'error')
      ctx.deps.log('[strip-keys] board failed', boardId, code)
    }
  }
  ctx.deps.log(
    `[strip-keys] prefix=${prefix} boards=${answer.boards} rewritten=${answer.rewritten} elements=${answer.elements} keys=${answer.keys} failed=${answer.failed}`,
  )
  return answer
}

async function handleStripKeys(ctx: RoomExtensionContext, req: IncomingMessage, res: ServerResponse) {
  const parsed = StripKeysRequest.safeParse(await readJson(req, BODY_LIMIT_BYTES))
  if (!parsed.success)
    throw new HttpError(
      400,
      'bad-request',
      `Expected {prefix: ${STRIP_KEYS_PREFIXES.map((p) => `'${p}'`).join(' | ')}} (packages/contracts sync-internal.ts).`,
    )
  sendJson(res, 200, await stripKeys(ctx, parsed.data.prefix))
}

export function stripKeysRoutes(ctx: RoomExtensionContext): InternalRoute[] {
  return [{ method: 'POST', path: ROUTE_RE, handle: (req, res) => handleStripKeys(ctx, req, res) }]
}
