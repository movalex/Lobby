// Wave V fix wave (review n4). Breakouts refuse to start during a live presentation or a spotlight (./index.ts
// refuseConflicts, 409 PRESENTING / SPOTLIGHT); this is the other direction: while breakouts run on a board, starting
// a presentation to everyone or a spotlight is 409 BREAKOUTS ("End breakouts first"), since its follow would pull
// every group out of its frame. Only while DRAFTROOM_BREAKOUTS is on: with it off, breakouts answer nothing (a running
// session in Postgres is stopped, not running), so they hold nothing up either.

import { BREAKOUT_ERROR_CODES } from '@draftroom/contracts'
import { conflict } from '../../errors.ts'
import type { FeatureContext } from '../context.ts'
import { breakoutsRunning } from './store.ts'

export const BREAKOUTS_RUNNING_MESSAGE = 'Breakouts are running on this board. End breakouts first.'

/** 409 BREAKOUTS while breakouts run on `boardId` (and the switch is on). */
export async function refuseDuringBreakouts(
  ctx: Pick<FeatureContext, 'db' | 'now' | 'config'>,
  boardId: string,
): Promise<void> {
  if (!ctx.config.live.breakouts) return
  if (await breakoutsRunning(ctx.db, boardId, ctx.now()))
    throw conflict(BREAKOUT_ERROR_CODES.breakouts, BREAKOUTS_RUNNING_MESSAGE)
}
