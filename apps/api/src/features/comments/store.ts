// SQL for the comments feature: loading threads/comments and shaping them into the public
// CommentThread contract. Every board-scoped query filters by board AND workspace.
//
// Wave J (AUTHZ-TEAM-OUTSIDER, docs/DOMAIN-ACCESS-CONTRACTS.md §15): "the team" of F10's team-only
// threads is a workspace owner, admin or member WHO IS A CONFIRMED CREATOR (auth/creator-sql.ts: a
// verified Dark Burn / TPG address, or an exception, confirmed within 24 hours). An outside account
// invited as a workspace member is not on the team, and an account Lobby cannot confirm fails closed
// (it is not on the team until a refresh confirms it). Comment authors carry `external` (the
// "External" tag) when Lobby knows the account is outside.

import {
  CommentAnchor,
  type CommentThread,
  type CommentThreadStatus,
  type CommentThreadVisibility,
  type CommentUserRef,
  cleanDisplayText,
  type ThreadComment,
} from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import { type BoardRole, can, resolveBoardRole, type WorkspaceRole } from '@draftroom/permissions'
import type { BoardRow } from '../../access.ts'
import {
  type CreatorLookup,
  isOpenLookup,
  knownOutsideSql,
  matchParams,
  userColumns,
  userParams,
} from '../../auth/creator-sql.ts'

/**
 * What decides who is on the team besides the workspace role: the running provider's creator policy
 * (ctx.identity.lookup) and the clock (`now`: an identity older than 24 hours is unconfirmed).
 */
export interface TeamRule {
  lookup: CreatorLookup
  now: Date
}

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
  external: boolean | null
}

/**
 * The people a thread names. With `lookup`, each carries `external` (wave J): Lobby knows the account
 * is outside Dark Burn / TPG (never for name-only guests, whose names carry " (guest)").
 */
async function userRefs(
  q: Queryable,
  ids: Iterable<string>,
  lookup?: CreatorLookup,
): Promise<Map<string, CommentUserRef>> {
  const list = [...new Set(ids)]
  const out = new Map<string, CommentUserRef>()
  if (list.length === 0) return out
  const rows = await q.query<UserRefRow>(
    lookup
      ? `SELECT u.id, u.name, u.color, ${knownOutsideSql('u', 2)} AS external FROM users u
          WHERE u.id IN (SELECT jsonb_array_elements_text($1::jsonb))`
      : 'SELECT id, name, color, NULL AS external FROM users WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))',
    lookup ? [idList(list), ...matchParams(lookup)] : [idList(list)],
  )
  for (const r of rows.rows)
    out.set(r.id, {
      id: r.id,
      // Without control, bidi or zero-width characters (names stored before wave J cleaned them).
      name: cleanDisplayText(r.name) || 'Someone',
      color: r.color,
      ...(r.external === null ? {} : { external: r.external === true }),
    })
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
  opts: {
    status?: CommentThreadStatus
    ids?: readonly string[]
    team: boolean
    /** Wave J: the creator policy, for the authors' `external` (omitted: no `external`). */
    lookup?: CreatorLookup
  },
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
  const users = await userRefs(
    q,
    [
      ...threads.rows.flatMap((t) => (t.resolved_by ? [t.created_by, t.resolved_by] : [t.created_by])),
      ...comments.rows.map((c) => c.author_id),
    ],
    opts.lookup,
  )
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
  lookup?: CreatorLookup,
): Promise<CommentThread | null> {
  return (await loadThreads(q, board, { ids: [threadId], team: true, lookup }))[0] ?? null
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
 * The workspace-role half of being on the team: a workspace owner, admin or member with an account.
 * Workspace guests (people who came in through a board link, review-link visitors) and name-only
 * guests (users.kind = 'guest') are not. Wave J: the team ALSO needs a confirmed creator (onTeam).
 */
export const isTeamRole = (role: WorkspaceRole | null | undefined, kind: string | null | undefined) =>
  (role === 'owner' || role === 'admin' || role === 'member') && kind !== 'guest'

/** On the team: isTeamRole and a confirmed creator (an unconfirmed account fails closed). */
export const onTeam = (
  role: WorkspaceRole | null | undefined,
  kind: string | null | undefined,
  creator: boolean | null | undefined,
) => isTeamRole(role, kind) && creator === true

/** Of `userIds`, the ones on the team of the workspace (see onTeam). */
export async function teamAmong(
  q: Queryable,
  workspaceId: string,
  userIds: readonly string[],
  rule: TeamRule,
): Promise<Set<string>> {
  const ids = [...new Set(userIds)]
  if (ids.length === 0) return new Set()
  const rows = await q.query<{ id: string; role: WorkspaceRole; kind: string; creator: boolean }>(
    `SELECT ${userColumns(3)}, wm.role FROM users u
       JOIN workspace_members wm ON wm.workspace_id = $1 AND wm.user_id = u.id
      WHERE u.id IN (SELECT jsonb_array_elements_text($2::jsonb))`,
    [workspaceId, idList(ids), ...userParams(rule.lookup, rule.now)],
  )
  return new Set(rows.rows.filter((r) => onTeam(r.role, r.kind, r.creator)).map((r) => r.id))
}

/** Whether this person is on the team of the workspace. */
export async function isTeamMember(
  q: Queryable,
  workspaceId: string,
  userId: string,
  rule: TeamRule,
): Promise<boolean> {
  return (await teamAmong(q, workspaceId, [userId], rule)).has(userId)
}

/**
 * Whether people outside the team can open this board now: a guest holds a grant on it (a workspace
 * guest or a name-only guest), a board link that has not ended could let one in, or (wave J) an
 * account that is not known to be at Dark Burn / TPG can open it (a grant, or a workspace role that
 * reaches it: owner, admin, or member while it is not private): one Lobby knows is outside, or one
 * whose addresses were never checked (it is not on the team either). An account whose stored addresses
 * qualify but are older than a day is not counted (a colleague who has not opened Lobby for a day; the
 * team rule re-checks them). The composer then starts with "Team only" on.
 */
export async function hasOutsideAccess(
  q: Queryable,
  board: Pick<BoardRow, 'id' | 'workspace_id' | 'visibility'>,
  at: Date,
  lookup: CreatorLookup,
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
     ) OR EXISTS (
       SELECT 1 FROM workspace_members wm
         JOIN users u ON u.id = wm.user_id
         LEFT JOIN board_members bm ON bm.board_id = $1 AND bm.user_id = wm.user_id
        WHERE wm.workspace_id = $2
          AND (wm.role IN ('owner', 'admin') OR bm.role IS NOT NULL OR (wm.role = 'member' AND $4::text <> 'private'))
          AND (${knownOutsideSql('u', 5)}${
            // never checked: not on the team; under open sign-in only the built-in owner, who never signs in
            isOpenLookup(lookup) ? '' : " OR (u.kind = 'account' AND u.identity_checked_at IS NULL)"
          })
     )) AS outside`,
    [board.id, board.workspace_id, at, board.visibility, ...matchParams(lookup)],
  )
  return r.outside === true
}

/**
 * Of `userIds`, the ones who can view the board right now (same rules as every other access
 * decision: @draftroom/permissions over membership, grant, visibility and status), with their names.
 * F10: with `team` (a team-only thread), only the ones on the team (wave J: confirmed creators).
 */
export async function viewersAmong(
  q: Queryable,
  board: Pick<BoardRow, 'id' | 'workspace_id' | 'visibility' | 'status'>,
  userIds: readonly string[],
  opts: { team?: TeamRule | null } = {},
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const ids = [...new Set(userIds)]
  if (ids.length === 0) return out
  const rule = opts.team ?? null
  const rows = await q.query<{
    id: string
    name: string
    kind: string
    creator: boolean
    workspace_role: WorkspaceRole
    board_grant: BoardRole | null
  }>(
    rule
      ? `SELECT ${userColumns(4)}, wm.role AS workspace_role, bm.role AS board_grant
           FROM users u
           JOIN workspace_members wm ON wm.workspace_id = $2 AND wm.user_id = u.id
           LEFT JOIN board_members bm ON bm.board_id = $1 AND bm.user_id = u.id
          WHERE u.id IN (SELECT jsonb_array_elements_text($3::jsonb))`
      : `SELECT u.id, u.name, u.kind, false AS creator, wm.role AS workspace_role, bm.role AS board_grant
           FROM users u
           JOIN workspace_members wm ON wm.workspace_id = $2 AND wm.user_id = u.id
           LEFT JOIN board_members bm ON bm.board_id = $1 AND bm.user_id = u.id
          WHERE u.id IN (SELECT jsonb_array_elements_text($3::jsonb))`,
    rule
      ? [board.id, board.workspace_id, idList(ids), ...userParams(rule.lookup, rule.now)]
      : [board.id, board.workspace_id, idList(ids)],
  )
  for (const r of rows.rows) {
    const role = resolveBoardRole({
      workspaceRole: r.workspace_role,
      boardGrant: r.board_grant,
      visibility: board.visibility,
    })
    if (rule && !onTeam(r.workspace_role, r.kind, r.creator)) continue
    if (can(role, 'view', board.status)) out.set(r.id, r.name)
  }
  return out
}
