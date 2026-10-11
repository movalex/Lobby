// OWNER: WS7 (wave N, links between boards; frozen by the wave N foundation). Pure rules of a board card:
//  - a card is a link-card rectangle with `customData.lobby.kind` BOARD_CARD_KIND and `link` a Lobby-relative board
//    path (`/b/<id>[?el=<id>]`); nothing else about the target is stored (no title, no thumbnail URL);
//  - `boardLinkOf(el)` reads the target of any element whose `link` is such a path (the relative form only; the
//    http(s)-only `linkOf` of file-card/ported/link-cards.tsx stays as it is);
//  - `boardPathOfUrl(url, origin)` turns a pasted same-origin board URL into the stored relative path, and refuses a
//    foreign origin (that stays a normal link card).
import { BOARD_CARD_KIND, boardLinkPath, parseBoardLinkPath } from '@draftroom/contracts'

/** The palette commands WS7 registers (contracts usage.ts PALETTE_COMMAND_IDS; pending until then). */
export const BOARD_LINKS_INSERT_COMMAND_ID = 'board-links.insert'
export const BOARD_LINKS_BACKLINKS_COMMAND_ID = 'board-links.backlinks'

interface LinkedElement {
  readonly link?: unknown
  readonly customData?: unknown
}

/** The board (and element) an element links to through a Lobby-relative board path, or null. */
export function boardLinkOf(el: LinkedElement): { boardId: string; elementId: string | null } | null {
  return parseBoardLinkPath(el.link)
}

/** Whether `el` is a board card (its kind; a card always links with a board path). */
export function isBoardCard(el: LinkedElement): boolean {
  const kind = (el.customData as { lobby?: { kind?: unknown } } | undefined)?.lobby?.kind
  return kind === BOARD_CARD_KIND && boardLinkOf(el) !== null
}

/**
 * The stored path for a pasted URL that opens a board of this Lobby (`origin`: the page's, or VITE_PUBLIC_ORIGIN), or
 * null when it does not: another origin, another route, more than one `?el=` id or other parameters. A relative
 * `/b/…` path counts as this origin's.
 */
export function boardPathOfUrl(raw: string, origin: string): string | null {
  let url: URL
  try {
    url = new URL(raw.trim(), origin)
  } catch {
    return null
  }
  if (url.origin !== new URL(origin).origin || url.hash || !url.pathname.startsWith('/b/')) return null
  const params = [...url.searchParams.keys()]
  if (params.some((k) => k !== 'el') || url.searchParams.getAll('el').length > 1) return null
  const path = boardLinkPath(url.pathname.slice(3), url.searchParams.get('el'))
  return parseBoardLinkPath(path) ? path : null
}
