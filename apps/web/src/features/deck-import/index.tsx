// OWNER: WS4 (wave W, deck import; docs/WAVE-W-CONTRACTS.md §6). The 'deck-import' feature on the Excalidraw board
// page: "Insert as slides" on a ready deck card (PDF, PowerPoint, OpenDocument presentation) already on the board or
// just dropped, from its context menu, the palette ('deck.insert-slides', held while the contracts list it pending)
// and the PDF viewer (./ViewerButton.tsx). The dialog (./DeckDialog.tsx) gets pages 9..min(N, 100) made when needed
// (./job.ts: POST /api/files/:ver/render-pages) and places per slide a frame (FORMAT_ELEMENT_KINDS.deckSlide) holding
// the page picture ver_….p<n> (deckPage) in a DECK_LIMITS grid, all in ONE canvas.transact (./place.ts: one undo
// step). Slides are flattened page pictures: nothing claims they are editable. A Keynote file gets "export to PDF or
// PowerPoint first" and no request.
//
// Offered only while its web switch (features/formats/flags.ts FORMATS_FLAGS.deckImport) AND the api's offer
// (AuthConfig.formats.deckImport: DRAFTROOM_DECK_IMPORT and a worker that can make pages, seen recently) say on, to
// someone who can add to the board. Off, it makes no request and draws nothing; placed slides stay frames and images
// for every reader (a 7e5b4d6 tab too: the kinds are new values of the existing create-only key).
import { PENDING_PALETTE_COMMAND_IDS } from '@draftroom/contracts'
import type {
  CanvasFeature,
  CanvasFeatureContext,
  CommandSpec,
  MenuEntrySpec,
} from '../../canvas/api/index.ts'
import { factsOf, fileItemKind } from '../../file-card/ported/model.ts'
import { formatsEnabled } from '../formats/flags.ts'
import { DeckDialogHost } from './DeckDialog.tsx'
import { type DeckKind, deckKindOf } from './model.ts'
import { openDeckImport } from './state.ts'

export const DECK_COMMAND_ID = 'deck.insert-slides'
/** Whether the contracts still hold 'deck.insert-slides' pending (then the palette does not offer it). */
export const deckCommandHeld = (pending: readonly string[] = PENDING_PALETTE_COMMAND_IDS): boolean =>
  pending.includes(DECK_COMMAND_ID)

/** The one deck (or Keynote) card among `ids`, when it is the only thing selected. */
export function deckCardOf(
  ctx: Pick<CanvasFeatureContext, 'canvas'>,
  ids: readonly string[],
): { id: string; kind: Exclude<DeckKind, null> } | null {
  if (ids.length !== 1) return null
  const id = ids[0] as string
  const el = ctx.canvas.get(id)
  if (!el || el.isDeleted) return null
  // a placed page is an image of the PDF too: only the card itself makes slides
  if (fileItemKind(el) !== 'card') return null
  const kind = deckKindOf(factsOf(el))
  return kind ? { id, kind } : null
}

const offered = (ctx: CanvasFeatureContext) => formatsEnabled('deckImport') && !ctx.canvas.readOnly()

const MENU: readonly MenuEntrySpec[] = [
  {
    id: 'deck-import.insert-slides',
    group: 'frame',
    order: 80,
    label: 'Insert as slides…',
    visible: (ctx, target) => offered(ctx) && deckCardOf(ctx, target.ids) !== null,
    run: (ctx, target) => {
      const card = deckCardOf(ctx, target.ids)
      if (card) openDeckImport(ctx.registries, card.id)
    },
  },
]

const COMMANDS: readonly CommandSpec[] = [
  {
    id: DECK_COMMAND_ID,
    label: 'Insert as slides',
    group: 'Insert',
    keywords: ['deck', 'slides', 'powerpoint', 'pptx', 'pdf', 'presentation', 'keynote', 'import'],
    available: () => formatsEnabled('deckImport'),
    disabledReason: (ctx) =>
      ctx.canvas.readOnly()
        ? 'You can view this board but not add to it'
        : deckCardOf(ctx, ctx.canvas.selection)
          ? null
          : 'Select a PDF or PowerPoint file on the board',
    run: (ctx) => {
      const card = deckCardOf(ctx, ctx.canvas.selection)
      if (card) openDeckImport(ctx.registries, card.id)
    },
  },
]

export const feature: CanvasFeature = {
  id: 'deck-import',
  contextMenu: MENU,
  commands: deckCommandHeld() ? [] : COMMANDS,
  overlays: [
    { id: 'deck-import.dialog', layer: 'screen', order: 95, pointer: 'none', component: DeckDialogHost },
  ],
}
