// Keeps a name-only guest's session and board grants together (docs/WAVE3-CONTRACTS.md §2 guests).
//
// - A guest session left with no board grant is revoked: the link was revoked with removal, it
//   expired (the review-link sweeper removed the grant), or an owner removed the guest from their
//   last board. The board itself was already closed by the M1 revocation push (the sync server and
//   the event streams hear `accessChanged` from whoever removed the grant); this ends what is left,
//   so the browser is signed out instead of holding a session that opens nothing.
// - Board grants of a guest with no live session are removed: a guest cannot sign in again (no
//   identity), so after signing out, or once the session expired, those grants can never be used.
//   Removing them keeps member lists honest ("Sam (guest)" is gone once Sam cannot come back).
//
// Both run per guest under that guest's user row lock (FOR UPDATE), which joining a guest link takes
// too (join.ts), so a sweep never acts on the state from before a join that is committing.

import type { Queryable } from '@draftroom/db'
import type { FastifyInstance } from 'fastify'
import { audit } from '../../audit.ts'
import type { FeatureContext } from '../context.ts'
import { publishSharingChanged } from '../dashboard/shared.ts'

const BATCH = 100

export interface GuestSweepResult {
  /** Guests whose last sessions were revoked (they had no board grant left). */
  signedOut: string[]
  /** Guests whose grants were removed (they had no live session left), with the boards. */
  removed: { userId: string; boardIds: string[] }[]
}

async function candidates(q: Queryable, at: Date) {
  const noGrant = await q.query<{ id: string }>(
    `SELECT u.id FROM users u
      WHERE u.kind = 'guest'
        AND EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > $1)
        AND NOT EXISTS (SELECT 1 FROM board_members bm WHERE bm.user_id = u.id)
      LIMIT ${BATCH}`,
    [at],
  )
  const noSession = await q.query<{ id: string }>(
    `SELECT u.id FROM users u
      WHERE u.kind = 'guest'
        AND EXISTS (SELECT 1 FROM board_members bm WHERE bm.user_id = u.id)
        AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > $1)
      LIMIT ${BATCH}`,
    [at],
  )
  return { noGrant: noGrant.rows.map((r) => r.id), noSession: noSession.rows.map((r) => r.id) }
}

/** One pass over the guests whose sessions and grants disagree. Returns what it changed. */
export async function sweepGuests(ctx: FeatureContext): Promise<GuestSweepResult> {
  const { db, now, sessions, notifier } = ctx
  const out: GuestSweepResult = { signedOut: [], removed: [] }
  const found = await candidates(db, now())

  for (const userId of found.noGrant) {
    const ids = await db.transaction(async (tx) => {
      await tx.query("SELECT id FROM users WHERE id = $1 AND kind = 'guest' FOR UPDATE", [userId])
      const at = now()
      // Re-checked under the lock: a join that committed meanwhile added a grant.
      const r = await tx.query<{ id_hash: string }>(
        `UPDATE sessions SET revoked_at = $2
          WHERE user_id = $1 AND revoked_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM board_members bm WHERE bm.user_id = $1)
          RETURNING id_hash`,
        [userId, at],
      )
      return r.rows.map((x) => x.id_hash)
    })
    if (!ids.length) continue
    sessions.announceRevoked(ids) // ends their event streams now
    out.signedOut.push(userId)
  }

  for (const userId of found.noSession) {
    const boards = await db.transaction(async (tx) => {
      await tx.query("SELECT id FROM users WHERE id = $1 AND kind = 'guest' FOR UPDATE", [userId])
      const at = now()
      const live = await tx.maybeOne(
        'SELECT 1 AS ok FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > $2 LIMIT 1',
        [userId, at],
      )
      if (live) return []
      const r = await tx.query<{ board_id: string; workspace_id: string; role: string }>(
        `DELETE FROM board_members bm USING boards b
          WHERE bm.user_id = $1 AND b.id = bm.board_id
          RETURNING bm.board_id, b.workspace_id, bm.role`,
        [userId],
      )
      // The guest is the actor: their session ended (sign-out, sign out everywhere or expiry).
      for (const row of r.rows)
        await audit(tx, {
          workspaceId: row.workspace_id,
          actorId: userId,
          action: 'board.member.remove',
          target: row.board_id,
          detail: { userId, previousRole: row.role, via: 'guest_session_ended' },
          at,
        })
      return r.rows.map((row) => row.board_id)
    })
    if (!boards.length) continue
    for (const boardId of boards) {
      notifier.accessChanged({ boardId, userId })
      publishSharingChanged(ctx, boardId, 'guest-left')
    }
    out.removed.push({ userId, boardIds: boards })
  }
  return out
}

/** Runs sweepGuests every `intervalMs` while the app runs (one API instance: docs/DEPLOY.md). */
export function startGuestSweeper(app: FastifyInstance, ctx: FeatureContext, intervalMs: number): void {
  let timer: ReturnType<typeof setInterval> | null = null
  let running: Promise<void> | null = null
  app.addHook('onReady', async () => {
    timer = setInterval(() => {
      if (running) return
      running = sweepGuests(ctx)
        .then(() => {})
        .catch((e) => app.log.warn({ err: { message: (e as Error)?.message } }, 'guest sweep failed'))
        .finally(() => {
          running = null
        })
    }, intervalMs)
    timer.unref()
  })
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer)
    timer = null
    await running // the database closes after this hook
  })
}
