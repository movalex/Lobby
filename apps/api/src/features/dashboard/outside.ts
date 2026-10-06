// Outside markers (wave J, J1; owner decisions 2026-10-05, @draftroom/contracts outside.ts): who on a
// board is outside Dark Burn Creative and Trailer Park Group, the "Shared outside" marker, the "Internal
// only" switch's refusals, and the bell notice when an outside account first joins a board.
//
// Everything is decided from the stored verified addresses that make someone a creator
// (auth/creator-sql.ts), never from a request:
// - OutsideInfo (outside: true | false | 'unconfirmed', the primary address's domain and its masked
//   form) goes only to callers who may manage access: the access-request list, the Share dialog's
//   member list, the workspace member list for owners and admins and (with ?boardId=) for a manager of
//   that board, the address check. `User` stays clean. `canOwn` is NOT the signal (a name-only guest
//   and a never-checked account both differ from it; the audit's AUTHZ-NO-OUTSIDER-SIGNAL / INV-1 /
//   BRW-1). A stale account whose stored addresses qualify reads `false` (no tag, no confirm for a
//   colleague who has not opened Lobby for a day): every decision re-checks it (refreshTarget, the
//   team rule, the internal-only refusals).
// - The plain "External" list (no domain unless the caller manages access) is for everyone who can
//   view the board: cursors, the people list, the @mention picker (RT-02).
// - "Internal only" (0025): while a workspace or a project is internal only, inviting an outside
//   address, approving an outside account's request, giving an outside account a grant or a higher
//   role, and creating, extending or opening to guests a review, workshop or guest link are refused
//   with 409 INTERNAL_ONLY, and so is accepting an invitation or a link there (an older one included)
//   by anyone who is not a confirmed creator (routes/invitations.ts). Nothing that exists is removed:
//   the remaining outside access, pending outside invitations included, is listed for the owners.
//   The refusals for routes this workstream does not own (PUT board members, PATCH workspace members,
//   the email invite, a link's extend and PATCH) sit in root preHandler hooks below (the api refuses
//   to start if one of their routes is missing: assertHookRoutes), after the route's own permission
//   checks and only for a creator caller (a non-creator is refused by the route itself, so the hook
//   reveals nothing new);
//   createInvitation, review-link creation and access-request approval check in their transactions.

import {
  AddressCheckInput,
  type AddressCheckResult,
  BOARD_OUTSIDE_PEOPLE_MAX,
  type BoardOutsidePeople,
  cleanDisplayText,
  EmailInviteInput,
  ExtendReviewLinkInput,
  INTERNAL_ONLY_CODE,
  INTERNAL_ONLY_MESSAGES,
  type InternalOnlyScope,
  type OutsideAccessInvitation,
  type OutsideAccessLink,
  type OutsideAccessPerson,
  type OutsideInfo,
  PatchWorkspaceMemberInput,
  PutMemberInput,
  UpdateReviewLinkInput,
} from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import {
  BOARD_ROLES,
  type BoardRole,
  can,
  canManageWorkspace,
  WORKSPACE_ROLES,
  type WorkspaceRole,
} from '@draftroom/permissions'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { isBoardId, isUserId, isWorkspaceId, loadBoardAccess, requireBoardAction } from '../../access.ts'
import {
  type CreatorLookup,
  knownOutsideSql,
  matchParams,
  originColumns,
  userParams,
} from '../../auth/creator-sql.ts'
import { emailDomain, isCreatorEmail, normalizeEmail } from '../../auth/creators.ts'
import type { IdentityService } from '../../auth/identity.ts'
import type { AppContext, Params } from '../../context.ts'
import { ApiError, parse } from '../../errors.ts'
import { keyedLimit, type RouteRateLimit } from '../../rate-limit.ts'
import { toUser, type UserRow } from '../../serialize.ts'
import type { FeatureContext } from '../context.ts'
import { trySavepoint } from './shared.ts'

// ---- OutsideInfo ---------------------------------------------------------------------------------

interface OriginRow {
  o_id: string
  o_kind: string
  o_checked_at: Date | null
  o_creator: boolean
  o_qualifies: boolean
  o_email: string | null
}

/** What `identity` and `now` give every helper here (AppContext and FeatureContext both have them). */
export interface OutsideDeps {
  identity: Pick<IdentityService, 'lookup' | 'isCreatorUser' | 'refreshTarget'>
  now: () => Date
}

/** The invite page's mask (routes/invitations.ts maskEmail): `jane@client.example` → `j•••@client.example`. */
const maskAddress = (email: string) => `${email.slice(0, 1)}•••@${emailDomain(email)}`

function toInfo(r: OriginRow): OutsideInfo {
  if (r.o_kind === 'guest') return { outside: true, emailDomain: null, emailHint: null }
  const email = r.o_email
  // A stale account whose addresses qualify: false (see the header); never checked: 'unconfirmed'.
  const outside: OutsideInfo['outside'] =
    r.o_creator || (r.o_checked_at !== null && r.o_qualifies)
      ? false
      : r.o_checked_at !== null
        ? true
        : 'unconfirmed'
  return {
    outside,
    emailDomain: email ? emailDomain(email) : null,
    emailHint: email ? maskAddress(email) : null,
  }
}

/** OutsideInfo for these users, one query (unknown ids are left out). Manager-only data: never logged. */
export async function originAmong(
  q: Queryable,
  deps: OutsideDeps,
  userIds: readonly string[],
): Promise<Map<string, OutsideInfo>> {
  const out = new Map<string, OutsideInfo>()
  const ids = [...new Set(userIds)]
  if (!ids.length) return out
  const rows = await q.query<OriginRow>(
    `SELECT ${originColumns(2)} FROM users u WHERE u.id = ANY($1::text[])`,
    [ids, ...userParams(deps.identity.lookup, deps.now())],
  )
  for (const r of rows.rows) out.set(r.o_id, toInfo(r))
  return out
}

/**
 * A display name as the manager lists show it (access requests, the Share dialog, the workspace's
 * people): without control, bidi or zero-width characters, so a look-alike of a colleague's name reads
 * as what it is. Names are cleaned on input too (contracts cleanDisplayText); this covers names stored
 * before that, and provider names (BRW-1).
 */
export const cleanName = (name: string): string => cleanDisplayText(name) || 'Someone'

/** The manager-only fields as they go on a list row. */
export const outsideFieldsOf = (info: OutsideInfo | undefined): Partial<OutsideInfo> =>
  info ? { outside: info.outside, emailDomain: info.emailDomain, emailHint: info.emailHint } : {}

// ---- "Shared outside" and the board's outside people --------------------------------------------

/** A known outside account or a name-only guest (`alias` a users row); 3 parameters from `first`. */
const outsideOrGuestSql = (alias: string, first: number) =>
  `(${alias}.kind = 'guest' OR ${knownOutsideSql(alias, first)})`

/**
 * The boards (of these ids) that are shared outside: a known outside account or a name-only guest can
 * open it (a grant, or owner/admin of its workspace, or member while it is not private), or a review,
 * workshop or guest link is open. One query.
 */
export async function sharedOutsideAmong(
  q: Queryable,
  lookup: CreatorLookup,
  at: Date,
  boardIds: readonly string[],
): Promise<Set<string>> {
  const ids = [...new Set(boardIds)].filter(isBoardId)
  if (!ids.length) return new Set()
  const rows = await q.query<{ id: string }>(
    `SELECT b.id FROM boards b
      WHERE b.id = ANY($1::text[]) AND (
        EXISTS (SELECT 1 FROM invitations i
                 WHERE i.board_id = b.id AND i.workspace_id = b.workspace_id AND i.multi_use
                   AND i.revoked_at IS NULL AND i.expires_at > $2)
        OR EXISTS (SELECT 1 FROM board_members bm
                     JOIN workspace_members wm ON wm.workspace_id = b.workspace_id AND wm.user_id = bm.user_id
                     JOIN users u ON u.id = bm.user_id
                    WHERE bm.board_id = b.id AND ${outsideOrGuestSql('u', 3)})
        OR EXISTS (SELECT 1 FROM workspace_members wm JOIN users u ON u.id = wm.user_id
                    WHERE wm.workspace_id = b.workspace_id
                      AND (wm.role IN ('owner', 'admin') OR (wm.role = 'member' AND b.visibility <> 'private'))
                      AND ${outsideOrGuestSql('u', 3)}))`,
    [ids, at, ...matchParams(lookup)],
  )
  return new Set(rows.rows.map((r) => r.id))
}

/** The known outside ACCOUNTS (no name-only guests) who can open the board, with their email domain. */
export async function outsidePeopleOn(
  q: Queryable,
  lookup: CreatorLookup,
  board: { id: string; workspace_id: string; visibility: string },
): Promise<{ userId: string; emailDomain: string | null }[]> {
  const rows = await q.query<{ id: string; domain: string | null }>(
    `SELECT u.id,
            (SELECT e.domain FROM user_emails e WHERE e.user_id = u.id AND e.source = $4::text
              ORDER BY e.is_primary DESC, e.seen_at, e.email LIMIT 1) AS domain
       FROM workspace_members wm
       JOIN users u ON u.id = wm.user_id
       LEFT JOIN board_members bm ON bm.board_id = $1 AND bm.user_id = wm.user_id
      WHERE wm.workspace_id = $2
        AND (wm.role IN ('owner', 'admin') OR bm.role IS NOT NULL OR (wm.role = 'member' AND $3::text <> 'private'))
        AND ${knownOutsideSql('u', 4)}
      ORDER BY u.id
      LIMIT ${BOARD_OUTSIDE_PEOPLE_MAX}`,
    [board.id, board.workspace_id, board.visibility, ...matchParams(lookup)],
  )
  return rows.rows.map((r) => ({ userId: r.id, emailDomain: r.domain }))
}

/** Of these users, the ones Lobby knows are outside accounts (comment authors' "External" tag). */
export async function knownOutsideAmong(
  q: Queryable,
  lookup: CreatorLookup,
  userIds: readonly string[],
): Promise<Set<string>> {
  const ids = [...new Set(userIds)]
  if (!ids.length) return new Set()
  const rows = await q.query<{ id: string }>(
    `SELECT u.id FROM users u WHERE u.id = ANY($1::text[]) AND ${knownOutsideSql('u', 2)}`,
    [ids, ...matchParams(lookup)],
  )
  return new Set(rows.rows.map((r) => r.id))
}

// ---- "Internal only" -----------------------------------------------------------------------------

export const internalOnlyRefused = (scope: InternalOnlyScope) =>
  new ApiError(409, INTERNAL_ONLY_CODE, INTERNAL_ONLY_MESSAGES[scope])

/** Whether a board's workspace (first) or project is internal only; null when neither (or no board). */
export async function boardInternalOnly(q: Queryable, boardId: string): Promise<InternalOnlyScope | null> {
  if (!isBoardId(boardId)) return null
  const row = await q.maybeOne<{ ws: boolean; prj: boolean | null }>(
    `SELECT w.internal_only AS ws, p.internal_only AS prj
       FROM boards b JOIN workspaces w ON w.id = b.workspace_id
       LEFT JOIN projects p ON p.id = b.project_id AND p.workspace_id = b.workspace_id
      WHERE b.id = $1`,
    [boardId],
  )
  if (!row) return null
  return row.ws ? 'workspace' : row.prj ? 'project' : null
}

export async function workspaceInternalOnly(q: Queryable, workspaceId: string): Promise<boolean> {
  if (!isWorkspaceId(workspaceId)) return false
  const row = await q.maybeOne<{ ws: boolean }>('SELECT internal_only AS ws FROM workspaces WHERE id = $1', [
    workspaceId,
  ])
  return row?.ws === true
}

/** The scope an invitation falls in: a board's (workspace or project), or a workspace invitation's. */
async function invitationScope(
  q: Queryable,
  target: { boardId: string | null; workspaceId: string },
): Promise<InternalOnlyScope | null> {
  if (target.boardId !== null) return boardInternalOnly(q, target.boardId)
  return (await workspaceInternalOnly(q, target.workspaceId)) ? 'workspace' : null
}

/** The internal-only scope an invitation row falls in (null: none is on). */
export const internalOnlyScopeOf = (
  q: Queryable,
  inv: { board_id: string | null; workspace_id: string },
): Promise<InternalOnlyScope | null> =>
  invitationScope(q, { boardId: inv.board_id, workspaceId: inv.workspace_id })

/**
 * createInvitation's guard (routes/invitations.ts; every single-use invitation, the email route's
 * links included): an address that is not a creator address cannot be invited while the scope is
 * internal only. `email` is already normalised.
 */
export async function assertInviteAllowed(
  q: Queryable,
  deps: Pick<OutsideDeps, 'identity'>,
  target: { boardId: string | null; workspaceId: string },
  email: string,
): Promise<void> {
  const { policy, devDomain } = deps.identity.lookup
  if (isCreatorEmail(email, policy, devDomain)) return
  const scope = await invitationScope(q, target)
  if (scope) throw internalOnlyRefused(scope)
}

/**
 * Giving `userId` access (an approval, a new or higher grant) while the board is internal only: only
 * to a confirmed creator (an unconfirmed account fails closed). Stored status; call in the transaction.
 */
export async function assertRaiseAllowed(
  q: Queryable,
  deps: Pick<OutsideDeps, 'identity'>,
  boardId: string,
  userId: string,
): Promise<void> {
  const scope = await boardInternalOnly(q, boardId)
  if (scope && !(await deps.identity.isCreatorUser(q, userId))) throw internalOnlyRefused(scope)
}

/**
 * Accepting an invitation or a link (routes/invitations.ts; joining as a name-only guest goes through
 * the same check): while its board's workspace or project (a workspace invitation: the workspace) is
 * internal only, only a confirmed creator may redeem it, however old the invitation is. Stored status
 * (the accept route confirmed the caller's addresses before its transaction for an email-locked one);
 * call in the transaction. Removes nothing.
 */
export async function assertRedeemAllowed(
  q: Queryable,
  deps: Pick<OutsideDeps, 'identity'> | null,
  inv: { board_id: string | null; workspace_id: string },
  userId: string,
): Promise<void> {
  const scope = await internalOnlyScopeOf(q, inv)
  if (!scope) return
  // deps null: a name-only guest (never a creator).
  if (!deps || !(await deps.identity.isCreatorUser(q, userId))) throw internalOnlyRefused(scope)
}

/** Review, workshop and guest links: none while the board is internal only. */
export async function assertLinksAllowed(q: Queryable, boardId: string): Promise<void> {
  const scope = await boardInternalOnly(q, boardId)
  if (scope) throw internalOnlyRefused(scope)
}

/**
 * What still reaches a workspace's boards from outside (GET /api/workspaces/:wid/internal-only, owners
 * and admins): the known outside accounts among its members, with their board grants (boards not in
 * the trash), and the open review, workshop and guest links. Listed so a manager can remove them; the
 * switch itself never does.
 */
export async function outsideAccessIn(
  q: Queryable,
  deps: OutsideDeps,
  workspaceId: string,
): Promise<{
  people: OutsideAccessPerson[]
  links: OutsideAccessLink[]
  invitations: OutsideAccessInvitation[]
}> {
  const { lookup } = deps.identity
  const members = await q.query<UserRow & { role: WorkspaceRole }>(
    `SELECT u.id, u.name, u.handle, u.color, u.avatar_url, wm.role
       FROM workspace_members wm JOIN users u ON u.id = wm.user_id
      WHERE wm.workspace_id = $1 AND ${knownOutsideSql('u', 2)}
      ORDER BY u.name, u.id
      LIMIT ${BOARD_OUTSIDE_PEOPLE_MAX}`,
    [workspaceId, ...matchParams(lookup)],
  )
  const ids = members.rows.map((m) => m.id)
  const origin = await originAmong(q, deps, ids)
  const grants = ids.length
    ? await q.query<{ user_id: string; id: string; title: string; project_id: string | null; role: string }>(
        `SELECT bm.user_id, b.id, b.title, b.project_id, bm.role
           FROM board_members bm JOIN boards b ON b.id = bm.board_id
          WHERE b.workspace_id = $1 AND b.status <> 'trashed' AND bm.user_id = ANY($2::text[])
          ORDER BY b.title, b.id`,
        [workspaceId, ids],
      )
    : { rows: [] }
  const people: OutsideAccessPerson[] = members.rows.map(({ role, ...u }) => {
    const info = origin.get(u.id)
    return {
      user: { ...toUser(u), name: cleanName(u.name) },
      outside: info?.outside ?? true,
      emailDomain: info?.emailDomain ?? null,
      emailHint: info?.emailHint ?? null,
      workspaceRole: role,
      boards: grants.rows
        .filter((g) => g.user_id === u.id)
        .map((g) => ({ id: g.id, title: g.title, projectId: g.project_id, role: g.role })),
    }
  })
  const links = await q.query<{
    id: string
    board_id: string
    title: string
    project_id: string | null
    role: string
    expires_at: Date
    allow_guests: boolean
  }>(
    `SELECT i.id, i.board_id, b.title, b.project_id, i.role, i.expires_at, i.allow_guests
       FROM invitations i JOIN boards b ON b.id = i.board_id AND b.workspace_id = i.workspace_id
      WHERE i.workspace_id = $1 AND i.multi_use AND i.revoked_at IS NULL AND i.expires_at > $2
        AND b.status <> 'trashed'
      ORDER BY i.expires_at, i.id
      LIMIT 200`,
    [workspaceId, deps.now()],
  )
  // Pending single-use invitations (locked to an address) whose address is outside: nobody outside can
  // accept them while the scope is internal only, and they are listed to be revoked. Board invitations
  // (not in the trash) and workspace invitations; the policy decides in code (the exceptions list).
  const pending = await q.query<{
    id: string
    board_id: string | null
    title: string | null
    project_id: string | null
    role: string
    expires_at: Date
    invited_email: string
  }>(
    `SELECT i.id, i.board_id, b.title, b.project_id, i.role, i.expires_at, i.invited_email
       FROM invitations i LEFT JOIN boards b ON b.id = i.board_id AND b.workspace_id = i.workspace_id
      WHERE i.workspace_id = $1 AND NOT i.multi_use AND i.invited_email IS NOT NULL
        AND i.redeemed_by IS NULL AND i.revoked_at IS NULL AND i.expires_at > $2
        AND (i.board_id IS NULL OR (b.id IS NOT NULL AND b.status <> 'trashed'))
      ORDER BY i.expires_at, i.id
      LIMIT 500`,
    [workspaceId, deps.now()],
  )
  const { policy, devDomain } = lookup
  const invitations: OutsideAccessInvitation[] = pending.rows
    .filter((i) => !isCreatorEmail(i.invited_email, policy, devDomain))
    .slice(0, 200)
    .map((i) => ({
      id: i.id,
      boardId: i.board_id,
      boardTitle: i.title,
      projectId: i.project_id,
      role: i.role,
      expiresAt: i.expires_at.toISOString(),
      emailDomain: emailDomain(i.invited_email),
      emailHint: maskAddress(i.invited_email),
    }))
  return {
    people,
    invitations,
    links: links.rows.map((l) => ({
      id: l.id,
      boardId: l.board_id,
      boardTitle: l.title,
      projectId: l.project_id,
      role: l.role,
      expiresAt: l.expires_at.toISOString(),
      allowGuests: l.allow_guests,
    })),
  }
}

/** An audit row for a switch change (audit.ts lists the M1 actions; this writes the same table). */
export async function auditInternalOnly(
  tx: Queryable,
  e: {
    workspaceId: string
    actorId: string
    scope: InternalOnlyScope
    target: string
    on: boolean
    at: Date
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO audit_events (workspace_id, actor_id, action, target, detail, at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [
      e.workspaceId,
      e.actorId,
      e.scope === 'workspace' ? 'workspace.internal_only' : 'project.internal_only',
      e.target,
      JSON.stringify({ internalOnly: e.on }),
      e.at,
    ],
  )
}

// ---- the bell notice: an outside account joined a board ------------------------------------------

/** pg_advisory_xact_lock namespace (the two-key form) of one board's outsider notices ("DROJ"). */
const OUTSIDER_LOCK_NS = 0x44524f4a
/** (board, user) pairs this process already handled, so a ticket refresh costs no query (bounded). */
const JOIN_CACHE_MAX = 20_000

/**
 * The first time a KNOWN outside account (not a name-only guest, not an unconfirmed one) opens a board,
 * its owners get an 'outsider_joined' bell item (the explicit owner grants of people still in the
 * workspace; the workspace's owners and admins when the board has none, like an access request). Once
 * per board and person, under a per-pair advisory lock. Best effort: never fails the caller.
 */
export async function notifyOutsiderJoined(
  ctx: Pick<FeatureContext, 'db' | 'identity' | 'now'>,
  boardId: string,
  userId: string,
): Promise<{ settled: boolean; inserted: number }> {
  const { db } = ctx
  const info = (await originAmong(db, ctx, [userId])).get(userId)
  // A creator never gets a notice (settled); an account Lobby cannot confirm yet might later (not settled).
  if (info?.outside !== true) return { settled: info?.outside === false, inserted: 0 }
  const inserted = await db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2::text))', [
      OUTSIDER_LOCK_NS,
      `${boardId}:${userId}`,
    ])
    const seen = await tx.maybeOne(
      `SELECT 1 AS ok FROM notifications WHERE kind = 'outsider_joined' AND board_id = $1 AND actor_id = $2 LIMIT 1`,
      [boardId, userId],
    )
    if (seen) return 0
    const board = await tx.maybeOne<{ workspace_id: string }>(
      'SELECT workspace_id FROM boards WHERE id = $1',
      [boardId],
    )
    if (!board) return 0
    const inserted = await trySavepoint(tx, async () => {
      const res = await tx.query(
        `WITH owners AS (
           SELECT bm.user_id FROM board_members bm
             JOIN workspace_members wm ON wm.workspace_id = $1 AND wm.user_id = bm.user_id
            WHERE bm.board_id = $2 AND bm.role = 'owner'
         ), recipients AS (
           SELECT user_id FROM owners
           UNION
           SELECT wm.user_id FROM workspace_members wm
            WHERE wm.workspace_id = $1 AND wm.role IN ('owner', 'admin') AND NOT EXISTS (SELECT 1 FROM owners)
         )
         INSERT INTO notifications (workspace_id, user_id, kind, board_id, actor_id, created_at)
         SELECT $1, user_id, 'outsider_joined', $2, $3, $4 FROM recipients WHERE user_id <> $3`,
        [board.workspace_id, boardId, userId, ctx.now()],
      )
      return res.rowCount
    })
    return inserted ?? 0
  })
  return { settled: true, inserted }
}

// ---- routes and hooks ----------------------------------------------------------------------------

const WS_RANK = Object.fromEntries(WORKSPACE_ROLES.map((r, i) => [r, i])) as Record<string, number>
const BOARD_RANK = Object.fromEntries(BOARD_ROLES.map((r, i) => [r, BOARD_ROLES.length - i])) as Record<
  BoardRole,
  number
>
const BOARD_LISTS = new Set(['/api/workspaces/:wid/boards', '/api/workspaces/:wid/boards/starred'])
const TICKET_ROUTE = '/api/boards/:bid/ticket'

/**
 * Address checks per caller (a creator who manages some board): the dialog asks once per address, so
 * this is far above real use and keeps anyone from walking a list of addresses against the policy
 * (the exceptions list). 429 RATE_LIMITED past it; the web then says so and invites nothing.
 */
export const ADDRESS_CHECKS_PER_USER: RouteRateLimit = { max: 30, timeWindow: 10 * 60_000 }

const routeKey = (req: FastifyRequest) => `${req.method} ${req.routeOptions.url ?? ''}`

export function registerOutsideRoutes(app: FastifyInstance, ctx: FeatureContext): void {
  const { db, now, identity, sessions } = ctx
  const addressChecks = keyedLimit(
    ADDRESS_CHECKS_PER_USER,
    now,
    'Too many address checks just now. Wait a few minutes and try again.',
  )

  // Everyone who can view the board: who on it is an outside account (the "External" tags), whether it
  // is shared outside, and whether it is internal only. The domain only for people who manage access.
  app.get('/api/boards/:bid/sharing/outside', async (req): Promise<BoardOutsidePeople> => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const access = await requireBoardAction(db, bid, user.id, 'view')
    const manager = can(access.role, 'manage_access', access.board.status)
    const people = await outsidePeopleOn(db, identity.lookup, access.board)
    const shared = await sharedOutsideAmong(db, identity.lookup, now(), [access.board.id])
    return {
      sharedOutside: shared.has(access.board.id),
      internalOnly: await boardInternalOnly(db, access.board.id),
      people: people.map((p) => ({ userId: p.userId, emailDomain: manager ? p.emailDomain : null })),
    }
  })

  // The Share dialog asks before it invites an outside address: the server's policy decides (the
  // exceptions list never reaches the web). Only people who could invite here ask (manage_access and a
  // creator), so nobody else learns whether an address is on the list. Nothing is logged.
  app.post('/api/boards/:bid/sharing/address-check', async (req): Promise<AddressCheckResult> => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const { email: typed } = parse(AddressCheckInput, req.body ?? {})
    const access = await requireBoardAction(db, bid, user.id, 'manage_access')
    await identity.requireCreator(db, user.id, 'share', { route: req.routeOptions.url ?? '', by: 'route' })
    // Counted only for callers who may ask (after both checks), so nobody else learns anything from it.
    addressChecks.take(user.id)
    const email = normalizeEmail(typed) ?? typed
    const { policy, devDomain } = identity.lookup
    const outside = !isCreatorEmail(email, policy, devDomain)
    return {
      email,
      outside,
      emailDomain: emailDomain(email),
      internalOnly: outside ? await boardInternalOnly(db, access.board.id) : null,
    }
  })

  // `sharedOutside` on the dashboard's board lists (M1's list and the starred one), added like the
  // `starred` flag (stars.ts): root hooks bind to every route at ready time; anything unexpected leaves
  // the payload as it is (the field then defaults to false in the web).
  app.addHook('preSerialization', async (req: FastifyRequest, reply, payload) => {
    if (req.method !== 'GET' || !BOARD_LISTS.has(req.routeOptions.url ?? '') || reply.statusCode !== 200)
      return payload
    const boards = (payload as { boards?: unknown } | null)?.boards
    if (!Array.isArray(boards)) return payload
    try {
      const ids = boards
        .map((b) => (b as { id?: unknown }).id)
        .filter((id): id is string => typeof id === 'string')
      const shared = await sharedOutsideAmong(db, identity.lookup, now(), ids)
      return {
        ...(payload as object),
        boards: boards.map((b) => ({
          ...(b as object),
          sharedOutside: shared.has((b as { id: string }).id),
        })),
      }
    } catch (e) {
      req.log.warn({ err: { name: (e as Error)?.name } }, 'sharedOutside flag not added')
      return payload
    }
  })

  // The bell notice: a ticket is minted when someone opens (or reconnects to) a board. Once per board
  // and person, after the reply; a failure only loses the notice.
  const handled = new Set<string>()
  app.addHook('onResponse', async (req, reply) => {
    if (req.method !== 'POST' || req.routeOptions.url !== TICKET_ROUTE || reply.statusCode !== 200) return
    const { bid = '' } = req.params as Params
    try {
      const user = await sessions.user(req)
      if (!user || user.kind === 'guest' || !isBoardId(bid)) return
      const key = `${bid}:${user.id}`
      if (handled.has(key)) return
      const { settled } = await notifyOutsiderJoined(ctx, bid, user.id)
      if (!settled) return // unconfirmed: ask again at the next ticket
      if (handled.size >= JOIN_CACHE_MAX) handled.clear()
      handled.add(key)
    } catch (e) {
      req.log.warn(
        { evt: 'outsider_joined.failed', err: { name: (e as Error)?.name } },
        'outsider notice not sent',
      )
    }
  })

  // "Internal only" for the routes other workstreams own. Each decides only after the route's own
  // permission check would pass and only for a creator caller (anyone else gets the route's own answer,
  // so this reveals nothing), and only refuses what hands outside access out.
  app.addHook('preHandler', async (req) => {
    const key = routeKey(req)
    const rule = INTERNAL_ONLY_HOOKS[key]
    if (!rule) return
    const caller = await sessions.user(req)
    if (!caller || caller.kind === 'guest') return
    await rule(req, caller.id)
  })

  /** The board's manager who is a creator, or null (the route then answers for itself). */
  async function creatorManager(bid: string, callerId: string) {
    const access = await loadBoardAccess(db, bid, callerId)
    if (!access || !can(access.role, 'manage_access', access.board.status)) return null
    if (!(await identity.isCreatorUser(db, callerId))) return null
    return access
  }

  /** A target confirmed first when unknown or stale (never throws), then decided on stored data. */
  async function targetIsCreator(userId: string): Promise<boolean> {
    if (await identity.isCreatorUser(db, userId)) return true
    await identity.refreshTarget(userId)
    return identity.isCreatorUser(db, userId)
  }

  app.addHook('onReady', async () => {
    assertHookRoutes(app, [
      ...Object.keys(INTERNAL_ONLY_HOOKS),
      ...[...BOARD_LISTS].map((url) => `GET ${url}`),
      `POST ${TICKET_ROUTE}`,
    ])
  })

  const INTERNAL_ONLY_HOOKS: Record<string, (req: FastifyRequest, callerId: string) => Promise<void>> = {
    // A new or higher board grant for an outside account (lowering, keeping and owner are the route's).
    'PUT /api/boards/:bid/members/:uid': async (req, callerId) => {
      const { bid = '', uid = '' } = req.params as Params
      const body = PutMemberInput.safeParse(req.body)
      if (!body.success || body.data.role === 'owner' || !isUserId(uid)) return
      const scope = await boardInternalOnly(db, bid)
      if (!scope) return
      const access = await creatorManager(bid, callerId)
      if (!access) return
      const target = await db.maybeOne<{ grant: BoardRole | null }>(
        `SELECT bm.role AS grant FROM workspace_members wm
           LEFT JOIN board_members bm ON bm.board_id = $1 AND bm.user_id = wm.user_id
          WHERE wm.workspace_id = $2 AND wm.user_id = $3`,
        [bid, access.board.workspace_id, uid],
      )
      if (!target) return
      if (target.grant !== null && BOARD_RANK[body.data.role] <= BOARD_RANK[target.grant]) return
      if (!(await targetIsCreator(uid))) throw internalOnlyRefused(scope)
    },
    // Raising an outside account's workspace role (guest to member; admin and owner are creator-only).
    'PATCH /api/workspaces/:wid/members/:uid': async (req, callerId) => {
      const { wid = '', uid = '' } = req.params as Params
      const body = PatchWorkspaceMemberInput.safeParse(req.body)
      if (!body.success || !isUserId(uid) || !(await workspaceInternalOnly(db, wid))) return
      const role = body.data.role
      if (role === 'owner' || role === 'admin') return
      const rows = await db.query<{ user_id: string; role: WorkspaceRole }>(
        'SELECT user_id, role FROM workspace_members WHERE workspace_id = $1 AND user_id = ANY($2::text[])',
        [wid, [callerId, uid]],
      )
      const callerRole = rows.rows.find((r) => r.user_id === callerId)?.role ?? null
      const targetRole = rows.rows.find((r) => r.user_id === uid)?.role ?? null
      if (!canManageWorkspace(callerRole) || targetRole === null) return
      if ((WS_RANK[role] ?? 9) >= (WS_RANK[targetRole] ?? 9)) return
      if (!(await identity.isCreatorUser(db, callerId))) return
      if (!(await targetIsCreator(uid))) throw internalOnlyRefused('workspace')
    },
    // The email invite (its "granted" path gives an existing account the role at once).
    'POST /api/boards/:bid/invitations/email': async (req, callerId) => {
      const { bid = '' } = req.params as Params
      const body = EmailInviteInput.safeParse(req.body)
      if (!body.success) return
      const scope = await boardInternalOnly(db, bid)
      if (!scope || !(await creatorManager(bid, callerId))) return
      const email = normalizeEmail(body.data.email)
      const { policy, devDomain } = identity.lookup
      if (email !== null && !isCreatorEmail(email, policy, devDomain)) throw internalOnlyRefused(scope)
    },
    // A link that exists: no more time, and no opening it to name-only guests, while internal only.
    'POST /api/boards/:bid/review-links/:id/extend': async (req, callerId) => {
      const { bid = '' } = req.params as Params
      if (!ExtendReviewLinkInput.safeParse(req.body ?? {}).success) return
      const scope = await boardInternalOnly(db, bid)
      if (scope && (await creatorManager(bid, callerId))) throw internalOnlyRefused(scope)
    },
    'PATCH /api/boards/:bid/review-links/:id': async (req, callerId) => {
      const { bid = '' } = req.params as Params
      const body = UpdateReviewLinkInput.safeParse(req.body)
      if (!body.success || !body.data.allowGuests) return
      const scope = await boardInternalOnly(db, bid)
      if (scope && (await creatorManager(bid, callerId))) throw internalOnlyRefused(scope)
    },
  }
}

/** For callers outside this module (createInvitation) that only have an AppContext. */
export const outsideDepsOf = (ctx: AppContext): OutsideDeps => ({ identity: ctx.identity, now: ctx.now })

/**
 * The routes this module's root hooks key on, by `METHOD pattern`, other workstreams' routes among them:
 * the api refuses to start when one of them is not registered (a rename would otherwise turn a guard
 * off without a sound). Checked at ready time, when every route exists.
 */
export function assertHookRoutes(app: FastifyInstance, keys: readonly string[]): void {
  const missing = keys.filter((key) => {
    const space = key.indexOf(' ')
    const method = key.slice(0, space) as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    return !app.hasRoute({ method, url: key.slice(space + 1) })
  })
  if (missing.length)
    throw new Error(`outside markers: hooked routes are not registered: ${missing.join(', ')}`)
}
