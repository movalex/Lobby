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

import { FILE_CARD_TYPE } from '@draftroom/canvas-schema'
import {
  rewriteMentionTokens,
  SEARCH_CANVAS_TEXT_BYTES,
  SEARCH_COMMENT_TEXT_BYTES,
  type SearchHitKind,
} from '@draftroom/contracts'
import type { Db, Queryable } from '@draftroom/db'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { SyncInternalClient } from '../../sync-internal.ts'
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
  }),
])
type BoardTextAnswer = z.infer<typeof BoardTextAnswer>

export type RefreshResult = 'indexed' | 'unchanged' | 'gone' | 'failed'

export interface PassResult {
  canvas: number
  comments: number
  purged: number
  /** Boards the pass looked at (a full batch means there may be more). */
  looked: number
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

  constructor(opts: {
    db: Db
    sync: SyncInternalClient
    now: () => Date
    log: Log
    settings: SearchSettings
  }) {
    this.db = opts.db
    this.sync = opts.sync
    this.now = opts.now
    this.log = opts.log
    this.settings = opts.settings
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
        .then((r) => r.looked >= this.settings.batch)
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
    if (cur && cur.status !== 'trashed') return true
    if (cur) await purgeBoard(tx, boardId)
    return false
  }

  private async canvas(boardId: string, since: number | null): Promise<RefreshResult> {
    const row = await this.boardRow(this.db, boardId)
    if (!row) return 'gone'
    if (row.status === 'trashed') {
      await purgeBoard(this.db, boardId)
      return 'gone'
    }
    const sourceAt = row.updated_at // read BEFORE the text (see the top of this file)
    let answer: BoardTextAnswer
    try {
      if (!this.sync.boardText) throw new Error('the sync client cannot read board text')
      const raw = await this.sync.boardText(boardId, {
        ...(since === null ? {} : { since }),
        maxBytes: SEARCH_CANVAS_TEXT_BYTES,
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
    const at = this.now()
    return this.db.transaction(async (tx) => {
      if (!(await this.stillIndexable(tx, boardId))) return 'gone'
      if (text)
        await replaceEntries(tx, { id: boardId, workspaceId: row.workspace_id }, 'canvas', text.entries)
      await tx.query(
        `INSERT INTO board_search_state
           (board_id, workspace_id, canvas_source_at, canvas_clock, canvas_indexed_at, canvas_bytes,
            canvas_truncated, failures, retry_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 0, NULL)
         ON CONFLICT (board_id) DO UPDATE SET
           canvas_source_at = EXCLUDED.canvas_source_at,
           canvas_clock = EXCLUDED.canvas_clock,
           canvas_indexed_at = EXCLUDED.canvas_indexed_at,
           canvas_bytes = CASE WHEN $8::boolean THEN board_search_state.canvas_bytes ELSE EXCLUDED.canvas_bytes END,
           canvas_truncated = CASE WHEN $8::boolean THEN board_search_state.canvas_truncated
                                   ELSE EXCLUDED.canvas_truncated END,
           failures = 0,
           retry_at = NULL`,
        [
          boardId,
          row.workspace_id,
          sourceAt,
          answer.clock,
          at,
          text?.bytes ?? 0,
          text?.truncated ?? false,
          text === null,
        ],
      )
      return text ? 'indexed' : 'unchanged'
    })
  }

  private async recordFailure(boardId: string, workspaceId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO board_search_state (board_id, workspace_id, failures, retry_at)
       SELECT $1, $2, 1, $3::timestamptz + make_interval(secs => $4::float8)
        WHERE EXISTS (SELECT 1 FROM boards WHERE id = $1 AND status <> 'trashed')
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
    if (row.status === 'trashed') {
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
        WHERE b.status <> 'trashed'
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
    const out: PassResult = { canvas: 0, comments: 0, purged, looked: rows.rows.length }
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
    return out
  }
}
