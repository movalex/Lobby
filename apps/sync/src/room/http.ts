// The ElementRoom's internal routes (docs/EXCALIDRAW-MIGRATION.md §2.4.6), mounted by the router behind
// the internal secret instead of the tldraw board routes (engine-switch.ts InternalRoute):
//
//   GET  /internal/boards/:bid/snapshot         → 200 LobbyElementsSnapshot (live elements and the doc); 404
//   POST /internal/boards/:bid/workshop-state   WorkshopStateBody → 204 (A2, the api's push)
//
// The test-only routes (snapshot with tombstones, lease-hook, fail-commit) are test-hooks.ts's; the room
// registers their implementation there (index.ts).
//
// Not built in spike B (not needed by a check): seed, place-notes, text, asset-refs, deleted.

import { WorkshopStateBody } from '@draftroom/contracts'
import type { InternalRoute } from '../engine-switch.ts'
import { readJson } from '../http/body.ts'
import { HttpError, sendJson } from '../http/respond.ts'
import { BOARD_ID_RE } from '../rooms.ts'
import type { ElementRoom } from './element-room.ts'

export interface RoomLookup {
  /** The open room, or the board's room opened from its file; null when the board has no file. */
  existing(boardId: string): ElementRoom | null
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
      handle: (_req, res, [raw = '']) => {
        const room = rooms.existing(boardParam(raw))
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
