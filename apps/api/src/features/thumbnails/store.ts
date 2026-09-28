// board_thumbnails rows (0011) and their blob keys. Keys are built from validated ids only, never from
// request input, so they cannot leave the `thumbnails/` prefix.

import { randomBytes } from 'node:crypto'
import { assertValidBlobKey } from '@draftroom/blob-store'
import {
  type BoardThumbnail,
  THUMBNAIL_VERSION_PATTERN,
  type ThumbnailMimeType,
  WorkspaceId,
} from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import { isBoardId } from '../../access.ts'

export interface ThumbnailRow {
  board_id: string
  workspace_id: string
  version: string
  blob_key: string
  mime_type: ThumbnailMimeType
  width: number
  height: number
  bytes: number
  updated_at: Date
}

const COLUMNS = 'board_id, workspace_id, version, blob_key, mime_type, width, height, bytes, updated_at'

export const newThumbnailVersion = () => randomBytes(12).toString('hex')

/** `thumbnails/<workspaceId>/<boardId>/<version>` (the CHECK in 0011 holds the same rule). */
export function thumbnailKey(workspaceId: string, boardId: string, version: string): string {
  if (!WorkspaceId.safeParse(workspaceId).success || !isBoardId(boardId))
    throw new Error('invalid thumbnail owner')
  if (!THUMBNAIL_VERSION_PATTERN.test(version)) throw new Error('invalid thumbnail version')
  const key = `thumbnails/${workspaceId}/${boardId}/${version}`
  assertValidBlobKey(key)
  return key
}

export function toThumbnail(r: ThumbnailRow): BoardThumbnail {
  return {
    version: r.version,
    mimeType: r.mime_type,
    width: r.width,
    height: r.height,
    bytes: r.bytes,
    updatedAt: r.updated_at.toISOString(),
  }
}

export async function loadThumbnail(
  q: Queryable,
  boardId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<ThumbnailRow | null> {
  return q.maybeOne<ThumbnailRow>(
    `SELECT ${COLUMNS} FROM board_thumbnails WHERE board_id = $1${opts.forUpdate ? ' FOR UPDATE' : ''}`,
    [boardId],
  )
}

/** Current versions for many boards (board lists); boards without a thumbnail are absent. */
export async function thumbnailVersions(
  q: Queryable,
  boardIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!boardIds.length) return out
  const rows = await q.query<{ board_id: string; version: string }>(
    'SELECT board_id, version FROM board_thumbnails WHERE board_id = ANY($1::text[])',
    [boardIds],
  )
  for (const r of rows.rows) out.set(r.board_id, r.version)
  return out
}

export interface NewThumbnail {
  boardId: string
  workspaceId: string
  version: string
  blobKey: string
  mimeType: ThumbnailMimeType
  width: number
  height: number
  bytes: number
  sha256: string
  userId: string
  at: Date
}

/** Inserts or replaces the board's row; returns the new row. */
export async function upsertThumbnail(q: Queryable, t: NewThumbnail): Promise<ThumbnailRow> {
  return q.one<ThumbnailRow>(
    `INSERT INTO board_thumbnails
       (board_id, workspace_id, version, blob_key, mime_type, width, height, bytes, sha256, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (board_id) DO UPDATE SET
       version = EXCLUDED.version, blob_key = EXCLUDED.blob_key, mime_type = EXCLUDED.mime_type,
       width = EXCLUDED.width, height = EXCLUDED.height, bytes = EXCLUDED.bytes,
       sha256 = EXCLUDED.sha256, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
     RETURNING ${COLUMNS}`,
    [
      t.boardId,
      t.workspaceId,
      t.version,
      t.blobKey,
      t.mimeType,
      t.width,
      t.height,
      t.bytes,
      t.sha256,
      t.userId,
      t.at,
    ],
  )
}
