// OWNER: WS4 (wave W, deck import). "Insert as slides" in the PDF page viewer's header (the one row WS4 adds to
// file-card/ported/PdfViewer.tsx): closes the viewer and opens the deck dialog for the same card. Shown only while the
// feature is offered (its web switch and the api's offer), to someone who can add to the board, for a deck.
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import type { FileFacts } from '../../file-card/ported/model.ts'
import { pdfViewerRequest } from '../../file-card/ported/viewer-state.ts'
import { useValue } from '../../lib/signals.ts'
import { formatsEnabled } from '../formats/flags.ts'
import { deckKindOf } from './model.ts'
import { openDeckImport } from './state.ts'

export function DeckViewerButton({
  ctx,
  facts,
  onOpen,
}: {
  ctx: CanvasFeatureContext
  facts: FileFacts
  /** closes the viewer */
  onOpen(): void
}) {
  const shown = useValue(
    'deck-import-viewer-button',
    () => formatsEnabled('deckImport') && !ctx.canvas.readOnly() && deckKindOf(facts) === 'deck',
    [ctx, facts],
  )
  if (!shown) return null
  return (
    <button
      type="button"
      className="dr-btn dr-btn--sm"
      data-testid="pdf-viewer-insert-slides"
      onClick={() => {
        const id = pdfViewerRequest(ctx.registries).get()?.id
        onOpen()
        if (id) openDeckImport(ctx.registries, id)
      }}
    >
      Insert as slides
    </button>
  )
}
