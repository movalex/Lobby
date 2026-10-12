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
//
// Wave N (WS7, N7-1/N7-2): board cards too (a link-card rectangle of kind 'board-card' whose `link` is a
// Lobby-relative board path): features/board-links/BoardCardFace.tsx draws the target's face (title, frame name,
// thumbnail) when this viewer can open it, else the neutral face. Link and board cards are found through the scene
// index by their kind (`canvas.index.byKind`), so a board with none of them asks nothing of each element for them.
import { BOARD_CARD_KIND } from '@draftroom/contracts'
import { type CSSProperties, type PointerEvent, useEffect, useRef, useState } from 'react'
import { derivativeUrl, originalUrl } from '../../assets/contract.ts'
import { useAssetMeta } from '../../assets/meta-store.ts'
import {
  type CanvasElement,
  type CanvasFeatureContext,
  type LobbyCanvas,
  paintOrderMemo,
} from '../../canvas/api/index.ts'
import { BoardCardFace } from '../../features/board-links/BoardCardFace.tsx'
import { boardCardOf } from '../../features/board-links/model.ts'
import { useUserKind } from '../../invite/guest.tsx'
import { extensionLabel, formatBytes, formatDuration, pluralize } from '../../lib/format.ts'
import { useValue } from '../../lib/signals.ts'
import { coverDerivative, stripPages } from '../card-model.ts'
import '../file-card.css'
import { CONVERSION_DETAIL, CONVERSION_NOTE, cardOfficeFormat, isConvertedPreview } from '../office.ts'
import { previewPages } from '../pdf-pages.ts'
import { downloadsAllowed } from './downloads.ts'
import { LINK_CARD_KIND, LinkFace, linkOf, titleOf } from './link-cards.tsx'
import { localPreviewsOf, PREVIEW_GRACE_MS } from './local-previews.ts'
import './media.css'
import { mediaMetaStore } from './meta.ts'
import {
  type CardView,
  cardDescriptor,
  cardViewOf,
  cornerRadiusOf,
  type FileFacts,
  factsOf,
  fileItemKind,
} from './model.ts'
import { type Box, Occluders } from './occluders.ts'
import { openPdfViewer } from './viewer-state.ts'

const STRIP_MAX = 4

interface Entry {
  readonly id: string
  readonly kind: 'card' | 'pending' | 'link' | 'board'
  /** a file element's facts (a link card has none) */
  readonly facts: FileFacts
  /** a link card's URL and title (D2) */
  readonly link?: { readonly url: string; readonly title: string }
  /** N7-1: a board card's stored path and its board-cards target */
  readonly board?: { readonly path: string; readonly target: string }
  /** the element box in scene units, and its rotation */
  readonly box: Box
  readonly angle: number
  /** holes (element-local scene units) cut by elements painted above it */
  readonly holes: readonly Box[]
  /** the loader's state (placeholders) */
  readonly state: 'loading' | 'failed' | null
  /**
   * W5-36: the face's corner radius (scene units): the element's own once the engine draws its bitmap
   * (Excalidraw clips a loaded image to its roundness), else 0 (its pending placeholder is square)
   */
  readonly radius: number
}

const NO_FACTS = {
  assetId: '',
  versionId: '',
  kind: 'other',
  name: '',
  mimeType: '',
  sizeBytes: 0,
} as const satisfies FileFacts

/**
 * N7-1: the ids of the link and board cards, from the scene index (by kind), or null when the canvas has no index
 * (then every element's kind is read as before).
 */
function cardIdsOf(canvas: LobbyCanvas): ReadonlySet<string> | null {
  const index = (canvas as Partial<LobbyCanvas>).index
  if (!index) return null
  try {
    const ids = new Set<string>()
    for (const kind of [LINK_CARD_KIND, BOARD_CARD_KIND])
      for (const el of index.byKind(kind)) ids.add((el as CanvasElement).id)
    return ids
  } catch {
    return null
  }
}

/** Wave N.1: per canvas, the merge of its face candidates (memoized while the index's answers stand). */
const candidateMemos = new WeakMap<object, ReturnType<typeof paintOrderMemo>>()
/** Wave N.1: each element's place in a scene array (its paint order), per array */
const places = new WeakMap<readonly CanvasElement[], ReadonlyMap<string, number>>()
const placeOf = (all: readonly CanvasElement[]): ReadonlyMap<string, number> => {
  let m = places.get(all)
  if (!m) {
    const built = new Map<string, number>()
    for (let i = 0; i < all.length; i++) built.set((all[i] as CanvasElement).id, i)
    places.set(all, built)
    m = built
  }
  return m
}

/** The entries to draw, in paint order (reactive: items, loader states, hidden ids). */
function entriesOf(canvas: LobbyCanvas): Entry[] {
  // wave N.1: the elements that can have a face (link and board cards by kind, files by their `file` key), from the
  // scene index in paint order, instead of every element of the scene on every change (a drag's every move); the whole
  // scene only when a face needs the holes the opaque elements above it cut. A canvas with no index (a test's): every
  // element, as before
  const sceneIndex = (canvas as Partial<LobbyCanvas>).index
  let memo = sceneIndex ? candidateMemos.get(canvas) : undefined
  if (sceneIndex && !memo) {
    memo = paintOrderMemo()
    candidateMemos.set(canvas, memo)
  }
  const items =
    sceneIndex && memo
      ? memo([
          sceneIndex.byKind(LINK_CARD_KIND),
          sceneIndex.byKind(BOARD_CARD_KIND),
          sceneIndex.withLobbyKey('file'),
        ])
      : canvas.items()
  const out: Entry[] = []
  const editing = canvas.editingId()
  const cardIds = cardIdsOf(canvas)
  // K1-8: the opaque elements in a grid, built once per pass and only when a card needs its holes
  let grid: Occluders | null = null
  // (with the index: each candidate's place among all the scene's elements, which the grid's paint order is)
  let place: ReadonlyMap<string, number> | null = null
  const holesAbove = (el: CanvasElement, at: number, box: Box) => {
    if (!grid) {
      const all = sceneIndex ? canvas.items() : items
      grid = new Occluders(all, (id) => canvas.isHidden(id))
      if (sceneIndex) place = placeOf(all)
    }
    return grid.holesAbove(place ? (place.get(el.id) ?? at) : at, box)
  }
  // a card whose words are being edited shows its plain canvas face (and the editor) meanwhile
  const editedNow = (el: CanvasElement) =>
    !!editing &&
    (editing === el.id ||
      ((el as { boundElements?: readonly { id: string }[] | null }).boundElements ?? []).some(
        (b) => b.id === editing,
      ))
  items.forEach((el, index) => {
    const aCard = cardIds === null || cardIds.has(el.id)
    // N7-1: a board card (its kind, and a Lobby-relative board path)
    const card = aCard && el.type === 'rectangle' ? boardCardOf(el as never) : null
    const board = card ? { path: card.path, target: card.target } : null
    if (board) {
      if (editedNow(el) || canvas.isHidden(el.id)) return
      const box = { x: el.x, y: el.y, w: el.width, h: el.height }
      out.push({
        id: el.id,
        kind: 'board',
        facts: NO_FACTS,
        board,
        box,
        angle: el.angle ?? 0,
        holes: el.angle ? [] : holesAbove(el, index, box),
        state: null,
        radius: cornerRadiusOf(el as never),
      })
      return
    }
    const url = aCard ? linkOf(el as never) : null
    const edited = editedNow(el)
    if (url && !edited && !canvas.isHidden(el.id)) {
      const box = { x: el.x, y: el.y, w: el.width, h: el.height }
      out.push({
        id: el.id,
        kind: 'link',
        facts: NO_FACTS,
        link: { url, title: titleOf(canvas.text.of(el.id), url) },
        box,
        angle: el.angle ?? 0,
        holes: el.angle ? [] : holesAbove(el, index, box),
        state: null,
        // the rectangle under it is drawn with its own rounded corners
        radius: cornerRadiusOf(el as never),
      })
      return
    }
    if (url) return
    const kind = fileItemKind(el)
    if (!kind || canvas.isHidden(el.id)) return
    const facts = factsOf(el) as FileFacts
    const box = { x: el.x, y: el.y, w: el.width, h: el.height }
    if (kind === 'card') {
      const holes = el.angle ? [] : holesAbove(el, index, box)
      const radius = canvas.files.status(el.id) === 'loaded' ? cornerRadiusOf(el as never) : 0
      out.push({ id: el.id, kind: 'card', facts, box, angle: el.angle ?? 0, holes, state: null, radius })
      return
    }
    const st = canvas.files.status(el.id)
    if (st === 'loaded') return
    const holes = el.angle ? [] : holesAbove(el, index, box)
    out.push({
      id: el.id,
      kind: 'pending',
      facts,
      box,
      angle: el.angle ?? 0,
      holes,
      state: st === 'failed' ? 'failed' : 'loading',
      radius: 0,
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
  const previews = localPreviewsOf(ctx.registries)
  const ghosts = useValue(previews.ghosts)
  // W5-56: a local preview is kept while an element of its version still waits for the loader
  const waiting = entries.filter((e) => e.kind === 'pending' && e.state === 'loading')
  const needed = waiting.map((e) => e.facts.versionId).join(' ')
  useEffect(() => {
    const keep = new Set(needed ? needed.split(' ') : [])
    previews.sweep(keep)
    const t = setInterval(() => previews.sweep(keep), PREVIEW_GRACE_MS)
    return () => clearInterval(t)
  }, [previews, needed])
  return (
    <>
      {ghosts.map((g) => {
        const c = canvas.sceneToOverlay({ x: g.rect.x + g.rect.w / 2, y: g.rect.y + g.rect.h / 2 })
        return (
          <div
            key={g.key}
            className="lobby-ghost"
            data-testid="upload-ghost"
            data-lobby-upload-ghost={g.key}
            style={{
              position: 'absolute',
              left: c.x - g.rect.w / 2,
              top: c.y - g.rect.h / 2,
              width: g.rect.w,
              height: g.rect.h,
              transform: `scale(${zoom})`,
              transformOrigin: 'center',
            }}
          >
            <img src={g.url} alt="" decoding="async" draggable={false} />
            <span className="lobby-ghost__chip">Uploading…</span>
            <span className="dr-sr-only">{g.name}</span>
          </div>
        )
      })}
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
          ['--lobby-face-radius' as string]: `${e.radius}px`,
        } as CSSProperties
        if (e.kind === 'link' && e.link)
          return (
            <LinkFace key={e.id} ctx={ctx} id={e.id} url={e.link.url} title={e.link.title} style={style} />
          )
        if (e.kind === 'board' && e.board)
          return (
            <BoardCardFace
              key={e.id}
              ctx={ctx}
              id={e.id}
              path={e.board.path}
              target={e.board.target}
              style={style}
            />
          )
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
  // W5-56: the tab that uploaded it shows its own copy meanwhile (never stored, never synced)
  const previews = localPreviewsOf(ctx.registries)
  const local = useValue('media-local-preview', () => previews.urlOf(facts.versionId), [
    previews,
    facts.versionId,
  ])
  const preview = !unavailable && local ? local : null
  return (
    <div
      className="lobby-pending"
      data-testid="image-placeholder"
      data-lobby-image-placeholder={id}
      data-state={unavailable ? 'unavailable' : 'processing'}
      data-local-preview={preview ? '' : undefined}
      style={style}
    >
      {preview && (
        <img className="lobby-pending__local" src={preview} alt="" decoding="async" draggable={false} />
      )}
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

/** How long after a tap opened the viewer its click is still taken for that tap's own. */
const TAP_CLICK_MS = 800

/**
 * F5: the click a browser makes from a touch or pen tap arrives after the pointerup that already opened the
 * PDF viewer, at the same point, so it would land on whatever the viewer now puts under the finger (a page
 * thumbnail, which turned the viewer to that page, or Prev/Next or Close). Swallow that one click: the next
 * click within TAP_CLICK_MS, and only near the tap point.
 */
function swallowTapClick(x: number, y: number): void {
  const until = Date.now() + TAP_CLICK_MS
  const stop = (e: MouseEvent) => {
    window.removeEventListener('click', stop, true)
    if (Date.now() > until || Math.abs(e.clientX - x) > 16 || Math.abs(e.clientY - y) > 16) return
    e.preventDefault()
    e.stopPropagation()
  }
  window.addEventListener('click', stop, true)
  window.setTimeout(() => window.removeEventListener('click', stop, true), TAP_CLICK_MS)
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
  // it is then ignored, on this button and on the viewer that is now under the finger.
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
    swallowTapClick(e.clientX, e.clientY)
    onViewPages()
  }
  const onViewPagesClick = () => {
    if (Date.now() - tappedAt.current < TAP_CLICK_MS) return
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
