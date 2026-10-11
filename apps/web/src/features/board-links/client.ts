// OWNER: WS7 (wave N, links between boards; a stub landed by the wave N foundation). The web side of board card faces
// and backlinks (@draftroom/contracts board-links.ts):
//
// Frozen signatures:
//   boardCards(boardId, targets): Promise<BoardCardsAnswer>   a face per asked target (`<board>[:<element>]`); every
//                                                              target `unavailable` when the api cannot say (a 404 of
//                                                              an older api, a refusal, a network error)
//   backlinks(boardId): Promise<BacklinksAnswer | null>         the boards that link here; null when the api cannot
//                                                              say (the "Linked from" section stays hidden)
//
// The stub: no request; every face is `unavailable` (cards still navigate, with the neutral face) and backlinks are
// null, until WS7 implements them.
import type { BacklinksAnswer, BoardCardsAnswer } from '@draftroom/contracts'

/** Every target as `unavailable` (the neutral "Board you can't open" face). */
export const unavailableCards = (targets: readonly string[]): BoardCardsAnswer => ({
  cards: Object.fromEntries(targets.map((t) => [t, { state: 'unavailable' as const }])),
})

export async function boardCards(_boardId: string, targets: readonly string[]): Promise<BoardCardsAnswer> {
  return unavailableCards(targets)
}

export async function backlinks(_boardId: string): Promise<BacklinksAnswer | null> {
  return null
}
