// OWNER: WS2 (wave S, compare; docs/WAVE-S-CONTRACTS.md §3.3). The review viewer's `compare` slot: version A
// (`request.compareWith`, "before") against version B (`request.versionId`, the one shown), each read from its own
// meta (never the card's: two versions of one deliverable may be of different kinds).
//   - images: side by side with one zoom and pan (wheel or the buttons; drag to pan), a slider (B clipped by a
//     draggable divider, both fitted into A's proportions, letterboxed and said so when they differ), and onion skin
//     (B's opacity); pixels from the `display` renderings (≤ 2,048 px), "Load full resolution" (the originals) only
//     when downloads are allowed;
//   - PDF and Office previews: page N of A against page N of B, side by side or with the slider; the page steps move
//     both; a page count mismatch is stated;
//   - video: the originals, one transport (B follows A's clock, ./video-sync.ts; B muted), side by side, wipe or
//     toggle (the A and B keys, inside the viewer only); a file the browser cannot play shows the posters and says so.
// Phones: the panes stack (compare.css); the slider and the wipe take touch.
import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
  type WheelEvent,
} from 'react'
import { type AssetVersionMeta, derivativeUrl, originalUrl } from '../../../assets/contract.ts'
import { useAssetMeta } from '../../../assets/meta-store.ts'
import type { CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { coverDerivative } from '../../../file-card/card-model.ts'
import { previewPages } from '../../../file-card/pdf-pages.ts'
import { downloadsAllowed } from '../../../file-card/ported/downloads.ts'
import { mediaMetaStore } from '../../../file-card/ported/meta.ts'
import { useUserKind } from '../../../invite/guest.tsx'
import { useValue } from '../../../lib/signals.ts'
import type { ViewerSlotProps } from '../slots.ts'
import {
  compareRefusal,
  displayDerivative,
  pageCountNote,
  pictureSize,
  versionLabel,
} from '../versions/model.ts'
import { versionStoreOf } from '../versions/store.ts'
import {
  FIT,
  panBy,
  percentAt,
  type Size,
  sameAspect,
  sharedBox,
  sliderClip,
  type View,
  viewTransform,
  zoomAt,
} from './geometry.ts'
import { browserScheduler, follow, formatTimecode } from './video-sync.ts'
import './compare.css'

interface Side {
  readonly versionId: string
  readonly label: string
  readonly meta: AssetVersionMeta
}

export function CompareSlot({ ctx, request }: ViewerSlotProps) {
  const list = useValue(versionStoreOf(ctx).list(request.assetId))
  const aId = request.compareWith
  const bId = request.versionId
  const board = ctx.board.id
  const snapA = useAssetMeta(mediaMetaStore, board, request.assetId, aId ?? bId)
  const snapB = useAssetMeta(mediaMetaStore, board, request.assetId, bId)
  if (!aId || aId === bId) return <Note testId="compare-pick">Pick another version to compare with.</Note>
  if (snapA.missing || snapB.missing)
    return <Note testId="compare-missing">One of these versions can't be shown here.</Note>
  if (!snapA.meta || !snapB.meta) return <Note testId="compare-loading">Loading both versions…</Note>
  const a: Side = { versionId: aId, label: versionLabel(list, aId) ?? 'A', meta: snapA.meta }
  const b: Side = { versionId: bId, label: versionLabel(list, bId) ?? 'B', meta: snapB.meta }
  const refusal = compareRefusal({ kind: a.meta.kind, label: a.label }, { kind: b.meta.kind, label: b.label })
  if (refusal) return <Note testId="compare-refused">{refusal}</Note>
  const props = { ctx, assetId: request.assetId, a, b }
  return (
    <div className="lobby-cmp" data-testid="compare" data-kind={a.meta.kind}>
      {a.meta.kind === 'image' ? (
        <ImageCompare {...props} />
      ) : a.meta.kind === 'pdf' ? (
        <PdfCompare {...props} />
      ) : (
        <VideoCompare {...props} />
      )}
    </div>
  )
}

interface CompareProps {
  ctx: CanvasFeatureContext
  assetId: string
  a: Side
  b: Side
}

const Note = ({ testId, children }: { testId: string; children: ReactNode }) => (
  <p className="dr-rv__empty lobby-cmp__note" data-testid={testId}>
    {children}
  </p>
)

/** Whether this person may download the originals here (export control; the api refuses them anyway). */
function useCanDownload(ctx: CanvasFeatureContext): boolean {
  const kind = useUserKind()
  const guest = kind === null ? null : kind === 'guest'
  return useValue('compare-can-download', () => downloadsAllowed(ctx, guest), [ctx, guest])
}

/** The element's size in CSS pixels, followed with a ResizeObserver (none: what it was at mount). */
function useSize<T extends HTMLElement>(): [RefObject<T | null>, Size] {
  const ref = useRef<T>(null)
  const [size, setSize] = useState<Size>({ w: 0, h: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, size]
}

function ModeBar<M extends string>({
  modes,
  mode,
  onMode,
  children,
}: {
  modes: readonly (readonly [M, string])[]
  mode: M
  onMode(m: M): void
  children?: ReactNode
}) {
  return (
    <div className="lobby-cmp__bar" role="toolbar" aria-label="Compare">
      {modes.map(([m, label]) => (
        <button
          key={m}
          type="button"
          className="lobby-cmp__mode"
          data-testid={`compare-mode-${m}`}
          aria-pressed={mode === m}
          onClick={() => onMode(m)}
        >
          {label}
        </button>
      ))}
      {children}
    </div>
  )
}

// ---- images --------------------------------------------------------------------------------------------------

type ImageMode = 'side' | 'slider' | 'onion'
const IMAGE_MODES: readonly (readonly [ImageMode, string])[] = [
  ['side', 'Side by side'],
  ['slider', 'Slider'],
  ['onion', 'Onion skin'],
]

function ImageCompare({ ctx, assetId, a, b }: CompareProps) {
  const canDownload = useCanDownload(ctx)
  const [mode, setMode] = useState<ImageMode>('side')
  const [full, setFull] = useState(false)
  const [view, setView] = useState<View>(FIT)
  const src = (s: Side) => {
    const d = displayDerivative(s.meta)
    if ((full && canDownload) || !d) return originalUrl(ctx.board.id, assetId, s.versionId)
    return derivativeUrl(ctx.board.id, assetId, s.versionId, d.id)
  }
  const sizeA = pictureSize(a.meta)
  const sizeB = pictureSize(b.meta)
  return (
    <>
      <ModeBar<ImageMode> modes={IMAGE_MODES} mode={mode} onMode={setMode}>
        {mode === 'side' && (
          <span className="lobby-cmp__zoom">
            <button
              type="button"
              className="lobby-cmp__mode"
              aria-label="Zoom out"
              onClick={() => setView((v) => zoomAt(v, 1 / 1.5, { x: 0, y: 0 }))}
            >
              −
            </button>
            <button
              type="button"
              className="lobby-cmp__mode"
              data-testid="compare-zoom-in"
              aria-label="Zoom in"
              onClick={() => setView((v) => zoomAt(v, 1.5, { x: 0, y: 0 }))}
            >
              +
            </button>
            <button type="button" className="lobby-cmp__mode" onClick={() => setView(FIT)}>
              Fit
            </button>
          </span>
        )}
        {canDownload && !full && (
          <button
            type="button"
            className="lobby-cmp__mode"
            data-testid="compare-full"
            onClick={() => setFull(true)}
          >
            Load full resolution
          </button>
        )}
      </ModeBar>
      {mode !== 'side' && !sameAspect(sizeA, sizeB) && (
        <p className="lobby-cmp__hint" data-testid="compare-aspect-note">
          {a.label} and {b.label} have different proportions: {b.label} is fitted into {a.label}'s frame.
        </p>
      )}
      {mode === 'side' ? (
        <div className="lobby-cmp__side" data-testid="compare-side">
          <ZoomPane label={`A · ${a.label}`} src={src(a)} view={view} onView={setView} testId="compare-a" />
          <ZoomPane label={`B · ${b.label}`} src={src(b)} view={view} onView={setView} testId="compare-b" />
        </div>
      ) : (
        <Overlay
          mode={mode === 'slider' ? 'slider' : 'onion'}
          sizeA={sizeA}
          sizeB={sizeB}
          a={
            <img
              src={src(a)}
              alt={`${a.label} of ${a.meta.name}`}
              draggable={false}
              data-testid="compare-a"
            />
          }
          b={
            <img
              src={src(b)}
              alt={`${b.label} of ${b.meta.name}`}
              draggable={false}
              data-testid="compare-b"
            />
          }
          labels={[a.label, b.label]}
        />
      )}
    </>
  )
}

/** One side-by-side pane: the shared zoom and pan (the wheel zooms at the pointer, a drag pans). */
function ZoomPane({
  label,
  src,
  view,
  onView,
  testId,
}: {
  label: string
  src: string
  view: View
  onView(v: View | ((v: View) => View)): void
  testId: string
}) {
  const [ref, size] = useSize<HTMLDivElement>()
  const drag = useRef<{ id: number; x: number; y: number } | null>(null)
  const onWheel = (e: WheelEvent) => {
    const r = e.currentTarget.getBoundingClientRect()
    const at = { x: e.clientX - r.left, y: e.clientY - r.top }
    onView((v) => zoomAt(v, e.deltaY < 0 ? 1.2 : 1 / 1.2, at))
  }
  const onDown = (e: ReactPointerEvent) => {
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    drag.current = { id: d.id, x: e.clientX, y: e.clientY }
    onView((v) => panBy(v, dx, dy, size))
  }
  const onUp = () => {
    drag.current = null
  }
  return (
    <figure className="lobby-cmp__pane">
      <div
        ref={ref}
        className="lobby-cmp__frame"
        data-zoom={view.zoom}
        onWheel={onWheel}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <img
          src={src}
          alt={label}
          draggable={false}
          data-testid={testId}
          style={{ transform: viewTransform(view), transformOrigin: '0 0' }}
        />
      </div>
      <figcaption>{label}</figcaption>
    </figure>
  )
}

/** The slider (B clipped right of the divider) or onion skin (B over A at an opacity), A's frame for both. */
function Overlay({
  mode,
  sizeA,
  sizeB,
  a,
  b,
  labels,
}: {
  mode: 'slider' | 'onion'
  sizeA: Size | null
  sizeB: Size | null
  a: ReactNode
  b: ReactNode
  labels: readonly [string, string]
}) {
  const [stageRef, stage] = useSize<HTMLDivElement>()
  const [percent, setPercent] = useState(50)
  const [opacity, setOpacity] = useState(50)
  const box = sharedBox(sizeA, sizeB, stage)
  const dragging = useRef<number | null>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const at = (e: ReactPointerEvent) => {
    const r = frameRef.current?.getBoundingClientRect()
    if (r) setPercent(percentAt(e.clientX, r.left, r.width))
  }
  return (
    <div className="lobby-cmp__overlay">
      <div ref={stageRef} className="lobby-cmp__stage">
        <div
          ref={frameRef}
          className="lobby-cmp__box"
          data-testid={mode === 'slider' ? 'compare-slider-box' : 'compare-onion-box'}
          style={{ width: box.w || '100%', height: box.h || '100%' }}
          onPointerDown={(e) => {
            if (mode !== 'slider') return
            dragging.current = e.pointerId
            e.currentTarget.setPointerCapture?.(e.pointerId)
            at(e)
          }}
          onPointerMove={(e) => {
            if (dragging.current === e.pointerId) at(e)
          }}
          onPointerUp={() => {
            dragging.current = null
          }}
          onPointerCancel={() => {
            dragging.current = null
          }}
        >
          <div className="lobby-cmp__layer">{a}</div>
          <div
            className="lobby-cmp__layer"
            data-testid="compare-top"
            style={mode === 'slider' ? { clipPath: sliderClip(percent) } : { opacity: opacity / 100 }}
          >
            {b}
          </div>
          {mode === 'slider' && (
            <div className="lobby-cmp__divider" style={{ left: `${percent}%` }} aria-hidden="true" />
          )}
          <span className="lobby-cmp__tag lobby-cmp__tag--a">A · {labels[0]}</span>
          <span className="lobby-cmp__tag lobby-cmp__tag--b">B · {labels[1]}</span>
        </div>
      </div>
      {mode === 'slider' ? (
        <input
          type="range"
          className="lobby-cmp__range"
          min={0}
          max={100}
          step={1}
          value={percent}
          aria-label="Divider position"
          data-testid="compare-slider"
          onChange={(e) => setPercent(Number(e.target.value))}
        />
      ) : (
        <input
          type="range"
          className="lobby-cmp__range"
          min={0}
          max={100}
          step={1}
          value={opacity}
          aria-label={`Opacity of ${labels[1]}`}
          data-testid="compare-opacity"
          onChange={(e) => setOpacity(Number(e.target.value))}
        />
      )}
    </div>
  )
}

// ---- PDF and Office previews -----------------------------------------------------------------------------------

type PageMode = 'side' | 'slider'
const PAGE_MODES: readonly (readonly [PageMode, string])[] = [
  ['side', 'Side by side'],
  ['slider', 'Slider'],
]

function PdfCompare({ ctx, assetId, a, b }: CompareProps) {
  const [mode, setMode] = useState<PageMode>('side')
  const [page, setPage] = useState(1)
  const pagesA = previewPages(a.meta)
  const pagesB = previewPages(b.meta)
  const countA = a.meta.probe?.pageCount ?? pagesA.length
  const countB = b.meta.probe?.pageCount ?? pagesB.length
  const last = Math.max(1, pagesA.length, pagesB.length)
  const pageOf = (s: Side, pages: ReturnType<typeof previewPages>) => {
    const p = pages.find((x) => x.page === page)
    return p ? derivativeUrl(ctx.board.id, assetId, s.versionId, p.full.id) : null
  }
  const urlA = pageOf(a, pagesA)
  const urlB = pageOf(b, pagesB)
  const sizeOf = (pages: ReturnType<typeof previewPages>) => {
    const p = pages.find((x) => x.page === page)
    return p ? { w: p.full.width, h: p.full.height } : null
  }
  const note = pageCountNote({ label: a.label, pages: countA }, { label: b.label, pages: countB })
  const missing = (s: Side) => (
    <span className="lobby-cmp__missing">{`${s.label} has no page ${page} to show.`}</span>
  )
  return (
    <>
      <ModeBar<PageMode> modes={PAGE_MODES} mode={mode} onMode={setMode}>
        <span className="lobby-cmp__pages">
          <button
            type="button"
            className="lobby-cmp__mode"
            data-testid="compare-page-prev"
            aria-label="Previous page"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            ‹
          </button>
          <span data-testid="compare-page" aria-live="polite">
            Page {page}
          </span>
          <button
            type="button"
            className="lobby-cmp__mode"
            data-testid="compare-page-next"
            aria-label="Next page"
            disabled={page >= last}
            onClick={() => setPage((p) => Math.min(last, p + 1))}
          >
            ›
          </button>
        </span>
      </ModeBar>
      {note && (
        <p className="lobby-cmp__hint" data-testid="compare-page-note">
          {note}
        </p>
      )}
      {mode === 'side' || !urlA || !urlB ? (
        <div className="lobby-cmp__side" data-testid="compare-side">
          {[
            [a, urlA, 'compare-a'],
            [b, urlB, 'compare-b'],
          ].map(([s, url, testId]) => (
            <figure key={testId as string} className="lobby-cmp__pane">
              <div className="lobby-cmp__frame lobby-cmp__frame--page">
                {url ? (
                  <img
                    src={url as string}
                    alt={`Page ${page} of ${(s as Side).label}`}
                    draggable={false}
                    data-testid={testId as string}
                  />
                ) : (
                  missing(s as Side)
                )}
              </div>
              <figcaption>
                {testId === 'compare-a' ? 'A' : 'B'} · {(s as Side).label}
              </figcaption>
            </figure>
          ))}
        </div>
      ) : (
        <Overlay
          mode="slider"
          sizeA={sizeOf(pagesA)}
          sizeB={sizeOf(pagesB)}
          a={<img src={urlA} alt={`Page ${page} of ${a.label}`} draggable={false} data-testid="compare-a" />}
          b={<img src={urlB} alt={`Page ${page} of ${b.label}`} draggable={false} data-testid="compare-b" />}
          labels={[a.label, b.label]}
        />
      )}
    </>
  )
}

// ---- video ---------------------------------------------------------------------------------------------------

type VideoMode = 'side' | 'wipe' | 'toggle'
const VIDEO_MODES: readonly (readonly [VideoMode, string])[] = [
  ['side', 'Side by side'],
  ['wipe', 'Wipe'],
  ['toggle', 'Toggle A/B'],
]

export const CANT_PLAY_TEXT = "This browser can't play this file; download it."

function VideoCompare({ ctx, assetId, a, b }: CompareProps) {
  const [mode, setMode] = useState<VideoMode>('side')
  const [shown, setShown] = useState<'A' | 'B'>('A')
  const [percent, setPercent] = useState(50)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [failed, setFailed] = useState<{ A: boolean; B: boolean }>({ A: false, B: false })
  const refA = useRef<HTMLVideoElement>(null)
  const refB = useRef<HTMLVideoElement>(null)
  const board = ctx.board.id
  const poster = (s: Side) => {
    const d = coverDerivative(s.meta)
    return d ? derivativeUrl(board, assetId, s.versionId, d.id) : undefined
  }
  const cantPlay = failed.A || failed.B
  const rootRef = useRef<HTMLDivElement>(null)
  // the A and B keys show A or B (toggle), heard on the viewer's dialog only: it stops every key before the board
  useEffect(() => {
    const dialog = rootRef.current?.closest('dialog')
    if (!dialog || cantPlay) return
    const keydown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return
      const t = e.target as HTMLElement | null
      if (
        t &&
        (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      )
        return
      const k = e.key.toLowerCase()
      if (k !== 'a' && k !== 'b') return
      e.preventDefault()
      setMode('toggle')
      setShown(k === 'a' ? 'A' : 'B')
    }
    dialog.addEventListener('keydown', keydown)
    return () => dialog.removeEventListener('keydown', keydown)
  }, [cantPlay])
  useEffect(() => {
    const va = refA.current
    const vb = refB.current
    if (!va || !vb || cantPlay) return
    return follow(va, vb, browserScheduler(va))
  }, [cantPlay])
  const toggle = () => {
    const va = refA.current
    if (!va) return
    if (va.paused) void Promise.resolve(va.play()).catch(() => {})
    else va.pause()
  }
  const video = (s: Side, which: 'A' | 'B') => (
    <video
      ref={which === 'A' ? refA : refB}
      className="lobby-cmp__video"
      data-testid={which === 'A' ? 'compare-a' : 'compare-b'}
      src={originalUrl(board, assetId, s.versionId)}
      poster={poster(s)}
      preload="metadata"
      playsInline
      muted={which === 'B'}
      onError={() => setFailed((f) => ({ ...f, [which]: true }))}
      {...(which === 'A'
        ? {
            onTimeUpdate: (e) => setTime(e.currentTarget.currentTime),
            onLoadedMetadata: (e) =>
              setDuration(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0),
            onPlay: () => setPlaying(true),
            onPause: () => setPlaying(false),
            onEnded: () => setPlaying(false),
          }
        : {})}
    />
  )
  if (cantPlay)
    return (
      <div className="lobby-cmp__side" data-testid="compare-cant-play">
        {[a, b].map((s, i) => (
          <figure key={s.versionId} className="lobby-cmp__pane">
            <div className="lobby-cmp__frame">
              {poster(s) ? <img src={poster(s)} alt={`Poster of ${s.label}`} /> : null}
            </div>
            <figcaption>
              {i === 0 ? 'A' : 'B'} · {s.label}
            </figcaption>
          </figure>
        ))}
        <p className="lobby-cmp__hint">{CANT_PLAY_TEXT}</p>
      </div>
    )
  return (
    <div ref={rootRef} className="lobby-cmp__video-root">
      <ModeBar<VideoMode> modes={VIDEO_MODES} mode={mode} onMode={setMode}>
        {mode === 'toggle' && (
          <span className="lobby-cmp__zoom">
            {(['A', 'B'] as const).map((w) => (
              <button
                key={w}
                type="button"
                className="lobby-cmp__mode"
                data-testid={`compare-show-${w.toLowerCase()}`}
                aria-pressed={shown === w}
                aria-keyshortcuts={w}
                onClick={() => setShown(w)}
              >
                Show {w}
              </button>
            ))}
          </span>
        )}
      </ModeBar>
      <div className={`lobby-cmp__videos lobby-cmp__videos--${mode}`} data-shown={shown}>
        <figure className="lobby-cmp__pane lobby-cmp__pane--a">
          <div className="lobby-cmp__frame">{video(a, 'A')}</div>
          <figcaption>A · {a.label}</figcaption>
        </figure>
        <figure
          className="lobby-cmp__pane lobby-cmp__pane--b"
          style={mode === 'wipe' ? { clipPath: sliderClip(percent) } : undefined}
        >
          <div className="lobby-cmp__frame">{video(b, 'B')}</div>
          <figcaption>B · {b.label}</figcaption>
        </figure>
      </div>
      {mode === 'wipe' && (
        <input
          type="range"
          className="lobby-cmp__range"
          min={0}
          max={100}
          value={percent}
          aria-label="Wipe position"
          data-testid="compare-wipe"
          onChange={(e) => setPercent(Number(e.target.value))}
        />
      )}
      <div className="lobby-cmp__transport">
        <button type="button" className="dr-btn" data-testid="compare-play" onClick={toggle}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <input
          type="range"
          className="lobby-cmp__range"
          min={0}
          max={Math.max(0.1, duration)}
          step={0.04}
          value={Math.min(time, duration || time)}
          aria-label="Position"
          data-testid="compare-seek"
          onChange={(e) => {
            const va = refA.current
            const t = Number(e.target.value)
            if (va) va.currentTime = t
            setTime(t)
          }}
        />
        <span className="lobby-cmp__time" data-testid="compare-time">
          {formatTimecode(time)} / {formatTimecode(duration)}
        </span>
      </div>
    </div>
  )
}
