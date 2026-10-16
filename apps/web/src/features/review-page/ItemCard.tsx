// OWNER: WS4 (wave S, the client review page). One item of the page: its label and place in the list, a large picture
// (a frame drawn by the exporter, lazily as it scrolls in; a file's own preview), the status pill (icon and words, never
// colour alone) with who and when, the status controls and the item's open comments.
import { type CommentThread, type ReviewCan, type ReviewItem, reviewPillText } from '@draftroom/contracts'
import { useEffect, useRef, useState } from 'react'
import { derivativeUrl, originalUrl } from '../../assets/contract.ts'
import { useAssetMeta } from '../../assets/meta-store.ts'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { mediaMetaStore } from '../../file-card/ported/meta.ts'
import { openPdfViewer } from '../../file-card/ported/viewer-state.ts'
import { formatRelativeTime } from '../../lib/format.ts'
import { useValue } from '../../lib/signals.ts'
import type { CommentsStore } from '../comments/store.ts'
import type { PageEntry } from './model.ts'
import { type FramePictures, frameKey, previewDerivative } from './picture.ts'
import { StatusControls } from './StatusControls.tsx'
import { Threads } from './Threads.tsx'

const RING = <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2.2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const
const ICONS = {
  approved: (
    <>
      {RING}
      <path d="M7.8 12.4l3 3 5.4-6" {...STROKE} />
    </>
  ),
  changes_requested: (
    <>
      {RING}
      <path d="M12 7.6v5.2M12 16.2v.2" {...STROKE} />
    </>
  ),
  pending: (
    <>
      {RING}
      <path d="M12 7.5V12l3 1.8" {...STROKE} />
    </>
  ),
} as const

/** The status pill: an icon and the words ("Approved · Ana (guest)"), with when. */
export function StatusPill({ item }: { item: Pick<ReviewItem, 'status' | 'statusBy' | 'statusAt'> }) {
  return (
    <p className="dr-rp__pill" data-testid="review-item-status" data-status={item.status}>
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        {ICONS[item.status]}
      </svg>
      <span>
        {reviewPillText(item)}
        {item.statusAt ? <span className="dr-rp__when"> · {formatRelativeTime(item.statusAt)}</span> : null}
      </span>
    </p>
  )
}

/** True once the element has been on screen (or near it): the picture is drawn then, not before. */
function useNear(ref: React.RefObject<Element | null>): boolean {
  const [near, setNear] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || near) return
    if (typeof IntersectionObserver !== 'function') {
      setNear(true)
      return
    }
    const io = new IntersectionObserver(
      (hits) => {
        if (hits.some((h) => h.isIntersecting)) setNear(true)
      },
      { rootMargin: '700px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [ref, near])
  return near
}

function useWidth(ref: React.RefObject<Element | null>): number {
  const [w, setW] = useState(360)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => setW(Math.max(120, Math.round(el.getBoundingClientRect().width)))
    read()
    if (typeof ResizeObserver !== 'function') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return w
}

function FramePicture({
  ctx,
  entry,
  pictures,
}: {
  ctx: CanvasFeatureContext
  entry: PageEntry
  pictures: FramePictures
}) {
  const box = useRef<HTMLDivElement>(null)
  const near = useNear(box)
  const width = useWidth(box)
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
  const id = entry.item.elementId
  const k = useValue('review-frame-key', () => frameKey(ctx.canvas, id, width, dpr), [ctx, id, width, dpr])
  const [shown, setShown] = useState<{ url: string; key: string } | null>(null)
  const [failed, setFailed] = useState(false)
  const key = k?.key ?? null
  const scale = k?.scale ?? 1
  useEffect(() => {
    if (!near || !key) return
    const hit = pictures.cached(id, key)
    if (hit) {
      setShown(hit)
      return
    }
    let live = true
    void pictures.load(id, key, scale).then((p) => {
      if (!live) return
      if (p) {
        setShown(p)
        setFailed(false)
      } else setFailed(true)
    })
    return () => {
      live = false
    }
  }, [near, key, scale, id, pictures])
  return (
    <div
      ref={box}
      className="dr-rp__picture"
      data-testid="review-item-picture"
      data-state={shown ? 'ready' : failed ? 'error' : 'loading'}
      style={k ? { aspectRatio: `${k.width} / ${k.height}` } : undefined}
    >
      {shown ? (
        <img src={shown.url} alt={`${entry.label}`} decoding="async" draggable={false} />
      ) : (
        <p className="dr-rp__picture-note">
          {failed || !k ? 'This item could not be drawn here.' : 'Drawing the preview…'}
        </p>
      )}
    </div>
  )
}

function FilePicture({
  ctx,
  entry,
  playable,
}: {
  ctx: CanvasFeatureContext
  entry: PageEntry
  playable: boolean
}) {
  const file = entry.file
  const boardId = ctx.board.id
  const snap = useAssetMeta(mediaMetaStore, boardId, file?.assetId ?? '', file?.versionId ?? '')
  if (!file) return <div className="dr-rp__picture" data-state="error" data-testid="review-item-picture" />
  const preview = previewDerivative(snap.meta, file.kind)
  const src = preview ? derivativeUrl(boardId, file.assetId, file.versionId, preview.id) : null
  const waiting = snap.meta?.status === 'queued' || snap.meta?.status === 'processing' || !snap.meta
  return (
    <div
      className="dr-rp__picture dr-rp__picture--file"
      data-testid="review-item-picture"
      data-state={src ? 'ready' : snap.missing ? 'error' : 'loading'}
      data-kind={file.kind}
    >
      {file.kind === 'video' && playable && !snap.missing ? (
        // biome-ignore lint/a11y/useMediaCaption: a deliverable under review has no caption track
        <video
          controls
          preload="none"
          playsInline
          poster={src ?? undefined}
          src={originalUrl(boardId, file.assetId, file.versionId)}
          aria-label={entry.label}
        />
      ) : src ? (
        <img src={src} alt={entry.label} decoding="async" draggable={false} />
      ) : (
        <p className="dr-rp__picture-note">
          {snap.missing
            ? 'There is no preview of this file.'
            : waiting
              ? 'Preparing the preview…'
              : file.name || 'File'}
        </p>
      )}
      {file.kind === 'pdf' && src && (
        <button
          type="button"
          className="dr-rp__btn dr-rp__btn--overlay"
          data-testid="review-view-pages"
          onClick={() => openPdfViewer(ctx.registries, entry.item.elementId)}
        >
          View pages
        </button>
      )}
    </div>
  )
}

export function ItemCard({
  ctx,
  entry,
  total,
  active,
  pictures,
  can,
  threads,
  store,
  canComment,
  playable,
  onApplied,
  announce,
  cardRef,
}: {
  ctx: CanvasFeatureContext
  entry: PageEntry
  total: number
  active: boolean
  pictures: FramePictures
  can: ReviewCan
  threads: readonly CommentThread[]
  store: CommentsStore
  canComment: boolean
  /** a video may play inline (downloads and playback are separate: playback keeps working with downloads off) */
  playable: boolean
  onApplied(item: ReviewItem, thread?: CommentThread): void
  announce(text: string): void
  cardRef(el: HTMLElement | null): void
}) {
  const { item } = entry
  return (
    <article
      ref={cardRef}
      className="dr-rp__item"
      data-testid="review-item"
      data-item-id={item.id}
      data-element-id={item.elementId}
      data-status={item.status}
      data-kind={entry.kind}
      data-active={active || undefined}
      aria-label={`${entry.label}, item ${entry.index + 1} of ${total}`}
    >
      <header className="dr-rp__item-head">
        <p className="dr-rp__position">
          Item {entry.index + 1} of {total}
        </p>
        <h2 className="dr-rp__item-title" data-testid="review-item-label">
          {entry.label}
        </h2>
      </header>
      {entry.kind === 'frame' ? (
        <FramePicture ctx={ctx} entry={entry} pictures={pictures} />
      ) : (
        <FilePicture ctx={ctx} entry={entry} playable={playable} />
      )}
      <StatusPill item={item} />
      <StatusControls
        boardId={ctx.board.id}
        entry={entry}
        can={can}
        onApplied={onApplied}
        announce={announce}
      />
      <Threads store={store} entry={entry} threads={threads} canComment={canComment} />
    </article>
  )
}
