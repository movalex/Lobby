// OWNER: W5 (wave M, M5-1; a stub landed by the wave M foundation). The board-open read, shared by the board's
// features: GET /api/boards/:bid/open-state (@draftroom/contracts board-open.ts OpenState) answers the panel reads
// a board page fires when it opens, together.
//
// takeOpenState(boardId, part) hands a feature its part ONCE, for its first fetch:
//   - undefined: nothing to take (no answer yet, already taken, older than OPEN_STATE_TTL_MS, another board, or an
//     api without the route): the feature fetches its own route, exactly as before wave M;
//   - null: the api says this caller may not read that part (the feature behaves as its own route's refusal);
//   - otherwise that part's body, the same as its own route would have answered.
//
// The parts and their takers: 'exportPolicy', 'outside', 'sharing', 'threads' (W5), 'workshop', 'presentation',
// 'privateBrainstorm' (W2), 'ai' (W4).
//
// The stub never has an answer: it always returns undefined, so every feature's first fetch is unchanged until W5
// lands the request (started by lib/prefetch-board.ts with /api/auth/me) and the cache.

import type { OpenState, OpenStatePart } from '@draftroom/contracts'

export type { OpenStatePart }

export function takeOpenState<P extends OpenStatePart>(_boardId: string, _part: P): OpenState[P] | undefined {
  return undefined
}
