// Wave W (WS3, docs/WAVE-W-CONTRACTS.md §5): which file versions a board's CANVAS shows (migration 0039 board_file_refs),
// so a file hit needs the version placed on that board, not only served there (uploaded to it or linked to it): a
// file removed from the board stops hitting at the board's next canvas reindex, and a version only in "Recently
// deleted" never hits. Read from the sync server's GET /internal/boards/:bid/asset-refs (the asset collector's source,
// files/gc.ts; no sync change): its `canvas` refs and, on the Excalidraw engine, `versionsOnly.canvas` (an image that
// names its version without file facts). Never `deleted`.
//
// The indexer refreshes it right after each canvas text reindex that changed (./indexer.ts), and once per process for
// the boards that may show a file (a board indexed before this build whose canvas has not changed since). A failure
// keeps the rows as they are (logged by the caller) and is retried by the next pass.

import type { Db } from '@draftroom/db'
import { isId } from '@draftroom/dev-assets'
import { isOpenBoardStatus } from '@draftroom/permissions'

export interface AssetRefsReader {
  assetRefs?(boardId: string): Promise<unknown>
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/**
 * The versions a sync asset-refs answer says the board's canvas shows, or null when the answer is not one to trust
 * (another board's, a wrong shape): the caller then keeps the rows it has.
 */
export function canvasVersionsOf(value: unknown, boardId: string): string[] | null {
  if (!isObject(value) || value.boardId !== boardId || typeof value.exists !== 'boolean') return null
  if (!Array.isArray(value.canvas)) return null
  const out = new Set<string>()
  for (const r of value.canvas) {
    if (!isObject(r) || !isId('ast', r.assetId) || !isId('ver', r.versionId)) return null
    out.add(r.versionId)
  }
  const only = value.versionsOnly
  if (only !== undefined) {
    if (!isObject(only) || !Array.isArray(only.canvas)) return null
    for (const v of only.canvas) {
      if (!isId('ver', v)) return null
      out.add(v)
    }
  }
  return [...out].sort()
}

export type FileRefsResult = 'refreshed' | 'gone' | 'failed'

/**
 * Re-reads the board's placed versions and replaces its rows (only versions of the board's own workspace: a version id
 * of anywhere else on its canvas names nothing here). One transaction, the board row locked first (FOR NO KEY UPDATE,
 * as the links write): two writers of one board take turns. Throws only on a database error; a sync failure or an
 * untrusted answer is 'failed' with the rows kept.
 */
export async function refreshFileRefs(
  db: Db,
  sync: AssetRefsReader,
  boardId: string,
  now: Date,
): Promise<FileRefsResult> {
  if (!sync.assetRefs) return 'failed'
  let versions: string[] | null
  try {
    versions = canvasVersionsOf(await sync.assetRefs(boardId), boardId)
  } catch {
    return 'failed'
  }
  if (!versions) return 'failed'
  const found = versions
  return db.transaction(async (tx) => {
    const b = await tx.maybeOne<{ workspace_id: string; status: string }>(
      'SELECT workspace_id, status FROM boards WHERE id = $1 FOR NO KEY UPDATE',
      [boardId],
    )
    if (!b) return 'gone'
    await tx.query('DELETE FROM board_file_refs WHERE board_id = $1', [boardId])
    if (!isOpenBoardStatus(b.status)) return 'gone'
    if (found.length)
      await tx.query(
        `INSERT INTO board_file_refs (board_id, workspace_id, version_id, refreshed_at)
         SELECT $1, $2, v.id, $4 FROM asset_versions v WHERE v.id = ANY($3::text[]) AND v.workspace_id = $2
         ON CONFLICT (board_id, version_id) DO UPDATE SET refreshed_at = EXCLUDED.refreshed_at`,
        [boardId, b.workspace_id, found, now],
      )
    return 'refreshed'
  })
}

/**
 * Boards that may show a file with text and whose rows this process has not read yet (after `afterId`, in id order):
 * open boards with a `pdf`-kind version served on them (uploaded to them or linked to them). The once-per-process
 * backfill walks them in batches.
 */
export async function boardsMaybeShowingFiles(
  db: Db,
  afterId: string,
  limit: number,
): Promise<{ id: string }[]> {
  const r = await db.query<{ id: string }>(
    `SELECT b.id FROM boards b
      WHERE b.status IN ('active', 'archived') AND b.id > $1
        AND (EXISTS (SELECT 1 FROM asset_versions v
                      WHERE v.board_id = b.id AND v.workspace_id = b.workspace_id AND v.kind = 'pdf')
          OR EXISTS (SELECT 1 FROM board_asset_links l
                       JOIN asset_versions v ON v.id = l.version_id AND v.kind = 'pdf'
                      WHERE l.board_id = b.id AND l.workspace_id = b.workspace_id))
      ORDER BY b.id
      LIMIT $2`,
    [afterId, limit],
  )
  return r.rows
}
