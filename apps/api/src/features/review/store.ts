// OWNER: WS1 (wave S, review status; docs/WAVE-S-CONTRACTS.md §2). The review store: rows of review_items,
// review_events and review_rounds (migration 0037) shaped into the public contracts (@draftroom/contracts review.ts),
// who did it as it was then, the history, and the review_status notifications with their chat outbox rows.
//
// Every write here runs in the caller's transaction. The board row is never locked here (the routes take it first
// when they must: the lock order of access.ts); an item row is locked FOR UPDATE before it changes, items in id
// order when there are several (a round start, a new-version reset), so two writers never wait on each other in a
// cycle. Every board-scoped query filters by board AND workspace, and the board reads name
// `status IN ('active', 'archived')` (the importing-board tripwire).

import {
  cleanDisplayText,
  REVIEW_LIMITS,
  type ReviewActor,
  type ReviewActorKind,
  type ReviewEvent,
  type ReviewEventKind,
  type ReviewItem,
  type ReviewItemKind,
  type ReviewRound,
  type ReviewStatus,
  type ReviewStatusReason,
} from '@draftroom/contracts'
import { newId, type Queryable } from '@draftroom/db'
import type { BoardRow } from '../../access.ts'
import { type CreatorLookup, knownOutsideSql, matchParams } from '../../auth/creator-sql.ts'
import { enqueueChatDeliveries } from '../chat-hooks/outbox.ts'
import { boardOwners } from '../comments/notifications.ts'
import { idList, viewersAmong } from '../comments/store.ts'

const iso = (d: Date | null) => (d ? d.toISOString() : null)

// ---- the actor --------------------------------------------------------------------------------------------------

/** The session's user as a review event records them, read from users in the write's own transaction. */
export interface ReviewActorRow {
  id: string
  /** as typed for a guest (users.guest_name), else users.name; cleaned and cut to 120 */
  name: string
  kind: ReviewActorKind
  external: boolean
}

const ACTOR_NAME_MAX = 120

/** A display name as an event stores it: no control, bidi or zero-width characters; 1..120 characters. */
export function storedActorName(raw: string | null | undefined): string {
  const clean = cleanDisplayText(raw ?? '').trim()
  const chars = [...clean]
  const cut = chars.length > ACTOR_NAME_MAX ? chars.slice(0, ACTOR_NAME_MAX).join('').trim() : clean
  return cut || 'Someone'
}

/**
 * The actor, from users: its kind (never from the request: anything but 'account' or 'guest' fails closed, null),
 * a guest's typed name (never users.name, which already ends in " (guest)"), and wave J's "known outside" for an
 * account (null `lookup`: false). Null when the user row is gone.
 */
export async function loadActor(
  q: Queryable,
  userId: string,
  lookup: CreatorLookup | null,
): Promise<ReviewActorRow | null> {
  const row = await q.maybeOne<{
    id: string
    name: string
    guest_name: string | null
    kind: string
    external: boolean | null
  }>(
    lookup
      ? `SELECT u.id, u.name, u.guest_name, u.kind, ${knownOutsideSql('u', 2)} AS external FROM users u WHERE u.id = $1`
      : 'SELECT u.id, u.name, u.guest_name, u.kind, false AS external FROM users u WHERE u.id = $1',
    lookup ? [userId, ...matchParams(lookup)] : [userId],
  )
  if (!row || (row.kind !== 'account' && row.kind !== 'guest')) return null
  const guest = row.kind === 'guest'
  return {
    id: row.id,
    name: storedActorName(guest ? (row.guest_name ?? row.name) : row.name),
    kind: guest ? 'guest' : 'account',
    external: !guest && row.external === true,
  }
}

// ---- rows and their contracts -------------------------------------------------------------------------------------

export interface ItemRow {
  id: string
  workspace_id: string
  board_id: string
  element_id: string
  kind: ReviewItemKind
  asset_id: string | null
  label: string
  position: number | null
  round_id: string | null
  status: ReviewStatus
  status_seq: string | number
  status_by: string | null
  status_at: Date | null
  status_version_id: string | null
  created_by: string | null
  created_at: Date
  removed_at: Date | null
  /** the last status event's actor, as it was then (null: no status event kept) */
  by_id: string | null
  by_name: string | null
  by_kind: ReviewActorKind | null
  by_external: boolean | null
}

const ITEM_COLUMNS = `i.id, i.workspace_id, i.board_id, i.element_id, i.kind, i.asset_id, i.label, i.position, i.round_id,
  i.status, i.status_seq, i.status_by, i.status_at, i.status_version_id, i.created_by, i.created_at, i.removed_at,
  lastev.actor_id AS by_id, lastev.actor_name AS by_name, lastev.actor_kind AS by_kind,
  lastev.actor_external AS by_external`
const ITEM_FROM = `review_items i
  LEFT JOIN LATERAL (
    SELECT e.actor_id, e.actor_name, e.actor_kind, e.actor_external FROM review_events e
     WHERE e.item_id = i.id AND e.kind = 'status' ORDER BY e.seq DESC LIMIT 1
  ) lastev ON true`

const actorOf = (
  id: string | null,
  name: string | null,
  kind: ReviewActorKind | null,
  external: boolean | null,
): ReviewActor => ({
  id,
  name: cleanDisplayText(name ?? '') || 'Someone',
  kind: kind === 'guest' ? 'guest' : 'account',
  external: external === true,
})

export function toItem(r: ItemRow): ReviewItem {
  return {
    id: r.id,
    boardId: r.board_id,
    elementId: r.element_id,
    kind: r.kind,
    assetId: r.asset_id,
    label: cleanDisplayText(r.label) || 'Untitled',
    position: r.position,
    roundId: r.round_id,
    status: r.status,
    statusSeq: Number(r.status_seq),
    statusBy:
      Number(r.status_seq) > 0 && r.by_name !== null
        ? actorOf(r.by_id, r.by_name, r.by_kind, r.by_external)
        : null,
    statusAt: iso(r.status_at),
    statusVersionId: r.status_version_id,
    createdAt: r.created_at.toISOString(),
    removedAt: iso(r.removed_at),
  }
}

export interface EventRow {
  id: string
  workspace_id: string
  board_id: string
  item_id: string | null
  round_id: string | null
  kind: ReviewEventKind
  status: ReviewStatus | null
  previous_status: ReviewStatus | null
  reason: ReviewStatusReason | null
  version_id: string | null
  thread_id: string | null
  actor_id: string | null
  actor_name: string
  actor_kind: ReviewActorKind
  actor_external: boolean
  item_count: number | null
  created_at: Date
  seq: string | number
}

const EVENT_COLUMNS = `id, workspace_id, board_id, item_id, round_id, kind, status, previous_status, reason, version_id,
  thread_id, actor_id, actor_name, actor_kind, actor_external, item_count, created_at, seq`

export function toEvent(r: EventRow): ReviewEvent {
  return {
    id: r.id,
    itemId: r.item_id,
    roundId: r.round_id,
    kind: r.kind,
    status: r.status,
    previousStatus: r.previous_status,
    reason: r.reason,
    versionId: r.version_id,
    threadId: r.thread_id,
    actor: actorOf(r.actor_id, r.actor_name, r.actor_kind, r.actor_external),
    itemCount: r.item_count,
    createdAt: r.created_at.toISOString(),
    seq: Number(r.seq),
  }
}

export interface RoundRow {
  id: string
  workspace_id: string
  board_id: string
  number: number
  title: string
  opened_by: string | null
  opened_at: Date
  closed_at: Date | null
  checkpoint_id: string | null
  /** the round_opened event's actor, as it was then */
  by_id: string | null
  by_name: string | null
  by_kind: ReviewActorKind | null
  by_external: boolean | null
}

const ROUND_COLUMNS = `r.id, r.workspace_id, r.board_id, r.number, r.title, r.opened_by, r.opened_at, r.closed_at,
  r.checkpoint_id, op.actor_id AS by_id, op.actor_name AS by_name, op.actor_kind AS by_kind,
  op.actor_external AS by_external`
const ROUND_FROM = `review_rounds r
  LEFT JOIN LATERAL (
    SELECT e.actor_id, e.actor_name, e.actor_kind, e.actor_external FROM review_events e
     WHERE e.round_id = r.id AND e.board_id = r.board_id AND e.kind = 'round_opened' ORDER BY e.seq LIMIT 1
  ) op ON true`

export function toRound(r: RoundRow): ReviewRound {
  return {
    id: r.id,
    boardId: r.board_id,
    number: r.number,
    title: cleanDisplayText(r.title) || `Round ${r.number}`,
    openedBy: r.by_name !== null ? actorOf(r.by_id, r.by_name, r.by_kind, r.by_external) : null,
    openedAt: r.opened_at.toISOString(),
    closedAt: iso(r.closed_at),
    checkpointId: r.checkpoint_id,
  }
}

// ---- reads ------------------------------------------------------------------------------------------------------

export interface BoardKey {
  id: string
  workspace_id: string
}

/** The board's live items (removed ones left out), in the panel's stored order, then oldest first. */
export async function loadLiveItems(q: Queryable, board: BoardKey): Promise<ReviewItem[]> {
  const rows = await q.query<ItemRow>(
    `SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM}
      WHERE i.board_id = $1 AND i.workspace_id = $2 AND i.removed_at IS NULL
      ORDER BY i.position NULLS LAST, i.created_at, i.id`,
    [board.id, board.workspace_id],
  )
  return rows.rows.map(toItem)
}

/** Some items of the board by id (live or removed), as their rows. */
export async function loadItemRows(
  q: Queryable,
  board: BoardKey,
  ids: readonly string[],
): Promise<ItemRow[]> {
  if (ids.length === 0) return []
  const rows = await q.query<ItemRow>(
    `SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM}
      WHERE i.board_id = $1 AND i.workspace_id = $2 AND i.id IN (SELECT jsonb_array_elements_text($3::jsonb))
      ORDER BY i.position NULLS LAST, i.created_at, i.id`,
    [board.id, board.workspace_id, idList(ids)],
  )
  return rows.rows
}

export async function loadItem(q: Queryable, board: BoardKey, id: string): Promise<ReviewItem | null> {
  const [row] = await loadItemRows(q, board, [id])
  return row ? toItem(row) : null
}

/**
 * Locks one item of the board (FOR UPDATE) and returns its row without the last actor (read it again after the
 * write). `live`: only an item still in review. Null: none.
 */
export async function lockItem(
  q: Queryable,
  board: BoardKey,
  id: string,
  opts: { live: boolean },
): Promise<ItemRow | null> {
  return q.maybeOne<ItemRow>(
    `SELECT i.*, NULL::text AS by_id, NULL::text AS by_name, NULL::text AS by_kind, NULL::boolean AS by_external
       FROM review_items i
      WHERE i.id = $1 AND i.board_id = $2 AND i.workspace_id = $3 ${opts.live ? 'AND i.removed_at IS NULL' : ''}
      FOR UPDATE`,
    [id, board.id, board.workspace_id],
  )
}

export async function loadRounds(q: Queryable, board: BoardKey): Promise<ReviewRound[]> {
  const rows = await q.query<RoundRow>(
    `SELECT ${ROUND_COLUMNS} FROM ${ROUND_FROM}
      WHERE r.board_id = $1 AND r.workspace_id = $2 ORDER BY r.number`,
    [board.id, board.workspace_id],
  )
  return rows.rows.map(toRound)
}

export async function loadRound(q: Queryable, board: BoardKey, id: string): Promise<ReviewRound | null> {
  const row = await q.maybeOne<RoundRow>(
    `SELECT ${ROUND_COLUMNS} FROM ${ROUND_FROM} WHERE r.id = $1 AND r.board_id = $2 AND r.workspace_id = $3`,
    [id, board.id, board.workspace_id],
  )
  return row ? toRound(row) : null
}

export async function openRoundId(q: Queryable, board: BoardKey): Promise<string | null> {
  const row = await q.maybeOne<{ id: string }>(
    'SELECT id FROM review_rounds WHERE board_id = $1 AND workspace_id = $2 AND closed_at IS NULL',
    [board.id, board.workspace_id],
  )
  return row?.id ?? null
}

/** One page of an item's history, newest first (`before`: a seq; the page ends past it). */
export async function loadEvents(
  q: Queryable,
  board: BoardKey,
  itemId: string,
  before: number | null,
): Promise<{ events: ReviewEvent[]; nextBefore: number | null }> {
  const page = REVIEW_LIMITS.eventsPage
  const rows = await q.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM review_events
      WHERE item_id = $1 AND board_id = $2 AND workspace_id = $3 AND ($4::bigint IS NULL OR seq < $4::bigint)
      ORDER BY seq DESC LIMIT ${page + 1}`,
    [itemId, board.id, board.workspace_id, before],
  )
  const list = rows.rows.slice(0, page).map(toEvent)
  const last = list.at(-1)
  return { events: list, nextBefore: rows.rows.length > page && last ? last.seq : null }
}

/**
 * The newest version of `assetId` servable on this board (uploaded to it, or linked to it: files-auth.ts), with its
 * board still in the workspace. Null: none.
 */
export async function latestServableVersion(
  q: Queryable,
  board: BoardKey,
  assetId: string,
): Promise<string | null> {
  const row = await q.maybeOne<{ id: string }>(
    `SELECT v.id FROM asset_versions v
       JOIN boards owner ON owner.id = v.board_id AND owner.workspace_id = v.workspace_id
      WHERE v.asset_id = $1 AND v.workspace_id = $2
        AND (v.board_id = $3 OR EXISTS (
              SELECT 1 FROM board_asset_links l
               WHERE l.workspace_id = $2 AND l.board_id = $3 AND l.asset_id = v.asset_id AND l.version_id = v.id))
      ORDER BY v.created_at DESC, v.id DESC LIMIT 1`,
    [assetId, board.workspace_id, board.id],
  )
  return row?.id ?? null
}

// ---- writes ---------------------------------------------------------------------------------------------------

/**
 * Serializes the review's board-wide writes (marking: the live-item cap; starting a round) on the board row, FOR NO
 * KEY UPDATE: it conflicts with itself and with access changes' FOR UPDATE, but NOT with the key-share locks that
 * every insert naming the board takes (an event, a note thread, a notification). So a status write that holds an
 * item's lock and then inserts its event never waits for a round start that holds the board and waits for that item
 * (the deadlock FOR UPDATE would make). Taken before any row of the board (access.ts step 1). False: no such board.
 */
export async function lockBoardForReview(q: Queryable, boardId: string): Promise<boolean> {
  if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(boardId)) return false
  const row = await q.maybeOne<{ id: string }>(
    "SELECT id FROM boards WHERE id = $1 AND status IN ('active', 'archived') FOR NO KEY UPDATE",
    [boardId],
  )
  return row !== null
}

// ---- writes (rows) -----------------------------------------------------------------------------------------------------

export interface NewEvent {
  board: BoardKey
  itemId: string | null
  roundId: string | null
  kind: ReviewEventKind
  status?: ReviewStatus
  previousStatus?: ReviewStatus | null
  reason?: ReviewStatusReason
  versionId?: string | null
  threadId?: string | null
  itemCount?: number
  actor: ReviewActorRow
  at: Date
}

/** Inserts one history row (and keeps an item's history to REVIEW_LIMITS.eventsPerItem, the oldest going). */
export async function insertEvent(q: Queryable, e: NewEvent): Promise<EventRow> {
  const row = await q.one<EventRow>(
    `INSERT INTO review_events (id, workspace_id, board_id, item_id, round_id, kind, status, previous_status, reason,
                                version_id, thread_id, actor_id, actor_name, actor_kind, actor_external, item_count,
                                created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     RETURNING ${EVENT_COLUMNS}`,
    [
      newId('rve'),
      e.board.workspace_id,
      e.board.id,
      e.itemId,
      e.roundId,
      e.kind,
      e.status ?? null,
      e.previousStatus ?? null,
      e.reason ?? null,
      e.versionId ?? null,
      e.threadId ?? null,
      e.actor.id,
      e.actor.name,
      e.actor.kind,
      e.actor.external,
      e.itemCount ?? null,
      e.at,
    ],
  )
  if (e.itemId) {
    await q.query(
      `DELETE FROM review_events WHERE item_id = $1 AND seq <= (
         SELECT seq FROM review_events WHERE item_id = $1 ORDER BY seq DESC OFFSET ${REVIEW_LIMITS.eventsPerItem} LIMIT 1)`,
      [e.itemId],
    )
  }
  return row
}

/** Sets an item's status (one more status change: status_seq + 1). */
export async function applyStatus(
  q: Queryable,
  itemId: string,
  s: { status: ReviewStatus; by: string; at: Date; versionId: string | null | undefined },
): Promise<void> {
  await q.query(
    `UPDATE review_items
        SET status = $2, status_seq = status_seq + 1, status_by = $3, status_at = $4,
            status_version_id = CASE WHEN $5::boolean THEN $6::text ELSE status_version_id END
      WHERE id = $1`,
    [itemId, s.status, s.by, s.at, s.versionId !== undefined, s.versionId ?? null],
  )
}

// ---- the bell and chat --------------------------------------------------------------------------------------------

/**
 * Who hears about a review step on these items: the board's owners (its direct owner grants), the people who
 * marked the items, and the earlier status setters who are accounts; never the actor, and only people who can view
 * the board now.
 */
export async function reviewRecipients(
  q: Queryable,
  board: Pick<BoardRow, 'id' | 'workspace_id' | 'visibility' | 'status'>,
  itemIds: readonly string[],
  actorId: string,
): Promise<string[]> {
  const owners = await boardOwners(q, board.id)
  const people =
    itemIds.length === 0
      ? []
      : (
          await q.query<{ user_id: string }>(
            `SELECT created_by AS user_id FROM review_items
              WHERE board_id = $1 AND workspace_id = $2 AND created_by IS NOT NULL
                AND id IN (SELECT jsonb_array_elements_text($3::jsonb))
             UNION
             SELECT e.actor_id FROM review_events e JOIN users u ON u.id = e.actor_id AND u.kind = 'account'
              WHERE e.board_id = $1 AND e.workspace_id = $2 AND e.kind = 'status' AND e.actor_kind = 'account'
                AND e.item_id IN (SELECT jsonb_array_elements_text($3::jsonb))`,
            [board.id, board.workspace_id, idList(itemIds)],
          )
        ).rows.map((r) => r.user_id)
  const candidates = [...new Set([...owners, ...people])].filter((id) => id !== actorId)
  if (candidates.length === 0) return []
  const viewers = await viewersAmong(q, board, candidates, { team: null })
  return candidates.filter((id) => viewers.has(id))
}

/**
 * ONE review_status notification per recipient about `eventId` (on the event's board), with the chat outbox rows of
 * the people who opted in, in this transaction. Returns the notification ids.
 */
export async function notifyReview(
  q: Queryable,
  base: { board: BoardKey; eventId: string; actorId: string; at: Date },
  recipients: readonly string[],
): Promise<string[]> {
  const ids: string[] = []
  for (const userId of recipients) {
    const row = await q.one<{ id: string }>(
      `INSERT INTO notifications (workspace_id, user_id, kind, board_id, actor_id, review_event_id, created_at)
       VALUES ($1, $2, 'review_status', $3, $4, $5, $6) RETURNING id`,
      [base.board.workspace_id, userId, base.board.id, base.actorId, base.eventId, base.at],
    )
    ids.push(row.id)
  }
  // wave R: the opted-in people's chat messages, in this transaction (best effort: never fails the write)
  await enqueueChatDeliveries(q, ids)
  return ids
}
