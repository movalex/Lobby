// Creating a board from existing content (restore-as-new, duplicate, import).
//
// Always a NEW, PRIVATE board owned by the caller (PRF-08): no grants, no invitation/review links, no
// workspace visibility are inherited, except the explicit "keep sharing settings" duplicate, which
// copies people grants and visibility (never links, never name-only guests) and needs manage_access on
// the source. Domain access (D5): a copied grant of someone who is not a creator is at most `editor`
// (nobody makes an outsider a board owner), and the caller must still be a creator when the row is
// written (the seed can take a while).
//
// Order: seed the canvas first, then commit the board row. Until the row exists nobody can get a
// ticket for the id, so nothing can race the seed; a seed conflict (the id already has canvas data:
// an id collision or a leftover from an earlier failed attempt) just draws a new id. If the row
// insert fails after a successful seed, the canvas file is an orphan nobody can open (logged).

import { newBoardId, type Queryable } from '@draftroom/db'
import { type BoardVisibility, canCreateInWorkspace } from '@draftroom/permissions'
import { BOARD_RETURNING, type BoardRow, requireWorkspaceRole } from '../../access.ts'
import { audit } from '../../audit.ts'
import { ApiError, forbidden } from '../../errors.ts'
import { assertBoardRoom } from '../../files/usage.ts'
import { SyncSeedConflict, SyncUnavailable } from '../../sync-internal.ts'
import type { FeatureContext } from '../context.ts'
import type { FileRef } from './files.ts'

export interface NewBoardPlan {
  userId: string
  workspaceId: string
  projectId: string | null
  title: string
  /** Document records (validated again by the sync server's seed). */
  records: unknown[]
  /** Serialized tldraw schema the records are in. */
  schema: unknown
  /** File versions the new board may show. */
  files: readonly FileRef[]
  /** keepSharing duplicate only. */
  shareLike?: { boardId: string; visibility: BoardVisibility }
  via: 'restore' | 'duplicate' | 'import'
  from?: { boardId?: string; snapshotId?: string }
}

const SEED_ATTEMPTS = 4

export const syncUnavailable = () =>
  new ApiError(503, 'SYNC_UNAVAILABLE', 'The board server is not reachable right now. Try again in a moment.')

/** Wraps a sync call: an unreachable or failing sync server is a 503 with a user-safe message. */
export async function viaSync<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
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
): Promise<BoardRow> {
  const snapshot = {
    schema: plan.schema,
    documents: plan.records.map((state) => ({
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
      if (e instanceof SyncUnavailable) throw syncUnavailable()
      throw e
    }
  }
  if (!boardId) throw new ApiError(503, 'SYNC_CONFLICT', 'Could not create the board. Try again.')

  const newId = boardId
  try {
    return await ctx.db.transaction(async (tx) => {
      // Membership can change while the seed ran: decide again, inside the transaction.
      const role = await requireWorkspaceRole(tx, plan.workspaceId, plan.userId)
      if (!canCreateInWorkspace(role)) throw forbidden()
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
      const at = ctx.now()
      const row = await tx.maybeOne<BoardRow>(
        `INSERT INTO boards (id, workspace_id, project_id, title, visibility, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7) ON CONFLICT (id) DO NOTHING RETURNING ${BOARD_RETURNING}`,
        [
          newId,
          plan.workspaceId,
          projectId,
          plan.title,
          plan.shareLike?.visibility ?? 'private',
          plan.userId,
          at,
        ],
      )
      if (!row) throw new Error('board id already taken after seeding')
      await tx.query(
        "INSERT INTO board_members (board_id, user_id, role, added_by, created_at) VALUES ($1, $2, 'owner', $2, $3)",
        [newId, plan.userId, at],
      )
      if (plan.shareLike) {
        // People grants only (the caller is the owner already); invitation/review links never carry over.
        // Name-only guests (wave 3) never carry over either: they reach a board only through a guest
        // link (docs/WAVE3-CONTRACTS.md §2 guests), and a copied grant would be tied to no link, so
        // revoking the link with removal would leave them editing the copy (SEAM-03).
        const grants = await tx.query<{ user_id: string }>(
          'SELECT bm.user_id FROM board_members bm WHERE bm.board_id = $1 AND bm.user_id <> $2',
          [plan.shareLike.boardId, plan.userId],
        )
        const creators = await ctx.identity.creatorsAmong(
          tx,
          grants.rows.map((g) => g.user_id),
        )
        await tx.query(
          `INSERT INTO board_members (board_id, user_id, role, added_by, created_at)
           SELECT $1, bm.user_id,
                  CASE WHEN bm.role = 'owner' AND NOT (bm.user_id = ANY($6::text[])) THEN 'editor' ELSE bm.role END,
                  $3, $4
             FROM board_members bm
             JOIN boards src ON src.id = bm.board_id AND src.workspace_id = $5
             JOIN users u ON u.id = bm.user_id AND u.kind <> 'guest'
            WHERE bm.board_id = $2 AND bm.user_id <> $3
           ON CONFLICT DO NOTHING`,
          [newId, plan.shareLike.boardId, plan.userId, at, plan.workspaceId, [...creators]],
        )
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
          files: plan.files.length,
        },
        at,
      })
      return row
    })
  } catch (e) {
    log?.(`board ${newId} was seeded but its row was not created; its canvas file is unused`)
    throw e
  }
}
