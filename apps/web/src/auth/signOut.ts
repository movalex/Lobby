// Signing out (SCA-1 and SCA-4 in docs/SECURITY-REVIEW-2026-09-27.md), as pure logic the session
// provider runs and the unit tests drive: the order of the steps, what counts as signed out, and the
// sign-in page's rule for a Clerk session that is still live after an explicit sign-out.
//
// Why the Clerk session matters: the Draftroom session (`dr_session`) is only half of being signed in.
// Clerk keeps its own session in the browser, and the sign-in page trades a live one for a new
// Draftroom session. Revoking only `dr_session` therefore signed the same person straight back in on
// the next visit to /signin (a shared or meeting-room computer).

import { isApiError } from '../api/client.ts'
import type { SignedOutMark, SignedOutMarks } from './signOutMark.ts'

/** `here`: "Sign out" / "Switch user". `everywhere`: every session of this user, on every device. */
export type SignOutMode = 'here' | 'everywhere'

export interface SignOutSteps {
  readonly mode: SignOutMode
  /** POST /api/auth/sessions/revoke-all (only for `everywhere`). */
  revokeAll(): Promise<void>
  /** POST /api/auth/logout: revokes this browser's session and clears its cookie. */
  logout(): Promise<void>
  /** Ends this browser's Clerk session; null when the server does not use Clerk (or it is unknown). */
  readonly endClerkSession: (() => Promise<void>) | null
  readonly marks: Pick<SignedOutMarks, 'set' | 'clear'>
  now?(): number
}

export type SignOutOutcome =
  | { readonly status: 'signed-out'; readonly clerk: 'ended' | 'failed' | 'none' }
  /** Nothing may be shown as signed out: the session can still be valid. */
  | {
      readonly status: 'failed'
      readonly step: 'revoke-all' | 'logout'
      readonly title: string
      readonly detail: string
      readonly retryable: true
    }
  /** The API has no revoke-all route (404): nothing was changed. */
  | {
      readonly status: 'unsupported'
      readonly title: string
      readonly detail: string
      readonly retryable: false
    }

export type SignOutProblem = Exclude<SignOutOutcome, { status: 'signed-out' }>

/**
 * The session state once a 401 or a signed-out answer says the session ended (CRIT-18). The person's own
 * Sign out that already finished stays `explicit` (the state it set is kept, so a late 401 in the same
 * tick cannot hide it from the offline-queue purge); any other state becomes a plain signed-out, which
 * purges nothing.
 */
export function sessionEnded<S extends { readonly status: string }>(prev: S): S | { status: 'signed-out' } {
  return prev.status === 'signed-out' ? prev : { status: 'signed-out' }
}

const reason = (e: unknown) => (isApiError(e) ? e.message : 'Something went wrong.')

export async function runSignOut(steps: SignOutSteps): Promise<SignOutOutcome> {
  const at = steps.now?.() ?? Date.now()
  const mark = (clerk: SignedOutMark['clerk']) => steps.marks.set({ at, clerk })
  // First, before any request: a 401 from anything on the page sends this tab to /signin at once, and
  // the sign-in page must already know that this person chose to sign out.
  mark(steps.endClerkSession ? 'pending' : 'none')

  if (steps.mode === 'everywhere') {
    try {
      await steps.revokeAll()
    } catch (e) {
      if (isApiError(e) && e.kind === 'not-found') {
        steps.marks.clear()
        return {
          status: 'unsupported',
          title: 'Not available yet.',
          detail:
            'Signing out of every device is not available on this server yet. Nothing was changed; use “Sign out” to end this session.',
          retryable: false,
        }
      }
      return {
        status: 'failed',
        step: 'revoke-all',
        title: 'You are still signed in.',
        detail: `Other devices were not signed out: ${reason(e)} Try again.`,
        retryable: true,
      }
    }
  }

  let logoutError: unknown = null
  try {
    await steps.logout()
  } catch (e) {
    // 401: the session had already ended (expired, or revoked by "Sign out everywhere").
    if (!(isApiError(e) && e.kind === 'unauthorized')) logoutError = e ?? new Error('logout failed')
  }

  // The Clerk session is ended even when the logout failed: it is what would sign this person back in.
  let clerk: 'ended' | 'failed' | 'none' = 'none'
  if (steps.endClerkSession) {
    try {
      await steps.endClerkSession()
      clerk = 'ended'
    } catch {
      clerk = 'failed'
    }
    mark(clerk)
  }

  if (logoutError !== null) {
    const everywhere = steps.mode === 'everywhere'
    return {
      status: 'failed',
      step: 'logout',
      title: everywhere ? 'You are still signed in on this device.' : 'You are still signed in.',
      detail: `${everywhere ? 'Your other sessions were ended, but signing out here did not finish' : 'Signing out did not finish'}: ${reason(logoutError)} Try again before you leave this computer.`,
      retryable: true,
    }
  }
  return { status: 'signed-out', clerk }
}

// ---- the sign-in page ----------------------------------------------------------------------------

export type ClerkSignInView =
  /** Clerk is loading. */
  | 'loading'
  /** Nobody is signed in to Clerk: Clerk's own <SignIn> form. */
  | 'form'
  /** Signed in to Clerk after an explicit sign-out in this tab: "Continue as <name>" (no exchange yet). */
  | 'confirm'
  /** Trade the Clerk session for a Draftroom session (automatic unless the tab was signed out). */
  | 'exchange'
  | 'error'

export interface ClerkSignInState {
  readonly loaded: boolean
  readonly signedIn: boolean
  /** The explicit sign-out mark is set (signOutMark.ts). */
  readonly explicitSignOut: boolean
  /** The person clicked "Continue as <name>". */
  readonly confirmed: boolean
  /** The last exchange failed (its message is shown with "Try again"). */
  readonly failed: boolean
}

export function clerkSignInView(s: ClerkSignInState): ClerkSignInView {
  if (!s.loaded) return 'loading'
  if (!s.signedIn) return 'form'
  if (s.failed) return 'error'
  if (s.explicitSignOut && !s.confirmed) return 'confirm'
  return 'exchange'
}

/** The slice of Clerk's UserResource the "Continue as" button names. */
export interface ClerkUserLike {
  fullName?: string | null
  username?: string | null
  primaryEmailAddress?: { emailAddress: string } | null
}

export function clerkAccountLabel(user: ClerkUserLike | null | undefined): string {
  for (const v of [user?.fullName, user?.username, user?.primaryEmailAddress?.emailAddress]) {
    const s = v?.trim()
    if (s) return s
  }
  return 'your account'
}
