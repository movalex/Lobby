// Domain access (docs/DOMAIN-ACCESS-CONTRACTS.md §7). "Creators" (a verified sign-in address at a
// creator domain, or on the exceptions list) create workspaces, projects and boards and hand out
// access; everyone else gets only what they are invited to. Invitations to an address are locked to
// that address.
//
// This module imports only zod, so index.ts and dashboard.ts can both import it without an import
// cycle. Owned by the domain-access API owner; the WEB owner asks for changes in the contracts doc.

import { z } from 'zod'

/** The longest address SMTP can carry (RFC 5321: a 256-octet path, angle brackets included). */
export const ACCOUNT_EMAIL_MAX_LENGTH = 254

/**
 * Clerk test mode (on by default on development instances) verifies any address with this
 * subaddress with a fixed code, so such an address proves nothing about who controls the mailbox.
 * Lobby never stores, matches or invites one, in any environment (contracts doc §2).
 */
export const CLERK_TEST_SUBADDRESS = '+clerk_test'

/**
 * Lowercases ASCII letters only. Unicode lowercasing would map look-alikes into real domains (U+212A
 * KELVIN SIGN lowercases to "k"), so nothing in domain access ever calls toLowerCase() on an address.
 */
export const asciiLowercase = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase())

/** Whether `s` carries Clerk's test-mode subaddress (ASCII case-insensitive). */
export const isClerkTestAddress = (s: string): boolean => asciiLowercase(s).includes(CLERK_TEST_SUBADDRESS)

export const CLERK_TEST_ADDRESS_MESSAGE = 'Lobby doesn’t accept Clerk test addresses (+clerk_test).'

/**
 * An address typed by a person (invitations, the dev sign-in form): trimmed, printable ASCII only
 * (look-alike characters never normalise into a real domain), no Clerk test subaddress,
 * ASCII-lowercased, then a plain email shape.
 */
export const AccountEmail = z
  .string()
  .trim()
  .min(1, 'Enter an email address.')
  .max(ACCOUNT_EMAIL_MAX_LENGTH, 'That email address is too long.')
  .regex(/^[!-~]+$/, 'Enter a valid email address.')
  .refine((s) => !isClerkTestAddress(s), CLERK_TEST_ADDRESS_MESSAGE)
  .transform(asciiLowercase)
  .pipe(z.email('Enter a valid email address.'))
export type AccountEmail = z.output<typeof AccountEmail>

/**
 * Why the caller is or is not a creator:
 * - `domain`, `exception`, `dev`: a creator (a creator-domain address, the exceptions list, or a dev
 *   sign-in without an email while the api runs the dev provider);
 * - `outside`: signed in, no stored address qualifies;
 * - `guest`: a name-only guest (wave 3);
 * - `unconfirmed`: the stored addresses are missing or too old and the sign-in service could not be
 *   reached to refresh them (treated as not a creator until confirmed);
 * - `legacy`: only ever the web's default, when the api predates domain access (it then enforces no
 *   creator rule, so the web behaves exactly as before). The domain-access api never sends it.
 */
export const CreatorReason = z.enum([
  'domain',
  'exception',
  'dev',
  'outside',
  'guest',
  'unconfirmed',
  'legacy',
])
export type CreatorReason = z.infer<typeof CreatorReason>

export const MeAccess = z.object({
  /** May create workspaces, projects and boards, and hand out access (where the role allows it). */
  creator: z.boolean(),
  reason: CreatorReason,
  /** The caller's OWN primary verified address (else their first verified one); null when none. */
  email: z.string().nullable(),
})
export type MeAccess = z.infer<typeof MeAccess>

/**
 * `Me.access` when the api does not send it: an api from before domain access, which gates nothing,
 * so the web shows what it always showed. The server stays authoritative either way.
 */
export const ME_ACCESS_LEGACY: MeAccess = { creator: true, reason: 'legacy', email: null }

export const DOMAIN_ACCESS_CODES = {
  creatorRequired: 'CREATOR_REQUIRED',
  roleRequiresCreator: 'ROLE_REQUIRES_CREATOR',
  emailMismatch: 'INVITATION_EMAIL_MISMATCH',
  identityUnavailable: 'IDENTITY_UNAVAILABLE',
  accountDisabled: 'ACCOUNT_DISABLED',
} as const
export type DomainAccessCode = (typeof DOMAIN_ACCESS_CODES)[keyof typeof DOMAIN_ACCESS_CODES]

/** The messages the api sends with those codes (contracts doc §4.3). The web shows them as they are. */
export const DOMAIN_ACCESS_MESSAGES = {
  /** 403 CREATOR_REQUIRED on a route that creates something. */
  creatorRequiredCreate:
    'Only people at Dark Burn Creative or Trailer Park Group can create workspaces, projects and boards in Lobby. If you work there, sign in with your work email. Otherwise, ask the person who invited you.',
  /** 403 CREATOR_REQUIRED on a route that hands out access. */
  creatorRequiredShare:
    'Only people at Dark Burn Creative or Trailer Park Group can invite people, create links or give more access in Lobby. You can still lower or remove access.',
  /** 409 ROLE_REQUIRES_CREATOR. */
  roleRequiresCreator:
    'Only people at Dark Burn Creative or Trailer Park Group can own boards or be workspace admins in Lobby. Choose a different role for this person.',
  /** 503 IDENTITY_UNAVAILABLE. */
  identityUnavailable:
    'Lobby couldn’t confirm your email address with the sign-in service. Try again in a minute.',
  /** 403 ACCOUNT_DISABLED (Clerk exchange). */
  accountDisabled:
    'This account can’t sign in to Lobby. Contact the person who runs Lobby at Dark Burn Creative.',
} as const

/** 403 INVITATION_EMAIL_MISMATCH: `hint` is the masked invited address, never the full one. */
export const invitationEmailMismatchMessage = (hint: string): string =>
  `This invitation is for ${hint}. Sign in with that email address to accept it.`

/** GET /api/invitations/:token additions (defaults, so an older api's preview still parses). */
export const InvitationEmailLock = z.object({
  /** The invitation works only for an account with the invited verified address. */
  emailLocked: z.boolean().default(false),
  /** Masked ("j•••@client.example"); only for usable locked invitations, else null. */
  invitedEmailHint: z.string().nullable().default(null),
  /**
   * Signed-in accounts only, from their stored verified addresses: whether one of them is the invited
   * one. null when signed out, for name-only guests and for invitations that are not locked.
   */
  matchesYou: z.boolean().nullable().default(null),
})
export type InvitationEmailLock = z.infer<typeof InvitationEmailLock>

/**
 * 403 from POST /api/invitations/:token/accept when the caller has no verified address matching the
 * invitation. Nothing is redeemed; the invitation stays usable for the invitee. Never carries the
 * full address.
 */
export const InvitationEmailMismatchBody = z.object({
  error: z.object({ code: z.literal('INVITATION_EMAIL_MISMATCH'), message: z.string() }),
  mismatch: z.object({
    invitedEmailHint: z.string(),
    /** null when the inviter's account is gone. */
    invitedBy: z.object({ name: z.string() }).nullable(),
  }),
})
export type InvitationEmailMismatchBody = z.infer<typeof InvitationEmailMismatchBody>
