// OWNER: 3g. The faces of files on the Excalidraw canvas (docs/EXCALIDRAW-MIGRATION.md §2.10.3, §2.10.4):
// one scene-layer overlay that draws
//   - every file card (a PDF, video, Office document or other file: an `image` element whose canvas
//     face is the worker's cover or poster) as today's card: cover, page strip, status, pages and
//     duration chips, "View pages", play (the video plays in the card), the Office conversion note and
//     the footer with the Download link (file-card/FileCardView.tsx, same copy and test ids);
//   - Lobby's placeholder over an image or placed page the loader has not handed to the engine yet
//     ("Processing…" and the file name, F8) or cannot load ("Couldn't process this image", F5).
//
// The layer takes no pointer events: clicks, drags and selection go to the canvas under it; only the
// card's own buttons, links and the playing video take them. A card's face is drawn in scene units and
// scaled with the zoom, so it moves and resizes with its element. Opaque elements painted above a card
// (a note, a filled shape, an image) cut a hole in its face, so they stay visible over it.
// Live facts come from the api's meta (./meta.ts), never from the element.
import { type CSSProperties, type PointerEvent, useRef, useState } from 'react'
import { derivativeUrl, originalUrl } from '../../assets/contract.ts'
import { useAssetMeta } from '../../assets/meta-store.ts'
import {
  type CanvasElement,
  type CanvasFeatureContext,
  geometry,
  type LobbyCanvas,
} from '../../canvas/api/index.ts'
import { useUserKind } from '../../invite/guest.tsx'
import { extensionLabel, formatBytes, formatDuration, pluralize } from '../../lib/format.ts'
import { useValue } from '../../lib/signals.ts'
import { coverDerivative, stripPages } from '../card-model.ts'
import '../file-card.css'
import { CONVERSION_DETAIL, CONVERSION_NOTE, cardOfficeFormat, isConvertedPreview } from '../office.ts'
import { previewPages } from '../pdf-pages.ts'
import { downloadsAllowed } from './downloads.ts'
import './media.css'
import { mediaMetaStore } from './meta.ts'
import { type CardView, cardDescriptor, cardViewOf, type FileFacts, factsOf, fileItemKind } from './model.ts'
import { openPdfViewer } from './viewer-state.ts'

const STRIP_MAX = 4
/**
 * Whether an element painted above a card hides that part of it, so it cuts a hole in the card's face:
 * notes, images (and other cards) and shapes with a solid fill. Frames never do (their children are
 * drawn over them); strokes, texts and unfilled shapes over a card stay under its face.
 */
function opaque(el: CanvasElement): boolean {
  if (el.type === 'stickynote' || el.type === 'image') return true
  if (el.type !== 'rectangle' && el.type !== 'ellipse' && el.type !== 'diamond') return false
  const e = el as { backgroundColor?: string; fillStyle?: string; opacity?: number }
  return e.backgroundColor !== 'transparent' && e.fillStyle === 'solid' && (e.opacity ?? 100) >= 100
}

interface Box {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

interface Entry {
  readonly id: string
  readonly kind: 'card' | 'pending'
  readonly facts: FileFacts
  /** the element box in scene units, and its rotation */
  readonly box: Box
  readonly angle: number
  /** holes (element-local scene units) cut by elements painted above it */
  readonly holes: readonly Box[]
  /** the loader's state (placeholders) */
  readonly state: 'loading' | 'failed' | null
}

const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** An element's axis-aligned box from its own fields (rotation included; cheap: no engine call). */
function aabbOf(el: CanvasElement): Box {
  const r = { x: el.x, y: el.y, width: el.width, height: el.height }
  if (!el.angle) return { x: r.x, y: r.y, w: r.width, h: r.height }
  const pts = geometry.corners(r, el.angle)
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

function holesAbove(canvas: LobbyCanvas, items: readonly CanvasElement[], index: number, box: Box): Box[] {
  const out: Box[] = []
  for (let i = index + 1; i < items.length; i++) {
    const el = items[i] as CanvasElement
    if (!opaque(el)) continue
    const r = aabbOf(el)
    if (!overlap(r, box) || canvas.isHidden(el.id)) continue
    const x1 = Math.max(0, r.x - box.x)
    const y1 = Math.max(0, r.y - box.y)
    const x2 = Math.min(box.w, r.x + r.w - box.x)
    const y2 = Math.min(box.h, r.y + r.h - box.y)
    if (x2 > x1 && y2 > y1) out.push({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 })
  }
  return out
}

/** The entries to draw, in paint order (reactive: items, loader states, hidden ids). */
function entriesOf(canvas: LobbyCanvas): Entry[] {
  const items = canvas.items()
  const out: Entry[] = []
  items.forEach((el, index) => {
    const kind = fileItemKind(el)
    if (!kind || canvas.isHidden(el.id)) return
    const facts = factsOf(el) as FileFacts
    const box = { x: el.x, y: el.y, w: el.width, h: el.height }
    if (kind === 'card') {
      const holes = el.angle ? [] : holesAbove(canvas, items, index, box)
      out.push({ id: el.id, kind: 'card', facts, box, angle: el.angle ?? 0, holes, state: null })
      return
    }
    const st = canvas.files.status(el.id)
    if (st === 'loaded') return
    const holes = el.angle ? [] : holesAbove(canvas, items, index, box)
    out.push({
      id: el.id,
      kind: 'pending',
      facts,
      box,
      angle: el.angle ?? 0,
      holes,
      state: st === 'failed' ? 'failed' : 'loading',
    })
  })
  return out
}

const clipPath = (e: Entry): string | undefined => {
  if (!e.holes.length) return undefined
  const r = (b: Box) => `M${b.x} ${b.y}H${b.x + b.w}V${b.y + b.h}H${b.x}Z`
  return `path(evenodd, "${r({ x: 0, y: 0, w: e.box.w, h: e.box.h })} ${e.holes.map(r).join(' ')}")`
}

/** The scene-layer overlay of the media feature. */
export function MediaSceneLayer({ ctx }: { ctx: CanvasFeatureContext }) {
  const canvas = ctx.canvas
  // what to draw follows the elements and the loader; where, the camera (a pan re-renders the faces
  // without recomputing them)
  const entries = useValue('media-faces', () => entriesOf(canvas), [canvas])
  const zoom = useValue('media-faces-zoom', () => canvas.viewport.get().zoom, [canvas])
  useValue('media-faces-view', () => canvas.viewport.get(), [canvas])
  return (
    <>
      {entries.map((e) => {
        const c = canvas.sceneToOverlay({ x: e.box.x + e.box.w / 2, y: e.box.y + e.box.h / 2 })
        const style = {
          position: 'absolute' as const,
          left: c.x - e.box.w / 2,
          top: c.y - e.box.h / 2,
          width: e.box.w,
          height: e.box.h,
          transform: `scale(${zoom})${e.angle ? ` rotate(${e.angle}rad)` : ''}`,
          transformOrigin: 'center',
          clipPath: clipPath(e),
        }
        return e.kind === 'card' ? (
          <CardFace key={e.id} ctx={ctx} id={e.id} facts={e.facts} style={style} />
        ) : (
          <PendingTile key={e.id} ctx={ctx} id={e.id} facts={e.facts} state={e.state} style={style} />
        )
      })}
    </>
  )
}

type FaceStyle = CSSProperties

// ---- images and placed pages that are not on the canvas yet ------------------------------------------------

function PendingTile({
  ctx,
  id,
  facts,
  state,
  style,
}: {
  ctx: CanvasFeatureContext
  id: string
  facts: FileFacts
  state: Entry['state']
  style: FaceStyle
}) {
  const snap = useAssetMeta(mediaMetaStore, ctx.board.id, facts.assetId, facts.versionId)
  // the worker refused it (or the version is gone): the loader will never get a preview
  const unavailable = state === 'failed' || snap.missing || snap.meta?.status === 'failed'
  return (
    <div
      className="lobby-pending"
      data-testid="image-placeholder"
      data-lobby-image-placeholder={id}
      data-state={unavailable ? 'unavailable' : 'processing'}
      style={style}
    >
      {unavailable ? (
        <>
          <strong>Couldn't process this image</strong>
          <span>Select it to download the original</span>
        </>
      ) : (
        <>
          <strong>Processing…</strong>
          <span className="lobby-pending__name">{facts.name || 'Image'}</span>
        </>
      )}
    </div>
  )
}

// ---- file cards (file-card/FileCardView.tsx) ---------------------------------------------------------------

function CardFace({
  ctx,
  id,
  facts,
  style,
}: {
  ctx: CanvasFeatureContext
  id: string
  facts: FileFacts
  style: FaceStyle
}) {
  const boardId = ctx.board.id
  const snap = useAssetMeta(mediaMetaStore, boardId, facts.assetId, facts.versionId)
  const view = cardViewOf(facts, snap)
  const cover = coverDerivative(snap.meta)
  const coverSrc = cover ? derivativeUrl(boardId, facts.assetId, facts.versionId, cover.id) : null
  const original = snap.missing ? null : originalUrl(boardId, facts.assetId, facts.versionId)
  const pages = stripPages(snap.meta)
  // Office documents are previewed through their PDF conversion (office.ts): say so on the card.
  const office = cardOfficeFormat(snap.meta, facts)
  const converted = isConvertedPreview(snap.meta)
  // export-control: no Download while the board owner turned downloads off for this person (the api
  // refuses the original anyway). Previews, pages and video playback keep working.
  const kind = useUserKind()
  const guest = kind === null ? null : kind === 'guest'
  const canDownload = useValue('media-card-download', () => downloadsAllowed(ctx, guest), [ctx, guest])
  const hasPages = previewPages(snap.meta).length > 0

  return (
    <figure
      className="lobby-fc dr-fc"
      data-testid="file-card"
      data-lobby-card={id}
      data-status={view.status}
      data-kind={view.kind}
      data-office={office?.ext}
      data-meta={snap.missing ? 'missing' : snap.meta ? 'loaded' : 'pending'}
      aria-label={`${view.name}, ${statusText(view)}`}
      aria-description={cardDescriptor(view, office?.label ?? null)}
      style={style}
    >
      {(view.kind !== 'other' || view.status === 'failed') && (
        <div className="dr-fc__preview">
          <Preview
            view={view}
            coverSrc={coverSrc}
            original={original}
            canDownload={canDownload}
            onViewPages={view.kind === 'pdf' && hasPages ? () => openPdfViewer(ctx.registries, id) : null}
          />
        </div>
      )}
      {view.kind === 'pdf' && pages.length > 0 && (
        <div className="dr-fc__strip" data-testid="file-card-strip" aria-hidden="true">
          {pages.slice(0, STRIP_MAX).map((d) => (
            <img
              key={d.id}
              src={derivativeUrl(boardId, facts.assetId, facts.versionId, d.id)}
              alt=""
              decoding="async"
              draggable={false}
            />
          ))}
          {pages.length > STRIP_MAX && <span className="dr-fc__more">+{pages.length - STRIP_MAX}</span>}
        </div>
      )}
      {converted && !snap.missing && <ConversionNote />}
      <Footer view={view} original={canDownload ? original : null} />
    </figure>
  )
}

function Preview({
  view,
  coverSrc,
  original,
  canDownload,
  onViewPages,
}: {
  view: CardView
  coverSrc: string | null
  original: string | null
  /** false: the board owner turned downloads off for this person (the player offers none either). */
  canDownload: boolean
  /** Opens the PDF page viewer (null: no page previews to show). */
  onViewPages: (() => void) | null
}) {
  const [playing, setPlaying] = useState(false)
  // F5: a touch or pen tap opens the viewer on pointerup; the click that some browsers still send after
  // it is then ignored.
  const tappedAt = useRef(0)
  const pressed = useRef<number | null>(null)
  const onViewPagesDown = (e: PointerEvent) => {
    pressed.current = e.pointerId
  }
  const onViewPagesUp = (e: PointerEvent) => {
    const tap = pressed.current === e.pointerId
    pressed.current = null
    if (!onViewPages || !tap || e.pointerType === 'mouse' || e.button !== 0) return
    tappedAt.current = Date.now()
    onViewPages()
  }
  const onViewPagesClick = () => {
    if (Date.now() - tappedAt.current < 800) return
    onViewPages?.()
  }

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
    const pending = !view.missing && (view.status === 'queued' || view.status === 'processing')
    return (
      <div className="dr-fc__state" data-pending={pending || undefined}>
        <span className="dr-fc__badge-kind" aria-hidden="true">
          {extensionLabel(view.name, view.kind)}
        </span>
        <p>
          {view.missing
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
          onPointerDown={onViewPagesDown}
          onPointerUp={onViewPagesUp}
          onClick={onViewPagesClick}
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

function Footer({ view, original }: { view: CardView; original: string | null }) {
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
          <span className={`dr-fc__status dr-fc__status--${view.missing ? 'missing' : view.status}`}>
            {statusText(view)}
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

function statusText(view: CardView): string {
  if (view.missing) return 'Unavailable'
  switch (view.status) {
    case 'loading':
      return 'Loading'
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
