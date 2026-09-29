// GET /internal/boards/:bid/asset-refs on the Excalidraw engine (docs/EXCALIDRAW-MIGRATION.md §2.4.6
// "asset-refs", §5.8 "Asset GC"): which uploaded file versions a board still references, for the api's
// asset collector (apps/api/src/files/gc.ts). Read-only, the same answer shape as the tldraw route
// (http/asset-refs.ts), so the collector reads both engines:
//
//  - `canvas`: images, PDF pages and file cards on the board (an `image` element's `fileId`, D7);
//  - `deleted`: what could come back: the "Recently deleted" capture (`lb_deleted`, live and converted
//    rows), the tombstones a client's undo can still revive (`lb_elements` rows with `deleted = 1`, kept
//    14 days, §2.6), and, read-only until `drop-legacy`, the tldraw capture of a converted board
//    (`dr_deleted_records`: its file cards; its images were converted into `lb_deleted` rows);
//  - `unusedAssetRecords`: always empty (elements name their version; there are no asset records);
//  - `versionsOnly` (new, Excalidraw engine only): versions an image names by `fileId` with no
//    `customData.lobby.file` facts, so without an asset id. The collector keeps them like the others.

import type { DatabaseSync } from 'node:sqlite'
import type { InternalRoute, RoomExtensionContext } from '../engine-switch.ts'
import { type AssetRef, AssetRefScan } from '../http/asset-refs.ts'
import { sendJson } from '../http/respond.ts'
import { boardParam, hasTable, readableBoard, readBoardFile } from './board.ts'
import { fileOf, parseElement } from './elements.ts'

export interface ElementAssetRefs {
  boardId: string
  /** false: the board has no file (never opened or seeded), so it references nothing */
  exists: boolean
  canvas: AssetRef[]
  deleted: AssetRef[]
  unusedAssetRecords: AssetRef[]
  versionsOnly: { canvas: string[]; deleted: string[] }
}

/** Collects the versions named by stored element JSON. */
class ElementRefs {
  private readonly refs = new Map<string, AssetRef>()
  private readonly bare = new Set<string>()

  add(data: string): void {
    if (!data.includes('"fileId"')) return // not an image (cheap test before parsing)
    const el = parseElement(data)
    const file = el ? fileOf(el) : null
    if (!file) return
    if (file.assetId) this.refs.set(file.versionId, { assetId: file.assetId, versionId: file.versionId })
    else this.bare.add(file.versionId)
  }

  addRef(ref: AssetRef): void {
    this.refs.set(ref.versionId, ref)
  }

  result(): { refs: AssetRef[]; versionsOnly: string[] } {
    const refs = [...this.refs.values()].sort((a, b) =>
      a.assetId === b.assetId ? a.versionId.localeCompare(b.versionId) : a.assetId.localeCompare(b.assetId),
    )
    const versionsOnly = [...this.bare].filter((v) => !this.refs.has(v)).sort()
    return { refs, versionsOnly }
  }
}

export function scanAssetRefs(db: DatabaseSync, boardId: string): ElementAssetRefs {
  const canvas = new ElementRefs()
  const deleted = new ElementRefs()
  for (const r of db.prepare("SELECT deleted, data FROM lb_elements WHERE type = 'image'").all() as {
    deleted: number
    data: string
  }[])
    (r.deleted === 1 ? deleted : canvas).add(r.data)
  for (const r of db.prepare("SELECT data FROM lb_deleted WHERE type = 'image'").all() as { data: string }[])
    deleted.add(r.data)
  if (hasTable(db, 'dr_deleted_records')) {
    const legacy = new AssetRefScan()
    for (const r of db.prepare("SELECT state FROM dr_deleted_records WHERE kind = 'shape'").all() as {
      state: string
    }[])
      legacy.addDeleted(r.state)
    for (const ref of legacy.result(boardId, true).deleted) deleted.addRef(ref)
  }
  const c = canvas.result()
  const d = deleted.result()
  return {
    boardId,
    exists: true,
    canvas: c.refs,
    deleted: d.refs,
    unusedAssetRecords: [],
    versionsOnly: { canvas: c.versionsOnly, deleted: d.versionsOnly },
  }
}

export function assetRefsRoutes(ctx: RoomExtensionContext): InternalRoute[] {
  return [
    {
      method: 'GET',
      path: /^\/internal\/boards\/([^/]+)\/asset-refs$/,
      handle: async (_req, res, [raw = '']) => {
        const boardId = boardParam(raw)
        const board = await readableBoard(ctx, boardId)
        const answer: ElementAssetRefs =
          board.state === 'missing'
            ? {
                boardId,
                exists: false,
                canvas: [],
                deleted: [],
                unusedAssetRecords: [],
                versionsOnly: { canvas: [], deleted: [] },
              }
            : readBoardFile(board.path, (db) => scanAssetRefs(db, boardId))
        sendJson(res, 200, answer)
      },
    },
  ]
}
