// Outside markers (wave J, J1): who on a board is outside Dark Burn Creative and Trailer Park Group, and
// the "Internal only" switch of a workspace or a project. Owner decisions 2026-10-05: targeted markers
// rather than many warnings: an "External" tag on outside people wherever they appear, a one-time
// confirm before inviting or raising one, a "Shared outside" marker while anyone outside (or a link)
// can open a board, an "Internal only" switch the server enforces (default off), and a bell notice to
// the board's owners the first time an outside account joins one of their boards.
//
// Everything here is decided on the server, from the stored verified addresses that make someone a
// creator (apps/api/src/auth/creator-sql.ts). `User` stays clean: the manager-only fields (whether an
// account is outside, its verified email domain, its masked address) sit next to it, only in answers
// to people who may manage access (manage_access on the board, owner or admin of the workspace). The
// plain "External" tag (no domain) is for everyone who can see the person on the board.
//
// A leaf module: it imports only zod and ./domain-access.ts, so index.ts, dashboard.ts and comments.ts
// can use its values at module top level without an import cycle.

import { z } from 'zod'
import { AccountEmail } from './domain-access.ts'

// ---- whether an account is outside ---------------------------------------------------------------

/**
 * - `false`: at Dark Burn / TPG: a verified address at a creator domain or on the exceptions list, at
 *   the account's last check (however long ago: a colleague who has not opened Lobby for a day is not
 *   marked or asked about; the server re-checks a stale account whenever its status decides something:
 *   a grant, an internal-only scope, the team of team-only comments);
 * - `true`: outside: Lobby has checked this account's addresses and none of them qualifies (however
 *   long ago it checked: a later check can only make it a creator by finding a new address), or a
 *   name-only guest;
 * - `'unconfirmed'`: Lobby cannot tell: the account's addresses were never checked. Treated as outside
 *   the team (team-only comments), never shown as "External" to everyone.
 */
export const OutsideStatus = z.union([z.boolean(), z.literal('unconfirmed')])
export type OutsideStatus = z.infer<typeof OutsideStatus>

/**
 * The manager-only fields on AccessRequest, ShareMember and WorkspaceMember (absent for everyone else,
 * and from an api before wave J; the web then shows no tag and asks nothing). WorkspaceMember carries
 * them for the workspace's owners and admins, and, with `?boardId=`, for a manager of that board (the
 * Share dialog's people picker).
 * - `emailDomain`: the domain of the account's primary verified address (null: none stored);
 * - `emailHint`: that address masked ("c•••@client.example"), never the full one.
 */
export const OutsideFields = {
  outside: OutsideStatus.optional(),
  emailDomain: z.string().nullable().optional(),
  emailHint: z.string().nullable().optional(),
}
export interface OutsideInfo {
  outside: OutsideStatus
  emailDomain: string | null
  emailHint: string | null
}

/** The tag on an outside account (name-only guests keep their " (guest)" instead). */
export const EXTERNAL_TAG = 'External'
/** The board top bar and dashboard card marker while someone outside, or a link, can open the board. */
export const SHARED_OUTSIDE_LABEL = 'Shared outside'
export const SHARED_OUTSIDE_TITLE =
  'People outside Dark Burn Creative and Trailer Park Group can open this board (an outside account, a guest, or an open review, workshop or guest link).'

/** F10's "Team only" toggle (AUTHZ-TEAM-OUTSIDER: the team is creators with a workspace role). */
export const TEAM_ONLY_HINT = 'People outside Dark Burn / TPG won’t see it'

/** The one-time confirm before inviting, approving or raising someone outside (the web asks). */
export const outsideConfirmText = (who: string): string =>
  `${who} is outside Dark Burn and Trailer Park Group. They will only see this board.`
/** The same confirm when Lobby cannot tell (the account's addresses are unconfirmed). */
export const unconfirmedConfirmText = (who: string): string =>
  `Lobby couldn’t confirm whether ${who} is at Dark Burn or Trailer Park Group. If they are outside, they will only see this board.`

// ---- the board's outside people (everyone who can view the board) ---------------------------------

/**
 * GET /api/boards/:bid/sharing/outside (view). `people`: the accounts with access to the board that are
 * outside (OutsideStatus true; name-only guests are left out, they carry " (guest)"), at most 500, for
 * the "External" tags on cursors, the people list, comment authors and the @mention picker.
 * `emailDomain` only for callers who may manage access (null for everyone else).
 * `sharedOutside`: the board's "Shared outside" marker. `internalOnly`: the board is in an
 * internal-only workspace or project (null: sharing outside is allowed).
 */
export const InternalOnlyScope = z.enum(['workspace', 'project'])
export type InternalOnlyScope = z.infer<typeof InternalOnlyScope>

export const BOARD_OUTSIDE_PEOPLE_MAX = 500

export const BoardOutsidePeople = z.object({
  sharedOutside: z.boolean(),
  internalOnly: InternalOnlyScope.nullable().default(null),
  people: z.array(z.object({ userId: z.string(), emailDomain: z.string().nullable().default(null) })),
})
export type BoardOutsidePeople = z.infer<typeof BoardOutsidePeople>

/**
 * POST /api/boards/:bid/sharing/address-check (manage_access, creators only): whether an address typed
 * in the Share dialog is outside, decided by the server's policy (the exceptions list never reaches
 * the web), so the dialog can ask before it invites. Never logged.
 */
export const AddressCheckInput = z.strictObject({ email: AccountEmail })
export const AddressCheckResult = z.object({
  email: z.string(),
  outside: z.boolean(),
  emailDomain: z.string(),
  /** The board is in an internal-only workspace or project: the server refuses this invite (409). */
  internalOnly: InternalOnlyScope.nullable(),
})
export type AddressCheckResult = z.infer<typeof AddressCheckResult>

// ---- "Internal only" ------------------------------------------------------------------------------

export const INTERNAL_ONLY_CODE = 'INTERNAL_ONLY'

/** 409 INTERNAL_ONLY: what the server refuses while a workspace or project is internal only. */
export const INTERNAL_ONLY_MESSAGES: Readonly<Record<InternalOnlyScope, string>> = {
  workspace:
    'This workspace is internal only: only people at Dark Burn Creative or Trailer Park Group can be invited or given access here, and review, workshop and guest links are off. A workspace owner or admin can turn this off.',
  project:
    'This project is internal only: only people at Dark Burn Creative or Trailer Park Group can be invited or given access to its boards, and review, workshop and guest links are off. A workspace owner or admin can turn this off.',
}

/**
 * 503 COLLEAGUES_UNCONFIRMED (wave J refix round 2, IO-9): a visibility raise or a "Duplicate, keep sharing"
 * in an internal-only scope would count colleagues whose addresses Lobby has not confirmed with the sign-in
 * service for over a day, and it could not confirm all of them in one go. Nothing was changed; a retry
 * confirms the next ones.
 */
export const COLLEAGUES_UNCONFIRMED_CODE = 'COLLEAGUES_UNCONFIRMED'
export const COLLEAGUES_UNCONFIRMED_MESSAGE =
  'Lobby is still confirming some colleagues’ email addresses with the sign-in service, so nothing was changed. Try again in a minute.'

/** PUT /api/workspaces/:wid/internal-only and PUT /api/projects/:pid/internal-only. */
export const SetInternalOnlyInput = z.strictObject({ internalOnly: z.boolean() })
export type SetInternalOnlyInput = z.infer<typeof SetInternalOnlyInput>

const PersonRef = z.object({
  id: z.string(),
  name: z.string(),
  handle: z.string().nullable(),
  color: z.string(),
  avatarUrl: z.string().nullable(),
})

/** One account outside DBC/TPG that still has access in an internal-only scope (listed, never removed). */
export const OutsideAccessPerson = z.object({
  /** The same shape as index.ts `User` (this leaf module cannot import it). */
  user: PersonRef,
  outside: OutsideStatus,
  emailDomain: z.string().nullable(),
  emailHint: z.string().nullable(),
  /** Their workspace role (guest: only the boards below). */
  workspaceRole: z.enum(['owner', 'admin', 'member', 'guest']),
  /** Their direct board grants in the scope (the board's project, for the project lists). */
  boards: z.array(
    z.object({ id: z.string(), title: z.string(), projectId: z.string().nullable(), role: z.string() }),
  ),
})
export type OutsideAccessPerson = z.infer<typeof OutsideAccessPerson>

/** An open review, workshop or guest link in the scope (revoked from the review dialog). */
export const OutsideAccessLink = z.object({
  id: z.string(),
  boardId: z.string(),
  boardTitle: z.string(),
  projectId: z.string().nullable(),
  role: z.string(),
  expiresAt: z.string(),
  allowGuests: z.boolean(),
})
export type OutsideAccessLink = z.infer<typeof OutsideAccessLink>

/**
 * A pending single-use invitation in the scope to an address outside Dark Burn / TPG (sent before the
 * switch went on). While the scope is internal only nobody outside can accept it (409 INTERNAL_ONLY);
 * it is listed so a manager can revoke it (DELETE /api/invitations/:id). `boardId` null: a workspace
 * invitation. `emailHint` is the masked address, never the full one.
 */
export const OutsideAccessInvitation = z.object({
  id: z.string(),
  boardId: z.string().nullable(),
  boardTitle: z.string().nullable(),
  projectId: z.string().nullable(),
  role: z.string(),
  expiresAt: z.string(),
  emailDomain: z.string(),
  emailHint: z.string(),
})
export type OutsideAccessInvitation = z.infer<typeof OutsideAccessInvitation>

/**
 * GET /api/workspaces/:wid/internal-only (members and above). `outsideAccess` only for owners and
 * admins, and only while the workspace or one of its projects is internal only (null otherwise): the
 * outside accounts, open links and pending outside invitations that still reach the workspace's
 * boards, so a manager can remove them after turning a switch on (the switch never removes anything by
 * itself). `invitations` is absent from an api before the J1 review fixes (read as none).
 */
export const InternalOnlySettings = z.object({
  workspace: z.boolean(),
  projects: z.array(z.object({ projectId: z.string(), internalOnly: z.boolean() })),
  /** The caller may turn the switches on (owners and admins); turning one off also needs a creator. */
  canChange: z.boolean(),
  canTurnOff: z.boolean(),
  outsideAccess: z
    .object({
      people: z.array(OutsideAccessPerson),
      links: z.array(OutsideAccessLink),
      invitations: z.array(OutsideAccessInvitation).default([]),
    })
    .nullable(),
})
export type InternalOnlySettings = z.infer<typeof InternalOnlySettings>

// ---- names and messages people type (BRW-1 / INV-1: no invisible reordering) ---------------------

// C0 and C1 controls, the bidi controls that make text read differently on screen than it is stored
// (U+061C, U+200E/F, U+202A-E, U+2066-9), the line and paragraph separators (U+2028/9) and the
// zero-width characters that hide inside look-alike names (U+200B, U+2060, U+FEFF). Listed as code
// points (no escapes or literals in source) and checked one code point at a time.
const INVISIBLE = new Set([
  0x061c, 0x200b, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2066, 0x2067, 0x2068,
  0x2069, 0x2028, 0x2029, 0xfeff,
])
/** ZWNJ and ZWJ (U+200C, U+200D): kept only where they join two characters of a non-Latin text. */
const JOINERS = new Set([0x200c, 0x200d])
const WHITESPACE = /\s/u

const isControl = (cp: number) => cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)

/**
 * Whether a joiner next to this character can do something: an emoji sequence (a person and a laptop,
 * a skin tone, a flag's variation selector) or a script that uses joiners in its spelling (Persian,
 * Arabic, the Indic scripts). Never next to ASCII (inside a Latin look-alike, "Bo" + ZWJ + "b", it only
 * hides), whitespace, a control or another invisible character.
 */
const joinable = (ch: string | undefined): boolean => {
  if (ch === undefined) return false
  const cp = ch.codePointAt(0) ?? 0
  return cp > 0x9f && !INVISIBLE.has(cp) && !JOINERS.has(cp) && !WHITESPACE.test(ch)
}

/**
 * Text a person typed for others to read (a display name, an access request's message): every
 * control, bidi and zero-width character removed (tabs and line breaks become one space), runs of
 * spaces folded and the ends trimmed. Ordinary non-ASCII text stays: accents, right-to-left scripts,
 * and the joiners (ZWJ, ZWNJ) that sit between two such characters, so emoji sequences and Persian or
 * Indic spelling are unchanged; a joiner anywhere else (next to ASCII, a space or an end) is removed.
 */
export function cleanDisplayText(raw: string): string {
  const chars = [...raw]
  let out = ''
  let last: string | undefined
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string
    const cp = ch.codePointAt(0) ?? 0
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d) {
      out += ' '
      last = ' '
    } else if (JOINERS.has(cp)) {
      if (joinable(last) && joinable(chars[i + 1])) {
        out += ch
        last = ch
      }
    } else if (isControl(cp) || INVISIBLE.has(cp)) continue
    else {
      out += ch
      last = ch
    }
  }
  return out.replace(/ {2,}/g, ' ').trim()
}
