// Board connection tickets (docs/M1-CONTRACTS.md §6) and the sync server's access re-check (§7).
// Both answer with connectionRole(), so a ticket and a later re-check can never disagree.

import { checkInternalSecret, INTERNAL_SECRET_HEADER, signTicket } from '@draftroom/auth-tickets'
import { BoardId, type TicketResponse, UserId } from '@draftroom/contracts'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { connectionRole, loadBoardAccess } from '../access.ts'
import type { AppContext, Params } from '../context.ts'
import { ApiError, notFound, parse } from '../errors.ts'
import { ticketName } from '../features/guests/label.ts'

const AccessQuery = z.object({ boardId: BoardId, userId: UserId })

export function registerTicketRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, config, now } = ctx

  app.post('/api/boards/:bid/ticket', async (req): Promise<TicketResponse> => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const role = connectionRole(await loadBoardAccess(db, bid, user.id))
    // No access, trashed, or unknown: one answer, so a ticket request cannot probe for board ids.
    if (!role) throw notFound()
    // Wave 3: a name-only guest's long name is shortened so the cursor label keeps "(guest)".
    const name = await ticketName(db, user)
    const { ticket, claims } = signTicket(config.ticketSecret, {
      bid,
      uid: user.id,
      name,
      color: user.color,
      role,
      now: now().getTime(),
    })
    return { ticket, expiresAt: claims.exp, role, user: { id: user.id, name, color: user.color } }
  })

  // Server-to-server only (the web proxy never forwards /internal). Authenticated by the shared secret.
  app.get('/internal/access', async (req) => {
    if (!checkInternalSecret(req.headers[INTERNAL_SECRET_HEADER], config.internalSecret))
      throw new ApiError(401, 'NOT_AUTHENTICATED', 'Internal credentials required.')
    const { boardId, userId } = parse(AccessQuery, req.query)
    // Unknown board or user: null, the same as "no access" (the caller only needs to know whether to close).
    return { role: connectionRole(await loadBoardAccess(db, boardId, userId)) }
  })
}
