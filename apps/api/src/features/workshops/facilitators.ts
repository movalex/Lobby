// Who facilitates (final review R3): running the timer, starting, extending, closing and revealing a
// vote, starting a private brainstorm, "Gather everyone" and managing other people's hands are for
// editors with an account. A name-only guest on a workshop (editor) link takes part (writes notes,
// votes, reacts, raises a hand) but never runs the session: a guest identity costs nothing but a
// name, and anyone holding the link could otherwise pause everyone's timer.
//
// Always checked after the board checks, so a board the caller cannot reach stays a 404.

import type { Queryable } from '@draftroom/db'
import { userKind } from '../../auth/users.ts'
import { guestRefused } from '../guests/guard.ts'

export const FACILITATE_GUESTS =
  'Guests take part, but the timer, votes, brainstorms and “Gather everyone” are run by editors with an account.'

/** 403 TIMER_NOT_YOURS: someone else's running or paused timer (final review R3). */
export const TIMER_NOT_YOURS =
  'Someone else is running this timer. Only they or the board owner can pause, stop or change it.'

/** 403 GUEST_ACCOUNT_REQUIRED for a name-only guest. */
export async function requireFacilitatorAccount(db: Queryable, userId: string): Promise<void> {
  if ((await userKind(db, userId)) === 'guest') throw guestRefused(FACILITATE_GUESTS)
}
