import {
  DOMAIN_ACCESS_CODES,
  GUEST_NAME_SUFFIX,
  type InvitationBoardState,
  type InvitationEmailLock,
  InvitationGoneBody,
  type InvitationPreview,
} from '@draftroom/contracts'
import { boardPath, workspacePath } from '../lib/routing.ts'

const BOARD_ROLE: Record<string, string> = {
  owner: 'Owner',
  editor: 'Can edit',
  commenter: 'Can comment',
  viewer: 'Can view',
}
const WORKSPACE_ROLE: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  guest: 'Guest',
}

export interface InvitationSummary {
  eyebrow: string
  title: string
  /** The heading of the role fact: "Your role", or "Their role" on the inviter's own link. */
  roleHeading: string
  roleLabel: string
  acceptLabel: string
}

/**
 * Copy for the invitation screen. Unknown roles are shown as "Member"/"Can view" rather than raw.
 * `sentByYou`: the inviter is looking at their own locked link (domain access, §9 state 3, fixer round
 * 2), so the page is about their invitation, never "{inviter} invited you… Join".
 */
export function invitationSummary(
  inv: InvitationPreview,
  opts: { sentByYou?: boolean; boardInTrash?: boolean } = {},
): InvitationSummary {
  const who = inv.invitedBy.name || 'Someone'
  const own = opts.sentByYou === true
  const roleHeading = own ? 'Their role' : 'Your role'
  if (inv.board) {
    return {
      eyebrow: own ? 'Your invitation to a board' : `${who} invited you to a board`,
      // Fixer round 3 (§21): nobody can join a board in the trash, so the title does not say "Join".
      title: own || opts.boardInTrash ? `“${inv.board.title}”` : `Join “${inv.board.title}”`,
      roleHeading,
      roleLabel: BOARD_ROLE[inv.role] ?? 'Can view',
      acceptLabel: 'Accept and open board',
    }
  }
  return {
    eyebrow: own ? 'Your invitation to a workspace' : `${who} invited you to a workspace`,
    title: own ? inv.workspace.name : `Join ${inv.workspace.name}`,
    roleHeading,
    roleLabel: WORKSPACE_ROLE[inv.role] ?? 'Member',
    acceptLabel: 'Accept and open workspace',
  }
}

/**
 * The one action on the inviter's own locked link (fixer round 2): back to what they shared. Never
 * "Sign in with a different account", which would sign the inviter out.
 */
export function ownInvitationWayBack(inv: Pick<InvitationPreview, 'board' | 'workspace'>): {
  label: string
  href: string
} {
  return inv.board
    ? { label: 'Back to the board', href: boardPath(inv.board.id) }
    : { label: 'Go to the workspace', href: workspacePath(inv.workspace.id) }
}

// ---- name-only guests (wave 3) -------------------------------------------------------------------

/** What the guest will see and what others will see them as, on the "Join as a guest" form. */
export function guestJoinHint(name: string): string {
  const shown = name.trim() ? `“${name.trim()} (guest)”` : 'your name followed by “(guest)”'
  return `No account needed. People on the board see you as ${shown}. Your access ends when the link does, or when you sign out.`
}

/**
 * A name as [the name, the guest marker] ("Sam (guest)" → ["Sam", " (guest)"]; no marker → null), so a
 * list that cuts long names with an ellipsis can cut the name and keep the marker in view.
 */
export function splitGuestMarker(name: string): [string, string | null] {
  if (name.length <= GUEST_NAME_SUFFIX.length || !name.endsWith(GUEST_NAME_SUFFIX)) return [name, null]
  return [name.slice(0, -GUEST_NAME_SUFFIX.length), GUEST_NAME_SUFFIX]
}

/**
 * F14: someone's own name where "(you)" is added: "Dana Whitfield (guest, you)", never
 * "Dana Whitfield (guest) (you)"; "Alice (you)" for an account.
 */
export function ownName(name: string): string {
  const [base, marker] = splitGuestMarker(name)
  return marker ? `${base} (guest, you)` : `${name} (you)`
}

/**
 * The " (you)" or ", you" to put after someone's own name that is shown as [name, guest marker] (lists
 * that cut long names keep the marker and this in view): with the marker, the marker becomes
 * " (guest, you)" (F14).
 */
export function ownNameParts(name: string): [string, string] {
  const [base, marker] = splitGuestMarker(name)
  return marker ? [base, ' (guest, you)'] : [name, ' (you)']
}

/**
 * DANA2-07: what a guest reads when their access ends, on the board's "revoked" screen and on the
 * guest-ended screen that follows it: one message, the same words both times.
 */
export const GUEST_ENDED_COPY = {
  title: 'Your guest access has ended',
  what: 'The link you joined with was revoked or has expired, you were removed from the board, or you signed out.',
  next: 'To come back, ask whoever shared the link with you for a new one.',
} as const

/**
 * The words for a refused join or accept, by the API's error code (its message is already
 * user-facing; these only replace the few where the page can say more).
 */
export function guestJoinError(code: string, message: string): string {
  switch (code) {
    case 'GUEST_LIMIT':
      return 'This link has let in as many guests as it can. Ask whoever shared it for a new link, or sign in instead.'
    case 'GUESTS_NOT_ALLOWED':
      return 'This link needs an account. Sign in to accept it.'
    default:
      return message
  }
}

// ---- a link that no longer works (PRI-04) --------------------------------------------------------

/** What the API says about a link that expired, was revoked or used up (the 410 body). */
export interface GoneDetails {
  invitedBy: { name: string } | null
  /** Present only when the signed-in caller can open the board right now. */
  boardId: string | null
}

/**
 * Reads the 410 details of an invitation. The shared client turns error bodies into a plain error,
 * so this one call reads the body itself (same-origin, same cookie rules as the client).
 */
export async function fetchGoneDetails(
  token: string,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): Promise<GoneDetails | null> {
  try {
    const res = await fetchImpl(`/api/invitations/${encodeURIComponent(token)}`, {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
    })
    if (res.status !== 410) return null
    const parsed = InvitationGoneBody.safeParse(await res.json().catch(() => null))
    return parsed.success ? parsed.data.gone : { invitedBy: null, boardId: null }
  } catch {
    return null
  }
}

/** The dead-end page's words: whom to ask for a new link. */
export function goneCopy(details: GoneDetails | null): { title: string; body: string } {
  const who = details?.invitedBy?.name?.trim()
  return {
    title: 'This invitation is no longer valid',
    body: who
      ? `It has expired, was revoked, or was already used by someone else. Ask ${who} for a new link.`
      : 'It has expired, was revoked, or was already used by someone else. Ask the person who invited you for a new link.',
  }
}

// ---- sign in, then accept without a second click (PRI-16) ----------------------------------------

const ACCEPT_KEY = 'draftroom:accept-invite'

/**
 * Remembers (for this tab) that the person pressed "Sign in to accept" on this invitation, so the
 * invite page can accept by itself once they are back. Only that click sets it: a crafted link
 * alone never accepts anything.
 */
export function rememberAcceptIntent(storage: Pick<Storage, 'setItem'> | null, token: string) {
  try {
    storage?.setItem(ACCEPT_KEY, JSON.stringify({ token, at: Date.now() }))
  } catch {}
}

/** True (once) when the person asked to accept `token` in the last 30 minutes. */
export function takeAcceptIntent(
  storage: Pick<Storage, 'getItem' | 'removeItem'> | null,
  token: string,
  now = Date.now(),
): boolean {
  try {
    const raw = storage?.getItem(ACCEPT_KEY)
    if (!raw) return false
    const v = JSON.parse(raw) as { token?: unknown; at?: unknown }
    if (v.token !== token) return false
    storage?.removeItem(ACCEPT_KEY)
    return typeof v.at === 'number' && now - v.at >= 0 && now - v.at < 30 * 60_000
  } catch {
    return false
  }
}

export function safeSessionStorage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

/** The sign-in heading when someone arrives from an invitation (PRI-16). */
export function signInHeading(inv: (InvitationPreview & Partial<InvitationEmailLock>) | null): string {
  // DANA-08: a lobby is a project's space; signing in opens Lobby, the app (and every lobby in it).
  if (!inv) return 'Sign in to Lobby'
  const who = inv.invitedBy.name ? ` (invited by ${inv.invitedBy.name})` : ''
  // Domain access: a locked invitation only works for one address, so the heading repeats it (masked).
  const lock = lockedHint(inv)
  const verb = lock ? `Sign in with ${lock} to join` : 'Sign in to join'
  return inv.board ? `${verb} “${inv.board.title}”${who}` : `${verb} ${inv.workspace.name}${who}`
}

// ---- invitations locked to an email address (domain access, contracts doc §9) ------------------------

/** The masked invited address of a usable locked invitation ("p•••@client.example"), else null. */
export function lockedHint(inv: Partial<InvitationEmailLock> | null | undefined): string | null {
  return inv?.emailLocked && inv.invitedEmailHint ? inv.invitedEmailHint : null
}

/** The primary action on a locked invitation for someone signed out (state 1). */
export const lockedSignInLabel = (hint: string) => `Sign in or create an account with ${hint}`

/**
 * Whether the signed-in account is the wrong one for this invitation (state 3): the preview says so
 * (`matchesYou === false`, from its stored verified addresses), or accepting answered 403
 * INVITATION_EMAIL_MISMATCH (fresher data than the preview's).
 */
export function isEmailMismatch(
  inv: Partial<InvitationEmailLock> | null | undefined,
  mismatchAtAccept: boolean,
): boolean {
  return mismatchAtAccept || (!!inv?.emailLocked && inv.matchesYou === false)
}

/**
 * PRI-16 auto-accept after "Sign in to accept": never on a mismatch (the caller consumes the intent
 * first, so a wrong account never loops through sign-in and back).
 */
export function shouldAutoAccept(
  inv: (Partial<InvitationEmailLock> & Partial<InvitationBoardState>) | null | undefined,
): boolean {
  // Fixer round 3 (§21): nor for a board in the trash (accepting is refused until it is restored).
  return !isEmailMismatch(inv, false) && inv?.boardInTrash !== true
}

/**
 * What the wrong account reads (state 3). The full invited address is never shown, only the hint;
 * the account's own address comes from `/api/me` `access.email`.
 */
export function emailMismatchCopy(opts: {
  hint: string | null
  email: string | null
  invitedBy: string | null
  /** The signed-in account created this invitation (`sentByYou`): an inviter checking their link. */
  sentByYou?: boolean
}): { title: string; body: string } {
  const sentTo = opts.hint ?? 'a different email address'
  if (opts.sentByYou) {
    // Never "ask yourself to invite yourself": say whom the link is for and what to do with it.
    const asYou = opts.email ? ` It won't let you in as ${opts.email}.` : ''
    return {
      title: 'This is the invitation you sent',
      body: `Only ${sentTo} can use this link.${asYou} Send it to them: they sign in with that address to join.`,
    }
  }
  const inviter = opts.invitedBy?.trim() || 'the person who invited you'
  const signedInAs = opts.email
    ? `You're signed in as ${opts.email}.`
    : "You're signed in with a different account."
  const ask = opts.email ? `ask ${inviter} to invite ${opts.email}` : `ask ${inviter} for a new invitation`
  return {
    title: 'This invitation is for someone else',
    body: `This invitation was sent to ${sentTo}. ${signedInAs} Sign in with the invited address, or ${ask}.`,
  }
}

/** What a refused accept shows, by the api's code (its message is already user-facing). */
export function acceptErrorCopy(code: string, message: string): { message: string; retry: boolean } {
  switch (code) {
    case DOMAIN_ACCESS_CODES.identityUnavailable:
      return { message: 'Couldn’t confirm your email right now. Try again in a minute.', retry: true }
    default:
      return { message: guestJoinError(code, message), retry: false }
  }
}

// ---- fixer round 3 (docs/DOMAIN-ACCESS-CONTRACTS.md §21) ---------------------------------------------

/** The part of the session state the invite page's "Can't reach Lobby" check reads. */
export type SessionReachability =
  | { status: 'loading' | 'signed-out' | 'signed-in' }
  | { status: 'unreachable'; message: string }

/**
 * What the invite page says, instead of anything else, when Lobby cannot be reached (UnreachableScreen,
 * as RequireSession shows): the invitation read got no answer or a 5xx, or the session read did (state
 * 'unreachable', also after the re-read that follows a 403 INVITATION_EMAIL_MISMATCH). null when both
 * answered. The page is public, so before this it showed someone who is signed in, and only cut off,
 * the signed-out "Sign in…" state (or "Invitation unavailable" with no way to retry).
 */
export function inviteUnreachable(
  session: SessionReachability,
  previewError: { kind: string; message: string } | null,
): string | null {
  if (previewError && (previewError.kind === 'network' || previewError.kind === 'server'))
    return previewError.message
  if (session.status === 'unreachable') return session.message
  return null
}

/**
 * A board invitation whose board is in the trash (the preview's `boardInTrash`, or accepting answered
 * 409 BOARD_IN_TRASH): nothing can be accepted until the board is restored, and then the link works
 * again until it expires. The inviter checking their own locked link is not told to ask themselves.
 * `forSomeoneElse` (fixer round 4, §22): the signed-in account is the wrong one for a locked link
 * (`matchesYou === false`): it says whom the link is for and never promises that a restore lets them in.
 */
export function boardInTrashCopy(
  inv: Pick<InvitationPreview, 'board' | 'invitedBy'>,
  opts: { sentByYou: boolean; forSomeoneElse?: { hint: string | null; email: string | null } | null },
): { title: string; body: string } {
  const board = inv.board ? `“${inv.board.title}”` : 'This board'
  const title = 'This board is in the trash'
  if (opts.sentByYou)
    return {
      title,
      body: `${board} is in the trash, so nobody can use this link right now. Once the board is restored, the link works again until it expires.`,
    }
  if (opts.forSomeoneElse) {
    const sentTo = opts.forSomeoneElse.hint ?? 'a different email address'
    const asYou = opts.forSomeoneElse.email ? ` as ${opts.forSomeoneElse.email}` : ' with this account'
    return {
      title,
      body: `${board} is in the trash. This link is for ${sentTo}, so it won’t let you in${asYou}, even once the board is restored.`,
    }
  }
  const who = inv.invitedBy.name.trim() || 'the person who invited you'
  return {
    title,
    body: `${board} is in the trash, so this invitation can’t be used right now. Ask ${who} to restore it: the link works again once the board is back, until it expires.`,
  }
}
