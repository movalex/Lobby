// OWNER: WS5 (wave W, the workspace admin page; docs/WAVE-W-CONTRACTS.md §7). The reads behind the seven admin routes.
// Each takes a workspace id the caller was already checked to own or administer (index.ts `adminOf`), reads only rows
// of that workspace, and changes nothing. bigint sums come back as float8 (exact below 2^53), as files/usage.ts does,
// because PGlite and node-postgres map int8 differently.

import {
  ADMIN_LIMITS,
  type AdminAuditEvent,
  type AdminAuditQuery,
  type AdminGuest,
  type AdminInvitation,
  type AdminLink,
  type AdminMember,
  type AdminRetentionFact,
  type AdminStorageResponse,
  type AdminStorageRow,
  ASSET_GC_GRACE_DAYS,
  CHAT_DELIVERY,
  CHECKPOINT_RETENTION,
  IMPORT_TIMING,
  LIBRARY_LIMITS,
} from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import type { WorkspaceRole } from '@draftroom/permissions'
import { workspaceUsage } from '../../files/usage.ts'
import { maskEmail } from '../../routes/invitations.ts'
import { listWorkspaceMembers } from '../../routes/workspaces.ts'
import type { FeatureContext } from '../context.ts'
import { cleanName, originAmong, outsideFieldsOf } from '../dashboard/outside.ts'
import { collectRefs, type DetailRefs, showDetail } from './audit-view.ts'

/** Boards whose content still counts (a trashed board is out of sight until restored; `importing` is nobody's yet). */
const LIVE_BOARD = "b.status IN ('active', 'archived')"

const WS_RANK: Record<WorkspaceRole, number> = { owner: 0, admin: 1, member: 2, guest: 3 }

// ---- members (W5-1) -------------------------------------------------------------------------------------------------

/**
 * The workspace's people with an account (name-only guests are on the links tab), owners first: their role, whether
 * each is a creator, how many boards of the workspace they hold a direct grant on, and the manager-only outside
 * markers GET members already gives owners and admins. No visit time: 0031's promise (§12 departure 3).
 */
export async function adminMembers(q: Queryable, ctx: FeatureContext, wid: string): Promise<AdminMember[]> {
  const members = await listWorkspaceMembers(q, wid)
  const ids = members.map((m) => m.user.id)
  const grants = ids.length
    ? await q.query<{ user_id: string; n: number }>(
        `SELECT bm.user_id, count(*)::int AS n
           FROM board_members bm JOIN boards b ON b.id = bm.board_id
          WHERE b.workspace_id = $1 AND ${LIVE_BOARD} AND bm.user_id = ANY($2::text[])
          GROUP BY bm.user_id`,
        [wid, ids],
      )
    : { rows: [] }
  const grantsOf = new Map(grants.rows.map((r) => [r.user_id, Number(r.n)]))
  const creators = await ctx.identity.creatorsAmong(q, ids)
  const origin = await originAmong(q, ctx, ids)
  return members
    .map((m) => ({
      user: { id: m.user.id, name: cleanName(m.user.name) },
      role: m.role,
      creator: creators.has(m.user.id),
      boardGrants: grantsOf.get(m.user.id) ?? 0,
      ...outsideFieldsOf(origin.get(m.user.id)),
    }))
    .sort((a, b) => WS_RANK[a.role] - WS_RANK[b.role] || a.user.name.localeCompare(b.user.name))
}

/**
 * Pending single-use invitations, to the workspace or to one of its boards (not in the trash): nobody used, revoked or
 * outlived them. The address only as its hint ("j•••@client.example"), never the token.
 */
export async function adminInvitations(
  q: Queryable,
  wid: string,
  now: Date,
): Promise<{ invitations: AdminInvitation[]; more: boolean }> {
  const rows = await q.query<{
    id: string
    board_id: string | null
    title: string | null
    role: string
    invited_email: string | null
    created_by: string
    creator_name: string
    created_at: Date
    expires_at: Date
  }>(
    `SELECT i.id, i.board_id, b.title, i.role, i.invited_email, i.created_by, u.name AS creator_name,
            i.created_at, i.expires_at
       FROM invitations i
       JOIN users u ON u.id = i.created_by
       LEFT JOIN boards b ON b.id = i.board_id AND b.workspace_id = i.workspace_id
      WHERE i.workspace_id = $1 AND NOT i.multi_use AND i.redeemed_by IS NULL AND i.revoked_at IS NULL
        AND i.expires_at > $2
        AND (i.board_id IS NULL OR (b.id IS NOT NULL AND ${LIVE_BOARD}))
      ORDER BY i.created_at DESC, i.id
      LIMIT ${ADMIN_LIMITS.pageSize + 1}`,
    [wid, now],
  )
  const invitations = rows.rows.slice(0, ADMIN_LIMITS.pageSize).map(
    (r): AdminInvitation => ({
      id: r.id,
      scope: r.board_id === null ? 'workspace' : 'board',
      board: r.board_id === null ? null : { id: r.board_id, title: r.title ?? '' },
      role: r.role,
      emailHint: r.invited_email === null ? null : maskEmail(r.invited_email),
      invitedBy: { id: r.created_by, name: cleanName(r.creator_name) },
      createdAt: r.created_at.toISOString(),
      expiresAt: r.expires_at.toISOString(),
    }),
  )
  return { invitations, more: rows.rows.length > ADMIN_LIMITS.pageSize }
}

// ---- storage (W5-2) -------------------------------------------------------------------------------------------------

/** The total and its quota, as GET …/storage gives them, and the file text kept for search (WS3). */
async function storageTotals(q: Queryable, ctx: FeatureContext, wid: string) {
  const usage = await workspaceUsage(q, wid)
  const text = await q.one<{ bytes: number }>(
    'SELECT COALESCE(SUM(bytes), 0)::float8 AS bytes FROM file_text_state WHERE workspace_id = $1',
    [wid],
  )
  return {
    total: { versions: usage.files, bytes: usage.used, quotaBytes: ctx.config.uploads.workspaceQuotaBytes },
    fileTextBytes: Number(text.bytes),
  }
}

/**
 * The boards that store the most: each board's originals, the previews made from them and its dashboard thumbnail,
 * which is exactly how workspaceUsage counts (every board of the workspace, in any status, adds up to its `used`).
 */
export async function storageByBoard(
  q: Queryable,
  ctx: FeatureContext,
  wid: string,
): Promise<AdminStorageResponse> {
  const rows = await q.query<{ id: string; title: string; versions: number; bytes: number }>(
    `WITH v AS (
       SELECT board_id, count(*)::int AS versions, SUM(size_bytes)::float8 AS bytes
         FROM asset_versions WHERE workspace_id = $1 GROUP BY board_id
     ), d AS (
       SELECT v.board_id, SUM(d.bytes)::float8 AS bytes
         FROM asset_derivatives d JOIN asset_versions v ON v.id = d.version_id
        WHERE v.workspace_id = $1 GROUP BY v.board_id
     ), t AS (
       SELECT board_id, bytes::float8 AS bytes FROM board_thumbnails WHERE workspace_id = $1
     )
     SELECT b.id, b.title, COALESCE(v.versions, 0) AS versions,
            (COALESCE(v.bytes, 0) + COALESCE(d.bytes, 0) + COALESCE(t.bytes, 0))::float8 AS bytes
       FROM boards b
       LEFT JOIN v ON v.board_id = b.id
       LEFT JOIN d ON d.board_id = b.id
       LEFT JOIN t ON t.board_id = b.id
      WHERE b.workspace_id = $1 AND (v.board_id IS NOT NULL OR t.board_id IS NOT NULL)
      ORDER BY 4 DESC, b.id
      LIMIT ${ADMIN_LIMITS.topRows}`,
    [wid],
  )
  return {
    rows: rows.rows.map(
      (r): AdminStorageRow => ({
        board: { id: r.id, title: r.title },
        uploader: null,
        versions: Number(r.versions),
        bytes: Number(r.bytes),
      }),
    ),
    ...(await storageTotals(q, ctx, wid)),
  }
}

/**
 * The people whose uploads store the most: each person's originals and the previews made from them. Dashboard
 * thumbnails belong to no uploader: they are one row with neither a board nor a person, so the rows still add up to
 * workspaceUsage's `used`.
 */
export async function storageByUploader(
  q: Queryable,
  ctx: FeatureContext,
  wid: string,
): Promise<AdminStorageResponse> {
  const rows = await q.query<{ id: string; name: string; versions: number; bytes: number }>(
    `WITH d AS (
       SELECT d.version_id, SUM(d.bytes)::float8 AS bytes
         FROM asset_derivatives d JOIN asset_versions v ON v.id = d.version_id
        WHERE v.workspace_id = $1 GROUP BY d.version_id
     )
     SELECT v.uploaded_by AS id, u.name, count(*)::int AS versions,
            SUM(v.size_bytes + COALESCE(d.bytes, 0))::float8 AS bytes
       FROM asset_versions v
       JOIN users u ON u.id = v.uploaded_by
       LEFT JOIN d ON d.version_id = v.id
      WHERE v.workspace_id = $1
      GROUP BY v.uploaded_by, u.name
      ORDER BY 4 DESC, v.uploaded_by
      LIMIT ${ADMIN_LIMITS.topRows}`,
    [wid],
  )
  const thumbs = await q.one<{ bytes: number }>(
    'SELECT COALESCE(SUM(bytes), 0)::float8 AS bytes FROM board_thumbnails WHERE workspace_id = $1',
    [wid],
  )
  const list: AdminStorageRow[] = rows.rows.map((r) => ({
    board: null,
    uploader: { id: r.id, name: cleanName(r.name) },
    versions: Number(r.versions),
    bytes: Number(r.bytes),
  }))
  const thumbBytes = Number(thumbs.bytes)
  if (thumbBytes > 0) list.push({ board: null, uploader: null, versions: 0, bytes: thumbBytes })
  list.sort((a, b) => b.bytes - a.bytes)
  return { rows: list.slice(0, ADMIN_LIMITS.topRows), ...(await storageTotals(q, ctx, wid)) }
}

// ---- audit (W5-3) ---------------------------------------------------------------------------------------------------

/**
 * One page of the workspace's audit log, newest first by id (a row written while someone pages never moves a row
 * between pages: `before` is the last id of the page before). `action` is exact, or a prefix when it ends with a dot
 * (`board.`). Each detail is shown only through its action's allowlist (audit-view.ts).
 */
export async function auditPage(
  q: Queryable,
  wid: string,
  query: AdminAuditQuery,
): Promise<{ events: AdminAuditEvent[]; nextBefore: number | null }> {
  const limit = query.limit ?? ADMIN_LIMITS.pageSize
  const { text, params } = auditPageSql(wid, query, limit)
  const rows = await q.query<{
    id: number
    at: Date
    action: string
    actor_id: string | null
    actor_name: string | null
    target: string
    detail: unknown
  }>(text, params)
  const page = rows.rows.slice(0, limit)
  // The people and boards the shown details name, and every target that is a board, in two queries.
  const refs: DetailRefs = { users: new Set(), boards: new Set() }
  for (const r of page) {
    collectRefs(r.action, r.detail, refs)
    refs.boards.add(r.target)
  }
  const names = await namesOf(q, [...refs.users])
  const titles = await titlesIn(q, wid, [...refs.boards])
  const events = page.map((r): AdminAuditEvent => {
    const boardId = titles.has(r.target) ? r.target : boardIdOf(r.detail, titles)
    return {
      id: Number(r.id),
      at: r.at.toISOString(),
      action: r.action,
      actor: r.actor_id === null ? null : { id: r.actor_id, name: cleanName(r.actor_name ?? '') },
      board: boardId === null ? null : { id: boardId, title: titles.get(boardId) ?? '' },
      detail: showDetail(r.action, r.detail, names, titles),
    }
  })
  const last = page.at(-1)
  return { events, nextBefore: rows.rows.length > limit && last ? Number(last.id) : null }
}

/**
 * The page's statement (one more row than the page, to know whether another follows). Exported for the real-Postgres
 * plan check (test/features/workspace-admin/audit-plan.pg.test.ts): it must stay an index scan on a large log.
 */
export function auditPageSql(
  wid: string,
  query: AdminAuditQuery,
  limit: number,
): { text: string; params: unknown[] } {
  const params: unknown[] = [wid]
  const where = ['e.workspace_id = $1']
  if (query.before !== undefined) {
    params.push(query.before)
    where.push(`e.id < $${params.length}`)
  }
  if (query.action !== undefined) {
    if (query.action.endsWith('.')) {
      params.push(`${query.action.replace(/_/g, '\\_')}%`)
      where.push(`e.action LIKE $${params.length}`)
    } else {
      params.push(query.action)
      where.push(`e.action = $${params.length}`)
    }
  }
  if (query.actor !== undefined) {
    params.push(query.actor)
    where.push(`e.actor_id = $${params.length}`)
  }
  params.push(limit + 1)
  return {
    text: `SELECT e.id::float8 AS id, e.at, e.action, e.actor_id, u.name AS actor_name, e.target, e.detail
             FROM audit_events e LEFT JOIN users u ON u.id = e.actor_id
            WHERE ${where.join(' AND ')}
            ORDER BY e.id DESC
            LIMIT $${params.length}`,
    params,
  }
}

/** A row's board when its target is not one: its detail's `boardId`, if that board is of this workspace. */
function boardIdOf(detail: unknown, titles: ReadonlyMap<string, string>): string | null {
  if (typeof detail !== 'object' || detail === null) return null
  const id = (detail as { boardId?: unknown }).boardId
  return typeof id === 'string' && titles.has(id) ? id : null
}

async function namesOf(q: Queryable, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map()
  const rows = await q.query<{ id: string; name: string }>(
    'SELECT id, name FROM users WHERE id = ANY($1::text[])',
    [ids],
  )
  return new Map(rows.rows.map((r) => [r.id, cleanName(r.name)]))
}

/** Titles of these boards, only those of this workspace (an id of another workspace's board finds nothing). */
async function titlesIn(q: Queryable, wid: string, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map()
  const rows = await q.query<{ id: string; title: string }>(
    'SELECT id, title FROM boards WHERE workspace_id = $1 AND id = ANY($2::text[])',
    [wid, ids],
  )
  return new Map(rows.rows.map((r) => [r.id, r.title]))
}

// ---- links and guests (W5-4) ----------------------------------------------------------------------------------------

/** A link's kind as people call it: workshop (edit), a client link that opens the review page, or a review link. */
function linkKind(role: string, landing: string): AdminLink['kind'] {
  if (role === 'editor') return 'workshop'
  if (landing === 'review') return 'landing'
  if (role === 'viewer' || role === 'commenter') return 'review'
  return 'other'
}

/**
 * Every open multi-use link of the workspace's boards (not in the trash; the same rows each board's Share dialog
 * lists: GET /api/boards/:bid/invitations), and the name-only guests who still hold a grant here, with those boards.
 * Never a link's token, URL or join code (whether it has one only).
 */
export async function adminLinks(
  q: Queryable,
  wid: string,
  now: Date,
): Promise<{ links: AdminLink[]; guests: AdminGuest[]; more: boolean }> {
  const links = await q.query<{
    id: string
    board_id: string
    title: string
    role: string
    landing: string
    allow_guests: boolean
    has_code: boolean
    created_by: string
    creator_name: string
    created_at: Date
    expires_at: Date
    use_count: number
    max_uses: number | null
  }>(
    `SELECT i.id, i.board_id, b.title, i.role, i.landing, i.allow_guests, i.join_code_hash IS NOT NULL AS has_code,
            i.created_by, u.name AS creator_name, i.created_at, i.expires_at, i.use_count, i.max_uses
       FROM invitations i
       JOIN boards b ON b.id = i.board_id AND b.workspace_id = i.workspace_id
       JOIN users u ON u.id = i.created_by
      WHERE i.workspace_id = $1 AND i.multi_use AND i.revoked_at IS NULL AND i.redeemed_by IS NULL
        AND i.expires_at > $2 AND ${LIVE_BOARD}
      ORDER BY i.created_at DESC, i.id
      LIMIT ${ADMIN_LIMITS.pageSize + 1}`,
    [wid, now],
  )
  const guests = await q.query<{ id: string; name: string; joined_at: Date; grants: number }>(
    `SELECT u.id, u.name, wm.created_at AS joined_at, count(*)::int AS grants
       FROM workspace_members wm
       JOIN users u ON u.id = wm.user_id AND u.kind = 'guest'
       JOIN board_members bm ON bm.user_id = u.id
       JOIN boards b ON b.id = bm.board_id AND b.workspace_id = wm.workspace_id
      WHERE wm.workspace_id = $1 AND ${LIVE_BOARD}
      GROUP BY u.id, u.name, wm.created_at
      ORDER BY wm.created_at DESC, u.id
      LIMIT ${ADMIN_LIMITS.pageSize + 1}`,
    [wid],
  )
  const shownGuests = guests.rows.slice(0, ADMIN_LIMITS.pageSize)
  const boards = shownGuests.length
    ? await q.query<{ user_id: string; id: string; title: string; n: number }>(
        `SELECT g.user_id, g.id, g.title, g.n FROM (
           SELECT bm.user_id, b.id, b.title,
                  row_number() OVER (PARTITION BY bm.user_id ORDER BY bm.created_at DESC, b.id) AS n
             FROM board_members bm JOIN boards b ON b.id = bm.board_id
            WHERE b.workspace_id = $1 AND ${LIVE_BOARD} AND bm.user_id = ANY($2::text[])
         ) g WHERE g.n <= ${ADMIN_LIMITS.guestBoards}
         ORDER BY g.user_id, g.n`,
        [wid, shownGuests.map((g) => g.id)],
      )
    : { rows: [] }
  return {
    links: links.rows.slice(0, ADMIN_LIMITS.pageSize).map(
      (r): AdminLink => ({
        id: r.id,
        board: { id: r.board_id, title: r.title },
        kind: linkKind(r.role, r.landing),
        role: r.role,
        allowGuests: r.allow_guests,
        hasJoinCode: r.has_code,
        createdBy: { id: r.created_by, name: cleanName(r.creator_name) },
        createdAt: r.created_at.toISOString(),
        expiresAt: r.expires_at.toISOString(),
        uses: Number(r.use_count),
        maxUses: r.max_uses,
      }),
    ),
    guests: shownGuests.map(
      (g): AdminGuest => ({
        user: { id: g.id, name: cleanName(g.name) },
        grants: Number(g.grants),
        boards: boards.rows.filter((b) => b.user_id === g.id).map((b) => ({ id: b.id, title: b.title })),
        joinedAt: g.joined_at.toISOString(),
      }),
    ),
    more: links.rows.length > ADMIN_LIMITS.pageSize || guests.rows.length > ADMIN_LIMITS.pageSize,
  }
}

// ---- retention (W5-5) -----------------------------------------------------------------------------------------------

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * What Lobby keeps and for how long, as this api knows it (its code and its environment) or as the docs say (the
 * sync server's board backups: their settings are not visible to the api). Read-only: nothing here deletes anything.
 */
export function retentionFacts(ctx: FeatureContext): AdminRetentionFact[] {
  const gc = ctx.config.storage.assetGc.mode
  return [
    {
      id: 'trash',
      label: 'Boards in the trash',
      value: 'Kept until restored (never deleted automatically)',
      source: 'code',
    },
    {
      id: 'checkpoints.hourly',
      label: 'Automatic checkpoints, recent',
      value: `One an hour for ${plural(CHECKPOINT_RETENTION.hourlyHours, 'hour')}`,
      source: 'code',
    },
    {
      id: 'checkpoints.daily',
      label: 'Automatic checkpoints, then',
      value: `One a day until ${plural(CHECKPOINT_RETENTION.dailyDays, 'day')}`,
      source: 'code',
    },
    {
      id: 'checkpoints.weekly',
      label: 'Automatic checkpoints, older',
      value: `One a week until ${plural(CHECKPOINT_RETENTION.weeklyDays, 'day')}, then removed. Checkpoints saved by hand are kept.`,
      source: 'code',
    },
    {
      id: 'asset-gc',
      label: 'Files no board shows',
      value:
        gc === 'delete'
          ? `Deleted ${plural(ASSET_GC_GRACE_DAYS, 'day')} after nothing shows them`
          : gc === 'report'
            ? `Listed after ${plural(ASSET_GC_GRACE_DAYS, 'day')}, never deleted (report only)`
            : 'Kept (the file check is off)',
      source: 'env',
    },
    {
      id: 'visits',
      label: 'When each person last opened a board (private to them)',
      value: plural(ctx.config.visitsRetentionDays, 'day'),
      source: 'env',
    },
    {
      id: 'library.deleted',
      label: 'Deleted library items',
      value: `Restorable for ${plural(LIBRARY_LIMITS.restoreDays, 'day')}, then removed`,
      source: 'code',
    },
    {
      id: 'imports.listed',
      label: 'Imports in the import list',
      value: plural(IMPORT_TIMING.listDays, 'day'),
      source: 'code',
    },
    {
      id: 'chat.outbox',
      label: 'Chat notifications sent or waiting',
      value: plural(CHAT_DELIVERY.retentionDays, 'day'),
      source: 'code',
    },
    {
      id: 'audit',
      label: 'This audit log',
      value: 'Kept (no automatic removal)',
      source: 'code',
    },
    {
      id: 'board.backups',
      label: 'Board backups',
      value:
        'Every 15 minutes while a board changes: the newest 12 on the server, offsite copies for 14 days',
      source: 'documented',
    },
  ]
}
