// API schemas for name-only guests (docs/WAVE3-CONTRACTS.md). Browser-safe. Owned by the guests owner.
//
// Do not import values from ./index.ts here: index.ts re-exports this module.
//
// A manager can tick "Anyone with the link can join with just a name (no account)" on a review link
// (viewer/commenter) or a workshop link (editor). Such a link's invite page then offers "Join as a
// guest": POST /api/invitations/:token/guest {name} creates a user with no sign-in identity, gives it
// the link's board role (the same redemption as accepting: use counter, max uses, expiry) and starts a
// session that ends with the link, or after 7 days, whichever comes first.

import { z } from 'zod'
import { ReviewLanding } from './review-status.ts'

/** Longest guest name, in characters (code points), after trimming. */
export const GUEST_NAME_MAX = 40
/** A guest session never outlives its link, and never lasts longer than this. */
export const GUEST_SESSION_MAX_MS = 7 * 24 * 60 * 60 * 1000
/** Guests one link can let in. */
export const GUESTS_PER_LINK = 200
/**
 * New guests per client address (an IPv6 client counts by its /64). The address a room of people
 * shares is their office NAT, so this is sized for a workshop, not for one person: a 12-person session
 * in one office must get in at once (10 per 10 minutes refused the 11th).
 */
export const GUEST_JOINS_PER_ADDRESS = { max: 60, windowMs: 10 * 60 * 1000 } as const
/**
 * New guests per link, whatever their address, on top of GUESTS_PER_LINK: however many addresses
 * someone with the link controls, the link lets in at most this many new guests in any window.
 * Counted from the link's recorded redemptions (the database), so it holds across restarts.
 */
export const GUEST_JOINS_PER_LINK = { max: 60, windowMs: 10 * 60 * 1000 } as const
/**
 * Wave V (R1, the join-cap fix; WS3 applies it in apps/api/src/features/guests/join.ts; docs/WAVE-V-CONTRACTS.md §3.4):
 * a WORKSHOP link (multi-use, role editor) is how a room of people joins from one QR at once, so its joins are counted
 * apart from the two windows above:
 *  - per link, GUEST_JOINS_PER_WORKSHOP_LINK instead of GUEST_JOINS_PER_LINK (GUESTS_PER_LINK still caps the total);
 *  - per client address AND link, GUEST_JOINS_PER_ADDRESS_PER_WORKSHOP_LINK, instead of the address's own window: the
 *    office NAT a room shares lets the whole room in;
 *  - per client address over every workshop link together, GUEST_JOINS_PER_ADDRESS_ON_WORKSHOP_LINKS (two full rooms),
 *    so holding several workshop links multiplies nothing past it.
 * Joins through any other link keep GUEST_JOINS_PER_ADDRESS and GUEST_JOINS_PER_LINK, untouched by workshop joins.
 */
export const GUEST_JOINS_PER_WORKSHOP_LINK = { max: 200, windowMs: 10 * 60 * 1000 } as const
export const GUEST_JOINS_PER_ADDRESS_PER_WORKSHOP_LINK = { max: 200, windowMs: 10 * 60 * 1000 } as const
export const GUEST_JOINS_PER_ADDRESS_ON_WORKSHOP_LINKS = { max: 400, windowMs: 10 * 60 * 1000 } as const

// Per-link caps (SEAM-05). A guest identity costs nothing but a name, so a cap per person multiplies
// by the guests one person can create. The name-only guests of one link therefore SHARE caps on what
// reaches everyone on its board, on top of each person's own. People with an account never count, and
// a request the route refuses anyway never uses up the link's share.

/**
 * Board event streams the guests of one link may hold open together (on its board): two per guest at
 * the full GUESTS_PER_LINK (a tab and a reconnect). Past it the link's newcomers get 503
 * TOO_MANY_SUBSCRIBERS, so one link can never take more than 400 of a board's 2,000 slots.
 */
export const GUEST_LINK_STREAMS = 2 * GUESTS_PER_LINK
/** Reactions the guests of one link may send together: half of the board's own rate (100 per second). */
export const GUEST_LINK_REACTIONS = { max: 50, windowMs: 1000 } as const
/**
 * "Bring everyone to me" (summon) by the guest editors of one link together: one per window, like one
 * person's own cooldown, so a crowd of guests cannot keep pulling everyone around.
 */
export const GUEST_LINK_SUMMONS = { max: 1, windowMs: 3000 } as const
/** What every place that shows a name adds to a guest's name (the stored name stays as typed). */
export const GUEST_NAME_SUFFIX = ' (guest)'

// C0/C1 control characters, and the bidi controls that can make a name read differently on screen
// than it is stored (U+061C, U+200E/F, U+202A-E, U+2066-9), plus line and paragraph separators.
// Listed as code points (no escapes in source) and checked one code point at a time.
const BIDI_AND_SEPARATORS = new Set([
  0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x2028,
  0x2029,
])

function hasForbiddenCharacter(name: string): boolean {
  for (const ch of name) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || BIDI_AND_SEPARATORS.has(cp)) return true
  }
  return false
}

/** Why a typed guest name is refused (null = fine). Shared by the API and the invite page. */
export function guestNameProblem(raw: string): string | null {
  const name = raw.trim()
  if (!name) return 'Enter your name.'
  if ([...name].length > GUEST_NAME_MAX) return `Use at most ${GUEST_NAME_MAX} characters.`
  if (hasForbiddenCharacter(name)) return 'Use letters, numbers, spaces and punctuation only.'
  return null
}

/** A guest's name as typed: 1-40 characters after trimming, no control characters. */
export const GuestName = z
  .string()
  .max(400) // before trimming; the real limit is checked below
  .transform((s) => s.trim())
  .superRefine((name, ctx) => {
    const problem = guestNameProblem(name)
    if (problem) ctx.addIssue({ code: 'custom', message: problem })
  })

/** The display form of a guest's name ("Sam (guest)"). */
export const guestDisplayName = (name: string) => `${name.trim()}${GUEST_NAME_SUFFIX}`

// tldraw's cursor name tag is at most 120 px wide (108 px of 12 px text) and cuts the end off what
// does not fit, so "Chase Boyajian (guest)" reads "Chase Boyajian (gu…": the marker, the one part
// that must show, is what goes. The name the sync ticket carries (cursor labels, the people on the
// board) is therefore shortened in front of the marker instead. Widths are the widest of Segoe UI,
// Arial, Roboto and Helvetica at 12 px, rounded up (summed per character, which overestimates any
// one font); anything outside Latin counts wide.

/** Room for the name in front of " (guest)" (41 px) in a cursor label, in px of 12 px text. */
const LABEL_NAME_PX = 108 - 41
const ELLIPSIS_PX = 12

function glyphPx(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0
  if (cp < 0x80) {
    if ("'ijl".includes(ch)) return 3
    if (' !,.:;I[]`|'.includes(ch)) return 4
    if ('"()-/frt{}'.includes(ch)) return 5
    if ('*vxyz'.includes(ch)) return 6
    if ('#ABEFKPSTVXYZbdgpq'.includes(ch)) return 8
    if ('+<=>CDHNRU^w~'.includes(ch)) return 9
    if ('&GOQ'.includes(ch)) return 10
    if ('%Mm'.includes(ch)) return 11
    if (ch === 'W') return 12
    if (ch === '@') return 13
    return 7 // digits and the remaining letters and signs
  }
  if (/[\p{Mn}\p{Me}\p{Cf}]/u.test(ch)) return 0 // combining marks, invisible format characters
  if (cp >= 0xc0 && cp <= 0x24f) return 'æœÆŒ'.includes(ch) ? 12 : 9 // accented Latin letters
  if (cp > 0xffff || /\p{Extended_Pictographic}/u.test(ch)) return 17 // emoji and other astral characters
  return 13 // other scripts, CJK, fullwidth forms, wide blanks
}

/**
 * A guest's name for cursor labels and the people on a board: the display form ("Sam (guest)"), with
 * a long name shortened ("Chase B… (guest)") so the marker always fits in the label.
 */
export function guestLabelName(name: string): string {
  const chars = [...name.trim()]
  if (chars.reduce((px, ch) => px + glyphPx(ch), 0) <= LABEL_NAME_PX) return guestDisplayName(name)
  let kept = ''
  let used = 0
  for (const ch of chars) {
    used += glyphPx(ch)
    if (used > LABEL_NAME_PX - ELLIPSIS_PX) break
    kept += ch
  }
  return `${kept.trimEnd()}…${GUEST_NAME_SUFFIX}`
}

/**
 * POST /api/invitations/:token/guest. `name` is required for someone who is not signed in. A guest
 * who is already signed in (they joined through another guest link) keeps their name: the new grant
 * goes to the same guest user and `name` is ignored.
 */
export const GuestJoinInput = z.object({ name: GuestName.optional() })
export type GuestJoinInput = z.input<typeof GuestJoinInput>

export const GuestJoined = z.object({
  workspaceId: z.string(),
  boardId: z.string(),
  user: z.object({ id: z.string(), name: z.string() }),
  /** A new guest user was created (false: a signed-in guest joined one more board). */
  created: z.boolean(),
  /** When this browser's guest session ends (the link's expiry or 7 days, whichever comes first). */
  sessionExpiresAt: z.string(),
  /** Wave S (WS4): where the link opens (review.ts reviewLandingPath); absent: the board (as from an older api). */
  landing: ReviewLanding.optional(),
})
export type GuestJoined = z.infer<typeof GuestJoined>

/** Who is signed in: someone with a sign-in account, or a name-only guest. */
export const UserKind = z.enum(['account', 'guest'])
export type UserKind = z.infer<typeof UserKind>

/**
 * The part of GET /api/me this feature adds (M1's `Me` plus `kind`). Parse the same response with
 * both; `kind` defaults to 'account' so an older server's answer still parses.
 */
export const MeKind = z.object({ kind: UserKind.default('account') })
export type MeKind = z.infer<typeof MeKind>

/**
 * The part of GET /api/invitations/:token this feature adds (M1's InvitationPreview plus
 * `allowGuests`): the invite page offers "Join as a guest" only when it is true.
 */
export const InvitationGuestAccess = z.object({ allowGuests: z.boolean().default(false) })
export type InvitationGuestAccess = z.infer<typeof InvitationGuestAccess>

/**
 * GET /api/boards/:bid/guests (view): the name-only guests who have a grant on the board, so the
 * Share dialog can leave out what the server refuses for them (ownership). Their names already carry
 * the marker, so this tells nobody anything new.
 */
export const BoardGuests = z.object({ userIds: z.array(z.string()) })
export type BoardGuests = z.infer<typeof BoardGuests>

/**
 * Error codes this feature answers with (the message is always user-facing):
 * - GUESTS_NOT_ALLOWED (403): the link needs an account (its manager did not allow guests);
 * - GUEST_ACCOUNT_REQUIRED (403): a guest tried something only people with an account can do
 *   (accept a normal invitation, request access, create boards or links, manage people);
 * - GUEST_ONLY_THROUGH_LINKS (409): someone tried to add a guest to another board, or to make one an
 *   owner; guests reach boards only through guest links;
 * - SIGNED_IN (409): "join as a guest" while signed in with an account (accept instead);
 * - GUEST_LIMIT (409): the link already let in its maximum number of guests.
 */
export const GUEST_ERROR_CODES = [
  'GUESTS_NOT_ALLOWED',
  'GUEST_ACCOUNT_REQUIRED',
  'GUEST_ONLY_THROUGH_LINKS',
  'SIGNED_IN',
  'GUEST_LIMIT',
] as const
export type GuestErrorCode = (typeof GUEST_ERROR_CODES)[number]
