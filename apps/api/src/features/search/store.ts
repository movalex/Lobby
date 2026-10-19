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
  // wave W (WS3): the files its canvas showed (a restored board is reindexed from scratch, refs included)
  await q.query('DELETE FROM board_file_refs WHERE board_id = $1', [boardId])
}

/** Removes every trashed board from the index; returns how many boards had state. */
export async function purgeTrashed(q: Queryable): Promise<number> {
  await q.query(
    `DELETE FROM board_search_entries e USING boards b WHERE b.id = e.board_id AND b.status = 'trashed'`,
  )
  await q.query(
    `DELETE FROM board_file_refs r USING boards b WHERE b.id = r.board_id AND b.status = 'trashed'`,
  )
  const r = await q.query(
    `DELETE FROM board_search_state s USING boards b WHERE b.id = s.board_id AND b.status = 'trashed'`,
  )
  return r.rowCount
}

export interface RankedRow {
  board_id: string
  /** wave W (WS3): 'file', a page of a file's extracted text (object_id `file:<ver>.p<page>`) */
  source: EntrySource | 'file'
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
    /**
     * Wave M (M8-2, Ask across boards): only entries of this source. Ask reads canvas text only (no comment
     * threads, whatever the asker may read of them). Absent: every source, as the search route has it.
     */
    source?: EntrySource
    /**
     * Wave W (WS3, docs/WAVE-W-CONTRACTS.md §5): also the pages of files' extracted text (FILE_HITS_CTE), at most
     * `maxPerBoard` of a board's returned hits (the rest still count in its `board_hits`). Absent (DRAFTROOM_FILE_SEARCH
     * off): the CTE is skipped and the statement is the one before wave W.
     */
    files?: { maxPerBoard: number }
  },
): Promise<RankedRow[]> {
  if (!opts.boardIds.length || !opts.query.simple) return []
  const params: unknown[] = [
    opts.query.simple,
    opts.query.english,
    opts.workspaceId,
    opts.boardIds,
    opts.boards,
    opts.perBoard,
    opts.team,
  ]
  const param = (v: unknown) => {
    params.push(v)
    return `$${params.length}`
  }
  // Only an asked-for source adds a condition (and a parameter): the search route's statement is unchanged.
  const only = opts.source === undefined ? '' : ` AND e.source = ${param(opts.source)}`
  const files = opts.files
    ? `, f AS (${FILE_HITS_CTE}), fr AS (
         SELECT f.*, row_number() OVER (PARTITION BY f.board_id ORDER BY f.rank DESC, f.object_id) AS fn FROM f
       ), u AS (
         SELECT m.*, true AS eligible FROM m
         UNION ALL
         SELECT fr.board_id, fr.source, fr.object_id, fr.kind, fr.page_id, fr.rank,
                fr.fn <= ${param(opts.files.maxPerBoard)} AS eligible
           FROM fr
       )`
    : ''
  // with files, a board's hits are ranked among its eligible ones first (a file page past its board's file share is
  // never returned, but counts); the best hit of a board is always eligible, so boards rank as before
  const from = opts.files ? 'u' : 'm'
  const order = opts.files
    ? 'u.eligible DESC, u.rank DESC, u.source, u.object_id'
    : 'm.rank DESC, m.source, m.object_id'
  const r = await q.query<RankedRow>(
    `WITH m AS (
       SELECT e.board_id, e.source, e.object_id, e.kind, e.page_id,
              ts_rank_cd(e.tsv, ${QUERY_SQL}, 32)::float8 AS rank
         FROM board_search_entries e
        WHERE e.workspace_id = $3 AND e.board_id = ANY($4::text[]) AND e.tsv @@ ${QUERY_SQL}${only}
          AND ($7::boolean OR e.source <> 'comment' OR EXISTS (
                SELECT 1 FROM comment_threads t
                 WHERE t.id = e.object_id AND t.board_id = e.board_id AND t.visibility = 'everyone'))
     )${files}, r AS (
       SELECT ${from}.*,
              row_number() OVER (PARTITION BY ${from}.board_id ORDER BY ${order}) AS n,
              count(*) OVER (PARTITION BY ${from}.board_id) AS board_hits,
              count(*) OVER () AS total_hits
         FROM ${from}
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
       JOIN r ON r.board_id = top.board_id AND r.n <= $6${opts.files ? ' AND r.eligible' : ''}
      ORDER BY top.best DESC, top.board_id, r.n`,
    params,
  )
  return r.rows
}

/**
 * Wave W (WS3, docs/WAVE-W-CONTRACTS.md §5): the file pages a search may return, as rows of rankedHits' `m` (board,
 * source 'file', object `file:<ver>.p<page>`, kind 'file', no page id, rank), over the same parameters ($1/$2 the
 * queries, $3 the workspace, $4 the boards, all of which already passed the caller's permission filter). A page counts
 * for a board only when, at this moment:
 * - its version's text is `done` (a version mid-extraction, failed or skipped has none to show);
 * - the board's CANVAS shows the version (board_file_refs, refreshed at each canvas reindex: a removed card, or a
 *   version only in "Recently deleted", never counts);
 * - the board may serve the version, by files-auth.ts's rule: the version was uploaded to that board, or the board
 *   holds a link to it (board_asset_links, the upload's board in the same workspace);
 * - and everything is of the asker's workspace.
 * Nothing of it is cached per person: a lost grant, a trashed board or a removed card count at the next query.
 */
export const FILE_HITS_CTE = `
  SELECT r.board_id, 'file'::text AS source, 'file:' || p.version_id || '.p' || p.page::text AS object_id,
         'file'::text AS kind, NULL::text AS page_id, ts_rank_cd(p.tsv, ${QUERY_SQL}, 32)::float8 AS rank
    FROM file_text_pages p
    JOIN file_text_state st ON st.version_id = p.version_id AND st.status = 'done'
    JOIN board_file_refs r ON r.version_id = p.version_id AND r.workspace_id = $3 AND r.board_id = ANY($4::text[])
    JOIN asset_versions v ON v.id = p.version_id AND v.workspace_id = $3
   WHERE p.workspace_id = $3 AND p.tsv @@ ${QUERY_SQL}
     AND (v.board_id = r.board_id OR EXISTS (
           SELECT 1 FROM board_asset_links l
             JOIN boards owner ON owner.id = v.board_id AND owner.workspace_id = l.workspace_id
            WHERE l.workspace_id = $3 AND l.board_id = r.board_id AND l.asset_id = v.asset_id AND l.version_id = v.id))`

export interface FileHeadlineRow {
  i: number
  body: string
  headline: string
  name: string
}

/** ts_headline snippets of chosen file hits, and the file's display name (in `keys` order, by index). */
export async function fileHeadlines(
  q: Queryable,
  query: TsQueries,
  workspaceId: string,
  keys: readonly { versionId: string; page: number }[],
): Promise<Map<number, FileHeadlineRow>> {
  const out = new Map<number, FileHeadlineRow>()
  if (!keys.length) return out
  const r = await q.query<FileHeadlineRow>(
    `SELECT k.i::int AS i, p.body, v.name, ts_headline('english', p.body, ${QUERY_SQL}, $3) AS headline
       FROM unnest($5::text[], $6::int[]) WITH ORDINALITY AS k(version_id, page, i)
       JOIN file_text_pages p ON p.version_id = k.version_id AND p.page = k.page AND p.workspace_id = $4
       JOIN asset_versions v ON v.id = p.version_id AND v.workspace_id = $4`,
    [
      query.simple,
      query.english,
      HEADLINE_OPTIONS,
      workspaceId,
      keys.map((k) => k.versionId),
      keys.map((k) => k.page),
    ],
  )
  for (const row of r.rows) out.set(row.i - 1, row)
  return out
}

export interface EntryKey {
  boardId: string
  source: EntrySource
  objectId: string
}

/**
 * The indexed text of the chosen entries (wave M, M8-2), by index into `keys`. An entry re-indexed away
 * between the ranking and this read is simply missing. `workspaceId` keeps the read inside the asker's
 * workspace whatever the keys say.
 */
export async function entryBodies(
  q: Queryable,
  workspaceId: string,
  keys: readonly EntryKey[],
): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  if (!keys.length) return out
  const r = await q.query<{ i: number; body: string }>(
    `SELECT k.i::int AS i, e.body
       FROM unnest($2::text[], $3::text[], $4::text[]) WITH ORDINALITY AS k(board_id, source, object_id, i)
       JOIN board_search_entries e
         ON e.board_id = k.board_id AND e.source = k.source AND e.object_id = k.object_id
      WHERE e.workspace_id = $1`,
    [workspaceId, keys.map((k) => k.boardId), keys.map((k) => k.source), keys.map((k) => k.objectId)],
  )
  for (const row of r.rows) out.set(row.i - 1, row.body)
  return out
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
