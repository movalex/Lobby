// OWNER: WS1 (wave S; the signature is the foundation's contract with WS2, docs/WAVE-S-CONTRACTS.md §3.1). The review
// steps another workstream's code (and the round start) runs inside its own transaction.
//
// resetForNewVersion: WS2's upload with X-Lobby-Supersedes calls it in the upload's one transaction, after the new
// version row is inserted: every live review item on the asset whose status is not 'pending', ON THE BOARD THE NEW
// VERSION WAS UPLOADED TO, goes back to 'pending'. Copies of a card share its asset id, but each board's review is its
// own: a client reviewing board B was shown v1 there, B's cards still show v1 (visibility follows the version), and
// "Approved" on B stays "approved v1" until someone uploads a version on B itself (the integration's decision,
// docs/WAVE-S-CONTRACTS.md §3.1). Only the upload board hears the reset's REVIEW_ITEM_EVENTs. It goes back to 'pending' (event reason 'new_version', actor = the uploader, version = the new one), with the notifications
// and chat outbox rows of the reset in the same transaction (ONE notification per recipient per board for the whole
// reset). It returns the items it changed so the caller can publish REVIEW_ITEM_EVENT for each after COMMIT (never
// before). EVERY live item of the asset on that board is locked FOR UPDATE in id order, whatever its status, and only
// then are the non-pending ones picked (from a read after the locks): a status filter in the locking statement would
// skip an item an approval is setting at that moment (pending in the statement's snapshot, so never locked or waited
// for), and that approval would then commit "approved" on the old version (apps/api/test/files/versions.pg.test.ts).
// The locks come after the caller's own: the upload takes the board's notification lock first (the bell's caps), then
// its workspace row; it holds no board row lock, and a status write takes an item's lock only after its board's reads.

import type { ReviewItem } from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import type { BoardRow } from '../../access.ts'
import type { CreatorLookup } from '../../auth/creator-sql.ts'
import {
  applyStatus,
  type ItemRow,
  insertEvent,
  loadActor,
  loadItemRows,
  notifyReview,
  type ReviewActorRow,
  reviewRecipients,
  toItem,
} from './store.ts'

export interface NewVersionReset {
  workspaceId: string
  /** the board the new version was uploaded to: the only board whose items it resets */
  boardId: string
  assetId: string
  /** the new version (what the reset events record) */
  versionId: string
  /** the uploader: the session's user (its kind and name are read from users in the same transaction) */
  actorId: string
}

/** The creator policy the actor's "External" tag is read with; set when the review feature registers. */
let hookLookup: CreatorLookup | null = null
let hookNow: () => Date = () => new Date()
export function configureReviewHooks(opts: { lookup: CreatorLookup | null; now?: () => Date }): void {
  hookLookup = opts.lookup
  if (opts.now) hookNow = opts.now
}

type BoardRef = Pick<BoardRow, 'id' | 'workspace_id' | 'visibility' | 'status'>

/**
 * Resets `rows` (locked by the caller) to pending with `reason`, one event each, and ONE review_status notification
 * per recipient about the first reset's event (or `notifyEventId` when the caller made its own, a round's). Returns
 * the ids of the items it changed.
 */
export async function resetItems(
  tx: Queryable,
  board: BoardRef,
  rows: readonly ItemRow[],
  opts: {
    reason: 'new_version' | 'new_round'
    actor: ReviewActorRow
    at: Date
    versionId?: string
    roundId?: string | null
    /** notify about this event instead of the first reset's (null: notify nobody here) */
    notifyEventId?: string | null
  },
): Promise<string[]> {
  const changed: string[] = []
  let first: string | null = null
  for (const r of rows) {
    if (r.status === 'pending') continue
    const ev = await insertEvent(tx, {
      board,
      itemId: r.id,
      roundId: opts.roundId ?? r.round_id,
      kind: 'status',
      status: 'pending',
      previousStatus: r.status,
      reason: opts.reason,
      versionId: opts.versionId ?? null,
      actor: opts.actor,
      at: opts.at,
    })
    await applyStatus(tx, r.id, {
      status: 'pending',
      by: opts.actor.id,
      at: opts.at,
      versionId: opts.versionId,
    })
    first ??= ev.id
    changed.push(r.id)
  }
  const eventId = opts.notifyEventId === undefined ? first : opts.notifyEventId
  if (eventId && (changed.length > 0 || opts.notifyEventId)) {
    // about the items it changed (a pending one heard nothing new)
    const recipients = await reviewRecipients(
      tx,
      board,
      changed.length > 0 ? changed : rows.map((r) => r.id),
      opts.actor.id,
    )
    await notifyReview(tx, { board, eventId, actorId: opts.actor.id, at: opts.at }, recipients)
  }
  return changed
}

/** Resets the asset's live, non-pending review items to pending. Runs in the caller's transaction (`tx`). */
export async function resetForNewVersion(tx: Queryable, reset: NewVersionReset): Promise<ReviewItem[]> {
  // every live item on the asset on the upload board (open, and able to show the new version), locked in id order
  // with no status filter (resetItems skips the pending ones, as read after the locks)
  const locked = await tx.query<{ id: string; board_id: string }>(
    `SELECT i.id, i.board_id FROM review_items i
       JOIN boards b ON b.id = i.board_id AND b.workspace_id = i.workspace_id AND b.status IN ('active', 'archived')
       JOIN asset_versions v ON v.id = $3 AND v.asset_id = i.asset_id AND v.workspace_id = i.workspace_id
      WHERE i.workspace_id = $1 AND i.asset_id = $2 AND i.board_id = $4 AND i.removed_at IS NULL
        AND (v.board_id = i.board_id OR EXISTS (
              SELECT 1 FROM board_asset_links l
               WHERE l.workspace_id = i.workspace_id AND l.board_id = i.board_id AND l.asset_id = v.asset_id
                 AND l.version_id = v.id))
      ORDER BY i.id
      FOR UPDATE OF i`,
    [reset.workspaceId, reset.assetId, reset.versionId, reset.boardId],
  )
  if (locked.rows.length === 0) return []
  const actor = await loadActor(tx, reset.actorId, hookLookup)
  if (!actor) return []
  const at = hookNow()
  const byBoard = new Map<string, string[]>()
  for (const r of locked.rows) byBoard.set(r.board_id, [...(byBoard.get(r.board_id) ?? []), r.id])
  const out: ReviewItem[] = []
  for (const [boardId, ids] of byBoard) {
    const board = await tx.maybeOne<BoardRef>(
      `SELECT id, workspace_id, visibility, status FROM boards
        WHERE id = $1 AND workspace_id = $2 AND status IN ('active', 'archived')`,
      [boardId, reset.workspaceId],
    )
    if (!board) continue
    const rows = await loadItemRows(tx, board, ids)
    const changed = await resetItems(tx, board, rows, {
      reason: 'new_version',
      actor,
      at,
      versionId: reset.versionId,
    })
    for (const row of await loadItemRows(tx, board, changed)) out.push(toItem(row))
  }
  return out
}
