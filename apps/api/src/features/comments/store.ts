// SQL for the comments feature: loading threads/comments and shaping them into the public
// CommentThread contract. Every board-scoped query filters by board AND workspace.

import {
  CommentAnchor,
  type CommentThread,
  type CommentThreadStatus,
  type CommentThreadVisibility,
  type CommentUserRef,
  type ThreadComment,
} from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import { type BoardRole, can, resolveBoardRole, type WorkspaceRole } from '@draftroom/permissions'
import type { BoardRow } from '../../access.ts'

export const MAX_THREADS_LISTED = 5_000
export const MAX_COMMENTS_PER_THREAD = 1_000
export const MAX_THREADS_PER_BOARD = 20_000

export interface ThreadRow {
  id: string
  workspace_id: string
  board_id: string
  anchor: unknown
  status: CommentThreadStatus
  created_by: string
  created_at: Date
  updated_at: Date
  resolved_by: string | null
  resolved_at: Date | null
  visibility: CommentThreadVisibility
}

export interface CommentRow {
  id: string
  thread_id: string
  workspace_id: string
  board_id: string
  author_id: string
  body: string
  created_at: Date
  edited_at: Date | null
  deleted_at: Date | null
}

const iso = (d: Date) => d.toISOString()
/** jsonb arrives parsed from both drivers; tolerate a string anyway. */
const json = (v: unknown): unknown => (typeof v === 'string' ? JSON.parse(v) : v)
/** A list of ids as one jsonb parameter (portable across PGlite and pg, unlike array parameters). */
export const idList = (ids: readonly string[]) => JSON.stringify(ids)

const THREAD_COLUMNS =
  'id, workspace_id, board_id, anchor, status, created_by, created_at, updated_at, resolved_by, resolved_at, visibility'

export async function loadThreadRow(q: Queryable, threadId: string): Promise<ThreadRow | null> {
  return q.maybeOne<ThreadRow>(
    `SELECT ${THREAD_COLUMNS}
       FROM comment_threads WHERE id = $1`,
    [threadId],
  )
}

export async function loadCommentRow(q: Queryable, commentId: string): Promise<CommentRow | null> {
  return q.maybeOne<CommentRow>(
    `SELECT id, thread_id, workspace_id, board_id, author_id, body, created_at, edited_at, deleted_at
       FROM comments WHERE id = $1`,
    [commentId],
  )
}

interface UserRefRow {
  id: string
  name: string
  color: string
}

async function userRefs(q: Queryable, ids: Iterable<string>): Promise<Map<string, CommentUserRef>> {
  const list = [...new Set(ids)]
  const out = new Map<string, CommentUserRef>()
  if (list.length === 0) return out
  const rows = await q.query<UserRefRow>(
    'SELECT id, name, color FROM users WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))',
    [idList(list)],
  )
  for (const r of rows.rows) out.set(r.id, { id: r.id, name: r.name, color: r.color })
  return out
}

const unknownUser = (id: string): CommentUserRef => ({ id, name: 'Unknown', color: '#888888' })

/**
 * Threads of one board (optionally one status, or specific ids) with their live comments. Threads
 * whose every comment was deleted are dropped: they no longer exist for anyone. F10: team-only
 * threads only with `team: true` (the caller is on the team).
 */
export async function loadThreads(
  q: Queryable,
  board: { id: string; workspace_id: string },
  opts: { status?: CommentThreadStatus; ids?: readonly string[]; team: boolean },
): Promise<CommentThread[]> {
  const threads = await q.query<ThreadRow>(
    `SELECT ${THREAD_COLUMNS}
       FROM comment_threads
      WHERE board_id = $1 AND workspace_id = $2
        AND ($3::text IS NULL OR status = $3::text)
        AND ($4::jsonb IS NULL OR id IN (SELECT jsonb_array_elements_text($4::jsonb)))
        AND ($5::boolean OR visibility = 'everyone')
      ORDER BY created_at, seq
      LIMIT ${MAX_THREADS_LISTED}`,
    [board.id, board.workspace_id, opts.status ?? null, opts.ids ? idList(opts.ids) : null, opts.team],
  )
  if (threads.rows.length === 0) return []
  const threadIds = threads.rows.map((t) => t.id)
  const comments = await q.query<CommentRow>(
    `SELECT id, thread_id, workspace_id, board_id, author_id, body, created_at, edited_at, deleted_at
       FROM comments
      WHERE board_id = $1 AND workspace_id = $2 AND deleted_at IS NULL
        AND thread_id IN (SELECT jsonb_array_elements_text($3::jsonb))
      ORDER BY seq`,
    [board.id, board.workspace_id, idList(threadIds)],
  )
  const commentIds = comments.rows.map((c) => c.id)
  const mentions = new Map<string, string[]>()
  if (commentIds.length > 0) {
    const rows = await q.query<{ comment_id: string; user_id: string }>(
      `SELECT comment_id, user_id FROM comment_mentions
        WHERE workspace_id = $1 AND comment_id IN (SELECT jsonb_array_elements_text($2::jsonb))
        ORDER BY comment_id, user_id`,
      [board.workspace_id, idList(commentIds)],
    )
    for (const r of rows.rows) {
      const list = mentions.get(r.comment_id) ?? []
      list.push(r.user_id)
      mentions.set(r.comment_id, list)
    }
  }
  const users = await userRefs(q, [
    ...threads.rows.flatMap((t) => (t.resolved_by ? [t.created_by, t.resolved_by] : [t.created_by])),
    ...comments.rows.map((c) => c.author_id),
  ])
  const ref = (id: string) => users.get(id) ?? unknownUser(id)
  const byThread = new Map<string, ThreadComment[]>()
  for (const c of comments.rows) {
    const list = byThread.get(c.thread_id) ?? []
    list.push({
      id: c.id,
      threadId: c.thread_id,
      author: ref(c.author_id),
      body: c.body,
      mentions: mentions.get(c.id) ?? [],
      createdAt: iso(c.created_at),
      editedAt: c.edited_at ? iso(c.edited_at) : null,
    })
    byThread.set(c.thread_id, list)
  }
  const out: CommentThread[] = []
  for (const t of threads.rows) {
    const list = byThread.get(t.id)
    if (!list || list.length === 0) continue
    const anchor = CommentAnchor.safeParse(json(t.anchor))
    if (!anchor.success) continue // never stored unvalidated; skip rather than break the whole list
    out.push({
      id: t.id,
      boardId: t.board_id,
      anchor: anchor.data,
      status: t.status,
      createdBy: ref(t.created_by),
      createdAt: iso(t.created_at),
      updatedAt: iso(t.updated_at),
      resolvedBy: t.resolved_by ? ref(t.resolved_by) : null,
      resolvedAt: t.resolved_at ? iso(t.resolved_at) : null,
      visibility: t.visibility,
      comments: list,
    })
  }
  return out
}

/** One thread, whatever its visibility (the caller already decided who may see it). */
export async function loadThread(
  q: Queryable,
  board: { id: string; workspace_id: string },
  threadId: string,
): Promise<CommentThread | null> {
  return (await loadThreads(q, board, { ids: [threadId], team: true }))[0] ?? null
}

/** The caller's read marks for the given threads. */
export async function loadReads(
  q: Queryable,
  userId: string,
  threadIds: readonly string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  if (threadIds.length === 0) return out
  const rows = await q.query<{ thread_id: string; read_at: Date }>(
    `SELECT thread_id, read_at FROM comment_reads
      WHERE user_id = $1 AND thread_id IN (SELECT jsonb_array_elements_text($2::jsonb))`,
    [userId, idList(threadIds)],
  )
  for (const r of rows.rows) out[r.thread_id] = iso(r.read_at)
  return out
}

export async function markRead(
  q: Queryable,
  thread: { id: string; workspace_id: string },
  userId: string,
  at: Date,
): Promise<void> {
  await q.query(
    `INSERT INTO comment_reads (thread_id, user_id, workspace_id, read_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (thread_id, user_id) DO UPDATE SET read_at = GREATEST(comment_reads.read_at, EXCLUDED.read_at)`,
    [thread.id, userId, thread.workspace_id, at],
  )
}

// ---- F10: the team -------------------------------------------------------------------------------

/**
 * On the team: a workspace owner, admin or member with an account. Workspace guests (people who came
 * in through a board link, review-link visitors) and name-only guests (users.kind = 'guest') are not.
 */
export const isTeamRole = (role: WorkspaceRole | null | undefined, kind: string | null | undefined) =>
  (role === 'owner' || role === 'admin' || role === 'member') && kind !== 'guest'

/** Of `userIds`, the ones on the team of the workspace (see isTeamRole). */
export async function teamAmong(
  q: Queryable,
  workspaceId: string,
  userIds: readonly string[],
): Promise<Set<string>> {
  const ids = [...new Set(userIds)]
  if (ids.length === 0) return new Set()
  const rows = await q.query<{ id: string; role: WorkspaceRole; kind: string }>(
    `SELECT u.id, wm.role, u.kind FROM users u
       JOIN workspace_members wm ON wm.workspace_id = $1 AND wm.user_id = u.id
      WHERE u.id IN (SELECT jsonb_array_elements_text($2::jsonb))`,
    [workspaceId, idList(ids)],
  )
  return new Set(rows.rows.filter((r) => isTeamRole(r.role, r.kind)).map((r) => r.id))
}

/** Whether this person is on the team of the workspace. */
export async function isTeamMember(q: Queryable, workspaceId: string, userId: string): Promise<boolean> {
  return (await teamAmong(q, workspaceId, [userId])).has(userId)
}

/**
 * Whether people outside the team can open this board now: a guest holds a grant on it (a workspace
 * guest or a name-only guest), or a board link that has not ended could let one in. The composer then
 * starts with "Team only" on.
 */
export async function hasOutsideAccess(
  q: Queryable,
  board: { id: string; workspace_id: string },
  at: Date,
): Promise<boolean> {
  const r = await q.one<{ outside: boolean }>(
    `SELECT (EXISTS (
       SELECT 1 FROM board_members bm
         JOIN users u ON u.id = bm.user_id
         LEFT JOIN workspace_members wm ON wm.workspace_id = $2 AND wm.user_id = bm.user_id
        WHERE bm.board_id = $1 AND (u.kind = 'guest' OR wm.role IS NULL OR wm.role = 'guest')
     ) OR EXISTS (
       SELECT 1 FROM invitations i
        WHERE i.board_id = $1 AND i.workspace_id = $2 AND i.revoked_at IS NULL AND i.expires_at > $3
          AND (i.multi_use OR i.redeemed_by IS NULL)
     )) AS outside`,
    [board.id, board.workspace_id, at],
  )
  return r.outside === true
}

/**
 * Of `userIds`, the ones who can view the board right now (same rules as every other access
 * decision: @draftroom/permissions over membership, grant, visibility and status), with their names.
 * F10: with `team: true` (a team-only thread), only the ones on the team.
 */
export async function viewersAmong(
  q: Queryable,
  board: Pick<BoardRow, 'id' | 'workspace_id' | 'visibility' | 'status'>,
  userIds: readonly string[],
  opts: { team?: boolean } = {},
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const ids = [...new Set(userIds)]
  if (ids.length === 0) return out
  const rows = await q.query<{
    id: string
    name: string
    kind: string
    workspace_role: WorkspaceRole
    board_grant: BoardRole | null
  }>(
    `SELECT u.id, u.name, u.kind, wm.role AS workspace_role, bm.role AS board_grant
       FROM users u
       JOIN workspace_members wm ON wm.workspace_id = $2 AND wm.user_id = u.id
       LEFT JOIN board_members bm ON bm.board_id = $1 AND bm.user_id = u.id
      WHERE u.id IN (SELECT jsonb_array_elements_text($3::jsonb))`,
    [board.id, board.workspace_id, idList(ids)],
  )
  for (const r of rows.rows) {
    const role = resolveBoardRole({
      workspaceRole: r.workspace_role,
      boardGrant: r.board_grant,
      visibility: board.visibility,
    })
    if (opts.team && !isTeamRole(r.workspace_role, r.kind)) continue
    if (can(role, 'view', board.status)) out.set(r.id, r.name)
  }
  return out
}
