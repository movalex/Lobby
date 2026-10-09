// Vote counts AI may use (wave L: the recap's top voted list, L1-2, and the vote-weighted action items,
// L1-7). Only REVEALED votes: per-object totals of an open or closed vote are nobody's to read yet (PRF-07,
// FAC-06), so an open or unrevealed vote contributes nothing, and naming one for 'actions' is a 409. Only
// aggregates leave: never who voted for what. The reads are W5's (features/workshops/votes.ts), imported
// as they are; the board access check has already passed when these run.

import {
  AI_ERROR_CODES,
  AI_RECAP_TOP_VOTED_MAX,
  AI_SHAPE_ID_PATTERN,
  type AiTopVoted,
  rankVoteResults,
} from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import { ApiError, conflict } from '../../errors.ts'
import { findSessionForBoard, revealedResults, revealedResultsForBoard } from '../workshops/votes.ts'

/** Per object, the votes it received in the board's votes revealed at or after `sinceMs` (summed). */
export async function revealedTallies(
  q: Queryable,
  boardId: string,
  sinceMs: number,
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for (const vote of await revealedResultsForBoard(q, boardId, sinceMs))
    for (const r of vote.results) out.set(r.shapeId, (out.get(r.shapeId) ?? 0) + r.count)
  return out
}

/**
 * The recap's top voted list, computed here and never by the model: the objects still on the board, most
 * votes first, ties sharing a rank (contracts rankVoteResults), at most AI_RECAP_TOP_VOTED_MAX.
 */
export function topVotedOf(
  tallies: ReadonlyMap<string, number>,
  onBoard: (id: string) => boolean,
): AiTopVoted[] {
  const ranked = rankVoteResults(
    [...tallies]
      .filter(([id, n]) => n > 0 && AI_SHAPE_ID_PATTERN.test(id) && onBoard(id))
      .map(([shapeId, count]) => ({ shapeId, count })),
  )
  return ranked.slice(0, AI_RECAP_TOP_VOTED_MAX).map((r) => ({ id: r.shapeId, votes: r.count, rank: r.rank }))
}

const NOT_FOUND = () => new ApiError(404, 'NOT_FOUND', 'That vote is not on this board.')

/**
 * The tallies of the vote 'actions' is weighted by (L1-7): 404 when the vote is not this board's (another
 * board's vote is as good as none), 409 AI_VOTE_NOT_REVEALED before its reveal (open or closed).
 */
export async function votedSessionTallies(
  q: Queryable,
  boardId: string,
  sessionId: string,
): Promise<Map<string, number>> {
  const session = await findSessionForBoard(q, boardId, sessionId)
  if (!session) throw NOT_FOUND()
  if (session.status !== 'revealed')
    throw conflict(
      AI_ERROR_CODES.voteNotRevealed,
      'Reveal the vote first: action items follow the results once everyone can see them.',
    )
  const out = new Map<string, number>()
  for (const r of await revealedResults(q, session.id)) out.set(r.shapeId, r.count)
  return out
}
