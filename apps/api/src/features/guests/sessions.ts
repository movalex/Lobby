// How long a guest's session lasts (docs/WAVE3-CONTRACTS.md §2 guests): until the link's expiry, or
// 7 days after it started, whichever comes first.
//
// A link can be extended while it is open ("+1 h" on a workshop link), and its guests must not be
// signed out at the old time. So the session row (which the server checks) follows the link's
// current expiry, and the cookie is set to last as long as the link could ever be extended to (its
// role's maximum lifetime, still at most 7 days): the browser keeps offering it, the server decides.

import { GUEST_SESSION_MAX_MS, type ReviewLinkRole, reviewLinkMaxLifetimeMs } from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import type { InvitationRow } from '../../routes/invitations.ts'

/** When a guest session started at `at` through `inv` ends (the session row's expires_at). */
export const guestSessionEnd = (inv: Pick<InvitationRow, 'expires_at'>, at: Date) =>
  new Date(Math.min(inv.expires_at.getTime(), at.getTime() + GUEST_SESSION_MAX_MS))

/** The latest the session could be extended to with its link: how long the cookie is kept. */
export function guestCookieEnd(inv: Pick<InvitationRow, 'created_at' | 'role'>, at: Date): Date {
  const linkCap = inv.created_at.getTime() + reviewLinkMaxLifetimeMs(inv.role as ReviewLinkRole)
  return new Date(Math.min(linkCap, at.getTime() + GUEST_SESSION_MAX_MS))
}

/**
 * The link `invitationId` now lasts until `expiresAt`: the live sessions of guests who joined through
 * it last that long too (never past 7 days from their start, never shorter than they were). Call in
 * the transaction that extends the link. Returns how many sessions changed.
 */
export async function extendGuestSessions(
  tx: Queryable,
  invitationId: string,
  expiresAt: Date,
  at: Date,
): Promise<number> {
  const r = await tx.query(
    `UPDATE sessions s
        SET expires_at = LEAST(s.created_at + make_interval(secs => $4::double precision), $2::timestamptz)
       FROM invitation_redemptions r
       JOIN users u ON u.id = r.user_id AND u.kind = 'guest'
      WHERE r.invitation_id = $1 AND s.user_id = r.user_id
        AND s.revoked_at IS NULL AND s.expires_at > $3
        AND s.expires_at < LEAST(s.created_at + make_interval(secs => $4::double precision), $2::timestamptz)`,
    [invitationId, expiresAt, at, GUEST_SESSION_MAX_MS / 1000],
  )
  return r.rowCount
}
