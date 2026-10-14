import {
  type BoardMember,
  DOMAIN_ACCESS_MESSAGES,
  type EmailInviteFallbackReason,
  type EmailInviteResult,
  type InternalOnlyScope,
  InviteEmail,
  type OutsideStatus,
  outsideConfirmText,
  unconfirmedConfirmText,
  type WorkspaceMember,
} from '@draftroom/contracts'
import { BOARD_ROLES, type BoardRole, type BoardVisibility, roleAtLeast } from '../lib/permissions.ts'

export const VISIBILITY_OPTIONS: readonly {
  value: BoardVisibility
  label: string
  describe(workspace: string): string
}[] = [
  {
    value: 'private',
    label: 'Private',
    describe: () => 'Only the people listed above can open this board.',
  },
  {
    value: 'workspace_view',
    label: 'Workspace can view',
    describe: (ws) => `Everyone in ${ws} can open and view this board. People listed above keep their role.`,
  },
  {
    value: 'workspace_edit',
    label: 'Workspace can edit',
    describe: (ws) => `Everyone in ${ws} can open and edit this board. Guests still need to be added.`,
  },
]

/** Invite links can hand out any role except owner (the API rejects owner invitations too). */
export const inviteRoleOptions = (): Exclude<BoardRole, 'owner'>[] =>
  BOARD_ROLES.filter((r): r is Exclude<BoardRole, 'owner'> => r !== 'owner')

/**
 * Only explicit grants get a role select. Workspace-derived access (workspace admins are owners of
 * every board; visibility gives members view/edit) is not changed by a board grant, so offering a
 * select there would look like it did something it does not.
 */
export const memberRoleEditable = (m: BoardMember) => m.source === 'grant'

/** Workspace members who can be given an explicit grant (not already granted on this board). */
export function shareableWorkspaceMembers(
  workspaceMembers: readonly WorkspaceMember[],
  boardMembers: readonly BoardMember[],
): WorkspaceMember[] {
  const granted = new Set(boardMembers.filter((m) => m.source === 'grant').map((m) => m.user.id))
  return workspaceMembers
    .filter((m) => !granted.has(m.user.id) && m.role !== 'owner' && m.role !== 'admin')
    .sort((a, b) => a.user.name.localeCompare(b.user.name))
}

/** You first, then by role (owners first), then by name. */
export function sortMembers<M extends BoardMember>(members: readonly M[], selfUserId: string): M[] {
  return [...members].sort((a, b) => {
    if (a.user.id === selfUserId) return -1
    if (b.user.id === selfUserId) return 1
    const byRole = rank(b.role) - rank(a.role)
    return byRole || a.user.name.localeCompare(b.user.name)
  })
}

const rank = (r: BoardRole) =>
  roleAtLeast(r, 'owner') ? 4 : roleAtLeast(r, 'editor') ? 3 : roleAtLeast(r, 'commenter') ? 2 : 1

// ---- dashboard-share additions (docs/FEATURES-M2-CONTRACTS.md) ------------------------------------

export const ROLE_OPTION_LABEL: Record<BoardRole, string> = {
  owner: 'Owner',
  editor: 'Can edit',
  commenter: 'Can comment',
  viewer: 'Can view',
}

export type InviteTarget =
  | { kind: 'empty' }
  | { kind: 'member'; member: WorkspaceMember }
  | { kind: 'already'; member: WorkspaceMember }
  | { kind: 'email'; email: string }
  /**
   * K5-5: the start of someone's @handle, name (or a word of it), or of an address whose name part starts
   * their handle: the field lists them to pick (`matches`, the people still without a direct grant first).
   */
  | { kind: 'partial'; text: string; matches: WorkspaceMember[] }
  | { kind: 'unknown'; text: string }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** The most people the invite field's suggestion list shows at once. */
export const MAX_INVITE_SUGGESTIONS = 8

/** Lower case without accents: "Zoë" matches "zoe". */
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

/**
 * K5-5: whether `typed` starts this person's @handle, their name or one of its words (with or without an "@"
 * in front: accounts that sign in with Clerk have no handle, and people still type "@chase" for a colleague),
 * or, for an address being typed ("carol@da"), whether its name part starts their handle.
 * The members list carries no addresses (only a masked one for people outside), so an address is matched
 * through the handle.
 */
export function memberMatches(typed: string, m: Pick<WorkspaceMember, 'user'>): boolean {
  const t = fold(typed.trim())
  if (!t) return false
  const handle = fold(m.user.handle ?? '')
  const at = t.indexOf('@')
  if (at > 0) return handle !== '' && handle.startsWith(t.slice(0, at))
  const q = t.replace(/^@/, '')
  if (!q) return false
  if (handle.startsWith(q)) return true
  const name = fold(m.user.name)
  return name.startsWith(q) || name.split(/[\s.-]+/).some((w) => w.startsWith(q))
}

/**
 * The people `text` may mean, for the suggestion list: those still without a direct grant on the board
 * first, then those whose name (not only a word of it) starts with it, then by name; at most
 * MAX_INVITE_SUGGESTIONS.
 */
export function inviteMatches(
  text: string,
  workspaceMembers: readonly WorkspaceMember[],
  boardMembers: readonly Pick<BoardMember, 'user' | 'source'>[],
): WorkspaceMember[] {
  const granted = new Set(boardMembers.filter((b) => b.source === 'grant').map((b) => b.user.id))
  const q = fold(text.trim().replace(/^@/, ''))
  return workspaceMembers
    .filter((m) => memberMatches(text, m))
    .sort(
      (a, b) =>
        Number(granted.has(a.user.id)) - Number(granted.has(b.user.id)) ||
        Number(!fold(a.user.name).startsWith(q)) - Number(!fold(b.user.name).startsWith(q)) ||
        a.user.name.localeCompare(b.user.name),
    )
    .slice(0, MAX_INVITE_SUGGESTIONS)
}

/** How the hint and a suggestion name someone: "Carol Smith (@carol)". */
export const inviteWho = (m: Pick<WorkspaceMember, 'user'>): string =>
  `${m.user.name}${m.user.handle ? ` (@${m.user.handle})` : ''}`

/** What picking someone puts in the field: their @handle, else their name. */
export const pickedText = (m: Pick<WorkspaceMember, 'user'>): string =>
  m.user.handle ? `@${m.user.handle}` : m.user.name

/**
 * What the "Invite by @handle or email" field refers to. A handle (with or without @) or an exact
 * name of someone in the workspace is granted directly; an email address or anyone else gets an
 * invite link to send them (Lobby does not send email). K5-5: the start of someone's handle or name is
 * 'partial' (the field lists them to pick); only text that starts no one's is 'unknown'.
 */
export function parseInviteTarget(
  text: string,
  workspaceMembers: readonly WorkspaceMember[],
  boardMembers: readonly Pick<BoardMember, 'user' | 'source'>[],
): InviteTarget {
  const t = text.trim()
  if (!t) return { kind: 'empty' }
  if (EMAIL_RE.test(t)) return { kind: 'email', email: t }
  const handle = t.replace(/^@/, '').toLowerCase()
  const byHandle = workspaceMembers.find((m) => m.user.handle?.toLowerCase() === handle)
  const byName = workspaceMembers.filter((m) => m.user.name.toLowerCase() === t.toLowerCase())
  const member = byHandle ?? (byName.length === 1 ? byName[0] : undefined)
  if (!member) {
    const matches = inviteMatches(t, workspaceMembers, boardMembers)
    return matches.length > 0 ? { kind: 'partial', text: t, matches } : { kind: 'unknown', text: t }
  }
  return targetFor(member, boardMembers)
}

/** Someone typed exactly or picked from the list: a direct grant, or already granted. */
export function targetFor(
  member: WorkspaceMember,
  boardMembers: readonly Pick<BoardMember, 'user' | 'source'>[],
): InviteTarget {
  const granted = boardMembers.some((b) => b.user.id === member.user.id && b.source === 'grant')
  return granted ? { kind: 'already', member } : { kind: 'member', member }
}

// ---- domain access (docs/DOMAIN-ACCESS-CONTRACTS.md §9) --------------------------------------------

/** What "Invite" does with what was typed (the server has the final word on every step). */
export type InvitePlan =
  | { kind: 'none' }
  | { kind: 'already'; member: WorkspaceMember }
  /** Someone in the workspace: a direct grant. */
  | { kind: 'grant'; member: WorkspaceMember }
  /** An address: a single-use link only that verified address can accept (D13; no email is sent). */
  | { kind: 'locked-link'; email: string }
  | { kind: 'invalid-email'; message: string }
  /** Neither an address nor someone in the workspace: ask for their address, make nothing. */
  | { kind: 'ask-email' }
  /** K5-5: the start of someone's name or handle: pick them from the list (nothing is granted yet). */
  | { kind: 'pick'; matches: WorkspaceMember[] }
  /** The inviter's own address (fixer round 3, §21): nothing is created (the api answers 409). */
  | { kind: 'own-address'; message: string }

/** The prompt for a name that is neither an address nor a known @handle. */
export const ASK_EMAIL_PROMPT = 'Enter their email address to invite them.'

/**
 * Fixer round 3 (§21): an address that is the signed-in account's own (`Me.access.email`, stored
 * normalised), compared the way the api compares. A link locked to it would let only the inviter in, so
 * the dialog says so at once and creates nothing; the api refuses it too (409 INVITATION_TO_SELF), for
 * the account's other verified addresses as well.
 */
export function isOwnAddress(email: string, own: string | null | undefined): boolean {
  if (!own) return false
  const checked = checkInviteEmail(email)
  return checked.ok && checked.email === own.toLowerCase()
}

/** What the Share dialog says for the inviter's own address (the api's words for its 409). */
export const OWN_ADDRESS_MESSAGE = DOMAIN_ACCESS_MESSAGES.invitationToSelf

export function invitePlan(target: InviteTarget, ownEmail: string | null = null): InvitePlan {
  switch (target.kind) {
    case 'empty':
      return { kind: 'none' }
    case 'already':
      return { kind: 'already', member: target.member }
    case 'member':
      return { kind: 'grant', member: target.member }
    case 'unknown':
      return { kind: 'ask-email' }
    case 'partial':
      return { kind: 'pick', matches: target.matches }
    case 'email': {
      const checked = checkInviteEmail(target.email)
      if (!checked.ok) return { kind: 'invalid-email', message: checked.message }
      if (isOwnAddress(checked.email, ownEmail)) return { kind: 'own-address', message: OWN_ADDRESS_MESSAGE }
      return { kind: 'locked-link', email: checked.email }
    }
  }
}

/**
 * Under a new single-use link (Invite people, and "Link for one person"): it works for one verified
 * address only, once. Lobby sends no email for it.
 */
export function lockedLinkNote(
  link: { email: string; role: BoardRole; expiresAt: string },
  formatDate: (iso: string) => string,
): string {
  return `Only ${link.email} can use this link, once, until ${formatDate(link.expiresAt)}. Anyone else who opens it is turned away. Send it to them yourself (no email is sent); they join as “${ROLE_OPTION_LABEL[link.role]}”.`
}

/** A pending single-use invitation: "For pat@… · Can view · expires Oct 4 · by Alice" (older: "Unused link"). */
export function pendingInviteLabel(
  inv: { email: string | null; role: BoardRole; expiresAt: string; createdBy: { name: string } },
  formatDate: (iso: string) => string,
): string {
  const head = inv.email ? `For ${inv.email}` : 'Unused link'
  return `${head} · ${ROLE_OPTION_LABEL[inv.role]} · expires ${formatDate(inv.expiresAt)} · by ${inv.createdBy.name}`
}

/** Why the owner option (and transfer of ownership) is off for someone (`ShareMember.canOwn` false). */
export const OWNER_NEEDS_CREATOR = 'Only people at Dark Burn Creative or Trailer Park Group can own boards'

/**
 * The same reason as visible text (`member-owner-note`): a disabled option in a native select popup
 * shows no tooltip, and a disabled button takes no focus, so a title alone is rarely seen or announced.
 * It is said once, under "People with access", and the role menu and transfer button of every row it
 * applies to point to it (`aria-describedby`). Fixer round 2: on each row it repeated down a list of
 * client reviewers and, at 390 px, grew each of their rows to about eight lines.
 */
export const OWNER_NEEDS_CREATOR_NOTE = `${OWNER_NEEDS_CREATOR}, so Owner is turned off for everyone else here.`

/** Whether that person's Owner option is off because they cannot own boards (a creator is managing). */
export const showOwnerNote = (m: { canShare: boolean; canOwn?: boolean; current: BoardRole }): boolean =>
  m.canShare && m.canOwn === false && m.current !== 'owner'

/** One row of the people list, as the owner note needs it. */
export interface OwnerNoteRow {
  /** The caller can change this person's direct grant (the row has a role menu). */
  editable: boolean
  /** A name-only guest: Owner is never offered, for another reason. */
  guest: boolean
  /** `ShareMember.canOwn`. */
  canOwn?: boolean
  /** The role the row's menu shows (their direct grant, else their effective role). */
  current: BoardRole
}

/** Whether this row's role menu (and transfer button) points to the owner note. */
export const rowNeedsOwnerNote = (row: OwnerNoteRow, canShare: boolean): boolean =>
  row.editable && !row.guest && showOwnerNote({ canShare, canOwn: row.canOwn, current: row.current })

/** Whether the people list shows the owner note (once): some row's Owner option is off for that reason. */
export const listShowsOwnerNote = (rows: readonly OwnerNoteRow[], canShare: boolean): boolean =>
  rows.some((row) => rowNeedsOwnerNote(row, canShare))

/** The roles "Or pick someone from the workspace…" offers: never owner (set that on the person's row). */
export const ADD_MEMBER_ROLES: readonly Exclude<BoardRole, 'owner'>[] = BOARD_ROLES.filter(
  (r): r is Exclude<BoardRole, 'owner'> => r !== 'owner',
)

/** While Lobby could not confirm the caller's account (`access.reason` 'unconfirmed'). */
export const UNCONFIRMED_SHARE_NOTE =
  "Lobby couldn't confirm your account, so inviting people, creating links and giving more access are paused. You can still lower or remove access. Reload in a minute to try again."

/**
 * The Share dialog's note for a manager who may not hand out access (`share-creator-note`): an outside
 * account gets the server's CREATOR_REQUIRED message; a creator Lobby could not confirm is told it is
 * paused, never that they are not at Dark Burn Creative.
 */
export function shareCreatorNote(access: { creator: boolean; reason: string } | null): {
  reason: 'unconfirmed' | 'outside'
  text: string
} {
  return access && !access.creator && access.reason === 'unconfirmed'
    ? { reason: 'unconfirmed', text: UNCONFIRMED_SHARE_NOTE }
    : { reason: 'outside', text: DOMAIN_ACCESS_MESSAGES.creatorRequiredShare }
}

export interface RoleChoice {
  role: BoardRole
  disabled: boolean
  /** The reason, as a tooltip, when disabled. */
  title?: string
}

/**
 * The role menu of one person's direct grant. A creator who manages access gets every role (never
 * owner for a name-only guest; owner turned off for someone who cannot own boards). A manager who is
 * not a creator may only lower: the current role and the ones below it (Remove stays).
 */
export function memberRoleChoices(m: {
  /** The role the select shows: their direct grant (else their effective role). */
  current: BoardRole
  /** The caller may hand out access (`canHandOutAccess`). */
  canShare: boolean
  /** `ShareMember.canOwn` (undefined: an older api, which allows it). */
  canOwn?: boolean
  /** A name-only guest: never an owner. */
  guest?: boolean
}): RoleChoice[] {
  const roles = BOARD_ROLES.filter((r) => !(m.guest && r === 'owner'))
  if (!m.canShare) {
    return roles.filter((r) => roleAtLeast(m.current, r)).map((role) => ({ role, disabled: false }))
  }
  return roles.map((role) =>
    role === 'owner' && m.canOwn === false && m.current !== 'owner'
      ? { role, disabled: true, title: OWNER_NEEDS_CREATOR }
      : { role, disabled: false },
  )
}

const VISIBILITY_RANK: Record<BoardVisibility, number> = { private: 0, workspace_view: 1, workspace_edit: 2 }

/**
 * The workspace-access select: someone who may not hand out access can only lower it (the options
 * above the current one are turned off; the server refuses raising with 403 CREATOR_REQUIRED).
 */
export function visibilityChoices(
  current: BoardVisibility,
  canRaise: boolean,
): { value: BoardVisibility; label: string; disabled: boolean }[] {
  return VISIBILITY_OPTIONS.map((o) => ({
    value: o.value,
    label: o.label,
    disabled: !canRaise && VISIBILITY_RANK[o.value] > VISIBILITY_RANK[current],
  }))
}

export interface AccessDetail {
  user: { id: string }
  role: BoardRole
  source: 'grant' | 'workspace'
  grant: BoardRole | null
  workspaceRole: 'owner' | 'admin' | 'member' | 'guest'
  withoutGrant: BoardRole | null
  viaReviewLink: boolean
  linkEndsAt: string | null
}

/**
 * "Through which grant" for one person (PRS-02). A grant a link gave carries the link's own role
 * (GET /api/boards/:bid/sharing/members matches them), and only a workshop link gives edit: so an
 * editor who joined with a link joined with the workshop link, which ends at a time of day (F7).
 */
export function accessSource(m: AccessDetail, workspaceName: string, format: LinkDateFormat): string {
  if (m.viaReviewLink) {
    const workshop = m.grant === 'editor'
    const joined = workshop ? 'Joined with the workshop link' : 'Joined with a review link'
    return m.linkEndsAt ? `${joined} · until ${format(m.linkEndsAt, workshop ? 'time' : 'date')}` : joined
  }
  if (m.source === 'workspace') {
    if (m.workspaceRole === 'owner' || m.workspaceRole === 'admin')
      return `${workspaceName} ${m.workspaceRole} · owns every board`
    const through = `Everyone in ${workspaceName} can ${m.role === 'editor' ? 'edit' : 'view'}`
    return m.grant ? `${through} (also invited as “${ROLE_OPTION_LABEL[m.grant]}”)` : through
  }
  return m.workspaceRole === 'guest' ? 'Direct access · guest' : 'Direct access'
}

/**
 * When removing someone's direct invite leaves them another grant, the dialog says so (PRS-02). Null
 * when removal ends their access (or they have no direct invite to remove).
 */
export function removalNote(m: AccessDetail): string | null {
  if (!m.grant || !m.withoutGrant) return null
  return `Removing their invite leaves “${ROLE_OPTION_LABEL[m.withoutGrant]}” through the workspace.`
}

/**
 * Direct grants can be changed or removed; workspace-derived access cannot (M1 rule). A workspace
 * owner/admin owns every board whatever their grant says, so their grant is not offered for editing.
 */
export const grantEditable = (m: Pick<AccessDetail, 'grant' | 'workspaceRole'>) =>
  m.grant !== null && m.workspaceRole !== 'owner' && m.workspaceRole !== 'admin'

// ---- shell-sharing-platform fixes ------------------------------------------------------------------

/** "Oct 4" for a review link, "3:40 PM" for a workshop link (they last hours). */
export type LinkDateFormat = (iso: string, kind: 'date' | 'time') => string

/**
 * The access line a non-manager sees under "Workspace access" while a link is open (PRI-07): the
 * select says "Private", but anyone with the link can get in. The widest open link wins.
 */
export function linkAccessLine(
  links: readonly { role: 'viewer' | 'commenter' | 'editor'; expiresAt: string }[],
  format: LinkDateFormat,
): string | null {
  if (!links.length) return null
  const top = links.some((l) => l.role === 'editor')
    ? 'editor'
    : links.some((l) => l.role === 'commenter')
      ? 'commenter'
      : 'viewer'
  const last = links
    .filter((l) => l.role === top)
    .reduce((a, b) => (Date.parse(b.expiresAt) > Date.parse(a.expiresAt) ? b : a))
  if (top === 'editor')
    return `Anyone with the workshop link can edit until ${format(last.expiresAt, 'time')}.`
  return `Anyone with the review link can ${top === 'commenter' ? 'comment' : 'view'} until ${format(last.expiresAt, 'date')}.`
}

/**
 * The confirmation before removing someone (PRI-21). When the workspace still gives them access,
 * say what they keep instead.
 */
export function removeConfirmText(name: string, fallback: string | null): string {
  if (fallback) return `Remove ${name}’s invite? ${fallback}`
  return `Remove ${name}? ${name} loses access now.`
}

// ---- share with a client, workshop link, "More ways to share" (DANA-03, F3, R15) --------------------

/**
 * "Share with a client" starts as the common case: a review link that lets people comment, and that
 * a client opens with just a name (no account). It lasts REVIEW_LINK_DEFAULT_DAY (14) days.
 */
export const CLIENT_LINK_DEFAULTS = { role: 'commenter', allowGuests: true } as const
/** A workshop link hands out EDIT access, so guests stay an explicit choice there. */
export const WORKSHOP_LINK_GUESTS_DEFAULT = false

/**
 * The line under "Share with a client". It follows the guest option, which sits above the Create
 * button and applies to the link it creates: it never says "after signing in" while guests may join
 * with just a name. `nextLink` (G2): a link is already open, so this line, like the box, is about the
 * NEXT link and says so, in one short line (a link that exists changes through its own box in the list).
 */
export function clientLinkHint(role: 'viewer' | 'commenter', allowGuests: boolean, nextLink = false): string {
  const verb = role === 'commenter' ? 'comment' : 'view'
  if (nextLink)
    return `The next link is for clients and reviewers to ${verb}, never edit. ${allowGuests ? 'No account needed.' : 'They sign in to open it.'}`
  return allowGuests
    ? `One link for clients and reviewers to ${verb}, never edit. No account needed; their access ends with the link.`
    : `One link for clients and reviewers to ${verb}, never edit. They sign in to open it; their access ends with the link.`
}

/**
 * The line under "Workshop link" (R15): "after signing in" only when guests are not allowed. `nextLink`
 * (G2): a workshop link is already open, so the line describes the next one, in one short line.
 */
export function workshopLinkHint(allowGuests: boolean, nextLink = false): string {
  const who = allowGuests ? 'with just a name or an account' : 'after signing in'
  if (nextLink) return `The next workshop link: anyone with it can edit for a few hours, ${who}.`
  return `For a live session: anyone with the link can edit for a few hours, ${who}. Their edit access ends with the link.`
}

/**
 * G2: the "join with just a name" box above Create. It is a choice for the link Create makes: ticking it
 * after a link exists used to read as if it changed that link (it did not). With a link already open the
 * label and the sentence under the box say so, and the link's own box (GUESTS_TOGGLE_LABEL) changes it.
 */
export function guestsOptionLabel(openLinks: number): string {
  return openLinks > 0
    ? 'For the next link: anyone with it can join with just a name (no account)'
    : 'Anyone with the link can join with just a name (no account)'
}

/** The box on a link that exists (G2): it applies to that link and nothing else. */
export const GUESTS_TOGGLE_LABEL = 'Anyone with this link can join with just a name (no account)'

/** What a link's own guest box says after it changed, for the status line under it. */
export function guestsToggleSaying(allowGuests: boolean): string {
  return allowGuests
    ? 'Anyone with this link can now join with just a name.'
    : 'No new guests can join this link with just a name. People who already joined keep their access until the link ends or is revoked.'
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** K5-5: the collapsed section's title (client links, the workshop link, invite by email, one-time links). */
export const GUESTS_SECTION_TITLE = 'Guests and clients'

/**
 * The summary of the collapsed "Guests and clients" (a client review link, a workshop link, invite by
 * email, one-time invite links): what is inside, or what is open in there, so nothing running hides behind
 * the fold.
 */
export function guestsSummary(
  open: {
    reviewLinks: number
    workshopLinks: number
    unusedInvites: number
  },
  /** linksAllowed: false on an Internal-only board (no client or workshop link can be made there) */
  opts: { readonly linksAllowed?: boolean } = {},
): string {
  const extras = [
    open.reviewLinks > 0 ? `${count(open.reviewLinks, 'client link', 'client links')} open` : '',
    open.workshopLinks > 0 ? `${count(open.workshopLinks, 'workshop link', 'workshop links')} open` : '',
    open.unusedInvites > 0 ? count(open.unusedInvites, 'unused invite link', 'unused invite links') : '',
  ].filter(Boolean)
  if (extras.length) return extras.join(' · ')
  return opts.linksAllowed === false
    ? 'Invite by email, one-time invite links'
    : 'Client review link, workshop link for a live session, invite by email, one-time invite links'
}

/** K5-5: the collapsed "Advanced" section (export and download) says the setting it holds. */
export const ADVANCED_SECTION_TITLE = 'Advanced'

export function advancedSummary(policy: 'editors' | 'everyone' | 'everyone-including-guests' | null): string {
  switch (policy) {
    case 'editors':
      return 'Export and download: editors and owners only'
    case 'everyone':
      return 'Export and download: everyone with an account'
    case 'everyone-including-guests':
      return 'Export and download: everyone, guests too'
    default:
      return 'Export and download'
  }
}

// ---- invite by email ------------------------------------------------------------------------------

/**
 * Under the "Invite by email" field. Only a server that signs people in with Clerk can email; the
 * server decides per address in the end (see `emailInviteOutcome`).
 */
export function emailInviteHint(canEmail: boolean): string {
  return canEmail
    ? 'We email them an invitation to this board that works only for that address. People who already use Lobby get access right away.'
    : 'This server can’t send email (that needs a Lobby account): you get a one-time link that works only for that address, to send them instead.'
}

/** The "@handle, name or email" field's hint for an address, pointing at the email form when it can email. */
export function linkForEmailHint(canEmail: boolean): string {
  return canEmail
    ? 'This makes a one-time link that only this address can use, for you to send. To have Lobby email the invitation, use “Invite by email” below.'
    : 'Lobby does not send email: you get a one-time invite link that only this address can use, to copy and send them yourself.'
}

/** The line under "Invite people" while nothing is typed. */
export const INVITE_IDLE_HINT =
  'People in the workspace get access right away. For anyone else, enter their email.'

/**
 * K5-5: the one line under the invite field, for what is typed. It is said once: a submit adds no second
 * copy of it (for the inviter's own address the alert replaces it: `notice`). '' draws nothing.
 */
export function inviteHintText(
  target: InviteTarget,
  opts: { workspaceName: string; canEmail: boolean; ownAddress: boolean; notice: string | null },
): string {
  switch (target.kind) {
    case 'empty':
      return INVITE_IDLE_HINT
    case 'member':
      return `${target.member.user.name} is in ${opts.workspaceName}: they get access right away.`
    case 'already':
      return `${target.member.user.name} already has access. Change their role under People with access.`
    case 'email':
      if (!opts.ownAddress) return linkForEmailHint(opts.canEmail)
      return opts.notice === OWN_ADDRESS_MESSAGE ? '' : OWN_ADDRESS_MESSAGE
    case 'partial': {
      const [only] = target.matches
      return target.matches.length === 1 && only
        ? `Pick ${inviteWho(only)} from the list.`
        : `${target.matches.length} people in ${opts.workspaceName} match. Pick one from the list.`
    }
    case 'unknown':
      return `No one in ${opts.workspaceName} matches. ${ASK_EMAIL_PROMPT}`
  }
}

/** The address as the API will read it, or the reason it is not one (shown next to the field). */
export function checkInviteEmail(text: string): { ok: true; email: string } | { ok: false; message: string } {
  const r = InviteEmail.safeParse(text)
  if (r.success) return { ok: true, email: r.data }
  return { ok: false, message: r.error.issues[0]?.message ?? 'Enter a valid email address.' }
}

export interface EmailInviteOutcome {
  /** success: done; info: nothing changed; fallback: no email went out, the link is to be sent. */
  tone: 'success' | 'info' | 'fallback'
  /** The headline (announced). */
  text: string
  detail: string
  /** Present when the inviter has to send the link themselves. */
  link: string | null
}

const FALLBACK_DETAIL: Record<EmailInviteFallbackReason, (email: string) => string> = {
  email_not_configured: (email) =>
    `This server can’t send email: that needs a Lobby account. Send the link to ${email} yourself.`,
  existing_account: (email) =>
    `${email} has a sign-in account but hasn’t opened Lobby yet, and invitation emails only go to new people. Send them the link yourself.`,
  invalid_email: (email) =>
    `The email service didn’t accept ${email}. Check the address, or send the link yourself.`,
  rate_limited: (email) =>
    `The email service is limiting invitations right now. Send the link to ${email} yourself.`,
  provider_error: (email) =>
    `The email service couldn’t send it right now. Send the link to ${email} yourself.`,
}

/** What the Share dialog says after "Send invite", for each answer of the email invitation route. */
export function emailInviteOutcome(
  result: EmailInviteResult,
  role: Exclude<BoardRole, 'owner'>,
  formatDate: (iso: string) => string,
): EmailInviteOutcome {
  const asRole = `as “${ROLE_OPTION_LABEL[role]}”`
  switch (result.mode) {
    case 'granted':
      return result.alreadyHadAccess
        ? {
            tone: 'info',
            text: `${result.user.name} already has access to this board (“${ROLE_OPTION_LABEL[result.role]}”).`,
            detail: 'Nothing changed: an invite never lowers a role. Change it under People with access.',
            link: null,
          }
        : {
            tone: 'success',
            text: `Added ${result.user.name} to this board.`,
            detail: `They already use Lobby, so they can open it now, ${asRole}.`,
            link: null,
          }
    case 'emailed':
      return {
        tone: 'success',
        text: `Invitation email sent to ${result.email}.`,
        detail: `The link in it works once, only for ${result.email}, ${asRole}, until ${formatDate(result.expiresAt)}.`,
        link: null,
      }
    case 'link':
      return {
        tone: 'fallback',
        text: 'Couldn’t email — copy this link instead.',
        detail: `${FALLBACK_DETAIL[result.reason](result.email)} It works once, only for ${result.email}, ${asRole}, until ${formatDate(result.expiresAt)}.`,
        link: result.url,
      }
  }
}

// ---- wave J: people outside Dark Burn / TPG (@draftroom/contracts outside.ts) -----------------------

/**
 * Whether giving this person access asks first: they are outside, or Lobby cannot tell. Creators, and
 * an api from before wave J (no field), ask nothing; the server decides either way.
 */
export const asksBeforeGiving = (outside: OutsideStatus | undefined): boolean =>
  outside === true || outside === 'unconfirmed'

/**
 * Said instead of inviting when the server's address check failed (the network, the server, a 503):
 * the dialog never skips its question silently. A 4xx says the server's own words (429: too many checks).
 */
export const ADDRESS_CHECK_FAILED =
  'Lobby couldn’t check that address just now, so nothing was sent. Try again.'

/** How the confirm names an account: with its masked address when the server sent one. */
export const outsideWho = (name: string, emailHint: string | null | undefined): string =>
  emailHint ? `${name} (${emailHint})` : name

/** The confirm's words for this person or address (the owner's sentence; a softer one when unknown). */
export const outsideConfirmFor = (who: string, outside: OutsideStatus | undefined): string =>
  outside === 'unconfirmed' ? unconfirmedConfirmText(who) : outsideConfirmText(who)

/** A new grant, or a higher one; lowering or keeping a role never asks. */
export function raisesAccess(current: BoardRole | null | undefined, next: BoardRole): boolean {
  if (!current) return true
  return BOARD_ROLES.indexOf(next) < BOARD_ROLES.indexOf(current)
}

/** "Or pick someone from the workspace…" options: an outside account says so in its option text. */
export function pickerOptionText(m: WorkspaceMember): string {
  const base = `${m.user.name}${m.user.handle ? ` (@${m.user.handle})` : ''}`
  if (m.outside !== true) return base
  return `${base} · ${m.emailDomain ? `External · ${m.emailDomain}` : 'External'}`
}

/** The Share dialog's note while the board's workspace or project is internal only. */
export function internalOnlyNote(scope: InternalOnlyScope): string {
  return scope === 'workspace'
    ? 'This workspace is internal only: invite people at Dark Burn Creative or Trailer Park Group only. Review, workshop and guest links are off.'
    : 'This board’s project is internal only: invite people at Dark Burn Creative or Trailer Park Group only. Review, workshop and guest links are off.'
}
