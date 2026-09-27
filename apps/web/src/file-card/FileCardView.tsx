import type { FileCardShape } from '@draftroom/canvas-schema'
import { type PointerEvent, useCallback, useEffect, useState } from 'react'
import { HTMLContainer, useEditor } from 'tldraw'
import { derivativeUrl, originalUrl } from '../assets/contract.ts'
import { useAssetMeta } from '../assets/meta-store.ts'
import { useBoard } from '../board/board-context.ts'
import { extensionLabel, formatBytes, formatDuration, pluralize } from '../lib/format.ts'
import { type CardView, cardView, coverDerivative, stripPages } from './card-model.ts'
import './file-card.css'
import { registerCardBoard } from './open-original.ts'

const STRIP_MAX = 4

/**
 * Interactive children (play, download, the playing <video>) opt back into pointer events and mark
 * the event as handled so the canvas does not also start a selection/drag. Everywhere else the card
 * stays pointer-transparent like tldraw's own shapes, so select/move/resize work normally. Holding
 * Shift lets the editor have the event (to add the card to the selection).
 */
function useInteractive() {
  const editor = useEditor()
  return useCallback(
    (e: PointerEvent) => {
      if (!editor.inputs.getShiftKey()) editor.markEventAsHandled(e)
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

  return (
    <HTMLContainer
      className="dr-fc"
      data-testid="file-card"
      data-status={view.status}
      data-kind={view.kind}
      data-meta={snap.missing ? 'missing' : snap.meta ? 'loaded' : 'pending'}
      aria-label={`${view.name}, ${statusText(view, snap.missing)}`}
    >
      {(view.kind !== 'other' || view.status === 'failed') && (
        <div className="dr-fc__preview">
          <Preview view={view} coverSrc={coverSrc} original={original} missing={snap.missing} />
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
      <Footer view={view} original={original} missing={snap.missing} />
    </HTMLContainer>
  )
}

function Preview({
  view,
  coverSrc,
  original,
  missing,
}: {
  view: CardView
  coverSrc: string | null
  original: string | null
  missing: boolean
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
        <p className="dr-fc__hint">The original file is still available below.</p>
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
