// Creating a board from existing content (restore-as-new, duplicate, import).
//
// Always a NEW, PRIVATE board owned by the caller (PRF-08): no grants, no invitation/review links, no
// workspace visibility are inherited, except the explicit "keep sharing settings" duplicate, which
// copies people grants and visibility (never links nor the access a link gave, never name-only guests,
// never someone who no longer belongs to the workspace) and needs manage_access on the source. Domain
// access (D5): a copied grant of someone who is not a creator is at most `editor` (nobody makes an
// outsider a board owner), and the caller must still be a creator when the row is written (the seed can
// take a while).
//
// "Internal only" (wave J pre-deploy review IO-2a): when the copy's workspace or project is internal
// only, "keep sharing" copies only confirmed creators' grants, and the copy is private when its copied
// workspace visibility would reach a member who is not inside; the response says both (KeptSharing).
//
// Order: seed the canvas first, then commit the board row. Until the row exists nobody can get a
// ticket for the id, so nothing can race the seed; a seed conflict (the id already has canvas data:
// an id collision or a leftover from an earlier failed attempt) just draws a new id. If the row
// insert fails after a successful seed, the canvas file is an orphan nobody can open (logged).

import { type InternalOnlyScope, NEW_CANVAS_BOARD_MESSAGE, NEW_CANVAS_ERROR } from '@draftroom/contracts'
import { newBoardId, type Queryable } from '@draftroom/db'
import type { BoardRole, BoardVisibility } from '@draftroom/permissions'
import { BOARD_RETURNING, type BoardRow, requireCreatingRoleLocked } from '../../access.ts'
import { audit } from '../../audit.ts'
import { onNewCanvas } from '../../canvas-engine.ts'
import { ApiError } from '../../errors.ts'
import { assertBoardRoom } from '../../files/usage.ts'
import {
  type LobbySeed,
  type RoomSnapshotJson,
  SyncNewCanvasBoard,
  SyncSeedConflict,
  SyncUnavailable,
} from '../../sync-internal.ts'
import type { FeatureContext } from '../context.ts'
import { scopeIn, visibilityReachesOutside } from '../dashboard/outside.ts'
import type { FileRef } from './files.ts'

/**
 * What the new board starts with (validated again by the sync server's seed): tldraw records with the
 * serialized schema they are in (a v1 checkpoint or archive, a tldraw board; a sync on the Excalidraw
 * engine converts them), or elements of the Excalidraw engine with its board document (a v2 checkpoint or
 * archive, a board on the new canvas).
 */
export type BoardContent =
  | { format: 'tldraw'; records: unknown[]; schema: unknown }
  | { format: 'lobby-elements'; elements: unknown[]; doc: Record<string, unknown> }

export interface NewBoardPlan {
  userId: string
  workspaceId: string
  projectId: string | null
  title: string
  content: BoardContent
  /** File versions the new board may show. */
  files: readonly FileRef[]
  /** keepSharing duplicate only. */
  shareLike?: { boardId: string; visibility: BoardVisibility }
  via: 'restore' | 'duplicate' | 'import'
  from?: { boardId?: string; snapshotId?: string }
}

const SEED_ATTEMPTS = 4

/**
 * What "keep sharing" could not carry over because the copy's scope is internal only (IO-2a, wave J
 * pre-deploy review): the people left out (not confirmed creators) and whether the copy was made private.
 */
export interface KeptSharing {
  scope: InternalOnlyScope
  outsideLeftOut: number
  madePrivate: boolean
}

/** The board a createBoardFrom made, and (keep sharing into an internal-only scope) what it left out. */
export interface NewBoard {
  row: BoardRow
  kept: KeptSharing | null
}

/** The person-safe notes on a copy that left something out (HistoryBoardCreated.warnings). */
export function keptSharingWarnings(kept: KeptSharing | null): string[] {
  if (!kept) return []
  const where = kept.scope === 'workspace' ? 'This workspace' : 'This project'
  const out: string[] = []
  const n = kept.outsideLeftOut
  if (n > 0) {
    const who = n === 1 ? '1 person who is' : `${n} people who are`
    out.push(
      `${where} is internal only, so ${who} not confirmed as Dark Burn Creative or Trailer Park Group ${n === 1 ? 'was' : 'were'} not given access to the copy.`,
    )
  }
  if (kept.madePrivate)
    out.push(
      `${where} is internal only and its workspace has members who are not confirmed as Dark Burn Creative or Trailer Park Group, so the copy is private.`,
    )
  return out
}

export const syncUnavailable = () =>
  new ApiError(503, 'SYNC_UNAVAILABLE', 'The board server is not reachable right now. Try again in a moment.')

/**
 * The sync server's seed refused the CONTENT (J4: it converts a v1 body in a worker with limits, and answers 413
 * past its record, byte, answer or heap limits and 422 past its time budget), as opposed to being unreachable:
 * the person is told why, instead of "the board server is not reachable, try again" for a board that will never
 * convert. The api's sync client reports every failed seed as a SyncUnavailable whose message ends in the status
 * ("seed failed with 413"; `status` is read first, for a client that sets it). Null for anything else.
 */
export function seedRefusal(e: SyncUnavailable): ApiError | null {
  const status = e.status ?? Number(/^seed failed with (\d{3})$/.exec(e.message)?.[1])
  if (status === 413)
    return new ApiError(
      413,
      'IMPORT_TOO_LARGE',
      'This board is too large or complex to convert for the new canvas, so it can’t be imported or restored as a new board.',
    )
  if (status === 422)
    return new ApiError(
      422,
      'IMPORT_TOO_COMPLEX',
      'This board takes too long to convert for the new canvas, so it can’t be imported or restored as a new board.',
    )
  return null
}

/** Bridge release R0: the board was made on the new canvas (409; the message says when it works again). */
export const newCanvasBoard = () => new ApiError(409, NEW_CANVAS_ERROR, NEW_CANVAS_BOARD_MESSAGE)

/**
 * Wraps a sync call: an unreachable or failing sync server is a 503 with a user-safe message; a board
 * the sync server refused because it was made on the new canvas is a 409 that says so (R0).
 */
export async function viaSync<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof SyncNewCanvasBoard) throw newCanvasBoard()
    if (e instanceof SyncUnavailable) throw syncUnavailable()
    throw e
  }
}

async function insertLinks(
  tx: Queryable,
  workspaceId: string,
  boardId: string,
  files: readonly FileRef[],
  at: Date,
) {
  for (let i = 0; i < files.length; i += 100) {
    const part = files.slice(i, i + 100)
    const values: string[] = []
    const params: unknown[] = [workspaceId, boardId, at]
    for (const f of part) {
      params.push(f.assetId, f.versionId)
      values.push(`($1, $2, $${params.length - 1}, $${params.length}, $3)`)
    }
    await tx.query(
      `INSERT INTO board_asset_links (workspace_id, board_id, asset_id, version_id, created_at)
       VALUES ${values.join(', ')} ON CONFLICT DO NOTHING`,
      params,
    )
  }
}

export async function createBoardFrom(
  ctx: FeatureContext,
  plan: NewBoardPlan,
  log?: (message: string) => void,
): Promise<NewBoard> {
  const content = plan.content
  const snapshot: RoomSnapshotJson | LobbySeed =
    content.format === 'lobby-elements'
      ? { format: 'lobby-elements', elements: content.elements, doc: content.doc }
      : {
          schema: content.schema,
          documents: content.records.map((state) => ({
            state: state as Record<string, unknown>,
            lastChangedClock: 0,
          })),
        }
  // SEAM-11: before the seed, so a full workspace never leaves an orphan canvas behind (and again below).
  await assertBoardRoom(ctx.db, plan.workspaceId, ctx.config.storage.maxBoardsPerWorkspace)
  let boardId: string | null = null
  for (let attempt = 0; attempt < SEED_ATTEMPTS && !boardId; attempt++) {
    const id = newBoardId()
    try {
      await ctx.sync.seed(id, snapshot)
      boardId = id
    } catch (e) {
      if (e instanceof SyncSeedConflict) continue // that id already has canvas data: draw another
      if (e instanceof SyncUnavailable) throw seedRefusal(e) ?? syncUnavailable()
      throw e
    }
  }
  if (!boardId) throw new ApiError(503, 'SYNC_CONFLICT', 'Could not create the board. Try again.')
  // Bridge release R0's contract: every board this api makes on the new canvas (restore as new,
  // duplicate, import) has `new_canvas = true`, so a rollback's R0 refuses it instead of opening it
  // empty. Converted boards (made before the cut-over) keep false.
  const newCanvas = await onNewCanvas(ctx)

  const newId = boardId
  try {
    return await ctx.db.transaction(async (tx) => {
      // Membership can change while the seed ran: decide again, inside the transaction. Lock order
      // (access.ts): the workspace row FIRST, the creator's role after it (requireCreatingRoleLocked), so a
      // member removal cannot leave the copy with an owner grant for someone who is no member: it waits and
      // sweeps the grant written below, or went first and the creator is found gone (404).
      await requireCreatingRoleLocked(tx, plan.workspaceId, plan.userId)
      await ctx.identity.requireCreator(tx, plan.userId, 'create', {
        route: `createBoardFrom:${plan.via}`,
        by: 'route',
      })
      await assertBoardRoom(tx, plan.workspaceId, ctx.config.storage.maxBoardsPerWorkspace)
      let projectId = plan.projectId
      if (projectId) {
        const p = await tx.maybeOne('SELECT 1 AS ok FROM projects WHERE id = $1 AND workspace_id = $2', [
          projectId,
          plan.workspaceId,
        ])
        if (!p) projectId = null
      }
      // IO-2a: the copy's internal-only scope, read under the workspace row lock the switch takes.
      const scope = plan.shareLike ? await scopeIn(tx, plan.workspaceId, projectId) : null
      const at = ctx.now()
      let row = await tx.maybeOne<BoardRow>(
        `INSERT INTO boards (id, workspace_id, project_id, title, visibility, created_by, created_at, updated_at, new_canvas)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8) ON CONFLICT (id) DO NOTHING RETURNING ${BOARD_RETURNING}`,
        [
          newId,
          plan.workspaceId,
          projectId,
          plan.title,
          plan.shareLike?.visibility ?? 'private',
          plan.userId,
          at,
          newCanvas,
        ],
      )
      if (!row) throw new Error('board id already taken after seeding')
      let kept: KeptSharing | null = null
      await tx.query(
        "INSERT INTO board_members (board_id, user_id, role, added_by, created_at) VALUES ($1, $2, 'owner', $2, $3)",
        [newId, plan.userId, at],
      )
      if (plan.shareLike) {
        // People grants only (the caller is the owner already); invitation/review links never carry over.
        // Name-only guests (wave 3) never carry over either: they reach a board only through a guest
        // link (docs/WAVE3-CONTRACTS.md §2 guests), and a copied grant would be tied to no link, so
        // revoking the link with removal would leave them editing the copy (SEAM-03).
        //
        // Only people who still belong to the workspace get a grant, and their membership rows are read
        // FOR SHARE and held to the end of this transaction (the lock order in access.ts: the membership,
        // then the grant, as members.ts `loadTarget` does). A grant of someone who is no member gives
        // nothing, but it comes back to life if they ever join again, so a source grant that already
        // outlived its membership is not copied. A member removal (routes/workspaces.ts: the workspace row,
        // then the membership, then a sweep of their grants) cannot run between this read and the insert:
        // the workspace row, locked first in this transaction (requireCreatingRoleLocked), holds it off, and
        // these row locks keep it so for any path that deletes a membership without that row (it waits for
        // this transaction and sweeps the copy's grant too). Sorted by user, so two copies lock the rows in
        // one order.
        //
        // Access that a review or workshop link gave (J2 / INV-4) is no "people" setting either: it ends with
        // its link on the source (the link sweep), and a copied grant would be tied to no link and last for
        // good. So a grant a multi-use link of the source CREATED (the link sweep's own test, review-links.ts
        // `created_by_link`: a redemption at the grant's creation time through a link with the grant's role)
        // is not copied, and nobody is locked for it; a grant an open workshop (edit) link RAISED is copied at
        // the role it goes back to when that link ends (the redemption's previous_role). A review link's
        // raise stays on the source, so it is copied as it is.
        const grants = await tx.query<{ user_id: string; role: BoardRole }>(
          `SELECT bm.user_id,
                  COALESCE((
                    SELECT r.previous_role FROM invitation_redemptions r JOIN invitations i ON i.id = r.invitation_id
                     WHERE r.board_id = bm.board_id AND r.user_id = bm.user_id AND i.multi_use
                       AND i.swept_at IS NULL AND i.role = 'editor' AND bm.role = 'editor'
                       AND r.previous_role IS NOT NULL
                     ORDER BY array_position(ARRAY['viewer', 'commenter', 'editor']::text[], r.previous_role) DESC
                     LIMIT 1
                  ), bm.role) AS role
             FROM board_members bm
             JOIN boards src ON src.id = bm.board_id AND src.workspace_id = $3
             JOIN workspace_members wm ON wm.workspace_id = $3 AND wm.user_id = bm.user_id
             JOIN users u ON u.id = bm.user_id AND u.kind <> 'guest'
            WHERE bm.board_id = $1 AND bm.user_id <> $2
              AND NOT EXISTS (
                SELECT 1 FROM invitation_redemptions r JOIN invitations i ON i.id = r.invitation_id
                 WHERE r.board_id = bm.board_id AND r.user_id = bm.user_id AND i.multi_use
                   AND r.redeemed_at = bm.created_at AND i.role = bm.role)
            ORDER BY bm.user_id
              FOR SHARE OF wm`,
          [plan.shareLike.boardId, plan.userId, plan.workspaceId],
        )
        const creators = await ctx.identity.creatorsAmong(
          tx,
          grants.rows.map((g) => g.user_id),
        )
        // IO-2a (wave J pre-deploy review): while the copy's workspace or project is internal only, nobody
        // outside is given new access there, so only confirmed creators' grants are copied (an account
        // whose addresses are unconfirmed is left out too, failing closed); the response says how many.
        const copied = scope ? grants.rows.filter((g) => creators.has(g.user_id)) : grants.rows
        const people = copied.map((g) => g.user_id)
        // D5: a copied owner grant of someone who is not a creator is at most editor.
        const roles = copied.map((g) => (g.role === 'owner' && !creators.has(g.user_id) ? 'editor' : g.role))
        await tx.query(
          `INSERT INTO board_members (board_id, user_id, role, added_by, created_at)
           SELECT $1, g.user_id, g.role, $2, $3
             FROM unnest($4::text[], $5::text[]) AS g(user_id, role)
            WHERE g.user_id <> $2
           ON CONFLICT DO NOTHING`,
          [newId, plan.userId, at, people, roles],
        )
        if (scope) {
          // IO-2b's rule on the copy: its workspace visibility would give a member who is not inside new
          // access, so the copy is private (and the response says so).
          const madePrivate =
            row.visibility !== 'private' &&
            (await visibilityReachesOutside(tx, ctx, newId, plan.workspaceId, row.visibility))
          if (madePrivate)
            row = await tx.one<BoardRow>(
              `UPDATE boards SET visibility = 'private' WHERE id = $1 RETURNING ${BOARD_RETURNING}`,
              [newId],
            )
          kept = { scope, outsideLeftOut: grants.rows.length - copied.length, madePrivate }
        }
      }
      await insertLinks(tx, plan.workspaceId, newId, plan.files, at)
      // AIPV-04: a copy of a board with AI off (an NDA client's board) keeps AI off; a copy never falls
      // back to the workspace default (usually on). Restore-as-new and duplicate only, from a board of
      // the same workspace; a board without its own choice gives a copy without one.
      if (plan.from?.boardId && (plan.via === 'restore' || plan.via === 'duplicate'))
        await tx.query(
          `INSERT INTO board_ai_settings (board_id, workspace_id, enabled, updated_by, updated_at)
           SELECT $1, $2, s.enabled, $3, $4 FROM board_ai_settings s
            WHERE s.board_id = $5 AND s.workspace_id = $2`,
          [newId, plan.workspaceId, plan.userId, at, plan.from.boardId],
        )
      await audit(tx, {
        workspaceId: plan.workspaceId,
        actorId: plan.userId,
        action: 'board.create',
        target: newId,
        detail: {
          via: plan.via,
          ...(plan.from?.boardId ? { fromBoard: plan.from.boardId } : {}),
          ...(plan.from?.snapshotId ? { fromSnapshot: plan.from.snapshotId } : {}),
          keepSharing: !!plan.shareLike,
          ...(kept ? { outsideLeftOut: kept.outsideLeftOut, madePrivate: kept.madePrivate } : {}),
          files: plan.files.length,
        },
        at,
      })
      return { row, kept }
    })
  } catch (e) {
    log?.(`board ${newId} was seeded but its row was not created; its canvas file is unused`)
    throw e
  }
}
