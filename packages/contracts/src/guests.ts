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

/** Longest guest name, in characters (code points), after trimming. */
export const GUEST_NAME_MAX = 40
/** A guest session never outlives its link, and never lasts longer than this. */
export const GUEST_SESSION_MAX_MS = 7 * 24 * 60 * 60 * 1000
/** Guests one link can let in. */
export const GUESTS_PER_LINK = 200
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
