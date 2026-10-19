// OWNER: WS4 (wave W, deck import; docs/WAVE-W-CONTRACTS.md §6). Places a deck's slides on the board as ONE
// canvas.transact, so one undo step takes the whole deck back: per slide a `frame` (customData.lobby.kind
// 'deck-slide', named "Slide n") and inside it an `image` of the page picture the worker made (`fileId`
// `ver_….p<n>`, kind 'deck-page', alt "Slide n of N"), in model.ts's grid, right of the card, clear of what is on the
// board. Frames never nest, so the grid always goes on the page itself, even for a card inside a frame.
//
// What an element holds: the PDF version's stable ids (`fileId` = a version id plus the page; customData.lobby.file
// the card's own facts, canonicalized by the server), never a URL or bytes: the image loader shows the worker's
// rendering of that page (canvas/files/resolve.ts). Nothing here pushes on its own: this is the person's own write.
import { FORMAT_ELEMENT_KINDS } from '@draftroom/contracts'
import { placeBlock, type Rect } from '../../assets/drop-layout.ts'
import type { LobbyCanvas } from '../../canvas/api/index.ts'
import type { PreviewPage } from '../../file-card/pdf-pages.ts'
import { bringIntoView } from '../../file-card/ported/insert.ts'
import type { FileFacts } from '../../file-card/ported/model.ts'
import { layoutSlides, slideAlt, slideName } from './model.ts'

/** Between the card and the grid, and around it. */
export const DECK_CLEARANCE = 80

const rectOf = (b: { x: number; y: number; width: number; height: number }): Rect => ({
  x: b.x,
  y: b.y,
  w: b.width,
  h: b.height,
})

const r2 = (v: number) => Math.round(v * 100) / 100

/** The page's top-level content (frames included): what the grid must stay clear of. */
function topLevel(canvas: LobbyCanvas): Rect[] {
  const out: Rect[] = []
  for (const el of canvas.items()) {
    if ((el.frameId ?? null) !== null || (el as { containerId?: string | null }).containerId) continue
    const b = canvas.bounds(el.id)
    if (b) out.push(rectOf(b))
  }
  return out
}

export interface PlacedDeck {
  /** the slide frames, in page order */
  readonly frames: string[]
  /** the page pictures, in page order */
  readonly images: string[]
}

/**
 * Puts `pages` (in page order) on the board as slides right of the card `cardId`; `total` is the document's page
 * count (the alt text's N). Selects the frames and brings the grid into view. Nothing on a read-only canvas.
 */
export function placeDeck(
  canvas: LobbyCanvas,
  cardId: string,
  facts: FileFacts,
  pages: readonly PreviewPage[],
  total: number,
): PlacedDeck {
  const none: PlacedDeck = { frames: [], images: [] }
  if (!pages.length || canvas.readOnly()) return none
  const card = canvas.bounds(cardId)
  if (!card) return none
  const grid = layoutSlides([...pages].sort((a, b) => a.page - b.page))
  const center = { x: card.x + card.width + DECK_CLEARANCE + 0.5 + grid.w / 2, y: card.y + grid.h / 2 }
  const { topLeft } = placeBlock(
    { w: grid.w, h: grid.h },
    center,
    [{ id: null, bounds: null, obstacles: topLevel(canvas) }],
    DECK_CLEARANCE,
  )
  const frames: string[] = []
  const images: string[] = []
  canvas.transact('Insert slides', (tx) => {
    for (const s of grid.slides) {
      const x = r2(topLeft.x + s.x)
      const y = r2(topLeft.y + s.y)
      const frameId = tx.create('frame', {
        x,
        y,
        width: s.w,
        height: s.h,
        name: slideName(s.page),
        customData: { lobby: { kind: FORMAT_ELEMENT_KINDS.deckSlide } },
      })
      frames.push(frameId)
      images.push(
        tx.create('image', {
          x,
          y,
          width: s.w,
          height: s.h,
          fileId: `${facts.versionId}.p${s.page}`,
          status: 'saved',
          scale: [1, 1],
          frameId,
          customData: {
            lobby: {
              file: { ...facts },
              pdfPage: s.page,
              alt: slideAlt(s.page, total),
              kind: FORMAT_ELEMENT_KINDS.deckPage,
            },
          },
        }),
      )
    }
  })
  canvas.select(frames)
  bringIntoView(canvas, { x: topLeft.x, y: topLeft.y, w: grid.w, h: grid.h })
  return { frames, images }
}
