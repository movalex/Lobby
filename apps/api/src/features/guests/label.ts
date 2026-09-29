// The name a board connection ticket carries (docs/WAVE3-CONTRACTS.md §2 guests): the sync server
// puts it on the person's presence, so it is the cursor label and the name in the people list. A
// guest's long name is shortened in front of the marker so short labels still say "(guest)"
// (contracts guestLabelName); everyone else's name is used as it is.

import { guestLabelName } from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'

export async function ticketName(db: Queryable, user: { id: string; name: string }): Promise<string> {
  return (await ticketIdentity(db, user)).name
}

/**
 * The name a ticket carries and whether it is a name-only guest's (A3, docs/EXCALIDRAW-MIGRATION.md §1:
 * the ticket's `guest` claim, from which the Excalidraw engine's sync enforces the guest limits: half
 * the op rate, a 500-item creation cap, Lobby-relative links only, no lock or unlock). Read from the
 * users row, never from the request: a guest cannot drop the claim, and nobody else can get it.
 */
export async function ticketIdentity(
  db: Queryable,
  user: { id: string; name: string },
): Promise<{ name: string; guest: boolean }> {
  const row = await db.maybeOne<{ kind: string; guest_name: string | null }>(
    'SELECT kind, guest_name FROM users WHERE id = $1',
    [user.id],
  )
  const guest = row?.kind === 'guest'
  return { name: guest && row?.guest_name ? guestLabelName(row.guest_name) : user.name, guest }
}
