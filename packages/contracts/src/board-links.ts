// Links between boards (wave N, PWR-10; OWNER: WS7 for the routes, WS4 for this file after the wave N foundation).
//
// A board card is a link-card rectangle with `customData.lobby.kind` BOARD_CARD_KIND and `link` a Lobby-relative
// board path (`/b/<boardId>[?el=<elementId>]`, BOARD_LINK_PATH_PATTERN). Nothing else about the target is stored on
// the board (no title, no thumbnail URL): its face comes at view time from a permission-checked route, and the
// bound label says "Board link", so exports, thumbnails and search stay honest.
//
//   GET /api/boards/:bid/board-cards?ids=<boardId[:elementId]>,…  → 200 BoardCardsAnswer   (view :bid; ≤ 50 ids)
//   GET /api/boards/:bid/backlinks                                → 200 BacklinksAnswer    (view :bid; no guests)
//
// Card faces use 404 semantics: a target the caller cannot view, one that does not exist and one in the trash all
// answer the same `unavailable` face, byte for byte. A name-only guest gets only `unavailable` faces. Backlinks are
// filtered at query time by search's scope (viewable, not trashed, workspace membership) and never name the board
// itself. Until WS7 implements them both routes are pending (404 NOT_FOUND, like any unknown route), and the web's
// boardCards() and backlinks() answer unavailable (apps/web/src/features/board-links/client.ts).
//
// Do not import values from ./index.ts here: index.ts re-exports this module.

import { z } from 'zod'

/** `customData.lobby.kind` of a board card (canvas-schema KindValue accepts it; create-only). */
export const BOARD_CARD_KIND = 'board-card'
/** The bound label every board card shows (never the target's title). */
export const BOARD_CARD_LABEL = 'Board link'

export const BOARD_CARDS_ROUTE = '/api/boards/:bid/board-cards'
export const BACKLINKS_ROUTE = '/api/boards/:bid/backlinks'
export const boardCardsPath = (boardId: string, targets: readonly string[]) =>
  `/api/boards/${encodeURIComponent(boardId)}/board-cards?ids=${targets.map(encodeURIComponent).join(',')}`
export const backlinksPath = (boardId: string) => `/api/boards/${encodeURIComponent(boardId)}/backlinks`

/** At most this many card targets per board-cards call (the 51st is a 400). */
export const BOARD_CARDS_MAX_IDS = 50
/** At most this many boards in one backlinks answer. */
export const BACKLINKS_MAX = 50

/** A board id (index.ts BOARD_ID_PATTERN, repeated: this module may not import index.ts). */
const BOARD_ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/
/** An element id as a deep link carries it (canvas-schema ELEMENT_ID_PATTERN; ai.ts WORKSPACE_ASK_ELEMENT_ID_PATTERN). */
const ELEMENT_ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/
const LinkBoardId = z.string().regex(BOARD_ID_RE)
const LinkElementId = z.string().regex(ELEMENT_ID_RE)

/**
 * A Lobby-relative board path as a card's `link` stores it: `/b/<boardId>`, optionally `?el=<elementId>` (one id).
 * Only the relative form: an absolute URL, even of Lobby's own origin, is turned into this form before it is stored.
 */
export const BOARD_LINK_PATH_PATTERN = /^\/b\/([a-z0-9][a-z0-9_-]{2,63})(?:\?el=([A-Za-z0-9_.:-]{1,120}))?$/

/** `{boardId, elementId}` of a stored board path, or null when `link` is not exactly one (BOARD_LINK_PATH_PATTERN). */
export function parseBoardLinkPath(link: unknown): { boardId: string; elementId: string | null } | null {
  if (typeof link !== 'string') return null
  const m = BOARD_LINK_PATH_PATTERN.exec(link)
  if (!m?.[1]) return null
  return { boardId: m[1], elementId: m[2] ?? null }
}

/** The stored path of a board (and an element on it). */
export const boardLinkPath = (boardId: string, elementId?: string | null) =>
  elementId ? `/b/${boardId}?el=${elementId}` : `/b/${boardId}`

/** One card target in a board-cards query: `<boardId>` or `<boardId>:<elementId>`. */
export const BOARD_CARD_TARGET_PATTERN = /^([a-z0-9][a-z0-9_-]{2,63})(?::([A-Za-z0-9_.:-]{1,120}))?$/
export const BoardCardTarget = z.string().regex(BOARD_CARD_TARGET_PATTERN)
export const boardCardTarget = (boardId: string, elementId?: string | null) =>
  elementId ? `${boardId}:${elementId}` : boardId

/** `?ids=`: 1 to BOARD_CARDS_MAX_IDS comma-separated targets (unique after parsing). */
export const BoardCardsQuery = z.strictObject({
  ids: z
    .string()
    .min(1)
    .transform((s) => [...new Set(s.split(','))])
    .pipe(z.array(BoardCardTarget).min(1).max(BOARD_CARDS_MAX_IDS)),
})
export type BoardCardsQuery = z.infer<typeof BoardCardsQuery>

/**
 * One card's face. `ok` only when this caller can view the target now and it is not in the trash: its title, the
 * frame's name when the target element is a frame (else null), and the same-origin thumbnail route (which checks
 * access itself). Every other case is `unavailable`, with nothing else.
 */
export const BoardCardFace = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('ok'),
    title: z.string().max(200),
    frameName: z.string().max(200).nullable(),
    thumbnailPath: z.string().regex(/^\/api\/boards\/[a-z0-9][a-z0-9_-]{2,63}\/thumbnail$/),
  }),
  z.strictObject({ state: z.literal('unavailable') }),
])
export type BoardCardFace = z.infer<typeof BoardCardFace>

/** GET board-cards: each asked target (as asked) → its face. */
export const BoardCardsAnswer = z.strictObject({
  cards: z.record(BoardCardTarget, BoardCardFace),
})
export type BoardCardsAnswer = z.infer<typeof BoardCardsAnswer>

/** One board that links here: its id and title, and the linking element (for "Go to the link"). */
export const Backlink = z.strictObject({
  boardId: LinkBoardId,
  title: z.string().max(200),
  elementId: LinkElementId,
})
export type Backlink = z.infer<typeof Backlink>
/** GET backlinks: the boards the caller can view that link to this one (never this board itself). */
export const BacklinksAnswer = z.strictObject({ backlinks: z.array(Backlink).max(BACKLINKS_MAX) })
export type BacklinksAnswer = z.infer<typeof BacklinksAnswer>
