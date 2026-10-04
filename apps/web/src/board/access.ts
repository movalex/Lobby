import { type BoardRole, type BoardStatus, can } from '../lib/permissions.ts'

export interface AccessPill {
  label: string
  title: string
  /** The pill is a button that opens the "ask for more access" flow (PRI-09b). */
  request: boolean
}

/**
 * The top-bar pill for people who cannot edit the canvas. UI only: the sync server decides what a
 * session may write (read-only sessions have their writes skipped), this just explains it.
 */
export function readonlyPill(role: BoardRole, status: BoardStatus): AccessPill | null {
  if (can(role, 'edit', status)) return null
  if (status === 'archived') {
    return {
      label: 'Archived · View only',
      title: 'This board is archived: it is read-only until an owner restores it',
      request: false,
    }
  }
  if (can(role, 'comment', status)) {
    return {
      label: 'Can comment',
      title: 'You can look around and comment (comments are saved), but not change the board',
      request: true,
    }
  }
  return { label: 'View only', title: 'You can look around but not change this board', request: true }
}

/** The top bar's button that opens the Share dialog, as this person should see it. */
export interface ShareButtonView {
  label: 'Share' | 'People'
  /** Primary (filled) for people who can hand out access; plain for everyone else. */
  primary: boolean
  title: string
}

/**
 * DANA-11 / F14 / PRI-18: a viewer, a commenter or a name-only guest cannot invite anyone, so for
 * them the button is a plain "People" (who is on this board, and how to ask for more); everyone else
 * keeps the primary "Share". UI only: the dialog and the api decide what each role may do.
 */
export function shareButtonView(role: BoardRole, guest: boolean): ShareButtonView {
  if (guest || role === 'viewer' || role === 'commenter')
    return { label: 'People', primary: false, title: 'See who has access to this board' }
  return { label: 'Share', primary: true, title: 'Share this board' }
}

/** Whether the editor must be read-only for this role (tldraw instance state; the server enforces). */
export const isReadonlyRole = (role: BoardRole, status: BoardStatus) => !can(role, 'edit', status)

/**
 * The one-time hint after a blocked edit on a read-only board (PRI-08). `owner` is the name of
 * someone who can grant access, when known.
 */
export function blockedEditHint(role: BoardRole, owner: string | null): string {
  const what = role === 'commenter' ? 'You can comment on this board.' : 'You can view this board.'
  return `${what} Ask ${owner ?? 'an owner'} for edit access.`
}

const ROLE_NAME: Record<BoardRole, string> = {
  owner: 'Owner',
  editor: 'Can edit',
  commenter: 'Can comment',
  viewer: 'Can view',
}

/**
 * The toast when my role on an open board changes (PRI-09b), or null when nothing to say. Raising
 * someone to edit is the change they asked for, so it reads as a grant. `by` (REVIEW-6) is the name of
 * the person who changed it, when the server said: after an unexpected downgrade this is whom to ask.
 */
export function roleChangeNotice(
  before: BoardRole,
  after: BoardRole,
  by: string | null = null,
): string | null {
  if (before === after) return null
  const text =
    after === 'editor' && (before === 'viewer' || before === 'commenter')
      ? 'You can edit this board now'
      : after === 'owner'
        ? 'You are now an owner of this board'
        : `Your access changed to ${ROLE_NAME[after]}`
  return by ? `${text} (changed by ${by})` : text
}

/** REVIEW-6: how long the name from an `access.changed` event is kept for the toast that follows it. */
export const ACCESS_ACTOR_FRESH_MS = 60_000

/** The actor's name in an `access.changed` event's data (`{ actor: { name } }`), or null for anything else. */
export function accessActorName(data: unknown): string | null {
  const actor = (data as { actor?: unknown } | null)?.actor
  const name = (actor as { name?: unknown } | null)?.name
  return typeof name === 'string' && name.trim() ? name.trim() : null
}

/** The name held from an `access.changed` event, while it is still about the change being announced. */
export function freshActorName(hint: { name: string; at: number } | null, now: number): string | null {
  return hint && now - hint.at <= ACCESS_ACTOR_FRESH_MS ? hint.name : null
}

/**
 * REVIEW-6: the name of whoever changed my access, held from the `access.changed` event that carried it until
 * the role-change toast uses it. The server sends the event for every change that really changed access (a
 * member's grant set or removed, an approved request, a revoked review link, a change of the workspace role, an
 * email invite, an ownership transfer, a change of the board's visibility, which everyone on the board but whoever
 * made it hears) and for none that changed nothing (a PUT or DELETE of a grant that stays as it was). A change can
 * still leave MY role here as it was (most of a visibility change's events), and the toast may follow much later
 * (a raise waits for the socket to reconnect). So a name is kept only while it can still be about the change the
 * toast announces: it is dropped as soon as a read of my role from the server agrees with the role on screen
 * (`settle`: the change did not touch my role), and otherwise after `ACCESS_ACTOR_FRESH_MS`.
 */
export class AccessActorHint {
  private held: { name: string; at: number; n: number } | null = null
  private count = 0

  /**
   * An `access.changed` event's data arrived: its actor's name replaces any held one (an event with no name
   * clears it: whoever acted before is not who acted now).
   */
  record(data: unknown, now: number): void {
    const name = accessActorName(data)
    this.held = name ? { name, at: now, n: ++this.count } : null
  }

  /** The newest hint's number: a read of my role that starts now can settle every hint up to it (`settle`). */
  get mark(): number {
    return this.count
  }

  /**
   * A read of my role from the server finished. When it agrees with the role the page shows (`serverRole`
   * equals `shownRole`) the change the held name was told of left my role as it was (most of a visibility
   * change's events, a grant that gives me no more than I had), so the name is dropped now instead of being put
   * on an unrelated change a minute later. `upTo` is `mark` from before the read started: a hint that came
   * after it may be about a change the read did not see, and stays.
   */
  settle(upTo: number, shownRole: BoardRole, serverRole: BoardRole): void {
    if (this.held && this.held.n <= upTo && shownRole === serverRole) this.held = null
  }

  /** The name to put on the toast for a role change now, or null (none held, or it is too old). Keeps it. */
  fresh(now: number): string | null {
    return freshActorName(this.held, now)
  }

  /** The toast used it (or the change it was about is over). */
  clear(): void {
    this.held = null
  }
}
