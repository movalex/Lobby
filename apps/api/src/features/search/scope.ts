// Which boards a search may look at: the permission filter, applied at query time
// (docs/WAVE4-CONTRACTS.md "search": "a guest sees only their boards and a viewer only boards they can
// view"). Like the board list (routes/boards.ts), SQL only narrows the candidates cheaply;
// @draftroom/permissions (resolveBoardRole + can 'view') makes every decision:
// - workspace owners and admins: every board of the workspace (they own them all);
// - members: boards they hold a grant on, and boards shared with the workspace;
// - guests (name-only or with an account): only the boards of their own grants;
// - trashed boards: never (nobody can open one); archived boards only when asked for.
// Each row also carries the board's index state, so the search can refresh what is stale.

import type { SearchStatus } from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import {
  type BoardRole,
  type BoardVisibility,
  can,
  resolveBoardRole,
  type WorkspaceRole,
} from '@draftroom/permissions'

export interface IndexState {
  canvasSourceAt: Date | null
  canvasClock: number | null
  canvasIndexedAt: Date | null
  canvasTruncated: boolean
  commentsSourceAt: Date | null
  commentsTruncated: boolean
  retryAt: Date | null
}

export interface ScopedBoard {
  id: string
  workspaceId: string
  title: string
  projectId: string | null
  status: SearchStatus
  updatedAt: Date
  /** Newest comment_threads.updated_at of the board (null: no threads). */
  commentsAt: Date | null
  role: BoardRole
  /** null: never indexed. */
  state: IndexState | null
}

interface ScopeRow {
  id: string
  workspace_id: string
  title: string
  project_id: string | null
  visibility: BoardVisibility
  status: SearchStatus
  updated_at: Date
  board_grant: BoardRole | null
  comments_at: Date | null
  indexed: boolean
  canvas_source_at: Date | null
  canvas_clock: number | null
  canvas_indexed_at: Date | null
  canvas_truncated: boolean | null
  comments_source_at: Date | null
  comments_truncated: boolean | null
  retry_at: Date | null
}

export async function searchScope(
  q: Queryable,
  opts: {
    workspaceId: string
    userId: string
    workspaceRole: WorkspaceRole
    status: SearchStatus
    projectId: string | null
  },
): Promise<ScopedBoard[]> {
  const { workspaceRole } = opts
  const rows = await q.query<ScopeRow>(
    `SELECT b.id, b.workspace_id, b.title, b.project_id, b.visibility, b.status, b.updated_at,
            bm.role AS board_grant,
            (SELECT max(t.updated_at) FROM comment_threads t
              WHERE t.board_id = b.id AND t.workspace_id = b.workspace_id) AS comments_at,
            (s.board_id IS NOT NULL) AS indexed,
            s.canvas_source_at, s.canvas_clock::float8 AS canvas_clock, s.canvas_indexed_at,
            s.canvas_truncated, s.comments_source_at, s.comments_truncated, s.retry_at
       FROM boards b
       LEFT JOIN board_members bm ON bm.board_id = b.id AND bm.user_id = $2
       LEFT JOIN board_search_state s ON s.board_id = b.id
      WHERE b.workspace_id = $1 AND b.status = $3
        AND ($4::text IS NULL OR b.project_id = $4::text)
        AND ($5::boolean OR bm.role IS NOT NULL OR ($6::boolean AND b.visibility <> 'private'))`,
    [
      opts.workspaceId,
      opts.userId,
      opts.status,
      opts.projectId,
      workspaceRole === 'owner' || workspaceRole === 'admin',
      workspaceRole === 'member',
    ],
  )
  const out: ScopedBoard[] = []
  for (const r of rows.rows) {
    const role = resolveBoardRole({ workspaceRole, boardGrant: r.board_grant, visibility: r.visibility })
    if (!role || !can(role, 'view', r.status)) continue
    out.push({
      id: r.id,
      workspaceId: r.workspace_id,
      title: r.title,
      projectId: r.project_id,
      status: r.status,
      updatedAt: r.updated_at,
      commentsAt: r.comments_at,
      role,
      state: r.indexed
        ? {
            canvasSourceAt: r.canvas_source_at,
            canvasClock: r.canvas_clock,
            canvasIndexedAt: r.canvas_indexed_at,
            canvasTruncated: r.canvas_truncated ?? false,
            commentsSourceAt: r.comments_source_at,
            commentsTruncated: r.comments_truncated ?? false,
            retryAt: r.retry_at,
          }
        : null,
    })
  }
  return out
}

export interface Freshness {
  /** The canvas text is older than the board's latest reported change (or was never indexed). */
  canvasStale: boolean
  /** Changed very recently: a canvas write may still be waiting for its throttled report. */
  canvasRecent: boolean
  /** Fetching is paused after failures (retry_at in the future). */
  backoff: boolean
  commentsStale: boolean
}

export function freshness(
  b: Pick<ScopedBoard, 'updatedAt' | 'commentsAt' | 'state'>,
  now: Date,
  opts: { recentMs: number; recheckMs: number },
): Freshness {
  const s = b.state
  const t = now.getTime()
  const canvasStale = !s?.canvasSourceAt || b.updatedAt > s.canvasSourceAt
  const canvasRecent =
    !canvasStale &&
    b.updatedAt.getTime() >= t - opts.recentMs &&
    (!s?.canvasIndexedAt || s.canvasIndexedAt.getTime() <= t - opts.recheckMs)
  const backoff = !!s?.retryAt && s.retryAt.getTime() > t
  const commentsStale = !!b.commentsAt && (!s?.commentsSourceAt || b.commentsAt > s.commentsSourceAt)
  return { canvasStale, canvasRecent, backoff, commentsStale }
}
