// OWNER: WS4 (wave W, deck import; docs/WAVE-W-CONTRACTS.md §6). The pure model of "Insert as slides": which file
// cards are decks, how many slides a deck gives, which page pictures still have to be made, and the grid the slides
// form (DECK_LIMITS: a 1600-wide frame per slide at its page's aspect, 5 to a row, 80 apart, rows top-aligned, in page
// order: the board's reading order, which is the order Present walks frames that have no explicit position). No DOM,
// no canvas: unit-tested in model.test.ts.
import { DECK_LIMITS, deckSlideName } from '@draftroom/contracts'
import type { AssetVersionMeta } from '../../assets/contract.ts'
import { type PreviewPage, previewPages } from '../../file-card/pdf-pages.ts'
import type { FileFacts } from '../../file-card/ported/model.ts'

/** What a file card is for this feature: a deck it can make slides of, a Keynote file (guidance only), or neither. */
export type DeckKind = 'deck' | 'keynote' | null

const DECK_MIMES: ReadonlySet<string> = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.presentation',
])
const DECK_EXT_RE = /\.(?:pdf|pptx|odp)$/i
const KEYNOTE_RE = /\.key$/i

/** A PDF, PowerPoint or OpenDocument presentation card (kind pdf); a `.key` file (kind other) is Keynote. */
export function deckKindOf(facts: Pick<FileFacts, 'kind' | 'mimeType' | 'name'> | null): DeckKind {
  if (!facts) return null
  if (facts.kind === 'pdf')
    return DECK_MIMES.has(facts.mimeType) || DECK_EXT_RE.test(facts.name) ? 'deck' : null
  if (KEYNOTE_RE.test(facts.name) || facts.mimeType === 'application/vnd.apple.keynote') return 'keynote'
  return null
}

export interface DeckPlan {
  /** the document's pages */
  readonly total: number
  /** the slides it gives: the first DECK_LIMITS.maxSlides pages */
  readonly slides: number
  /** more pages than slides (the dialog says so) */
  readonly truncated: boolean
  /** pages past the preview's eight must be made first (a render-pages request) */
  readonly needsRender: boolean
}

export function deckPlan(total: number): DeckPlan {
  const n = Math.max(0, Math.floor(total))
  const slides = Math.min(n, DECK_LIMITS.maxSlides)
  return { total: n, slides, truncated: n > slides, needsRender: slides > DECK_LIMITS.eagerPages }
}

/** The page pictures the meta has for pages 1..`slides`, in page order (only these can be placed). */
export function slidePagesOf(meta: AssetVersionMeta | null, slides: number): PreviewPage[] {
  return previewPages(meta).filter((p) => p.page <= slides)
}

/** The pages 1..`slides` the meta has no picture of yet. */
export function missingPages(meta: AssetVersionMeta | null, slides: number): number[] {
  const have = new Set(slidePagesOf(meta, slides).map((p) => p.page))
  const out: number[] = []
  for (let n = 1; n <= slides; n++) if (!have.has(n)) out.push(n)
  return out
}

/** The pages past the preview's eight that are ready, of those the deck needs (the dialog's progress). */
export function renderProgress(meta: AssetVersionMeta | null, slides: number): { ready: number; of: number } {
  const of = Math.max(0, slides - DECK_LIMITS.eagerPages)
  const ready = slidePagesOf(meta, slides).filter((p) => p.page > DECK_LIMITS.eagerPages).length
  return { ready: Math.min(ready, of), of }
}

export interface SlideRect {
  readonly page: number
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

const r2 = (v: number) => Math.round(v * 100) / 100

/** One slide's frame size: DECK_LIMITS.slideWidth wide at its page picture's aspect. */
export function slideSize(page: Pick<PreviewPage, 'full'>): { w: number; h: number } {
  const { width, height } = page.full
  const aspect = width > 0 && height > 0 ? height / width : 9 / 16
  return { w: DECK_LIMITS.slideWidth, h: r2(DECK_LIMITS.slideWidth * aspect) }
}

/** The grid relative to its top-left: rows of DECK_LIMITS.gridColumns, top-aligned, gridGap apart; and its size. */
export function layoutSlides(pages: readonly Pick<PreviewPage, 'page' | 'full'>[]): {
  w: number
  h: number
  slides: SlideRect[]
} {
  const cols = DECK_LIMITS.gridColumns
  const gap = DECK_LIMITS.gridGap
  const slides: SlideRect[] = []
  let y = 0
  let w = 0
  for (let i = 0; i < pages.length; i += cols) {
    const row = pages.slice(i, i + cols)
    let x = 0
    let rowH = 0
    for (const p of row) {
      const s = slideSize(p)
      slides.push({ page: p.page, x, y, w: s.w, h: s.h })
      x += s.w + gap
      rowH = Math.max(rowH, s.h)
    }
    w = Math.max(w, x - gap)
    y += rowH + gap
  }
  return { w, h: pages.length ? y - gap : 0, slides }
}

/** A slide frame's name (contracts deckSlideName; the slide's text is not known on the web: "Slide n"). */
export const slideName = (n: number, firstLine?: string | null) => deckSlideName(n, firstLine)

/** A slide picture's alt text: "Slide 3 of 24". */
export const slideAlt = (n: number, total: number) => `Slide ${n} of ${total}`

// ---- words ----------------------------------------------------------------------------------------------------------

export const DECK_COPY = {
  title: 'Insert as slides',
  pictures:
    'Each page becomes a frame holding a picture of the page, in a grid next to the file, ready to present. The slides are pictures: their text can’t be edited on the board.',
  soft: 'Slide pictures are 1024 pixels wide, so they can look soft when presented full screen.',
  keynote:
    'Keynote files can’t be made into slides here. Export to PDF or PowerPoint first (in Keynote: File › Export To), then add that file to the board.',
  guests: 'Guests can place the first 8 slides. Slides past 8 are made by editors with an account.',
  unavailable: 'Making slides is not available right now. Try again later.',
  slow: 'Making the slides is taking longer than expected. Try again later.',
  readOnly: 'You can view this board but not add to it.',
} as const

export const truncatedText = (total: number) =>
  `This file has ${total} pages: the first ${DECK_LIMITS.maxSlides} become slides.`
export const renderText = (slides: number) =>
  `Pages ${DECK_LIMITS.eagerPages + 1} to ${slides} are made first. This can take a minute or two.`
