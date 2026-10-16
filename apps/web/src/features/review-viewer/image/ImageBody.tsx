// OWNER: WS3 (wave S, media comments). The review viewer's `body` for an image (docs/WAVE-S-CONTRACTS.md §4): the
// worker's display rendering (never the original: that is a download, and the export policy decides it), zoom
// (buttons, + and -, 0 to fit; Ctrl/Cmd + wheel) and pan (drag when zoomed), and a pin per thread with a spot on
// this version. A click on the picture opens the composer with that spot; a pin picks its thread.
import { type KeyboardEvent, type PointerEvent, useEffect, useMemo, useRef, useState } from 'react'
import { derivativeUrl, usableDerivatives } from '../../../assets/contract.ts'
import { viewerPageSize } from '../../../file-card/pdf-pages.ts'
import type { ViewerSlotProps } from '../slots.ts'
import { spotAt, spotsShown } from '../threads/model.ts'
import { patchSession } from '../threads/session.ts'
import {
  DraftPin,
  mediaCommentsOn,
  SpotPin,
  STAGE_PAD,
  startComment,
  useBoxSize,
  useMedia,
} from '../threads/shared.tsx'

/** The zoom steps (1: the picture fits the stage). */
export const IMAGE_ZOOM_STEPS = [1, 1.5, 2, 3, 4] as const

export const zoomIn = (z: number) => IMAGE_ZOOM_STEPS.find((s) => s > z + 1e-9) ?? z
export const zoomOut = (z: number) => [...IMAGE_ZOOM_STEPS].reverse().find((s) => s < z - 1e-9) ?? 1

/** A drag shorter than this is a click (a comment); longer, a pan. */
const CLICK_SLOP_PX = 4

export function ImageBody(props: ViewerSlotProps) {
  if (!mediaCommentsOn()) return null
  return <Picture {...props} />
}

function Picture(props: ViewerSlotProps) {
  const { ctx, request, file } = props
  const { session, state, threads, canComment, meta } = useMedia(props)
  const stage = useRef<HTMLElement>(null)
  const [zoom, setZoom] = useState(1)
  const drag = useRef<{ x: number; y: number; left: number; top: number; id: number; moved: boolean } | null>(
    null,
  )
  const rendering = useMemo(() => {
    const m = meta.meta
    if (!m) return null
    const all = usableDerivatives(m)
    return all.find((d) => d.role === 'display') ?? all.find((d) => d.role === 'thumb') ?? null
  }, [meta.meta])
  const box = useBoxSize(stage)
  const size = rendering
    ? viewerPageSize(
        { w: rendering.width, h: rendering.height },
        { w: Math.max(0, box.w - 2 * STAGE_PAD), h: Math.max(0, box.h - 2 * STAGE_PAD) },
        zoom,
      )
    : { w: 0, h: 0 }
  const src = rendering ? derivativeUrl(ctx.board.id, request.assetId, request.versionId, rendering.id) : null

  useEffect(() => {
    stage.current?.focus({ preventScroll: true })
  }, [])

  // Ctrl/Cmd + wheel zooms the picture, not the page.
  useEffect(() => {
    const el = stage.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      setZoom((z) => (e.deltaY < 0 ? zoomIn(z) : zoomOut(z)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLTextAreaElement || e.altKey || e.metaKey || e.ctrlKey) return
    if (e.key === '+' || e.key === '=') setZoom(zoomIn)
    else if (e.key === '-') setZoom(zoomOut)
    else if (e.key === '0') setZoom(1)
    else return
    e.preventDefault()
  }
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const el = stage.current
    if (!el || e.button !== 0) return
    drag.current = {
      x: e.clientX,
      y: e.clientY,
      left: el.scrollLeft,
      top: el.scrollTop,
      id: e.pointerId,
      moved: false,
    }
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const el = stage.current
    const d = drag.current
    if (!el || !d || d.id !== e.pointerId) return
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_SLOP_PX) d.moved = true
    if (zoom > 1 && d.moved) {
      el.scrollLeft = d.left - (e.clientX - d.x)
      el.scrollTop = d.top - (e.clientY - d.y)
    }
  }
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    drag.current = null
    if (!d || d.id !== e.pointerId || d.moved || !canComment) return
    const box = (e.target as Element).closest('.dr-rvm-picture')
    if (!box) return
    const spot = spotAt(box.getBoundingClientRect(), e.clientX, e.clientY)
    if (spot) startComment(session, { spot })
  }

  const shown = spotsShown(threads, {})
  return (
    <div className="dr-rvm-image" data-testid="rv-image">
      <div className="dr-rvm-bar">
        <button
          type="button"
          className="dr-btn dr-btn--sm dr-btn--ghost"
          data-testid="rv-zoom-out"
          aria-label="Zoom out"
          aria-disabled={zoom <= 1}
          onClick={() => setZoom(zoomOut)}
        >
          −
        </button>
        <output className="dr-rvm-zoom" data-testid="rv-zoom-level">
          {Math.round(zoom * 100)}%
        </output>
        <button
          type="button"
          className="dr-btn dr-btn--sm dr-btn--ghost"
          data-testid="rv-zoom-in"
          aria-label="Zoom in"
          onClick={() => setZoom(zoomIn)}
        >
          +
        </button>
        <button
          type="button"
          className="dr-btn dr-btn--sm dr-btn--ghost"
          data-testid="rv-zoom-fit"
          onClick={() => setZoom(1)}
        >
          Fit
        </button>
        <span className="dr-rvm-spacer" />
        {canComment && <span className="dr-rvm-hint">Click the picture to comment on a spot</span>}
      </div>
      <section
        ref={stage}
        className="dr-rvm-stage"
        data-testid="rv-image-stage"
        data-zoomed={zoom > 1 || undefined}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable picture must be focusable to scroll it by keyboard
        tabIndex={0}
        aria-label={`${file.name || 'Image'}: click to comment on a spot`}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          drag.current = null
        }}
      >
        {src && rendering ? (
          <div
            className="dr-rvm-picture"
            data-testid="rv-picture"
            style={size.w ? { width: size.w, height: size.h } : undefined}
          >
            <img src={src} alt={file.name || 'Image'} draggable={false} />
            {shown.map((t) => (
              <SpotPin
                key={t.id}
                thread={t}
                selected={state.selected === t.id}
                onPick={() => patchSession(session, { selected: t.id, draft: null })}
              />
            ))}
            {state.draft?.spot && <DraftPin spot={state.draft.spot} />}
          </div>
        ) : (
          <p className="dr-rvm-note">
            {meta.missing ? 'This file is not available on this board.' : 'Loading the picture…'}
          </p>
        )}
      </section>
    </div>
  )
}
