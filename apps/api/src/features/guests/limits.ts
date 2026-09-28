// Abuse limits for name-only guests (docs/WAVE3-CONTRACTS.md §2 guests), shared by both ways a guest
// redeems a guest link: POST /api/invitations/:token/guest (join.ts) and, for a guest who is already
// signed in, POST /api/invitations/:token/accept (routes/invitations.ts).

import { GUESTS_PER_LINK } from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import { conflict } from '../../errors.ts'

/**
 * Throws 409 GUEST_LIMIT when the link already let in GUESTS_PER_LINK guests other than `guestId`
 * (null: a guest who does not exist yet). A guest already on the link can always come back. Call in
 * the transaction that locked the invitation row FOR UPDATE, so simultaneous joins cannot all pass.
 */
export async function assertGuestRoomOnLink(
  tx: Queryable,
  invitationId: string,
  guestId: string | null,
): Promise<void> {
  const row = await tx.one<{ n: number; mine: boolean }>(
    `SELECT count(*) FILTER (WHERE r.user_id IS DISTINCT FROM $2::text)::int AS n,
            coalesce(bool_or(r.user_id = $2::text), false) AS mine
       FROM invitation_redemptions r JOIN users u ON u.id = r.user_id AND u.kind = 'guest'
      WHERE r.invitation_id = $1`,
    [invitationId, guestId],
  )
  if (!row.mine && row.n >= GUESTS_PER_LINK)
    throw conflict(
      'GUEST_LIMIT',
      `This link has let in ${GUESTS_PER_LINK} guests, its limit. Ask whoever shared it for a new link.`,
    )
}

/**
 * The key the per-address limit on new guests counts under: an IPv4 address as it is, and for IPv6
 * the /64 it belongs to (a single client can pick any address in its /64, so counting addresses
 * would let it through as often as it likes). IPv4-mapped IPv6 addresses count as their IPv4.
 */
export function clientAddressKey(ip: string): string {
  const addr = (ip.split('%')[0] ?? '').toLowerCase()
  if (!addr.includes(':')) return addr
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr)
  if (mapped?.[1]) return mapped[1]
  const [head = '', tail] = addr.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
  const prefix = groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '') || '0')
  while (prefix.length < 4) prefix.push('0')
  return `${prefix.join(':')}::/64`
}
