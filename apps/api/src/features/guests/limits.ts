// Abuse limits for name-only guests (docs/WAVE3-CONTRACTS.md §2 guests), shared by both ways a guest
// redeems a guest link: POST /api/invitations/:token/guest (join.ts) and, for a guest who is already
// signed in, POST /api/invitations/:token/accept (routes/invitations.ts).

import { GUEST_JOINS_PER_LINK, GUESTS_PER_LINK } from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import { conflict } from '../../errors.ts'
import { rateLimited } from '../../rate-limit.ts'

export const LINK_RATE_MESSAGE =
  'Lots of guests joined through this link just now. Wait a few minutes and try again.'

/**
 * Whether `guestId` (null: a guest who does not exist yet) may come in as a NEW guest of the link:
 * - 409 GUEST_LIMIT when the link already let in GUESTS_PER_LINK guests other than them;
 * - 429 RATE_LIMITED (with Retry-After) when GUEST_JOINS_PER_LINK.max guests joined through it in the
 *   last GUEST_JOINS_PER_LINK.windowMs, whatever addresses they came from (the per-address limit in
 *   join.ts cannot see a crowd of addresses).
 * A guest already on the link can always come back, and people with an account are never counted.
 * Both come from the link's recorded redemptions (the first time each person used it), counted in
 * the transaction that locked the invitation row FOR UPDATE: simultaneous joins cannot all pass, and
 * a refused join counts for nothing.
 */
export async function assertGuestRoomOnLink(
  tx: Queryable,
  invitationId: string,
  guestId: string | null,
  at: Date,
): Promise<void> {
  const since = new Date(at.getTime() - GUEST_JOINS_PER_LINK.windowMs)
  const row = await tx.one<{ n: number; mine: boolean; recent: number; oldest: Date | null }>(
    `SELECT count(*) FILTER (WHERE r.user_id IS DISTINCT FROM $2::text)::int AS n,
            coalesce(bool_or(r.user_id = $2::text), false) AS mine,
            count(*) FILTER (WHERE r.redeemed_at > $3)::int AS recent,
            min(r.redeemed_at) FILTER (WHERE r.redeemed_at > $3) AS oldest
       FROM invitation_redemptions r JOIN users u ON u.id = r.user_id AND u.kind = 'guest'
      WHERE r.invitation_id = $1`,
    [invitationId, guestId, since],
  )
  if (row.mine) return
  if (row.n >= GUESTS_PER_LINK)
    throw conflict(
      'GUEST_LIMIT',
      `This link has let in ${GUESTS_PER_LINK} guests, its limit. Ask whoever shared it for a new link.`,
    )
  if (row.recent >= GUEST_JOINS_PER_LINK.max) {
    const freesAt = (row.oldest?.getTime() ?? at.getTime()) + GUEST_JOINS_PER_LINK.windowMs
    throw rateLimited(freesAt - at.getTime(), LINK_RATE_MESSAGE)
  }
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
