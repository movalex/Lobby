// OWNER: WS7 (wave N, links between boards). The web side of board card faces and backlinks (@draftroom/contracts
// board-links.ts), against the api's permission-checked routes (apps/api/src/features/board-links):
//
// Frozen signatures:
//   boardCards(boardId, targets): Promise<BoardCardsAnswer>   a face per asked target (`<board>[:<element>]`); every
//                                                              target `unavailable` when the api cannot say (a 404 of
//                                                              an older api, a refusal, a network error)
//   backlinks(boardId): Promise<BacklinksAnswer | null>         the boards that link here; null when the api cannot
//                                                              say (the "Linked from" section stays hidden)
//
// The face store (./faces.ts) uses askBoardCards, which tells the faces the api decided (a 200 answer) from the
// targets it could not say anything about, so a passing failure is never kept as "Board you can't open".
//
// Same-origin requests only (credentials: same-origin, no cache). A target that is not a card target is never sent
// (it stays `unavailable`), and at most BOARD_CARDS_MAX_IDS go in one request (more are split). Neither function
// ever throws.
import {
  BACKLINKS_MAX,
  BacklinksAnswer,
  BOARD_CARD_TARGET_PATTERN,
  BOARD_CARDS_MAX_IDS,
  type BoardCardFace,
  BoardCardsAnswer,
  backlinksPath,
  boardCardsPath,
} from '@draftroom/contracts'

/** Every target as `unavailable` (the neutral "Board you can't open" face). */
export const unavailableCards = (targets: readonly string[]): BoardCardsAnswer => ({
  cards: Object.fromEntries(targets.map((t) => [t, { state: 'unavailable' as const }])),
})

const get = (path: string, signal?: AbortSignal) =>
  fetch(path, {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { accept: 'application/json' },
    ...(signal ? { signal } : {}),
  })

/**
 * What one ask learned: the faces the api decided (`cards`: its 200 answer, and the targets that are no card target,
 * which are never sent and can never be anything but `unavailable`), and the targets it could not say anything
 * about (`unknown`: a 404 of an older api, a refusal, a 429 or 5xx, a body that does not parse, the network).
 * Every asked target is in exactly one of the two.
 */
export interface BoardCardsOutcome {
  readonly cards: Record<string, BoardCardFace>
  readonly unknown: readonly string[]
}

export async function askBoardCards(boardId: string, targets: readonly string[]): Promise<BoardCardsOutcome> {
  const unique = [...new Set(targets)]
  const cards: Record<string, BoardCardFace> = {}
  const unknown: string[] = []
  const asked: string[] = []
  for (const t of unique) {
    if (BOARD_CARD_TARGET_PATTERN.test(t)) asked.push(t)
    else cards[t] = { state: 'unavailable' }
  }
  for (let i = 0; i < asked.length; i += BOARD_CARDS_MAX_IDS) {
    const chunk = asked.slice(i, i + BOARD_CARDS_MAX_IDS)
    let answer: BoardCardsAnswer | null = null
    try {
      const res = await get(boardCardsPath(boardId, chunk))
      if (res.ok) {
        const parsed = BoardCardsAnswer.safeParse(await res.json())
        if (parsed.success) answer = parsed.data
      } else await res.body?.cancel().catch(() => {})
    } catch {
      // the network: nothing known (the face store asks again)
    }
    for (const t of chunk) {
      if (answer) cards[t] = answer.cards[t] ?? { state: 'unavailable' }
      else unknown.push(t)
    }
  }
  return { cards, unknown }
}

export async function boardCards(boardId: string, targets: readonly string[]): Promise<BoardCardsAnswer> {
  const out = unavailableCards(targets)
  const { cards } = await askBoardCards(boardId, targets)
  for (const [t, face] of Object.entries(cards)) out.cards[t] = face
  return out
}

export async function backlinks(boardId: string): Promise<BacklinksAnswer | null> {
  try {
    const res = await get(backlinksPath(boardId))
    if (!res.ok) {
      // 404: an older api (or a board this person cannot see any more); 403: a guest; anything else: unknown
      await res.body?.cancel().catch(() => {})
      return null
    }
    const parsed = BacklinksAnswer.safeParse(await res.json())
    if (!parsed.success) return null
    return { backlinks: parsed.data.backlinks.slice(0, BACKLINKS_MAX) }
  } catch {
    return null
  }
}
