// SQL for the search index (packages/db/migrations/0015_board_search.sql). Nothing here decides who
// may see what: callers pass board ids that already passed the permission filter (scope.ts).

import type { SearchHitKind } from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import { HEADLINE_OPTIONS, simpleIndexText } from './query.ts'

export type EntrySource = 'canvas' | 'comment'

export interface IndexEntry {
  objectId: string
  kind: SearchHitKind
  pageId: string | null
  body: string
}

/** Rows per INSERT statement (bounded parameter arrays). */
const INSERT_CHUNK = 500
/** Longest indexed text of one object (the migration's CHECK allows 8000). */
export const CANVAS_ENTRY_CHARS = 4_000
export const COMMENT_ENTRY_CHARS = 8_000

/**
 * Replaces every entry of one source of one board (inside the caller's transaction). The english and
 * simple vectors are computed by Postgres from the text and its folded form.
 */
export async function replaceEntries(
  tx: Queryable,
  board: { id: string; workspaceId: string },
  source: EntrySource,
  entries: readonly IndexEntry[],
): Promise<void> {
  await tx.query('DELETE FROM board_search_entries WHERE board_id = $1 AND source = $2', [board.id, source])
  for (let i = 0; i < entries.length; i += INSERT_CHUNK) {
    const chunk = entries.slice(i, i + INSERT_CHUNK)
    await tx.query(
      `INSERT INTO board_search_entries (board_id, workspace_id, source, object_id, kind, page_id, body, tsv)
       SELECT $1, $2, $3, e.object_id, e.kind, e.page_id, e.body,
              to_tsvector('english', e.body) || to_tsvector('simple', e.folded)
         FROM unnest($4::text[], $5::text[], $6::text[], $7::text[], $8::text[])
              AS e(object_id, kind, page_id, body, folded)
       ON CONFLICT (board_id, source, object_id) DO NOTHING`,
      [
        board.id,
        board.workspaceId,
        source,
        chunk.map((e) => e.objectId),
        chunk.map((e) => e.kind),
        chunk.map((e) => e.pageId),
        chunk.map((e) => e.body),
        chunk.map((e) => simpleIndexText(e.body)),
      ],
    )
  }
}

/** Removes a board from the index (trashed, or gone). */
export async function purgeBoard(q: Queryable, boardId: string): Promise<void> {
  await q.query('DELETE FROM board_search_entries WHERE board_id = $1', [boardId])
  await q.query('DELETE FROM board_search_state WHERE board_id = $1', [boardId])
}

/** Removes every trashed board from the index; returns how many boards had state. */
export async function purgeTrashed(q: Queryable): Promise<number> {
  await q.query(
    `DELETE FROM board_search_entries e USING boards b WHERE b.id = e.board_id AND b.status = 'trashed'`,
  )
  const r = await q.query(
    `DELETE FROM board_search_state s USING boards b WHERE b.id = s.board_id AND b.status = 'trashed'`,
  )
  return r.rowCount
}

export interface RankedRow {
  board_id: string
  source: EntrySource
  object_id: string
  kind: SearchHitKind
  page_id: string | null
  rank: number
  /** Every match in this board (the rows returned are its best `perBoard`). */
  board_hits: number
  /** Matching boards and matches among all of `boardIds` (the same on every row). */
  total_boards: number
  total_hits: number
}

export interface TsQueries {
  simple: string
  english: string
}

const QUERY_SQL = `(to_tsquery('simple', $1) || to_tsquery('english', $2))`

/**
 * The best `boards` matching boards among `boardIds` (all of which the caller may view), best first,
 * each with its best `perBoard` matching objects (best first), its own match count, and the totals.
 * Ranked per board, so a board with hundreds of matches never crowds the other boards out.
 * Rank: cover density, normalized to 0..1 (ts_rank_cd flag 32); a board ranks by its best match.
 */
export async function rankedHits(
  q: Queryable,
  opts: {
    workspaceId: string
    boardIds: readonly string[]
    query: TsQueries
    boards: number
    perBoard: number
    /**
     * F10: the searcher is on the team. Otherwise the text of team-only comment threads is left out
     * (read from comment_threads now, so a thread made team-only a moment ago is already excluded).
     */
    team: boolean
  },
): Promise<RankedRow[]> {
  if (!opts.boardIds.length || !opts.query.simple) return []
  const r = await q.query<RankedRow>(
    `WITH m AS (
       SELECT e.board_id, e.source, e.object_id, e.kind, e.page_id,
              ts_rank_cd(e.tsv, ${QUERY_SQL}, 32)::float8 AS rank
         FROM board_search_entries e
        WHERE e.workspace_id = $3 AND e.board_id = ANY($4::text[]) AND e.tsv @@ ${QUERY_SQL}
          AND ($7::boolean OR e.source <> 'comment' OR EXISTS (
                SELECT 1 FROM comment_threads t
                 WHERE t.id = e.object_id AND t.board_id = e.board_id AND t.visibility = 'everyone'))
     ), r AS (
       SELECT m.*,
              row_number() OVER (PARTITION BY m.board_id ORDER BY m.rank DESC, m.source, m.object_id) AS n,
              count(*) OVER (PARTITION BY m.board_id) AS board_hits,
              count(*) OVER () AS total_hits
         FROM m
     ), top AS (
       SELECT r.board_id, r.rank AS best, count(*) OVER () AS total_boards
         FROM r
        WHERE r.n = 1
        ORDER BY r.rank DESC, r.board_id
        LIMIT $5
     )
     SELECT r.board_id, r.source, r.object_id, r.kind, r.page_id, r.rank,
            r.board_hits::int AS board_hits, top.total_boards::int AS total_boards,
            r.total_hits::int AS total_hits
       FROM top
       JOIN r ON r.board_id = top.board_id AND r.n <= $6
      ORDER BY top.best DESC, top.board_id, r.n`,
    [
      opts.query.simple,
      opts.query.english,
      opts.workspaceId,
      opts.boardIds,
      opts.boards,
      opts.perBoard,
      opts.team,
    ],
  )
  return r.rows
}

export interface HeadlineRow {
  i: number
  body: string
  headline: string
}

/** ts_headline snippets for the chosen hits (in `keys` order, by index). */
export async function headlines(
  q: Queryable,
  query: TsQueries,
  keys: readonly { boardId: string; source: EntrySource; objectId: string }[],
): Promise<Map<number, HeadlineRow>> {
  const out = new Map<number, HeadlineRow>()
  if (!keys.length) return out
  const r = await q.query<HeadlineRow>(
    `SELECT k.i::int AS i, e.body, ts_headline('english', e.body, ${QUERY_SQL}, $3) AS headline
       FROM unnest($4::text[], $5::text[], $6::text[]) WITH ORDINALITY AS k(board_id, source, object_id, i)
       JOIN board_search_entries e
         ON e.board_id = k.board_id AND e.source = k.source AND e.object_id = k.object_id`,
    [
      query.simple,
      query.english,
      HEADLINE_OPTIONS,
      keys.map((k) => k.boardId),
      keys.map((k) => k.source),
      keys.map((k) => k.objectId),
    ],
  )
  for (const row of r.rows) out.set(row.i - 1, row)
  return out
}
