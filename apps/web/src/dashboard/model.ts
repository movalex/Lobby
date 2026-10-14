import type { BoardWithRole, MeAccess, Project, WorkspaceSummary } from '@draftroom/contracts'
import { formatRelativeTime } from '../lib/format.ts'
import {
  type BoardRole,
  type BoardStatus,
  can,
  canCreateContent,
  canCreateInWorkspace,
  type WorkspaceRole,
} from '../lib/permissions.ts'
import type { DashboardSection } from '../lib/routing.ts'
import { CREATOR_DOMAINS, creatorDomainsInWords } from './creator-config.ts'

// ---- domain access (docs/DOMAIN-ACCESS-CONTRACTS.md §9) --------------------------------------------

/**
 * Why this person cannot create here, when that is about who they are rather than their workspace
 * role: `outside` (not at Dark Burn Creative or Trailer Park Group), `unconfirmed` (Lobby could not
 * confirm their address, so creating and sharing are paused). null otherwise (a creator, an older api
 * (`legacy`), or a name-only guest, whose copy is unchanged).
 */
export type CreateLimit = 'outside' | 'unconfirmed' | null

export interface DashboardAccess {
  /** New board, templates, import, sample board, duplicate, new project, rename project. */
  canCreate: boolean
  /**
   * A workspace role that may read the project list, move boards between projects and see storage
   * (members and above). Separate from `canCreate`: outsiders who are members keep these.
   */
  inWorkspace: boolean
  limit: CreateLimit
}

/**
 * The dashboard's two flags from `/api/me`'s `access` and the workspace role. The server enforces both
 * (403 CREATOR_REQUIRED); hiding is a courtesy. `reason: 'legacy'` (an api from before domain access)
 * is a creator, so the dashboard behaves exactly as before.
 */
export function dashboardAccess(access: MeAccess, role: WorkspaceRole | null): DashboardAccess {
  return {
    canCreate: canCreateContent(access.creator, role),
    inWorkspace: canCreateInWorkspace(role),
    limit: createLimit(access),
  }
}

export function createLimit(access: MeAccess): CreateLimit {
  if (access.creator) return null
  if (access.reason === 'outside') return 'outside'
  if (access.reason === 'unconfirmed') return 'unconfirmed'
  return null
}

/** The line every outside-account screen ends with. */
export const OUTSIDE_CREATE_NOTE =
  'Only people at Dark Burn Creative or Trailer Park Group can create boards. Work there? Sign in with your work email.'

/** The dashboard notice while the account is unconfirmed (`access-unconfirmed`). */
export const UNCONFIRMED_NOTICE = "Lobby couldn't confirm your account, so creating and sharing are paused."

/** The dashboard notice for an outside account whose workspace role would let it create (`access-outside`). */
export const OUTSIDE_NOTICE = {
  title:
    'Only people at Dark Burn Creative or Trailer Park Group can create boards, projects and links in Lobby.',
  body: 'You can open and work on the boards shared with you. Work there? Sign in with your work email.',
} as const

/**
 * Whether the dashboard says why New board, Import, Templates and "New project lobby" are missing
 * (`access-outside`): an outside account whose workspace role (owner, admin, member) would otherwise
 * create, for example an existing account that lost creator status, even in its own workspace.
 * Workspace guests never create, so they keep the role's copy; Trash and Archived offer no creating.
 */
export function showOutsideNotice(a: DashboardAccess, section: DashboardSection): boolean {
  return a.limit === 'outside' && a.inWorkspace && section.kind !== 'archived' && section.kind !== 'trash'
}

export interface NoWorkspaceCopy {
  /** `data-reason` of the screen. */
  reason: 'outside' | 'unconfirmed' | 'none'
  title: string
  /** Paragraphs, in order. */
  body: string[]
  /**
   * The one action: switch account (sign out, to sign in with another address), reload, or none. Wave K
   * (K4-4): the "not in a workspace" screen offers it too, so a phone visitor who signed in with the wrong
   * address has a way out on the screen itself.
   */
  action: 'switch-account' | 'reload' | null
  /**
   * The signed-in address, when there is one: the screen shows it prominently and offers "Copy my address"
   * (to send to a colleague who invites it). null: nothing to copy.
   */
  address: string | null
}

/** "You're signed in as pat@client.example." or, with no confirmed address, what is true instead. */
const signedInAs = (email: string | null) =>
  email
    ? `You're signed in as ${email}.`
    : "You're signed in with an account that has no confirmed email address."

/** Which addresses can create, from the build's configuration (creator-config.ts), never typed into copy. */
const workAddresses = (domains: readonly string[]) =>
  `Work addresses end in ${creatorDomainsInWords(domains)}.`

/**
 * "/" for someone with no workspace (App.tsx RootRedirect, `no-workspace`). An outside account has
 * nothing until someone invites it; `none` (a creator without a workspace, which should not happen,
 * or an older api) tells the same story with its own first line. Both say which address is signed in,
 * what to do next, and which addresses are work addresses (`domains`: the configured creator domains).
 */
export function noWorkspaceCopy(
  access: MeAccess,
  domains: readonly string[] = CREATOR_DOMAINS,
): NoWorkspaceCopy {
  if (!access.creator && access.reason === 'outside') {
    return {
      reason: 'outside',
      title: 'Nothing has been shared with you yet',
      body: [
        signedInAs(access.email),
        'When someone at Dark Burn Creative or Trailer Park Group invites this address, open the invite link they send you. Work there? Sign in with your work email.',
        workAddresses(domains),
      ],
      action: 'switch-account',
      address: access.email,
    }
  }
  if (!access.creator && access.reason === 'unconfirmed') {
    return {
      reason: 'unconfirmed',
      title: "We couldn't confirm your account",
      body: [
        'Lobby couldn’t confirm your email address with the sign-in service, so it can’t show your boards yet. Reload in a minute to try again.',
      ],
      action: 'reload',
      address: null,
    }
  }
  return {
    reason: 'none',
    title: "You're not in a workspace yet",
    body: [
      signedInAs(access.email),
      'Open an invite link from a teammate to join their workspace or board. Signed in with the wrong address? Switch account.',
      workAddresses(domains),
    ],
    action: 'switch-account',
    address: access.email,
  }
}

// ---- card menu -----------------------------------------------------------------------------------

export type BoardMenuAction =
  | 'open'
  | 'copy-link'
  | 'share'
  | 'rename'
  | 'move'
  | 'duplicate'
  | 'star'
  | 'unstar'
  | 'details'
  | 'archive'
  | 'trash'
  | 'restore'
export interface BoardMenuItem {
  action: BoardMenuAction
  label: string
  tone?: 'danger'
}

export interface BoardMenuContext {
  /**
   * Creators who are workspace members (not guests) may create boards, so they may duplicate one
   * (`DashboardAccess.canCreate`).
   */
  canCreate: boolean
  /** Moving needs the project list, which guests cannot read. */
  canMove: boolean
}

/**
 * The card menu for one board (DSH-02), derived only from the shared permission rules. The server
 * enforces the same rules; hiding an item is a courtesy, not a control.
 */
export function boardMenuItems(
  board: { role: BoardRole; status: BoardStatus; starred?: boolean },
  ctx: BoardMenuContext = { canCreate: true, canMove: true },
): BoardMenuItem[] {
  const { role, status } = board
  const items: BoardMenuItem[] = []
  const viewable = can(role, 'view', status)
  if (viewable) {
    items.push(
      { action: 'open', label: 'Open' },
      { action: 'copy-link', label: 'Copy link' },
      { action: 'share', label: 'Share…' },
    )
  }
  if (can(role, 'rename', status)) {
    items.push({ action: 'rename', label: 'Rename' })
    if (ctx.canMove) items.push({ action: 'move', label: 'Move to project…' })
  }
  if (viewable) {
    if (ctx.canCreate) items.push({ action: 'duplicate', label: 'Duplicate…' })
    items.push(
      board.starred ? { action: 'unstar', label: 'Remove star' } : { action: 'star', label: 'Star' },
      { action: 'details', label: 'Details' },
    )
  }
  if (can(role, 'restore', status)) items.push({ action: 'restore', label: 'Restore' })
  if (can(role, 'archive', status)) items.push({ action: 'archive', label: 'Archive' })
  if (can(role, 'trash', status)) items.push({ action: 'trash', label: 'Move to trash', tone: 'danger' })
  return items
}

// ---- lists ---------------------------------------------------------------------------------------

export function boardsQueryForSection(section: DashboardSection): {
  status: BoardStatus
  projectId?: string
} {
  switch (section.kind) {
    case 'archived':
      return { status: 'archived' }
    case 'trash':
      return { status: 'trashed' }
    case 'project':
      return { status: 'active', projectId: section.projectId }
    default:
      return { status: 'active' }
  }
}

const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase()

/** Title search: every word must appear, ignoring case and accents ("cafe" finds "Café retro"). */
export function filterBoards<B extends { title: string }>(boards: readonly B[], query: string): B[] {
  const words = fold(query).split(/\s+/).filter(Boolean)
  if (!words.length) return [...boards]
  return boards.filter((b) => {
    const title = fold(b.title)
    return words.every((w) => title.includes(w))
  })
}

export type BoardSort = 'opened' | 'edited' | 'created' | 'name'

const time = (iso: string | null) => (iso ? Date.parse(iso) || 0 : 0)

export function sortBoards<
  B extends Pick<BoardWithRole, 'title' | 'updatedAt' | 'lastOpenedAt' | 'id'> & { createdAt?: string },
>(boards: readonly B[], sort: BoardSort): B[] {
  const out = [...boards]
  if (sort === 'name') {
    out.sort(
      (a, b) =>
        a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id),
    )
  } else if (sort === 'edited') {
    out.sort((a, b) => time(b.updatedAt) - time(a.updatedAt) || a.id.localeCompare(b.id))
  } else if (sort === 'created') {
    out.sort((a, b) => time(b.createdAt ?? null) - time(a.createdAt ?? null) || a.id.localeCompare(b.id))
  } else {
    out.sort(
      (a, b) =>
        Math.max(time(b.lastOpenedAt), time(b.updatedAt)) -
          Math.max(time(a.lastOpenedAt), time(a.updatedAt)) || a.id.localeCompare(b.id),
    )
  }
  return out
}

export const RECENT_LIMIT = 12

/** The landing view: the most recently opened or edited boards. */
export function recentBoards<B extends Pick<BoardWithRole, 'title' | 'updatedAt' | 'lastOpenedAt' | 'id'>>(
  boards: readonly B[],
  limit = RECENT_LIMIT,
): B[] {
  return sortBoards(boards, 'opened').slice(0, limit)
}

// ---- labels --------------------------------------------------------------------------------------

export const ROLE_LABEL: Record<BoardRole, string> = {
  owner: 'Owner',
  editor: 'Can edit',
  commenter: 'Can comment',
  viewer: 'Can view',
}

export function sectionTitle(section: DashboardSection, projects: readonly Project[]): string {
  switch (section.kind) {
    case 'recent':
      return 'Recent boards'
    case 'all':
      return 'All boards'
    case 'archived':
      return 'Archived'
    case 'trash':
      return 'Trash'
    case 'project':
      return projects.find((p) => p.id === section.projectId)?.name ?? 'Project'
  }
}

export interface EmptyState {
  title: string
  body: string
  /** Offer the "New board" action inside the empty state. */
  offerCreate: boolean
}

export function emptyState(
  section: DashboardSection,
  opts: {
    searching: boolean
    canCreate: boolean
    /** Domain access: why a member cannot create (`dashboardAccess().limit`); null = the role's copy. */
    limit?: CreateLimit
    /** The `access-outside` notice is on screen (showOutsideNotice), so the note is not repeated. */
    outsideNotice?: boolean
  },
): EmptyState {
  if (opts.searching) {
    return {
      title: 'No boards match your search',
      body: 'Try a shorter or different word. Search looks at board titles in this list only.',
      offerCreate: false,
    }
  }
  const limit = opts.canCreate ? null : (opts.limit ?? null)
  if (limit && (section.kind === 'recent' || section.kind === 'all' || section.kind === 'project')) {
    // An outside account (or one Lobby could not confirm) never creates, whatever its workspace role.
    const shared =
      section.kind === 'project'
        ? 'Boards in this project that are shared with you appear here.'
        : 'Boards shared with you appear here.'
    return {
      title: section.kind === 'project' ? "This project's lobby has no boards yet" : 'No boards yet',
      body:
        limit === 'outside'
          ? opts.outsideNotice
            ? shared
            : `${shared} ${OUTSIDE_CREATE_NOTE}`
          : `${shared} Creating boards is paused until Lobby can confirm your account.`,
      offerCreate: false,
    }
  }
  const createHint = opts.canCreate
    ? ''
    : ' Guests can open boards shared with them but cannot create new ones in this workspace.'
  switch (section.kind) {
    case 'recent':
    case 'all':
      return {
        title: 'No boards yet',
        body: opts.canCreate
          ? 'Create a board to start sketching, planning or reviewing work with your team. Boards you can open show up here.'
          : `Boards that are shared with you show up here.${createHint}`,
        offerCreate: opts.canCreate,
      }
    case 'project':
      return {
        // DANA-08: a project is the project's lobby (the sidebar's "Project lobbies").
        title: "This project's lobby has no boards yet",
        body: opts.canCreate
          ? "Create a board here, or pick this project when you create a board, to keep the project's work in its lobby."
          : `Boards in this project that are shared with you show up here.${createHint}`,
        offerCreate: opts.canCreate,
      }
    case 'archived':
      return {
        title: 'Nothing archived',
        body: 'Archived boards are read-only and hidden from the main list. Board owners can archive a board from its menu and restore it here at any time.',
        offerCreate: false,
      }
    case 'trash':
      return {
        title: 'Trash is empty',
        body: 'Boards moved to trash cannot be opened. Their owners can restore them from here, with all their content and files.',
        offerCreate: false,
      }
  }
}

/** DSH-03: what the Trash promises (nothing is purged automatically, so nothing expires). */
export const TRASH_NOTE =
  'Deleted boards stay here, with all their content and files, until an owner restores them. Nothing in the trash is deleted automatically.'

// ---- owner filter (DSH-04) -----------------------------------------------------------------------

export type OwnerFilter = 'anyone' | 'me' | 'not-me'

/** "Owner" is approximated by who created the board (boards can have several owners). */
export function filterByOwner<B extends { createdBy: string }>(
  boards: readonly B[],
  filter: OwnerFilter,
  selfUserId: string,
): B[] {
  if (filter === 'anyone') return [...boards]
  return boards.filter((b) => (filter === 'me' ? b.createdBy === selfUserId : b.createdBy !== selfUserId))
}

// ---- stars ---------------------------------------------------------------------------------------

/** Applies a star change to a list (optimistic update); the starred list keeps its newest-first order. */
export function withStar<B extends { id: string; starred?: boolean }>(
  boards: readonly B[],
  boardId: string,
  starred: boolean,
): B[] {
  return boards.map((b) => (b.id === boardId ? { ...b, starred } : b))
}

export function withStarredEntry<B extends { id: string; starred?: boolean }>(
  starred: readonly B[],
  board: B,
  on: boolean,
): B[] {
  const rest = starred.filter((b) => b.id !== board.id)
  return on ? [{ ...board, starred: true }, ...rest] : rest
}

/**
 * Title for a board imported from `fileName`. Exports download as "<title>.lobby.json" (history
 * feature; exports from before the rename end in ".draftroom.json"), so both extensions go; a
 * slug-like name ("brand-refresh_v2.json") reads as words. Titles with spaces keep their dashes
 * ("Q4 - roadmap"). Undefined when nothing is left (server default).
 */
export function importTitle(fileName: string): string | undefined {
  const base = fileName
    .replace(/(\.lobby|\.draftroom)?\.json$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  const words = /\s/.test(base) ? base : base.replace(/[-_]+/g, ' ').trim()
  return words.slice(0, 120).trim() || undefined
}

/** Default title for a duplicate. */
export const duplicateTitle = (title: string) => {
  const t = `${title} (copy)`
  return t.length <= 120 ? t : `${title.slice(0, 112).trimEnd()}… (copy)`
}

/**
 * The dashboard's toast after a duplicate: every note the server sent, not just the first (wave J
 * pre-deploy review IO-2a: a keep-sharing copy in an internal-only scope says who it left out, and that
 * note comes before a missing-files one).
 */
export function duplicatedToast(created: { board: { title: string }; warnings: readonly string[] }): string {
  const notes = created.warnings.filter((w) => w.trim().length > 0)
  return `Duplicated as “${created.board.title}”${notes.length ? ` (${notes.join(' ')})` : ''}`
}

/**
 * The dashboard's toast after an import: every note the server sent (IO-11, wave J refix round 3: a file left
 * out for the internal-only fence, for downloads turned off or for no access each has its own reason, and
 * the toast said "no access" for all of them). An older api with no note for them: just the count.
 */
export function importedToast(created: {
  board: { title: string }
  warnings: readonly string[]
  droppedFiles?: number
}): string {
  const notes = created.warnings.filter((w) => w.trim().length > 0)
  const n = created.droppedFiles ?? 0
  if (!notes.length && n > 0)
    notes.push(
      n === 1 ? '1 file was left out and shows as missing.' : `${n} files were left out and show as missing.`,
    )
  return `Imported “${created.board.title}”.${notes.length ? ` ${notes.join(' ')}` : ''}`
}

// ---- what a card says about time ------------------------------------------------------------------

/** A board saved this soon after it was made was not edited by anyone: making it saved it (P-042). */
const MADE_WINDOW_MS = 2_000

/**
 * The time line of a board's card: when it was trashed; "Created …" for a board nobody has changed since it was made
 * (it used to say "Edited just now" for one nobody had touched); otherwise when it was last edited.
 */
export function boardWhen(
  board: Pick<BoardWithRole, 'status' | 'trashedAt' | 'createdAt' | 'updatedAt'>,
  now: Date,
): string {
  if (board.status === 'trashed') {
    return `Trashed ${formatRelativeTime(board.trashedAt ?? board.updatedAt, now)}`
  }
  const made = Date.parse(board.createdAt)
  const changed = Date.parse(board.updatedAt)
  const neverEdited = Number.isFinite(made) && Number.isFinite(changed) && changed - made <= MADE_WINDOW_MS
  const [word, at] = neverEdited ? ['Created', board.createdAt] : ['Edited', board.updatedAt]
  return `${word} ${formatRelativeTime(at, now)}`
}

// ---- thumbnails ----------------------------------------------------------------------------------

/** Paper-and-ink pairs that sit well next to the navy/amber brand. */
const THUMB_PALETTES = [
  { bg: '#e8eef7', ink: '#1f3a5f' },
  { bg: '#f6ecdf', ink: '#8a4b12' },
  { bg: '#e4f1ea', ink: '#17663f' },
  { bg: '#efe8f7', ink: '#5b3cc4' },
  { bg: '#fbe9e7', ink: '#a3211a' },
  { bg: '#e6f2f4', ink: '#0e7490' },
  { bg: '#f3f0e3', ink: '#6b5b12' },
  { bg: '#eceff3', ink: '#334155' },
] as const

export interface ThumbStyle {
  bg: string
  ink: string
}

function hash(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Stable per board id, so a board keeps its look across sessions and for every viewer. */
export function thumbStyle(boardId: string): ThumbStyle {
  const h = hash(boardId)
  const p = THUMB_PALETTES[h % THUMB_PALETTES.length] ?? THUMB_PALETTES[0]
  return { ...p }
}

// ---- workspaces ----------------------------------------------------------------------------------

/**
 * Where "/" lands: the last-used workspace if the user still belongs to it; otherwise the first one
 * they are a real member of. A guest membership (created by accepting one board invitation) only
 * gives access to a few boards, so it is a poor default home unless it is all they have.
 */
export function landingWorkspace(
  workspaces: readonly WorkspaceSummary[],
  lastUsed: string | null,
): WorkspaceSummary | null {
  return (
    workspaces.find((w) => w.id === lastUsed) ??
    workspaces.find((w) => w.role !== 'guest') ??
    workspaces[0] ??
    null
  )
}
