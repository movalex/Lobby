import type { BoardWithRole, Project, WorkspaceSummary } from '@draftroom/contracts'
import { type BoardRole, type BoardStatus, can } from '../lib/permissions.ts'
import type { DashboardSection } from '../lib/routing.ts'

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
  /** Workspace members (not guests) may create boards, so they may duplicate one. */
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
  opts: { searching: boolean; canCreate: boolean },
): EmptyState {
  if (opts.searching) {
    return {
      title: 'No boards match your search',
      body: 'Try a shorter or different word. Search looks at board titles in this list only.',
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
        title: 'This project has no boards',
        body: opts.canCreate
          ? 'Create a board here, or pick this project when you create a board, to keep related work together.'
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

/** DSH-03: what the Trash promises (no automatic purge exists yet, so nothing expires). */
export const TRASH_NOTE =
  'Deleted boards stay here, with all their content and files, until an owner restores them. Draftroom does not empty the trash automatically yet.'

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

/** Default title for a duplicate. */
export const duplicateTitle = (title: string) => {
  const t = `${title} (copy)`
  return t.length <= 120 ? t : `${title.slice(0, 112).trimEnd()}… (copy)`
}

// ---- thumbnails ----------------------------------------------------------------------------------

/** Paper-and-ink pairs that sit well next to the navy/amber brand. */
const THUMB_PALETTES = [
  { bg: '#e8eef7', ink: '#1f3a5f', note: '#f6c863' },
  { bg: '#f6ecdf', ink: '#8a4b12', note: '#f0a53a' },
  { bg: '#e4f1ea', ink: '#17663f', note: '#9ad3b0' },
  { bg: '#efe8f7', ink: '#5b3cc4', note: '#f3b6c8' },
  { bg: '#fbe9e7', ink: '#a3211a', note: '#fbd38d' },
  { bg: '#e6f2f4', ink: '#0e7490', note: '#b9e2f0' },
  { bg: '#f3f0e3', ink: '#6b5b12', note: '#e9d77a' },
  { bg: '#eceff3', ink: '#334155', note: '#fda4af' },
] as const

export interface ThumbStyle {
  bg: string
  ink: string
  note: string
  /** 0..3: which of the placeholder compositions to draw. */
  layout: number
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
  return { ...p, layout: (h >>> 8) % 4 }
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
