// Keeps the search index current (docs/WAVE4-CONTRACTS.md "search").
//
// Two parts per board, refreshed independently:
// - canvas text, fetched from the sync server (GET /internal/boards/:bid/text). A board is stale when
//   boards.updated_at moved past what was indexed: the sync "touch" path moves it after canvas writes
//   (at most once a minute per board, the first write at once). A board changed in the last couple of
//   minutes may still have a write waiting for its throttled report, so a search re-checks those with
//   the indexed document clock (`since`), which costs the sync server one integer read when nothing
//   changed.
// - comment text, read from Postgres. Every comment write touches its thread's updated_at.
//
// The source value (updated_at, or the newest thread time) is always read BEFORE the text, so a change
// that lands in between leaves the board stale for the next round instead of being missed.
//
// Who drives it: a background pass (bounded batch, least recently indexed first, trashed boards swept
// out), and each search, which refreshes a bounded number of the stale boards in its own scope and
// waits a bounded time for them. Refreshes of one board never overlap (in-process; one API instance,
// docs/DEPLOY.md). Failures to reach the sync server back off per board (15 s doubling, at most 30 min).
// Nothing here logs board text.
//
// Wave N (WS7, N7-4): links between boards ride on the canvas refresh. Every text request asks for them
// (`?links=1`); a changed answer that carries `links` replaces the board's board_links rows and records its
// board_link_scans row, in one transaction of their own right after the text's, which also moves the board's
// canvas source time (the text's transaction leaves it behind for such an answer). A failure there never fails the
// search index: it is logged, and the board stays stale with the usual failure backoff, so a later refresh fetches
// it again and retries. A slower process's older answer never replaces a newer one (replaceBoardLinks). An answer
// without `links` (a sync older than wave N ignores the parameter), an unchanged one, or one whose links do not
// parse keeps the rows as they are. A one-time backfill then fetches,
// without `since`, the boards that were indexed before but never had their links scanned (the `unchanged`
// short-cut would skip them forever), a batch per pass: it pauses while the sync answers without links (an older
// sync: retried every LINKS_BACKFILL_PAUSE_MS) and, once no such board is left, never runs again in this process.

import { FILE_CARD_TYPE } from '@draftroom/canvas-schema'
import {
  type BoardTextLink,
  BoardTextLinks,
  rewriteMentionTokens,
  SEARCH_CANVAS_TEXT_BYTES,
  SEARCH_COMMENT_TEXT_BYTES,
  type SearchHitKind,
} from '@draftroom/contracts'
import type { Db, Queryable } from '@draftroom/db'
import { isOpenBoardStatus } from '@draftroom/permissions'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { SyncInternalClient } from '../../sync-internal.ts'
import { replaceBoardLinks } from '../board-links/store.ts'
import { boardsMaybeShowingFiles, type FileRefsResult } from './file-refs.ts'
import { cleanIndexText } from './query.ts'
import { freshness, type ScopedBoard } from './scope.ts'
import {
  CANVAS_ENTRY_CHARS,
  COMMENT_ENTRY_CHARS,
  type IndexEntry,
  purgeBoard,
  purgeTrashed,
  replaceEntries,
} from './store.ts'

export interface SearchSettings {
  /** Background pass period. */
  intervalMs: number
  /** After a pass that used its whole batch (a backlog), the next one starts after this. */
  backlogIntervalMs: number
  /** Boards per background pass. */
  batch: number
  /** Stale boards whose canvas text one search refreshes itself (the rest wait for the pass). */
  onDemandCanvas: number
  /** Boards whose comment text one search refreshes itself (Postgres only, cheap). */
  onDemandComments: number
  /** How long a search waits for its own refreshes before answering with what the index has. */
  waitMs: number
  /** "Changed very recently" (a throttled canvas report may be pending): sync reports ≤ 1/min. */
  recentMs: number
  /**
   * A recently changed board is not re-checked more often than this. 0 by default: the re-check is
   * one integer read on the sync server when nothing changed (an open room; a closed one is opened
   * once and stays open while idle-eviction waits), concurrent re-checks of a board share one call,
   * and a search re-checks at most `onDemandCanvas` boards. A person who edits and then searches at
   * once finds the edit.
   */
  recheckMs: number
}

/** Tests lower or raise these before creating the app (like guestSweepSettings). */
export const searchSettings: SearchSettings = {
  intervalMs: 15_000,
  backlogIntervalMs: 2_000,
  batch: 8,
  onDemandCanvas: 4,
  onDemandComments: 25,
  waitMs: 2_500,
  recentMs: 120_000,
  recheckMs: 0,
}

/** Comments read per board at most (newest threads first); beyond it the board is `truncated`. */
const MAX_COMMENTS_READ = 4_000
const RETRY_BASE_S = 15
const RETRY_MAX_S = 30 * 60
/** How long closing the app waits for running refreshes. */
const CLOSE_WAIT_MS = 3_000
/** Wave W (review m2): the first retry of a failed refs refresh, doubling per failure up to the max. */
export const REFS_RETRY_BASE_MS = 60_000
export const REFS_RETRY_MAX_MS = 30 * 60_000
/** N7-4: while the sync answers without `links` (older than wave N), the links backfill waits this long. */
export const LINKS_BACKFILL_PAUSE_MS = 10 * 60_000

const KIND_OF_TYPE: Readonly<Record<string, SearchHitKind>> = {
  note: 'note',
  text: 'text',
  geo: 'shape',
  arrow: 'arrow',
  frame: 'frame',
  [FILE_CARD_TYPE]: 'file',
  image: 'image',
  video: 'video',
}

// What the sync server answers (apps/sync/src/http/board-text.ts), checked before use.
const BoardTextEntry = z.object({
  id: z.string().regex(/^shape:[\x21-\x7e]{1,200}$/),
  type: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
  pageId: z.string().regex(/^page:[\x21-\x7e]{1,200}$/),
  text: z
    .string()
    .min(1)
    .max(CANVAS_ENTRY_CHARS * 2),
})
const BoardTextAnswer = z.discriminatedUnion('unchanged', [
  z.object({ boardId: z.string(), clock: z.number().int().min(0), unchanged: z.literal(true) }),
  z.object({
    boardId: z.string(),
    clock: z.number().int().min(0),
    unchanged: z.literal(false),
    truncated: z.boolean(),
    bytes: z.number().int().min(0),
    entries: z.array(BoardTextEntry).max(10_000),
    // N7-4: checked on its own (linksOf), so a links field this build cannot read never fails the text
    links: z.unknown().optional(),
  }),
])
type BoardTextAnswer = z.infer<typeof BoardTextAnswer>

/**
 * The links of a changed answer: the list, or null to keep the indexed rows (an older sync sent none; or they do
 * not parse, which a sync of this wave never sends).
 */
export function linksOf(answer: Extract<BoardTextAnswer, { unchanged: false }>): BoardTextLink[] | null {
  if (answer.links === undefined) return null
  const parsed = BoardTextLinks.safeParse(answer.links)
  return parsed.success ? parsed.data : null
}

export type RefreshResult = 'indexed' | 'unchanged' | 'gone' | 'failed'

export interface PassResult {
  canvas: number
  comments: number
  purged: number
  /** Boards the pass looked at (a full batch means there may be more). */
  looked: number
  /** N7-4: boards the links backfill fetched in this pass (a full batch means there may be more). */
  linksBackfill: number
  /** Wave W (WS3): boards whose file refs this pass read (a full batch means there may be more). */
  fileRefs: number
}

interface Log {
  warn(obj: object, msg: string): void
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    t.unref?.()
  })

/** Canvas entries from a sync answer, capped again here (the sync server is not the authority on caps). */
export function canvasEntries(answer: Extract<BoardTextAnswer, { unchanged: false }>): {
  entries: IndexEntry[]
  bytes: number
  truncated: boolean
} {
  const entries: IndexEntry[] = []
  const seen = new Set<string>()
  let bytes = 0
  let truncated = answer.truncated
  for (const e of answer.entries) {
    if (seen.has(e.id)) continue
    const body = cleanIndexText(e.text, CANVAS_ENTRY_CHARS)
    if (!body) continue
    const size = Buffer.byteLength(body, 'utf8')
    if (bytes + size > SEARCH_CANVAS_TEXT_BYTES) {
      truncated = true
      break
    }
    seen.add(e.id)
    bytes += size
    entries.push({ objectId: e.id, kind: KIND_OF_TYPE[e.type] ?? 'other', pageId: e.pageId, body })
  }
  return { entries, bytes, truncated }
}

export class SearchIndexer {
  private readonly db: Db
  private readonly sync: SyncInternalClient
  private readonly now: () => Date
  private readonly log: Log
  private readonly settings: SearchSettings
  private readonly inflight = new Map<string, Promise<RefreshResult>>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private pass: Promise<PassResult> | null = null
  private stopped = false
  /** N7-4: whether the last changed text answer carried `links` (null: none seen yet). */
  private syncLinks: boolean | null = null
  /** N7-4: the one-time links backfill found nothing left to do (it never runs again in this process). */
  private linksBackfillDone = false
  /** N7-4: the backfill waits until then (the sync answered without links: older than wave N). */
  private linksBackfillPausedUntil = 0
  /** Wave W (WS3): refreshes a board's board_file_refs (./file-refs.ts); absent while file search is off. */
  private readonly fileRefs: ((boardId: string) => Promise<FileRefsResult>) | null
  /** Wave W: boards whose refs refresh failed: how often in a row, and when a pass may retry them (review m2). */
  private readonly refsRetry = new Map<string, { failures: number; dueAt: number }>()
  /** Wave W: boards with a refs refresh in flight; true once another was asked for meanwhile (review m1). */
  private readonly refsDirty = new Map<string, boolean>()
  /** Wave W: the once-per-process walk over the boards that may show a file (its last board id; null once done). */
  private refsWalkAfter: string | null = ''

  constructor(opts: {
    db: Db
    sync: SyncInternalClient
    now: () => Date
    log: Log
    settings: SearchSettings
    fileRefs?: (boardId: string) => Promise<FileRefsResult>
  }) {
    this.db = opts.db
    this.sync = opts.sync
    this.now = opts.now
    this.log = opts.log
    this.settings = opts.settings
    this.fileRefs = opts.fileRefs ?? null
  }

  /**
   * Wave W (WS3): re-reads which files the board's canvas shows, after its canvas text changed (so a removed card stops
   * hitting with the same reindex). Never throws: a failure is logged (the board id only), keeps the rows, and the
   * board is retried by the next pass.
   */
  refreshFileRefs(boardId: string): Promise<RefreshResult> {
    const refresh = this.fileRefs
    if (!refresh) return Promise.resolve('unchanged')
    // Review m1: a refresh asked for while one is in flight must not join it (that one may have read the canvas before
    // the change the caller saw, and would be the last write). It marks the board dirty instead; the running loop
    // reads again once its read is written, and every caller gets the answer of a read that began after its call.
    const key = `files:${boardId}`
    if (this.refsDirty.has(boardId)) {
      this.refsDirty.set(boardId, true)
      return this.inflight.get(key) as Promise<RefreshResult>
    }
    this.refsDirty.set(boardId, false)
    const p = (async (): Promise<RefreshResult> => {
      let out: RefreshResult = 'unchanged'
      try {
        do {
          this.refsDirty.set(boardId, false)
          let r: FileRefsResult
          try {
            r = await refresh(boardId)
          } catch (e) {
            this.warn(e, 'search could not index the files of a board', boardId)
            r = 'failed'
          }
          if (r === 'failed') this.refsFailed(boardId)
          else this.refsRetry.delete(boardId)
          out = r === 'refreshed' ? 'indexed' : r
        } while (this.refsDirty.get(boardId) === true && !this.stopped)
      } finally {
        this.refsDirty.delete(boardId)
        this.inflight.delete(key)
      }
      return out
    })()
    this.inflight.set(key, p)
    return p
  }

  /**
   * Review m2: a board whose refresh failed is retried by the passes with a backoff (REFS_RETRY_BASE_MS doubling per
   * failure, at most REFS_RETRY_MAX_MS), so a sync outage or an answer it does not trust costs one read per board per
   * backoff, not one per pass.
   */
  private refsFailed(boardId: string): void {
    const failures = (this.refsRetry.get(boardId)?.failures ?? 0) + 1
    const wait = Math.min(REFS_RETRY_MAX_MS, REFS_RETRY_BASE_MS * 2 ** (failures - 1))
    this.refsRetry.set(boardId, { failures, dueAt: this.now().getTime() + wait })
  }

  /**
   * Wave W: the refs a pass refreshes: the boards whose refresh failed, then (once per process) the boards that may
   * show a file, in id order, a batch per pass, whose rows were written before this process (or never). Returns how
   * many boards it read.
   */
  private async backfillFileRefs(): Promise<number> {
    if (!this.fileRefs || this.stopped) return 0
    const at = this.now().getTime()
    const boards = [...this.refsRetry]
      .filter(([, r]) => r.dueAt <= at)
      .map(([id]) => id)
      .slice(0, this.settings.batch)
    if (boards.length < this.settings.batch && this.refsWalkAfter !== null) {
      const next = await boardsMaybeShowingFiles(
        this.db,
        this.refsWalkAfter,
        this.settings.batch - boards.length,
      )
      if (next.length < this.settings.batch - boards.length) this.refsWalkAfter = null
      else this.refsWalkAfter = next.at(-1)?.id ?? null
      // a board waiting out its retry backoff is not read early by the walk
      for (const b of next) if (!boards.includes(b.id) && !this.refsRetry.has(b.id)) boards.push(b.id)
    }
    let read = 0
    for (const id of boards) {
      if (this.stopped) break
      await this.refreshFileRefs(id)
      read++
    }
    return read
  }

  /** Wave W (tests): whether the once-per-process walk over the boards that may show a file has finished. */
  fileRefsWalkFinished(): boolean {
    return this.refsWalkAfter === null && this.refsRetry.size === 0
  }

  /** Background passes while the app runs; the last one (and every refresh) finishes before close. */
  start(app: FastifyInstance): void {
    app.addHook('onReady', async () => {
      this.stopped = false
      this.schedule(this.settings.intervalMs)
    })
    app.addHook('onClose', async () => {
      this.stopped = true
      if (this.timer) clearTimeout(this.timer)
      this.timer = null
      // The database closes after this hook. A refresh still waiting on the sync server after a few
      // seconds is abandoned (its write fails and is logged): shutdown never waits on another service.
      await Promise.race([this.idle(), sleep(CLOSE_WAIT_MS)])
    })
  }

  private schedule(ms: number) {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.runPass()
        .then(
          (r) =>
            r.looked >= this.settings.batch ||
            r.linksBackfill >= this.settings.batch ||
            r.fileRefs >= this.settings.batch,
        )
        .catch((e: unknown) => {
          this.warn(e, 'search index pass failed')
          return false
        })
        .then((backlog) =>
          this.schedule(backlog ? this.settings.backlogIntervalMs : this.settings.intervalMs),
        )
    }, ms)
    this.timer.unref?.()
  }

  /** Resolves once no pass and no refresh is running (tests; shutdown). */
  async idle(): Promise<void> {
    while (this.pass || this.inflight.size) {
      await Promise.allSettled([this.pass, ...this.inflight.values()])
    }
  }

  private warn(err: unknown, msg: string, boardId?: string) {
    const e = err as { name?: unknown; message?: unknown } | null
    this.log.warn({ err: { name: e?.name, message: e?.message }, ...(boardId ? { boardId } : {}) }, msg)
  }

  private dedupe(key: string, run: () => Promise<RefreshResult>): Promise<RefreshResult> {
    const running = this.inflight.get(key)
    if (running) return running
    const p = run().finally(() => this.inflight.delete(key))
    this.inflight.set(key, p)
    return p
  }

  /** Re-reads a board's canvas text (with `since`: only if its document clock moved). */
  refreshCanvas(boardId: string, opts: { since?: number | null } = {}): Promise<RefreshResult> {
    return this.dedupe(`canvas:${boardId}`, () => this.canvas(boardId, opts.since ?? null))
  }

  /** Re-reads a board's comment threads. */
  refreshComments(boardId: string): Promise<RefreshResult> {
    return this.dedupe(`comments:${boardId}`, () => this.comments(boardId))
  }

  /** Drops a board from the index now (it was trashed); never throws. */
  async purge(boardId: string): Promise<void> {
    try {
      await purgeBoard(this.db, boardId)
    } catch (e) {
      this.warn(e, 'search index purge failed', boardId)
    }
  }

  private async boardRow(q: Queryable, boardId: string) {
    return q.maybeOne<{ workspace_id: string; status: string; updated_at: Date }>(
      'SELECT workspace_id, status, updated_at FROM boards WHERE id = $1',
      [boardId],
    )
  }

  /** In the write transaction: the board still exists and is not trashed (else it leaves the index). */
  private async stillIndexable(tx: Queryable, boardId: string): Promise<boolean> {
    // FOR SHARE: a concurrent trash waits for this transaction, then its purge runs after it.
    const cur = await tx.maybeOne<{ status: string }>('SELECT status FROM boards WHERE id = $1 FOR SHARE', [
      boardId,
    ])
    if (cur && isOpenBoardStatus(cur.status)) return true
    if (cur) await purgeBoard(tx, boardId)
    return false
  }

  private async canvas(boardId: string, since: number | null): Promise<RefreshResult> {
    const row = await this.boardRow(this.db, boardId)
    if (!row) return 'gone'
    if (!isOpenBoardStatus(row.status)) {
      await purgeBoard(this.db, boardId)
      return 'gone'
    }
    const sourceAt = row.updated_at // read BEFORE the text (see the top of this file)
    const askedAt = this.now()
    let answer: BoardTextAnswer
    try {
      if (!this.sync.boardText) throw new Error('the sync client cannot read board text')
      const raw = await this.sync.boardText(boardId, {
        ...(since === null ? {} : { since }),
        maxBytes: SEARCH_CANVAS_TEXT_BYTES,
        links: true,
      })
      answer = BoardTextAnswer.parse(raw)
      if (answer.boardId !== boardId) throw new Error('the sync server answered for another board')
    } catch (e) {
      this.warn(e, 'search could not read board text', boardId)
      await this.recordFailure(boardId, row.workspace_id).catch((err: unknown) =>
        this.warn(err, 'search could not record a failure', boardId),
      )
      return 'failed'
    }
    const text = answer.unchanged ? null : canvasEntries(answer)
    const links = answer.unchanged ? null : linksOf(answer)
    if (!answer.unchanged) this.syncLinks = answer.links !== undefined
    // N7-4: links to write after the text: until they are written (writeLinks), the board's canvas source time and
    // its failure backoff stay where they were, so a failed or interrupted links write leaves the board stale for
    // the next refresh (and a failure that persists backs off)
    const linksPending = text !== null && links !== null
    const at = this.now()
    const result = await this.db.transaction(async (tx): Promise<RefreshResult> => {
      if (!(await this.stillIndexable(tx, boardId))) return 'gone'
      if (text)
        await replaceEntries(tx, { id: boardId, workspaceId: row.workspace_id }, 'canvas', text.entries)
      await tx.query(
        `INSERT INTO board_search_state
           (board_id, workspace_id, canvas_source_at, canvas_clock, canvas_indexed_at, canvas_bytes,
            canvas_truncated, failures, retry_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 0, NULL)
         ON CONFLICT (board_id) DO UPDATE SET
           canvas_source_at = CASE WHEN $9::boolean THEN board_search_state.canvas_source_at
                                   ELSE EXCLUDED.canvas_source_at END,
           canvas_clock = EXCLUDED.canvas_clock,
           canvas_indexed_at = EXCLUDED.canvas_indexed_at,
           canvas_bytes = CASE WHEN $8::boolean THEN board_search_state.canvas_bytes ELSE EXCLUDED.canvas_bytes END,
           canvas_truncated = CASE WHEN $8::boolean THEN board_search_state.canvas_truncated
                                   ELSE EXCLUDED.canvas_truncated END,
           failures = CASE WHEN $9::boolean THEN board_search_state.failures ELSE 0 END,
           retry_at = CASE WHEN $9::boolean THEN board_search_state.retry_at END`,
        [
          boardId,
          row.workspace_id,
          linksPending ? null : sourceAt,
          answer.clock,
          at,
          text?.bytes ?? 0,
          text?.truncated ?? false,
          text === null,
          linksPending,
        ],
      )
      return text ? 'indexed' : 'unchanged'
    })
    if (result === 'indexed' && links)
      await this.writeLinks(boardId, row.workspace_id, links, { clock: answer.clock, sourceAt, askedAt })
    // wave W (WS3): the canvas changed, so may the files it shows
    if (result === 'indexed') await this.refreshFileRefs(boardId)
    return result
  }

  /**
   * N7-4: replaces the board's links (one transaction of their own, after the text's), and only then moves the
   * board's canvas source time to the text's (the text transaction left it behind). Never throws: a failure is
   * logged (the board id only), keeps the rows and the scan as they were, and leaves the board stale with the
   * search index's failure backoff, so a later pass or search fetches it again (without `since`) and retries.
   */
  private async writeLinks(
    boardId: string,
    workspaceId: string,
    links: readonly BoardTextLink[],
    answer: { clock: number; sourceAt: Date; askedAt: Date },
  ): Promise<void> {
    try {
      await this.db.transaction(async (tx) => {
        // The board row first (access.ts lock order, step 1), FOR NO KEY UPDATE: two writers of one board's links
        // (two api processes overlap during a deploy) take turns, so the second DELETE sees the first one's rows
        // and the board never ends with both sets; a reader sees one set or the other (backlinks.pg.test.ts); and
        // the slower one's older answer never replaces a newer one recorded meanwhile (replaceBoardLinks). A board
        // deleted meanwhile is skipped (its rows cascade away anyway).
        const cur = await tx.maybeOne('SELECT id FROM boards WHERE id = $1 FOR NO KEY UPDATE', [boardId])
        if (!cur) return
        await replaceBoardLinks(tx, boardId, links, answer.clock, this.now(), answer.askedAt)
        await tx.query(
          `UPDATE board_search_state
              SET canvas_source_at = GREATEST(canvas_source_at, $2::timestamptz), failures = 0, retry_at = NULL
            WHERE board_id = $1`,
          [boardId, answer.sourceAt],
        )
      })
    } catch (e) {
      this.warn(e, 'board links could not be indexed', boardId)
      await this.recordLinksFailure(boardId, workspaceId).catch((err: unknown) =>
        this.warn(err, 'search could not record a failure', boardId),
      )
    }
  }

  /**
   * N7-4: the links of a freshly indexed board could not be written. The board is made stale (its canvas source
   * time cleared, so even a board whose text the recent re-check fetched is fetched again) and backs off like a
   * failed text read (15 s doubling, at most 30 min), so a failure that persists is not retried on every pass.
   */
  private async recordLinksFailure(boardId: string, workspaceId: string): Promise<void> {
    await this.recordFailure(boardId, workspaceId)
    await this.db.query('UPDATE board_search_state SET canvas_source_at = NULL WHERE board_id = $1', [
      boardId,
    ])
  }

  /**
   * N7-4, the one-time links backfill (see the top of this file): a batch of the boards that were indexed but
   * never had their links scanned, fetched without `since`. Returns how many it fetched.
   */
  private async backfillLinks(): Promise<number> {
    if (this.linksBackfillDone || this.stopped) return 0
    const now = this.now()
    if (now.getTime() < this.linksBackfillPausedUntil) return 0
    const never = `FROM boards b
       JOIN board_search_state s ON s.board_id = b.id
       LEFT JOIN board_link_scans l ON l.board_id = b.id
      WHERE b.status IN ('active', 'archived') AND l.board_id IS NULL AND s.canvas_indexed_at IS NOT NULL`
    const rows = await this.db.query<{ id: string }>(
      `SELECT b.id ${never} AND (s.retry_at IS NULL OR s.retry_at <= $1)
        ORDER BY b.updated_at DESC, b.id
        LIMIT $2`,
      [now, this.settings.batch],
    )
    if (!rows.rows.length) {
      // what is left (if anything) only waits for its retry: done once nothing is left at all
      const left = await this.db.query(`SELECT b.id ${never} LIMIT 1`)
      if (!left.rows.length) this.linksBackfillDone = true
      return 0
    }
    let fetched = 0
    for (const r of rows.rows) {
      if (this.stopped) break
      const result = await this.refreshCanvas(r.id)
      fetched++
      // an answer without links: the sync is older than wave N; try again later instead of fetching everything
      if (result === 'indexed' && this.syncLinks === false) {
        this.linksBackfillPausedUntil = this.now().getTime() + LINKS_BACKFILL_PAUSE_MS
        break
      }
    }
    return fetched
  }

  /** N7-4 (tests): whether the one-time links backfill has finished. */
  linksBackfillFinished(): boolean {
    return this.linksBackfillDone
  }

  private async recordFailure(boardId: string, workspaceId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO board_search_state (board_id, workspace_id, failures, retry_at)
       SELECT $1, $2, 1, $3::timestamptz + make_interval(secs => $4::float8)
        WHERE EXISTS (SELECT 1 FROM boards WHERE id = $1 AND status IN ('active', 'archived'))
       ON CONFLICT (board_id) DO UPDATE SET
         failures = board_search_state.failures + 1,
         retry_at = $3::timestamptz + make_interval(
           secs => LEAST($5::float8, $4::float8 * power(2, LEAST(board_search_state.failures, 12))))`,
      [boardId, workspaceId, this.now(), RETRY_BASE_S, RETRY_MAX_S],
    )
  }

  private async comments(boardId: string): Promise<RefreshResult> {
    const row = await this.boardRow(this.db, boardId)
    if (!row) return 'gone'
    if (!isOpenBoardStatus(row.status)) {
      await purgeBoard(this.db, boardId)
      return 'gone'
    }
    const ws = row.workspace_id
    // Read BEFORE the comments (see the top of this file).
    const source = await this.db.one<{ at: Date | null }>(
      'SELECT max(updated_at) AS at FROM comment_threads WHERE board_id = $1 AND workspace_id = $2',
      [boardId, ws],
    )
    const r = await this.db.query<{ thread_id: string; status: string; body: string }>(
      `SELECT t.id AS thread_id, t.status, c.body
         FROM comment_threads t
         JOIN comments c ON c.thread_id = t.id AND c.board_id = t.board_id AND c.workspace_id = t.workspace_id
        WHERE t.board_id = $1 AND t.workspace_id = $2 AND c.deleted_at IS NULL
        ORDER BY t.updated_at DESC, t.seq DESC, c.seq
        LIMIT $3`,
      [boardId, ws, MAX_COMMENTS_READ + 1],
    )
    let truncated = r.rows.length > MAX_COMMENTS_READ
    const threads = new Map<string, { status: string; bodies: string[] }>()
    for (const c of r.rows.slice(0, MAX_COMMENTS_READ)) {
      const t = threads.get(c.thread_id) ?? { status: c.status, bodies: [] }
      // A mention is indexed as the "@Name" people read, never as its token (`@[Name](usr_…)`):
      // user ids are not searchable text, and snippets show what the thread shows.
      t.bodies.push(rewriteMentionTokens(c.body, () => null))
      threads.set(c.thread_id, t)
    }
    const entries: IndexEntry[] = []
    let bytes = 0
    for (const [id, t] of threads) {
      const body = cleanIndexText(t.bodies.join(' · '), COMMENT_ENTRY_CHARS)
      if (!body) continue
      const size = Buffer.byteLength(body, 'utf8')
      if (bytes + size > SEARCH_COMMENT_TEXT_BYTES) {
        truncated = true
        break
      }
      bytes += size
      entries.push({
        objectId: id,
        kind: t.status === 'resolved' ? 'resolved-comment' : 'comment',
        pageId: null,
        body,
      })
    }
    const at = this.now()
    return this.db.transaction(async (tx) => {
      if (!(await this.stillIndexable(tx, boardId))) return 'gone'
      await replaceEntries(tx, { id: boardId, workspaceId: ws }, 'comment', entries)
      await tx.query(
        `INSERT INTO board_search_state (board_id, workspace_id, comments_source_at, comments_indexed_at,
                                         comments_truncated)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (board_id) DO UPDATE SET
           comments_source_at = EXCLUDED.comments_source_at,
           comments_indexed_at = EXCLUDED.comments_indexed_at,
           comments_truncated = EXCLUDED.comments_truncated`,
        [boardId, ws, source.at, at, truncated],
      )
      return 'indexed'
    })
  }

  /**
   * Before a search: refreshes (a bounded number of) the stale boards in its scope, waiting at most
   * `waitMs`. Refreshes still running then finish in the background. Returns how many boards in
   * scope still have changes the index does not have.
   */
  async refreshForSearch(scope: readonly ScopedBoard[]): Promise<number> {
    const now = this.now()
    const fresh = new Map(scope.map((b) => [b.id, freshness(b, now, this.settings)]))
    const f = (b: ScopedBoard) => fresh.get(b.id) as ReturnType<typeof freshness>
    const newest = (a: ScopedBoard, b: ScopedBoard) => b.updatedAt.getTime() - a.updatedAt.getTime()
    const stale = scope.filter((b) => f(b).canvasStale).sort(newest)
    const recent = scope.filter((b) => f(b).canvasRecent && !f(b).backoff).sort(newest)
    const canvasPick = [...stale.filter((b) => !f(b).backoff), ...recent].slice(
      0,
      this.settings.onDemandCanvas,
    )
    const commentsPick = scope.filter((b) => f(b).commentsStale).slice(0, this.settings.onDemandComments)
    const done = new Set<string>()
    const logged = (boardId: string) => (e: unknown) => {
      this.warn(e, 'search refresh failed', boardId)
      return 'failed' as const
    }
    const tasks = [
      ...commentsPick.map((b) => this.refreshComments(b.id).catch(logged(b.id))),
      ...canvasPick.map((b) =>
        this.refreshCanvas(b.id, { since: f(b).canvasStale ? null : (b.state?.canvasClock ?? null) }).then(
          (r) => {
            if (r !== 'failed') done.add(b.id)
            return r
          },
          logged(b.id),
        ),
      ),
    ]
    if (tasks.length) await Promise.race([Promise.all(tasks), sleep(this.settings.waitMs)])
    return stale.filter((b) => !done.has(b.id)).length
  }

  /** One background pass: sweep trashed boards out, then refresh a batch of stale boards. */
  runPass(): Promise<PassResult> {
    if (this.pass) return this.pass
    const p = this.passOnce().finally(() => {
      if (this.pass === p) this.pass = null
    })
    this.pass = p
    return p
  }

  private async passOnce(): Promise<PassResult> {
    const purged = await purgeTrashed(this.db)
    const now = this.now()
    const rows = await this.db.query<{
      id: string
      updated_at: Date
      comments_at: Date | null
      indexed: boolean
      canvas_source_at: Date | null
      canvas_clock: number | null
      canvas_indexed_at: Date | null
      comments_source_at: Date | null
      retry_at: Date | null
    }>(
      `SELECT b.id, b.updated_at,
              (SELECT max(t.updated_at) FROM comment_threads t
                WHERE t.board_id = b.id AND t.workspace_id = b.workspace_id) AS comments_at,
              (s.board_id IS NOT NULL) AS indexed, s.canvas_source_at, s.canvas_clock::float8 AS canvas_clock,
              s.canvas_indexed_at, s.comments_source_at, s.retry_at
         FROM boards b
         LEFT JOIN board_search_state s ON s.board_id = b.id
        WHERE b.status IN ('active', 'archived')
          AND (
            ((s.board_id IS NULL OR s.canvas_source_at IS NULL OR b.updated_at > s.canvas_source_at)
              AND (s.retry_at IS NULL OR s.retry_at <= $1))
            OR EXISTS (SELECT 1 FROM comment_threads t
                        WHERE t.board_id = b.id AND t.workspace_id = b.workspace_id
                          AND (s.comments_source_at IS NULL OR t.updated_at > s.comments_source_at))
          )
        ORDER BY s.canvas_indexed_at ASC NULLS FIRST, b.updated_at DESC, b.id
        LIMIT $2`,
      [now, this.settings.batch],
    )
    const out: PassResult = {
      canvas: 0,
      comments: 0,
      purged,
      looked: rows.rows.length,
      linksBackfill: 0,
      fileRefs: 0,
    }
    for (const r of rows.rows) {
      if (this.stopped) break
      const fr = freshness(
        {
          updatedAt: r.updated_at,
          commentsAt: r.comments_at,
          state: r.indexed
            ? {
                canvasSourceAt: r.canvas_source_at,
                canvasClock: r.canvas_clock,
                canvasIndexedAt: r.canvas_indexed_at,
                canvasTruncated: false,
                commentsSourceAt: r.comments_source_at,
                commentsTruncated: false,
                retryAt: r.retry_at,
              }
            : null,
        },
        now,
        this.settings,
      )
      if (fr.canvasStale && !fr.backoff && (await this.refreshCanvas(r.id)) !== 'failed') out.canvas++
      if (fr.commentsStale && (await this.refreshComments(r.id)) === 'indexed') out.comments++
    }
    // N7-4: after the stale boards, the boards whose links were never scanned (until none is left)
    out.linksBackfill = await this.backfillLinks()
    // wave W (WS3): then the files boards show (failed refreshes, and once per process the boards with files)
    out.fileRefs = await this.backfillFileRefs()
    return out
  }
}
