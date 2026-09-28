// The name a board connection ticket carries (docs/WAVE3-CONTRACTS.md §2 guests): the sync server
// puts it on the person's presence, so it is the cursor label and the name in the people list. A
// guest's long name is shortened in front of the marker so short labels still say "(guest)"
// (contracts guestLabelName); everyone else's name is used as it is.

import { guestLabelName } from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'

export async function ticketName(db: Queryable, user: { id: string; name: string }): Promise<string> {
  const row = await db.maybeOne<{ guest_name: string | null }>(
    "SELECT guest_name FROM users WHERE id = $1 AND kind = 'guest'",
    [user.id],
  )
  return row?.guest_name ? guestLabelName(row.guest_name) : user.name
}
