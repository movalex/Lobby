// An automatic checkpoint right before another feature makes a big change to a board (R10): the
// private brainstorm's reveal (features/workshops/private-notes.ts) and AI "Group into themes"
// (features/ai). One call each, so going back to how the board looked just before is one restore away.
//
// Best effort, like the one before a restore: it never throws and never blocks the change for more
// than the sync server's snapshot read. It is skipped when the board equals its newest checkpoint.

import type { FastifyInstance } from 'fastify'
import { checkpointServices } from './index.ts'

export type BeforeChangeReason = 'before_reveal' | 'before_ai_themes'

/** Saves an automatic checkpoint of `boardId` now (history must be registered on `app`; else a no-op). */
export async function checkpointBeforeChange(
  app: FastifyInstance,
  boardId: string,
  reason: BeforeChangeReason,
): Promise<void> {
  await checkpointServices.get(app)?.captureQuietly(boardId, reason)
}
