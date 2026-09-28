import type { FileCardShape } from '@draftroom/canvas-schema'
import { type PointerEvent, useCallback, useEffect, useState } from 'react'
import { HTMLContainer, useEditor, useValue } from 'tldraw'
import { derivativeUrl, originalUrl } from '../assets/contract.ts'
import { useAssetMeta } from '../assets/meta-store.ts'
import { useBoard } from '../board/board-context.ts'
import { exportAllowedOnBoard } from '../features/sharing/export-policy.ts'
import { extensionLabel, formatBytes, formatDuration, pluralize } from '../lib/format.ts'
import { type CardView, cardView, coverDerivative, stripPages } from './card-model.ts'
import './file-card.css'
import { CONVERSION_DETAIL, CONVERSION_NOTE, cardOfficeFormat, isConvertedPreview } from './office.ts'
import { registerCardBoard } from './open-original.ts'
import { previewPages } from './pdf-pages.ts'
import { openPdfViewer } from './viewer-state.ts'

const hasPagePreviews = (meta: Parameters<typeof previewPages>[0]) => previewPages(meta).length > 0

const STRIP_MAX = 4

/**
 * Interactive children (play, download, the playing <video>) opt back into pointer events and mark
 * the event as handled so the canvas does not also start a selection/drag. Everywhere else the card
 * stays pointer-transparent like tldraw's own shapes, so select/move/resize work normally. Holding
 * Shift lets the editor have the event (to add the card to the selection). The event's own flag
 * decides, not the editor's key state: that can lag behind (a Shift released while a dialog had
 * the keyboard), and a stale Shift let the canvas take the click and select the card instead.
 */
function useInteractive() {
  const editor = useEditor()
  return useCallback(
    (e: PointerEvent) => {
      if (!e.shiftKey) editor.markEventAsHandled(e)
    },
    [editor],
  )
}

export function FileCardView({ shape }: { shape: FileCardShape }) {
  const board = useBoard()
  const editor = useEditor()
  // Lets FileCardShapeUtil.onDoubleClick build the same original URL as the Download link.
  useEffect(() => {
    if (board) registerCardBoard(editor, { boardId: board.boardId, metaStore: board.metaStore })
  }, [editor, board])
  const p = shape.props
  const snap = useAssetMeta(board?.metaStore ?? null, board?.boardId ?? '', p.assetId, p.versionId)
  const view = cardView(p, snap.meta)
  const cover = coverDerivative(snap.meta)
  const coverSrc = board && cover ? derivativeUrl(board.boardId, p.assetId, p.versionId, cover.id) : null
  const original = board && !snap.missing ? originalUrl(board.boardId, p.assetId, p.versionId) : null
  const pages = stripPages(snap.meta)
  // Office documents are previewed through their PDF conversion (office.ts): say so on the card.
  const office = cardOfficeFormat(snap.meta, p)
  const converted = isConvertedPreview(snap.meta)
  // export-control: no Download while the board owner turned downloads off for this person (the api
  // refuses the original anyway). Previews, pages and video playback keep working.
  const boardId = board?.boardId ?? null
  const canDownload = useValue('dr-fc-can-download', () => (boardId ? exportAllowedOnBoard(boardId) : true), [
    boardId,
  ])

  return (
    <HTMLContainer
      className="dr-fc"
      data-testid="file-card"
      data-status={view.status}
      data-kind={view.kind}
      data-office={office?.ext}
      data-meta={snap.missing ? 'missing' : snap.meta ? 'loaded' : 'pending'}
      aria-label={`${view.name}, ${statusText(view, snap.missing)}`}
    >
      {(view.kind !== 'other' || view.status === 'failed') && (
        <div className="dr-fc__preview">
          <Preview
            view={view}
            coverSrc={coverSrc}
            original={original}
            canDownload={canDownload}
            missing={snap.missing}
            onViewPages={
              view.kind === 'pdf' && board && hasPagePreviews(snap.meta)
                ? () => openPdfViewer(editor, shape.id)
                : null
            }
          />
        </div>
      )}
      {view.kind === 'pdf' && pages.length > 0 && board && (
        <div className="dr-fc__strip" data-testid="file-card-strip" aria-hidden="true">
          {pages.slice(0, STRIP_MAX).map((d) => (
            <img
              key={d.id}
              src={derivativeUrl(board.boardId, p.assetId, p.versionId, d.id)}
              alt=""
              decoding="async"
              draggable={false}
            />
          ))}
          {pages.length > STRIP_MAX && <span className="dr-fc__more">+{pages.length - STRIP_MAX}</span>}
        </div>
      )}
      {converted && !snap.missing && <ConversionNote />}
      <Footer view={view} original={canDownload ? original : null} missing={snap.missing} />
    </HTMLContainer>
  )
}

function Preview({
  view,
  coverSrc,
  original,
  canDownload,
  missing,
  onViewPages,
}: {
  view: CardView
  coverSrc: string | null
  original: string | null
  /** false: the board owner turned downloads off for this person (the player offers none either). */
  canDownload: boolean
  missing: boolean
  /** Opens the PDF page viewer (null: no page previews to show). */
  onViewPages: (() => void) | null
}) {
  const onInteract = useInteractive()
  const [playing, setPlaying] = useState(false)

  if (view.status === 'failed') {
    return (
      <div className="dr-fc__state dr-fc__state--failed">
        <span className="dr-fc__state-icon" aria-hidden="true">
          !
        </span>
        <p data-testid="file-card-error">{view.errorMessage ?? 'Preview failed.'}</p>
        <p className="dr-fc__hint">
          {canDownload
            ? 'The original file is still available below.'
            : 'Downloading the original is turned off on this board.'}
        </p>
      </div>
    )
  }
  if (view.status !== 'ready' || !coverSrc) {
    const pending = !missing && (view.status === 'queued' || view.status === 'processing')
    return (
      <div className="dr-fc__state" data-pending={pending || undefined}>
        <span className="dr-fc__badge-kind" aria-hidden="true">
          {extensionLabel(view.name, view.kind)}
        </span>
        <p>
          {missing
            ? 'Preview unavailable'
            : view.status === 'queued'
              ? 'Queued for preview…'
              : view.status === 'processing'
                ? 'Generating preview…'
                : 'Loading preview…'}
        </p>
        {view.kind === 'pdf' && view.pageCount != null && <PagesBadge n={view.pageCount} />}
        {view.kind === 'video' && view.durationMs != null && <DurationBadge ms={view.durationMs} />}
      </div>
    )
  }
  if (view.kind === 'video' && playing && original) {
    return (
      // biome-ignore lint/a11y/useMediaCaption: user-uploaded video; no caption track exists in M0
      <video
        className="dr-fc__video dr-interactive"
        data-testid="file-card-video"
        src={original}
        poster={coverSrc}
        controls
        controlsList={canDownload ? undefined : 'nodownload'}
        autoPlay
        playsInline
        preload="metadata"
        onPointerDown={onInteract}
        onPointerUp={onInteract}
      />
    )
  }
  return (
    <>
      <img
        className="dr-fc__cover"
        data-testid="file-card-preview"
        src={coverSrc}
        alt={view.kind === 'pdf' ? `First page of ${view.name}` : `Preview of ${view.name}`}
        decoding="async"
        draggable={false}
      />
      {view.kind === 'pdf' && view.pageCount != null && <PagesBadge n={view.pageCount} />}
      {onViewPages && (
        <button
          type="button"
          className="dr-fc__view dr-interactive"
          data-testid="file-card-view-pages"
          aria-label={`View pages of ${view.name}`}
          onPointerDown={onInteract}
          onPointerUp={onInteract}
          onClick={onViewPages}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <path
              d="M7 3.5h7l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19V5a1.5 1.5 0 0 1 1-1.5zM14 3.5V8h4M9 12.5h6M9 16h6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          View pages
        </button>
      )}
      {view.kind === 'video' && (
        <>
          {view.durationMs != null && <DurationBadge ms={view.durationMs} />}
          {original && (
            <button
              type="button"
              className="dr-fc__play dr-interactive"
              data-testid="file-card-play"
              aria-label={`Play ${view.name}`}
              onPointerDown={onInteract}
              onPointerUp={onInteract}
              onClick={() => setPlaying(true)}
            >
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />
              </svg>
            </button>
          )}
        </>
      )}
    </>
  )
}

/** The pages are LibreOffice's rendering of the document, not the document: fonts and layout can differ. */
const ConversionNote = () => (
  <p className="dr-fc__note" data-testid="file-card-conversion-note" title={CONVERSION_DETAIL}>
    <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
      <path
        d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5.5M12 7.6v.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
    {CONVERSION_NOTE}
  </p>
)

const PagesBadge = ({ n }: { n: number }) => (
  <span className="dr-fc__chip" data-testid="file-card-pages">
    {pluralize(n, 'page')}
  </span>
)
const DurationBadge = ({ ms }: { ms: number }) => (
  <span className="dr-fc__chip" data-testid="file-card-duration">
    {formatDuration(ms)}
  </span>
)

function Footer({ view, original, missing }: { view: CardView; original: string | null; missing: boolean }) {
  const onInteract = useInteractive()
  return (
    <div className="dr-fc__footer">
      <span className={`dr-fc__icon dr-fc__icon--${view.kind}`} aria-hidden="true">
        {extensionLabel(view.name, view.kind)}
      </span>
      <div className="dr-fc__text">
        <div className="dr-fc__name" title={view.name}>
          {view.name}
        </div>
        <div className="dr-fc__meta">
          {formatBytes(view.sizeBytes)}
          <span aria-hidden="true"> · </span>
          <span className={`dr-fc__status dr-fc__status--${missing ? 'missing' : view.status}`}>
            {statusText(view, missing)}
          </span>
        </div>
      </div>
      {original && (
        <a
          className="dr-fc__download dr-interactive"
          data-testid="file-card-download"
          href={original}
          download={view.name}
          title="Download original"
          draggable={false}
          onPointerDown={onInteract}
          onPointerUp={onInteract}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path
              d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19.5h14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="dr-sr-only">Download {view.name}</span>
        </a>
      )}
    </div>
  )
}

function statusText(view: CardView, missing: boolean): string {
  if (missing) return 'Unavailable'
  switch (view.status) {
    case 'queued':
      return 'Queued'
    case 'processing':
      return 'Processing'
    case 'failed':
      return 'Preview failed'
    default:
      if (view.kind === 'pdf' && view.pageCount != null) return pluralize(view.pageCount, 'page')
      if (view.kind === 'video' && view.durationMs != null) return formatDuration(view.durationMs)
      return view.kind === 'other' ? 'Attachment' : 'Ready'
  }
}
