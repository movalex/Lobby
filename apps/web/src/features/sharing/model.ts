// Pure logic for the sharing feature: the board header badge, "request sent" memory, review-link
// options. No DOM or network here (unit-tested in node).

import type { RequestableRole, ShareState } from '@draftroom/contracts'

export const ROLE_WORD: Record<RequestableRole | 'owner', string> = {
  owner: 'own',
  editor: 'edit',
  commenter: 'comment',
  viewer: 'view',
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Oct 10" this year, "Oct 10, 2027" otherwise (local time). */
export function shortDate(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  const md = `${MONTHS[d.getMonth()]} ${d.getDate()}`
  return d.getFullYear() === now.getFullYear() ? md : `${md}, ${d.getFullYear()}`
}

export interface ShareBadge {
  /** Short text on the pill, e.g. "Private", "Workspace: edit", "Link: comment". */
  label: string
  /** Longer description for the tooltip / accessible name. */
  description: string
  /** 'private' | 'workspace' | 'link' (drives the icon and colour). */
  kind: 'private' | 'workspace' | 'link'
  /** Pending access requests (owners only; 0 otherwise). */
  requests: number
}

const VIS_LABEL: Record<ShareState['visibility'], string> = {
  private: 'Private',
  workspace_view: 'Workspace: view',
  workspace_edit: 'Workspace: edit',
}
const VIS_DESCRIPTION: Record<ShareState['visibility'], (ws: string) => string> = {
  private: () => 'Only people who were added can open this board',
  workspace_view: (ws) => `Everyone in ${ws} can view this board`,
  workspace_edit: (ws) => `Everyone in ${ws} can edit this board`,
}

/**
 * The header badge (PRS-03). A review link is the widest audience, so it leads the label when one is
 * open: the most permissive open link and the date it (last) expires.
 */
export function shareBadge(state: ShareState, workspaceName: string, now: Date = new Date()): ShareBadge {
  const requests = state.pendingRequests ?? 0
  const vis = VIS_DESCRIPTION[state.visibility](workspaceName)
  if (state.links.length) {
    const top = state.links.some((l) => l.role === 'commenter') ? 'commenter' : 'viewer'
    const ofTop = state.links.filter((l) => l.role === top)
    const last = ofTop.reduce((a, b) => (Date.parse(b.expiresAt) > Date.parse(a.expiresAt) ? b : a))
    const until = shortDate(last.expiresAt, now)
    const count = state.links.length > 1 ? ` (${state.links.length} links)` : ''
    return {
      kind: 'link',
      label: `Link: ${ROLE_WORD[top]} · until ${until}`,
      description: `Anyone with a review link can ${ROLE_WORD[top]} after signing in, until ${until}${count}. ${vis}.`,
      requests,
    }
  }
  return {
    kind: state.visibility === 'private' ? 'private' : 'workspace',
    label: VIS_LABEL[state.visibility],
    description: `${vis}.`,
    requests,
  }
}

// ---- "request sent" memory (per browser, per user + board) ----------------------------------------
// People without access cannot ask the server about their request (that would reveal the board), so
// the page remembers that it sent one.

export interface SentRequest {
  role: RequestableRole
  at: number
}
const SENT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const sentKey = (userId: string, boardId: string) => `draftroom:access-request:${userId}:${boardId}`

export function readSentRequest(
  storage: Pick<Storage, 'getItem'> | null,
  userId: string,
  boardId: string,
  now = Date.now(),
): SentRequest | null {
  try {
    const raw = storage?.getItem(sentKey(userId, boardId))
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<SentRequest>
    const roles: RequestableRole[] = ['viewer', 'commenter', 'editor']
    if (!v || typeof v.at !== 'number' || !roles.includes(v.role as RequestableRole)) return null
    if (now - v.at > SENT_TTL_MS || v.at > now + 60_000) return null
    return { role: v.role as RequestableRole, at: v.at }
  } catch {
    return null
  }
}

export function writeSentRequest(
  storage: Pick<Storage, 'setItem'> | null,
  userId: string,
  boardId: string,
  sent: SentRequest,
) {
  try {
    storage?.setItem(sentKey(userId, boardId), JSON.stringify(sent))
  } catch {
    // not remembered: the page just offers the button again after a reload
  }
}

export function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

// ---- review links ---------------------------------------------------------------------------------

export const REVIEW_LINK_DAY_OPTIONS = [1, 3, 7, 14, 30] as const
export const REVIEW_LINK_DEFAULT_DAY = 14

export function daysLabel(days: number): string {
  return days === 1 ? '1 day' : `${days} days`
}

/** Roles a person with `current` access may ask for (more than they have; never ownership). */
export function requestableRoles(current: 'owner' | RequestableRole | null): RequestableRole[] {
  const all: RequestableRole[] = ['editor', 'commenter', 'viewer']
  if (!current) return all
  const rank = { viewer: 1, commenter: 2, editor: 3, owner: 4 }
  return all.filter((r) => rank[r] > rank[current])
}
