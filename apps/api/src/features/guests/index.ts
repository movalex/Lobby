// Feature module: guests (docs/WAVE3-CONTRACTS.md §2): name-only guests.
//
// - join.ts: POST /api/invitations/:token/guest (join a guest link with just a name);
// - board-guests.ts: GET /api/boards/:bid/guests (who on the board is a guest, for the Share dialog);
// - guard.ts: what a signed-in guest may not do, and who may not be given to a guest;
// - sweep.ts: a guest's session ends with their last board grant, and their grants with their session.
//
// Elsewhere (the files this feature may change): the 0009_guests migration (users.kind/guest_name,
// invitations.allow_guests), `kind` on GET /api/me (routes/auth.ts), the guest refusal on accepting a
// normal invitation and on creating invitations (routes/invitations.ts), `allowGuests` on review and
// workshop links (features/dashboard/review-links.ts), and sessions that end early (auth/session.ts).
import type { FastifyInstance } from 'fastify'
import type { FeatureContext } from '../context.ts'
import { registerBoardGuests } from './board-guests.ts'
import { registerGuestGuard } from './guard.ts'
import { registerGuestJoin } from './join.ts'
import { startGuestSweeper } from './sweep.ts'

/**
 * How often guests' sessions and grants are reconciled (the M1 push already closed the board).
 * Read when an app is built: tests that call sweepGuests themselves raise it first, so the timer never
 * races their own passes.
 */
export const guestSweepSettings = { intervalMs: 5_000 }

export async function registerGuests(app: FastifyInstance, ctx: FeatureContext): Promise<void> {
  registerGuestGuard(app, ctx)
  registerGuestJoin(app, ctx)
  registerBoardGuests(app, ctx)
  startGuestSweeper(app, ctx, guestSweepSettings.intervalMs)
}
