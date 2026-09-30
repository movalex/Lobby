// The ElementRoom's own internal routes (docs/EXCALIDRAW-MIGRATION.md §2.4.6), mounted by the router
// behind the internal secret instead of the tldraw board routes (engine-switch.ts InternalRoute):
//
//   GET  /internal/boards/:bid/snapshot         → 200 LobbyElementsSnapshot (live elements and the doc); 404
//   POST /internal/boards/:bid/workshop-state   WorkshopStateBody → 204 (A2, the api's push)
//
// Mounted next to them by index.ts: O4's migration routes (convert-all, status; room/migrate/**), and with
// DRAFTROOM_TEST_HOOKS=1 the room's test-only prepare and server-write routes (test-routes.ts). The other
// test-only routes (snapshot with tombstones, lease-hook, fail-commit) are test-hooks.ts's; the room
// registers their implementation there (index.ts).
//
// The plan's other internal routes, seed, place-notes, text, asset-refs and deleted, are not the room's:
// wave 2F builds them outside it (apps/sync/src/room-internal/ on engine/excalidraw, mounted through CR
// 2F-1's extendElementRoom). They reach an open board only through the service's CR 2F-2 members:
// prepareBoard (the board opened after its conversion or roll-forward, like `existing` below) and
// serverWrite (a write queued in the room's drain; element-room.ts, server-write.ts).

import { WorkshopStateBody } from '@draftroom/contracts'
import type { InternalRoute } from '../engine-switch.ts'
import { readJson } from '../http/body.ts'
import { HttpError, sendJson } from '../http/respond.ts'
import { BOARD_ID_RE } from '../rooms.ts'
import type { ElementRoom } from './element-room.ts'

export interface RoomLookup {
  /**
   * The open room, or the board's room opened from its file (after its conversion or roll-forward, which it
   * waits for); null when the board has no file. Throws HttpError 503 when the board could not be prepared.
   */
  existing(boardId: string): Promise<ElementRoom | null>
  /** The open room only. */
  ifOpen(boardId: string): ElementRoom | null
}

function boardParam(raw: string): string {
  let id: string
  try {
    id = decodeURIComponent(raw)
  } catch {
    throw new HttpError(400, 'bad-request', 'Invalid board id.')
  }
  if (!BOARD_ID_RE.test(id)) throw new HttpError(400, 'bad-request', 'Invalid board id.')
  return id
}

export function roomRoutes(rooms: RoomLookup): InternalRoute[] {
  return [
    {
      method: 'GET',
      path: /^\/internal\/boards\/([^/]+)\/snapshot$/,
      handle: async (_req, res, [raw = '']) => {
        const room = await rooms.existing(boardParam(raw))
        if (!room) throw new HttpError(404, 'board-not-found', 'No such board.')
        sendJson(res, 200, room.liveSnapshot())
      },
    },
    {
      method: 'POST',
      path: /^\/internal\/boards\/([^/]+)\/workshop-state$/,
      handle: async (req, res, [raw = '']) => {
        const boardId = boardParam(raw)
        const body = WorkshopStateBody.safeParse(await readJson(req, 1024))
        if (!body.success) throw new HttpError(400, 'bad-request', 'Invalid workshop state.')
        rooms.ifOpen(boardId)?.setWorkshop(body.data)
        res.writeHead(204, { 'Cache-Control': 'no-store' }).end()
      },
    },
  ]
}
