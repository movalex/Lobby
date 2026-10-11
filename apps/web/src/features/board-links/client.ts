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
// Same-origin requests only (credentials: same-origin, no cache). A target that is not a card target is never sent
// (it stays `unavailable`), and at most BOARD_CARDS_MAX_IDS go in one request (more are split). Neither function
// ever throws.
import {
  BACKLINKS_MAX,
  BacklinksAnswer,
  BOARD_CARD_TARGET_PATTERN,
  BOARD_CARDS_MAX_IDS,
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

export async function boardCards(boardId: string, targets: readonly string[]): Promise<BoardCardsAnswer> {
  const out = unavailableCards(targets)
  const asked = [...new Set(targets)].filter((t) => BOARD_CARD_TARGET_PATTERN.test(t))
  for (let i = 0; i < asked.length; i += BOARD_CARDS_MAX_IDS) {
    const chunk = asked.slice(i, i + BOARD_CARDS_MAX_IDS)
    try {
      const res = await get(boardCardsPath(boardId, chunk))
      if (!res.ok) {
        await res.body?.cancel().catch(() => {})
        continue
      }
      const parsed = BoardCardsAnswer.safeParse(await res.json())
      if (!parsed.success) continue
      for (const t of chunk) {
        const face = parsed.data.cards[t]
        if (face) out.cards[t] = face
      }
    } catch {
      // the network: neutral faces (a later view asks again)
    }
  }
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
