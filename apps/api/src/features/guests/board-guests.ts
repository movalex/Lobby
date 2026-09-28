// GET /api/boards/:bid/guests (view): which people on the board are name-only guests. The Share dialog
// uses it to leave out actions the server refuses for guests (making one an owner). Names already say
// "(guest)" to everyone who can view the board, so the list reveals nothing new.

import type { BoardGuests } from '@draftroom/contracts'
import type { FastifyInstance } from 'fastify'
import { requireBoardAction } from '../../access.ts'
import type { Params } from '../../context.ts'
import type { FeatureContext } from '../context.ts'

export function registerBoardGuests(app: FastifyInstance, ctx: FeatureContext): void {
  const { db } = ctx
  app.get('/api/boards/:bid/guests', async (req): Promise<BoardGuests> => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const access = await requireBoardAction(db, bid, user.id, 'view')
    const rows = await db.query<{ id: string }>(
      `SELECT u.id FROM board_members bm JOIN users u ON u.id = bm.user_id AND u.kind = 'guest'
        WHERE bm.board_id = $1
        ORDER BY u.id
        LIMIT 1000`,
      [access.board.id],
    )
    return { userIds: rows.rows.map((r) => r.id) }
  })
}
