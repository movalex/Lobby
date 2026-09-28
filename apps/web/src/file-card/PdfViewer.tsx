// The PDF page viewer (FIL-04, review F7b): a modal over the board with the page previews the worker
// made (cover + the eagerly rendered pages), page N of M, zoom, keyboard navigation, an honest note
// when only the first pages have previews, "Download original", and "Place on board" for the
// selected pages. Opened from a PDF card's "View pages" button; rendered once per board as a child
// of <Tldraw> (outside the canvas, so its events never reach the canvas).
import { FILE_CARD_TYPE, type FileCardShape } from '@draftroom/canvas-schema'
import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { type Editor, useEditor, useValue } from 'tldraw'
import { derivativeUrl, originalUrl } from '../assets/contract.ts'
import { useAssetMeta } from '../assets/meta-store.ts'
import { type BoardContextValue, useBoard } from '../board/board-context.ts'
import { pluralize } from '../lib/format.ts'
import {
  documentPageCount,
  type PreviewPage,
  previewPages,
  stepPage,
  toggleSelection,
  VIEWER_ZOOM_STEPS,
  validPage,
  viewerPageSize,
  zoomLabel,
  zoomStep,
} from './pdf-pages.ts'
import './pdf-viewer.css'
import { placePdfPages } from './place-pages.ts'
import { closePdfViewer, pdfViewerRequest } from './viewer-state.ts'

const MAX_ZOOM = Math.max(...VIEWER_ZOOM_STEPS)

/** Mounted once per board (board/ExternalContent.tsx): shows the viewer a card asked for. */
export function PdfViewerHost() {
  const editor = useEditor()
  const board = useBoard()
  const request = useValue('dr-pdf-viewer-request', () => pdfViewerRequest(editor).get(), [editor])
  const card = useValue('dr-pdf-viewer-card', () => {
    if (!request) return null
    const s = editor.getShape(request.shapeId)
    return s && s.type === FILE_CARD_TYPE ? (s as FileCardShape) : null
  }, [editor, request])
  // The card was deleted (here or by someone else) while its viewer was open.
  useEffect(() => {
    if (request && !card) closePdfViewer(editor)
  }, [editor, request, card])
  if (!board || !request || !card) return null
  return (
    <PdfViewer
      key={request.nonce}
      editor={editor}
      board={board}
      card={card}
      initialPage={request.page}
      onClose={() => closePdfViewer(editor)}
    />
  )
}

interface ViewerProps {
  editor: Editor
  board: BoardContextValue
  card: FileCardShape
  initialPage: number
  onClose(): void
}

function PdfViewer({ editor, board, card, initialPage, onClose }: ViewerProps) {
  const { assetId, versionId } = card.props
  const snap = useAssetMeta(board.metaStore, board.boardId, assetId, versionId)
  const pages = useMemo(() => previewPages(snap.meta), [snap.meta])
  const available = useMemo(() => pages.map((p) => p.page), [pages])
  const total = documentPageCount(snap.meta, card.props, pages.length)
  const name = snap.meta?.name || card.props.name
  const readonly = useValue('dr-pdf-viewer-readonly', () => editor.getIsReadonly(), [editor])

  const [wanted, setWanted] = useState(initialPage)
  const current = validPage(available, wanted)
  const page = pages.find((p) => p.page === current) ?? null
  const [zoom, setZoom] = useState(1)
  const [selected, setSelected] = useState<number[]>([])
  const anchor = useRef<number | null>(null)
  const placed = useRef(false)
  const rail = useRef<HTMLElement>(null)

  // Keep the current page's thumbnail in view while the keys turn pages.
  useEffect(() => {
    rail.current
      ?.querySelector(`[data-testid="pdf-viewer-thumb"][data-page="${current}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [current])

  const go = useCallback(
    (p: number) => {
      setWanted(validPage(available, p))
    },
    [available],
  )
  const step = useCallback(
    (delta: number) => setWanted((w) => stepPage(available, validPage(available, w), delta)),
    [available],
  )

  const place = () => {
    const chosen = pages.filter((p) => selected.includes(p.page))
    const ids = placePdfPages(editor, card, chosen)
    if (!ids.length) {
      board.notify({
        key: 'pdf-pages-place',
        text: readonly ? 'You can view this board but not add to it.' : 'Those pages could not be placed.',
        tone: 'error',
      })
      return
    }
    placed.current = true
    board.notify({
      key: 'pdf-pages-place',
      text: `Placed ${pluralize(ids.length, 'page')} of ${name} next to it.`,
      testId: 'pdf-pages-placed',
      timeoutMs: 4000,
    })
    onClose()
  }

  const titleId = useId()
  const descId = useId()
  const counterId = useId()
  const partial = total > pages.length
  const selectedText = selected.length
    ? `${pluralize(selected.length, 'page')} selected`
    : 'Select pages to place them on the board'

  const onKeyDown = (e: KeyboardEvent) => {
    const t = e.target
    if (e.altKey || e.metaKey || e.ctrlKey || e.defaultPrevented) return
    if (t instanceof HTMLInputElement && t.type !== 'checkbox') return
    let handled = true
    switch (e.key) {
      case 'ArrowRight':
      case 'PageDown':
        step(1)
        break
      case 'ArrowLeft':
      case 'PageUp':
        step(-1)
        break
      case 'Home':
        step(-Number.MAX_SAFE_INTEGER)
        break
      case 'End':
        step(Number.MAX_SAFE_INTEGER)
        break
      case '+':
      case '=':
        setZoom((z) => zoomStep(z, 1))
        break
      case '-':
        setZoom((z) => zoomStep(z, -1))
        break
      case '0':
        setZoom(1)
        break
      default:
        handled = false
    }
    if (handled) e.preventDefault()
  }

  return (
    <ModalDialog
      className="dr-pv"
      testId="pdf-viewer"
      labelledBy={titleId}
      describedBy={descId}
      onClose={onClose}
      onKeyDown={onKeyDown}
      afterClose={() => {
        // After placing, the board takes the keys (Delete, arrows) for the new selection.
        if (placed.current) {
          editor.focus()
          editor.getContainer().focus({ preventScroll: true })
          return true
        }
        return false
      }}
    >
      <header className="dr-pv__head">
        <div className="dr-pv__titles">
          <h2 id={titleId} className="dr-pv__title" data-testid="pdf-viewer-title">
            {name}
          </h2>
          <p id={descId} className="dr-pv__desc">
            PDF · {pluralize(total, 'page')}
            {partial ? ` · previews of the first ${pluralize(pages.length, 'page')}` : ''} · ← → to turn pages
          </p>
        </div>
        <div className="dr-pv__head-actions">
          {!snap.missing && (
            <a
              className="dr-btn dr-btn--sm"
              data-testid="pdf-viewer-download"
              href={originalUrl(board.boardId, assetId, versionId)}
              download={name}
            >
              Download original
            </a>
          )}
          <button
            type="button"
            className="dr-iconbtn"
            aria-label="Close"
            data-testid="pdf-viewer-close"
            onClick={onClose}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </header>

      <div className="dr-pv__body">
        <nav ref={rail} className="dr-pv__rail" aria-label="Pages">
          <ol>
            {pages.map((p) => (
              <li key={p.page} className="dr-pv__item" data-selected={selected.includes(p.page) || undefined}>
                <button
                  type="button"
                  className="dr-pv__thumb"
                  data-testid="pdf-viewer-thumb"
                  data-page={p.page}
                  aria-label={`Page ${p.page}`}
                  aria-current={p.page === current ? 'page' : undefined}
                  onClick={() => go(p.page)}
                >
                  <img
                    src={derivativeUrl(board.boardId, assetId, versionId, p.thumb.id)}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    draggable={false}
                  />
                </button>
                <label className="dr-pv__check">
                  <input
                    type="checkbox"
                    data-testid="pdf-viewer-select"
                    data-page={p.page}
                    checked={selected.includes(p.page)}
                    aria-label={`Select page ${p.page}`}
                    onChange={() => {}}
                    onClick={(e) => {
                      // Read now: the updater runs after the anchor below has moved on.
                      const opts = { range: e.shiftKey, anchor: anchor.current }
                      setSelected((s) => toggleSelection(s, p.page, available, opts))
                      anchor.current = p.page
                    }}
                  />
                  <span className="dr-pv__num">{p.page}</span>
                </label>
              </li>
            ))}
            {partial && (
              <li className="dr-pv__rest" data-testid="pdf-viewer-rest">
                +{pluralize(total - pages.length, 'more page')}
              </li>
            )}
          </ol>
        </nav>

        <section className="dr-pv__main" aria-labelledby={counterId}>
          <div className="dr-pv__bar">
            <button
              type="button"
              className="dr-iconbtn"
              data-testid="pdf-viewer-prev"
              aria-label="Previous page"
              aria-disabled={current === available[0]}
              onClick={() => step(-1)}
            >
              <Chevron dir="left" />
            </button>
            <span
              id={counterId}
              className="dr-pv__counter"
              data-testid="pdf-viewer-counter"
              aria-live="polite"
            >
              Page {current} of {total}
            </span>
            <button
              type="button"
              className="dr-iconbtn"
              data-testid="pdf-viewer-next"
              aria-label="Next page"
              aria-disabled={current === available[available.length - 1]}
              onClick={() => step(1)}
            >
              <Chevron dir="right" />
            </button>
            <span className="dr-pv__spacer" />
            <button
              type="button"
              className="dr-iconbtn"
              data-testid="pdf-viewer-zoom-out"
              aria-label="Zoom out"
              aria-disabled={zoom <= 1}
              onClick={() => setZoom((z) => zoomStep(z, -1))}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <path d="M6 12h12" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              </svg>
            </button>
            <output className="dr-pv__zoom" data-testid="pdf-viewer-zoom-level" aria-label="Zoom">
              {zoomLabel(zoom)}
            </output>
            <button
              type="button"
              className="dr-iconbtn"
              data-testid="pdf-viewer-zoom-in"
              aria-label="Zoom in"
              aria-disabled={zoom >= MAX_ZOOM}
              onClick={() => setZoom((z) => zoomStep(z, 1))}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <path d="M6 12h12M12 6v12" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              </svg>
            </button>
            <button
              type="button"
              className="dr-btn dr-btn--sm dr-btn--ghost"
              data-testid="pdf-viewer-zoom-fit"
              aria-disabled={zoom === 1}
              onClick={() => setZoom(1)}
            >
              Fit
            </button>
          </div>
          <Stage
            page={page}
            src={page ? derivativeUrl(board.boardId, assetId, versionId, page.full.id) : null}
            alt={`Page ${current} of ${name}`}
            zoom={zoom}
            onZoom={setZoom}
            state={snap.missing ? 'missing' : snap.meta?.status === 'ready' ? 'ready' : 'loading'}
          />
          {partial && (
            <p className="dr-pv__note" data-testid="pdf-viewer-partial-note" role="note">
              Previews exist for the first {pluralize(pages.length, 'page')} of {total}. Download the original
              to read the rest.
            </p>
          )}
        </section>
      </div>

      <footer className="dr-pv__foot">
        <span className="dr-pv__selection" data-testid="pdf-viewer-selection" aria-live="polite">
          {selectedText}
        </span>
        <button
          type="button"
          className="dr-btn dr-btn--sm dr-btn--ghost"
          data-testid="pdf-viewer-select-all"
          onClick={() => setSelected(selected.length === available.length ? [] : [...available])}
          disabled={!available.length}
        >
          {selected.length === available.length && available.length ? 'Clear selection' : 'Select all'}
        </button>
        <span className="dr-pv__spacer" />
        {readonly && (
          <span className="dr-pv__hint" data-testid="pdf-viewer-readonly">
            You can view this board but not add to it.
          </span>
        )}
        <button
          type="button"
          className="dr-btn dr-btn--primary dr-btn--sm"
          data-testid="pdf-viewer-place"
          disabled={readonly || !selected.length}
          onClick={place}
        >
          Place on board
        </button>
      </footer>
    </ModalDialog>
  )
}

const Chevron = ({ dir }: { dir: 'left' | 'right' }) => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
    <path
      d={dir === 'left' ? 'M14.5 6l-6 6 6 6' : 'M9.5 6l6 6-6 6'}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

/**
 * The page itself: contain-fitted at zoom 1, bigger (scrollable, drag to pan) when zoomed.
 * Ctrl/Cmd + wheel zooms. The element stays mounted across pages (it usually has the focus, and a
 * removed focused element would hand the keys to the board); a new page scrolls back to the top.
 */
function Stage({
  page,
  src,
  alt,
  zoom,
  onZoom,
  state,
}: {
  page: PreviewPage | null
  src: string | null
  alt: string
  zoom: number
  onZoom(update: (z: number) => number): void
  state: 'ready' | 'loading' | 'missing'
}) {
  const ref = useRef<HTMLElement>(null)
  const [stage, setStage] = useState({ w: 0, h: 0 })
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null)
  const loaded = src !== null && loadedSrc === src
  const drag = useRef<{ x: number; y: number; left: number; top: number; id: number } | null>(null)

  const pageNumber = page?.page ?? 0
  useLayoutEffect(() => {
    ref.current?.scrollTo({ left: 0, top: 0 })
  }, [pageNumber])

  // The border box: scrollbars appearing when zoomed in must not shrink "fit" (and so the zoom).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setStage({ w: el.offsetWidth, h: el.offsetHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el, { box: 'border-box' })
    return () => ro.disconnect()
  }, [])

  // Ctrl/Cmd + wheel (and trackpad pinch) zooms the page, not the browser.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      onZoom((z) => zoomStepFor(z, e.deltaY))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onZoom])

  const pad = 2 * STAGE_PADDING_PX
  const size = page
    ? viewerPageSize(
        { w: page.full.width, h: page.full.height },
        { w: Math.max(0, stage.w - pad), h: Math.max(0, stage.h - pad) },
        zoom,
      )
    : { w: 0, h: 0 }

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    const el = ref.current
    if (!el || zoom <= 1 || e.button !== 0) return
    drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop, id: e.pointerId }
    el.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const el = ref.current
    const d = drag.current
    if (!el || !d || d.id !== e.pointerId) return
    el.scrollLeft = d.left - (e.clientX - d.x)
    el.scrollTop = d.top - (e.clientY - d.y)
  }
  const endDrag = (e: ReactPointerEvent<HTMLElement>) => {
    if (drag.current?.id === e.pointerId) drag.current = null
  }

  return (
    <section
      ref={ref}
      className="dr-pv__stage"
      data-testid="pdf-viewer-stage"
      data-zoomed={zoom > 1 || undefined}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be focusable to scroll it by keyboard
      tabIndex={0}
      aria-label={alt}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {src && page ? (
        <img
          key={src}
          className="dr-pv__page"
          data-testid="pdf-viewer-page"
          data-page={page.page}
          data-loaded={loaded || undefined}
          src={src}
          alt={alt}
          width={Math.round(size.w) || undefined}
          height={Math.round(size.h) || undefined}
          style={size.w ? { width: size.w, height: size.h } : undefined}
          draggable={false}
          onLoad={() => setLoadedSrc(src)}
        />
      ) : (
        <p className="dr-pv__empty">
          {state === 'missing'
            ? 'This file is not available on this board.'
            : state === 'loading'
              ? 'Loading page previews…'
              : 'This PDF has no page previews. Download the original to read it.'}
        </p>
      )}
      {src && !loaded && <span className="dr-spinner dr-pv__spinner" aria-hidden="true" />}
    </section>
  )
}

const zoomStepFor = (z: number, deltaY: number) => (deltaY < 0 ? zoomStep(z, 1) : zoomStep(z, -1))

/** `.dr-pv__stage` padding in pdf-viewer.css. */
const STAGE_PADDING_PX = 12

/** Backdrop clicks this soon after opening are the tail of the click that opened the viewer. */
const BACKDROP_GRACE_MS = 500

/**
 * A native modal <dialog> (focus trap, inert board, Escape, top layer), like ui/Dialog.tsx but with
 * the viewer's own large layout. Keys typed inside never reach the board's shortcuts (tldraw listens
 * on <body>). Focus goes back to whatever opened it unless `afterClose` placed it elsewhere.
 */
function ModalDialog({
  className,
  testId,
  labelledBy,
  describedBy,
  onClose,
  onKeyDown,
  afterClose,
  children,
}: {
  className: string
  testId: string
  labelledBy: string
  describedBy: string
  onClose(): void
  onKeyDown(e: KeyboardEvent): void
  afterClose(): boolean
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const afterCloseRef = useRef(afterClose)
  afterCloseRef.current = afterClose
  const onKeyDownRef = useRef(onKeyDown)
  onKeyDownRef.current = onKeyDown
  const openedAt = useRef(0)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    openedAt.current = performance.now()
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!dialog.open) dialog.showModal()
    // Start on the page itself, so the arrow keys turn pages and a screen reader reads the page.
    dialog.querySelector<HTMLElement>('.dr-pv__stage')?.focus({ preventScroll: true })
    // Native listeners: the board's shortcuts listen on <body> (and the document), so key presses
    // in here stop at the dialog. That also keeps them from React's root listener, hence no
    // onKeyDown. Key releases do reach the board: tldraw must see Shift (or Space) go up, or it
    // would still think the key is held after the viewer closes.
    const keydown = (e: KeyboardEvent) => {
      onKeyDownRef.current(e)
      e.stopPropagation()
    }
    // If the focus ever falls out of the dialog (onto <body>, e.g. when a focused control is
    // removed), key presses still belong to the viewer, never to the board behind it.
    const outside = (e: KeyboardEvent) => {
      if (e.target instanceof Node && dialog.contains(e.target)) return
      e.stopPropagation()
      onKeyDownRef.current(e)
      dialog.querySelector<HTMLElement>('.dr-pv__stage')?.focus({ preventScroll: true })
    }
    dialog.addEventListener('keydown', keydown)
    window.addEventListener('keydown', outside, true)
    return () => {
      dialog.removeEventListener('keydown', keydown)
      window.removeEventListener('keydown', outside, true)
      if (dialog.open) dialog.close()
      if (!afterCloseRef.current() && opener?.isConnected) opener.focus({ preventScroll: true })
    }
  }, [])

  return (
    <dialog
      ref={ref}
      className={className}
      data-testid={testId}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onCancel={(e) => {
        e.preventDefault() // we unmount instead of letting the browser close it
        onCloseRef.current()
      }}
      onPointerDown={(e) => {
        // The dialog element itself is only hit on its backdrop (the panel covers the rest). The
        // second click of a double-click on "View pages" lands here too: it must not close the viewer.
        if (e.target === ref.current && performance.now() - openedAt.current > BACKDROP_GRACE_MS) {
          onCloseRef.current()
        }
      }}
    >
      <div className="dr-pv__panel">{children}</div>
    </dialog>
  )
}
