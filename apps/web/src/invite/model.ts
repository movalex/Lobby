import { InvitationGoneBody, type InvitationPreview } from '@draftroom/contracts'

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
  roleLabel: string
  acceptLabel: string
}

/** Copy for the invitation screen. Unknown roles are shown as "Member"/"Can view" rather than raw. */
export function invitationSummary(inv: InvitationPreview): InvitationSummary {
  const who = inv.invitedBy.name || 'Someone'
  if (inv.board) {
    return {
      eyebrow: `${who} invited you to a board`,
      title: `Join “${inv.board.title}”`,
      roleLabel: BOARD_ROLE[inv.role] ?? 'Can view',
      acceptLabel: 'Accept and open board',
    }
  }
  return {
    eyebrow: `${who} invited you to a workspace`,
    title: `Join ${inv.workspace.name}`,
    roleLabel: WORKSPACE_ROLE[inv.role] ?? 'Member',
    acceptLabel: 'Accept and open workspace',
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
export function signInHeading(inv: InvitationPreview | null): string {
  if (!inv) return 'Sign in to your DBC lobby'
  const who = inv.invitedBy.name ? ` (invited by ${inv.invitedBy.name})` : ''
  return inv.board
    ? `Sign in to join “${inv.board.title}”${who}`
    : `Sign in to join ${inv.workspace.name}${who}`
}
