// OWNER: WS7 (wave N, N7-2 and N7-4). SQL for links between boards (packages/db/migrations/0032_board_links.sql).
//
// - board_links: derived data, like the search index. The indexer (../search/indexer.ts) replaces a board's rows
//   from the sync's read-only text route (`?links=1`) in one transaction, and records the scan in
//   board_link_scans. Nothing here decides access: GET backlinks filters the from-boards by the caller's
//   permissions at query time (./index.ts, with @draftroom/permissions).
// - frame names for card faces come from the search index (a frame's indexed name), read only for boards the
//   caller was already allowed to view.
// Nothing here logs titles, names or links.

import { BOARD_TEXT_LINKS_MAX, type BoardTextLink } from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import type { BoardRole, BoardStatus, BoardVisibility } from '@draftroom/permissions'

/**
 * Replaces every link FROM `fromBoard` with `links` (inside the caller's transaction) and records the scan at
 * `clock`. A link to the board itself is not indexed (backlinks never name the board itself), nor one to a board
 * that does not exist (the foreign key; a board made later is linked at the next scan). At most
 * BOARD_TEXT_LINKS_MAX rows, one per (element, target). Returns how many rows it wrote.
 */
export async function replaceBoardLinks(
  tx: Queryable,
  fromBoard: string,
  links: readonly BoardTextLink[],
  clock: number,
  at: Date,
): Promise<number> {
  await tx.query('DELETE FROM board_links WHERE from_board = $1', [fromBoard])
  const seen = new Set<string>()
  const rows: BoardTextLink[] = []
  for (const l of links) {
    if (l.to === fromBoard) continue
    const key = `${l.el}\u0000${l.to}`
    if (seen.has(key)) continue
    seen.add(key)
    rows.push(l)
    if (rows.length >= BOARD_TEXT_LINKS_MAX) break
  }
  let written = 0
  if (rows.length) {
    // only targets that exist (JOIN boards): a link to a missing board would break the foreign key
    const r = await tx.query(
      `INSERT INTO board_links (from_board, from_element, to_board, to_element, indexed_at)
       SELECT $1, u.from_element, u.to_board, u.to_element, $5
         FROM unnest($2::text[], $3::text[], $4::text[]) AS u(from_element, to_board, to_element)
         JOIN boards b ON b.id = u.to_board
       ON CONFLICT (from_board, from_element, to_board) DO NOTHING`,
      [fromBoard, rows.map((l) => l.el), rows.map((l) => l.to), rows.map((l) => l.toEl ?? null), at],
    )
    written = r.rowCount
  }
  await tx.query(
    `INSERT INTO board_link_scans (board_id, links_clock, scanned_at) VALUES ($1, $2, $3)
     ON CONFLICT (board_id) DO UPDATE SET links_clock = EXCLUDED.links_clock, scanned_at = EXCLUDED.scanned_at`,
    [fromBoard, Math.max(0, Math.trunc(clock)), at],
  )
  return written
}

/** One board that links to the asked board, with what decides whether the caller may see it. */
export interface BacklinkCandidate {
  id: string
  title: string
  visibility: BoardVisibility
  status: BoardStatus
  board_grant: BoardRole | null
  /** the first linking element of that board (by id) */
  element_id: string
}

/** At most this many candidates are read before the permission filter (each answer is at most 50). */
export const BACKLINK_CANDIDATES_MAX = 500

/**
 * The boards of `workspaceId` that link to `toBoard` (never `toBoard` itself, never a trashed one), narrowed by
 * SQL like search's scope (scope.ts: owners and admins every board, members their grants and the workspace's
 * shared boards, guests their grants only). The caller decides each row with @draftroom/permissions. Most
 * recently changed first.
 */
export async function backlinkCandidates(
  q: Queryable,
  opts: { toBoard: string; workspaceId: string; userId: string; allBoards: boolean; member: boolean },
): Promise<BacklinkCandidate[]> {
  const r = await q.query<BacklinkCandidate>(
    `SELECT b.id, b.title, b.visibility, b.status, bm.role AS board_grant, l.element_id
       FROM (SELECT from_board, min(from_element) AS element_id
               FROM board_links
              WHERE to_board = $1 AND from_board <> $1
              GROUP BY from_board) l
       JOIN boards b ON b.id = l.from_board
       LEFT JOIN board_members bm ON bm.board_id = b.id AND bm.user_id = $3
      WHERE b.workspace_id = $2 AND b.status <> 'trashed'
        AND ($4::boolean OR bm.role IS NOT NULL OR ($5::boolean AND b.visibility <> 'private'))
      ORDER BY b.updated_at DESC, b.id
      LIMIT $6`,
    [opts.toBoard, opts.workspaceId, opts.userId, opts.allBoards, opts.member, BACKLINK_CANDIDATES_MAX],
  )
  return r.rows
}

/**
 * The indexed names of frames, for card faces (`boardId` → element id → name). Call it ONLY with boards the
 * caller may view: the names are board content. A frame the index does not hold (not indexed yet, not a frame,
 * deleted) is simply absent.
 */
export async function frameNames(
  q: Queryable,
  pairs: readonly { boardId: string; elementId: string }[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!pairs.length) return out
  const r = await q.query<{ board_id: string; object_id: string; body: string }>(
    `SELECT e.board_id, e.object_id, e.body
       FROM unnest($1::text[], $2::text[]) AS k(board_id, object_id)
       JOIN board_search_entries e
         ON e.board_id = k.board_id AND e.source = 'canvas' AND e.object_id = k.object_id AND e.kind = 'frame'`,
    [pairs.map((p) => p.boardId), pairs.map((p) => `shape:${p.elementId}`)],
  )
  for (const row of r.rows) out.set(`${row.board_id}\u0000${row.object_id.slice('shape:'.length)}`, row.body)
  return out
}
