// OWNER: WS4 (wave W, deck import; docs/WAVE-W-CONTRACTS.md §6). The "Insert as slides" dialog, opened from a deck
// card's context menu, the palette or the PDF viewer (one row in file-card/ported/PdfViewer.tsx):
//   - says plainly what it makes: one frame per slide holding a PICTURE of the page (nothing claims it is editable),
//     the first 100 pages of a longer file, soft at full screen (1024 px pictures);
//   - a Keynote file gets the guidance (export to PDF or PowerPoint first) and no request at all;
//   - a deck of 8 pages or fewer is placed at once; a longer one waits for its pages 9..N (./job.ts) with progress, and
//     a name-only guest may place the first 8 (the api makes pages 9+ for editors with an account only);
//   - then ./place.ts writes the whole deck in ONE canvas.transact (one undo step).
// Closing the dialog while pages are being made stops waiting; the ops run on, so asking again later finds the pages.
import { DECK_LIMITS } from '@draftroom/contracts'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { isTerminal, useAssetMeta } from '../../assets/meta-store.ts'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { documentPageCount, type PreviewPage, previewPages } from '../../file-card/pdf-pages.ts'
import { mediaMetaStore } from '../../file-card/ported/meta.ts'
import { type FileFacts, factsOf } from '../../file-card/ported/model.ts'
import { knownUserKind } from '../../invite/guest.tsx'
import { pluralize } from '../../lib/format.ts'
import { useValue } from '../../lib/signals.ts'
import { Dialog } from '../../ui/Dialog.tsx'
import { prepareDeck } from './job.ts'
import { DECK_COPY, deckKindOf, deckPlan, renderText, slidePagesOf, truncatedText } from './model.ts'
import { placeDeck } from './place.ts'
import { closeDeckImport, deckImportRequest } from './state.ts'

/** Mounted once per board page (a screen overlay): shows the dialog a card asked for. */
export function DeckDialogHost({ ctx }: { ctx: CanvasFeatureContext }) {
  const request = useValue('deck-import-request', () => deckImportRequest(ctx.registries).get(), [ctx])
  const facts = useValue('deck-import-card', () => {
    if (!request) return null
    const el = ctx.canvas.get(request.id)
    return el && !el.isDeleted ? factsOf(el) : null
  }, [ctx, request])
  // the card was deleted (here or by someone else) while its dialog was open
  useEffect(() => {
    if (request && !facts) closeDeckImport(ctx.registries)
  }, [ctx, request, facts])
  if (!request || !facts) return null
  return createPortal(
    <DeckDialog
      key={request.nonce}
      ctx={ctx}
      cardId={request.id}
      facts={facts}
      onClose={() => closeDeckImport(ctx.registries)}
    />,
    document.body,
  )
}

type Phase =
  | { readonly kind: 'intro' }
  | { readonly kind: 'working'; readonly ready: number; readonly of: number }
  | { readonly kind: 'error'; readonly message: string; readonly pages: PreviewPage[] }

function DeckDialog({
  ctx,
  cardId,
  facts,
  onClose,
}: {
  ctx: CanvasFeatureContext
  cardId: string
  facts: FileFacts
  onClose(): void
}) {
  const boardId = ctx.board.id
  const { assetId, versionId } = facts
  const snap = useAssetMeta(mediaMetaStore, boardId, assetId, versionId)
  const kind = deckKindOf(facts)
  const previewed = useMemo(() => previewPages(snap.meta).length, [snap.meta])
  const plan = deckPlan(documentPageCount(snap.meta, { pageCount: null }, previewed))
  const readOnly = useValue('deck-import-readonly', () => ctx.canvas.readOnly(), [ctx])
  const [guestOnly, setGuestOnly] = useState(() => knownUserKind(ctx.me.user.id) === 'guest')
  const [phase, setPhase] = useState<Phase>({ kind: 'intro' })
  const abort = useRef<AbortController | null>(null)
  useEffect(() => () => abort.current?.abort(), [])
  const name = snap.meta?.name || facts.name

  const place = (pages: readonly PreviewPage[]) => {
    const placed = placeDeck(ctx.canvas, cardId, facts, pages, plan.total)
    if (!placed.frames.length) {
      ctx.notify({
        key: 'deck-import',
        text: readOnly ? DECK_COPY.readOnly : 'Those slides could not be placed.',
        tone: 'error',
      })
      return
    }
    ctx.notify({
      key: 'deck-import',
      text: `Placed ${pluralize(placed.frames.length, 'slide')} of ${name}.`,
      testId: 'deck-placed',
      timeoutMs: 5000,
    })
    onClose()
  }

  const limitFor = () => (guestOnly ? Math.min(plan.slides, DECK_LIMITS.eagerPages) : plan.slides)

  const start = async () => {
    const slides = limitFor()
    if (slides <= DECK_LIMITS.eagerPages) {
      place(slidePagesOf(snap.meta, slides))
      return
    }
    const ac = new AbortController()
    abort.current = ac
    setPhase({ kind: 'working', ready: 0, of: slides - DECK_LIMITS.eagerPages })
    const out = await prepareDeck({
      request: ctx.api.request,
      events: ctx.events,
      refresh: (force) => mediaMetaStore.refresh(boardId, assetId, versionId, force ? 0 : 2_500),
      boardId,
      versionId,
      slides,
      signal: ac.signal,
      onProgress: (p) => {
        if (!ac.signal.aborted) setPhase({ kind: 'working', ...p })
      },
    })
    if (ac.signal.aborted || out.kind === 'cancelled') return
    if (out.kind === 'ready') place(out.pages)
    else if (out.kind === 'guest') {
      setGuestOnly(true)
      setPhase({ kind: 'intro' })
    } else setPhase({ kind: 'error', message: out.message, pages: out.pages })
  }

  const stopWaiting = () => {
    abort.current?.abort()
    setPhase({ kind: 'intro' })
  }

  const slides = limitFor()
  const ready = snap.meta?.status === 'ready'
  const title = DECK_COPY.title

  if (kind === 'keynote')
    return (
      <Dialog title={title} description={name} onClose={onClose} testId="deck-import-dialog">
        <p className="dr-muted" data-testid="deck-import-keynote" role="note">
          {DECK_COPY.keynote}
        </p>
        <div className="dr-dialog__actions">
          <button
            type="button"
            className="dr-btn dr-btn--primary"
            data-testid="deck-import-close"
            onClick={onClose}
          >
            OK
          </button>
        </div>
      </Dialog>
    )

  return (
    <Dialog title={title} description={name} onClose={onClose} testId="deck-import-dialog">
      <p className="dr-muted" data-testid="deck-import-pictures" role="note">
        {DECK_COPY.pictures}
      </p>
      {plan.truncated && (
        <p className="dr-muted" data-testid="deck-import-truncated" role="note">
          {truncatedText(plan.total)}
        </p>
      )}
      {guestOnly && plan.slides > DECK_LIMITS.eagerPages && (
        <p className="dr-muted" data-testid="deck-import-guests" role="note">
          {DECK_COPY.guests}
        </p>
      )}
      {!guestOnly && plan.needsRender && phase.kind === 'intro' && (
        <p className="dr-muted" data-testid="deck-import-render-note">
          {renderText(plan.slides)}
        </p>
      )}
      <p className="dr-muted" data-testid="deck-import-soft">
        {DECK_COPY.soft}
      </p>
      {!ready && (
        <p className="dr-muted" data-testid="deck-import-not-ready" role="status">
          {snap.missing
            ? 'This file is missing.'
            : isTerminal(snap)
              ? 'This file has no pages to place.'
              : 'This file is still being processed…'}
        </p>
      )}
      {phase.kind === 'working' && (
        <div className="dr-row" role="status" data-testid="deck-import-progress">
          <progress max={Math.max(1, phase.of)} value={phase.ready} aria-label="Slides being made" />
          <span>
            Making slides… {phase.ready} of {phase.of} ready
          </span>
        </div>
      )}
      {phase.kind === 'error' && (
        <p className="dr-field-error" role="alert" data-testid="deck-import-error">
          {phase.message}
        </p>
      )}
      <div className="dr-dialog__actions">
        {phase.kind === 'working' ? (
          <button type="button" className="dr-btn" data-testid="deck-import-stop" onClick={stopWaiting}>
            Stop waiting
          </button>
        ) : (
          <button type="button" className="dr-btn" data-testid="deck-import-cancel" onClick={onClose}>
            Cancel
          </button>
        )}
        {phase.kind === 'error' && phase.pages.length > 0 && (
          <button
            type="button"
            className="dr-btn"
            data-testid="deck-import-place-ready"
            onClick={() => place(phase.pages)}
          >
            Insert the {pluralize(phase.pages.length, 'ready slide')}
          </button>
        )}
        {phase.kind !== 'working' && (
          <button
            type="button"
            className="dr-btn dr-btn--primary"
            data-testid="deck-import-insert"
            disabled={!ready || readOnly || slides < 1}
            onClick={() => void start()}
          >
            {phase.kind === 'error' ? 'Try again' : `Insert ${pluralize(slides, 'slide')}`}
          </button>
        )}
      </div>
    </Dialog>
  )
}
