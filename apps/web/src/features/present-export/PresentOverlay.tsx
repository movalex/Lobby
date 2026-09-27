// Presentation chrome, rendered inside <Tldraw> (so it is inside the fullscreen container): a dark
// surround with a hole at the current frame, an input shield over the canvas, a small auto-hiding
// control bar (previous / counter / next / slide list / exit) and a screen-reader announcement.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { type Editor, useValue } from 'tldraw'
import type { Presenter } from './present-session.ts'
import { fittedSlideRect, slideTitle } from './slides.ts'

/** The controls hide after this long without pointer movement or a key press (F21). */
const IDLE_MS = 2000
const SLIDE_ANIMATION_MS = 480
const SWIPE_PX = 50

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

export function PresentOverlay({ editor, presenter }: { editor: Editor; presenter: Presenter }) {
  const presenting = useValue('dr-presenting', () => presenter.isPresenting(), [presenter])
  // Leaving the board (unmount, access lost, sync error) ends the presentation and restores everything.
  useEffect(() => () => presenter.stop(), [presenter])
  if (!presenting) return null
  return <PresentChrome editor={editor} presenter={presenter} />
}

function PresentChrome({ editor, presenter }: { editor: Editor; presenter: Presenter }) {
  const rootRef = useRef<HTMLElement | null>(null)
  const setRoot = useCallback(
    (el: HTMLElement | null) => {
      rootRef.current = el
      presenter.setOverlayElement(el)
    },
    [presenter],
  )
  const index = useValue('dr-present-index', () => presenter.current().index, [presenter])
  const count = useValue('dr-present-count', () => presenter.current().count, [presenter])
  const slide = useValue('dr-present-slide', () => presenter.current().slide, [presenter])
  const slides = useValue('dr-present-slides', () => presenter.slides(), [presenter])
  const gridOpen = useValue('dr-present-grid', () => presenter.state.get()?.gridOpen ?? false, [presenter])
  const mode = useValue('dr-present-mode', () => presenter.state.get()?.mode ?? 'window', [presenter])
  const viewport = useValue('dr-present-viewport', () => {
    const b = editor.getViewportScreenBounds()
    return `${Math.round(b.w)}x${Math.round(b.h)}`
  }, [editor])

  // Fit the camera to the slide: animated when the slide changes (unless reduced motion), immediate when
  // the viewport (entering fullscreen, window resize) or the frame itself changes.
  const fitKey = slide
    ? `${slide.id}|${slide.bounds.x}|${slide.bounds.y}|${slide.bounds.w}|${slide.bounds.h}|${viewport}`
    : ''
  const lastSlideId = useRef<string | null>(null)
  // Runs when fitKey changes (slide id, frame bounds or viewport size); `slide` is this render's value.
  useLayoutEffect(() => {
    if (!slide) return
    const animate =
      lastSlideId.current !== null && lastSlideId.current !== slide.id && !prefersReducedMotion()
    lastSlideId.current = slide.id
    editor.zoomToBounds(
      slide.bounds,
      animate
        ? { inset: 0, force: true, animation: { duration: SLIDE_ANIMATION_MS } }
        : { inset: 0, force: true, immediate: true },
    )
  }, [fitKey, editor])

  // A collaborator deleted/skipped the current frame: stay on the slide now shown.
  const slideId = slide?.id ?? null
  useEffect(() => {
    if (slideId) presenter.settle()
  }, [presenter, slideId, index])

  // The window in the surround is where the slide sits once fitted: it stays put while the camera flies
  // between slides (content passes behind it, like a projector screen), so nothing flickers.
  const hole = useValue('dr-present-hole', () => {
    const s = presenter.current().slide
    if (!s) return null
    const vp = editor.getViewportScreenBounds()
    const { zoomSteps } = editor.getCameraOptions()
    const base = editor.getBaseZoom()
    const r = fittedSlideRect(
      s.bounds,
      { w: vp.w, h: vp.h },
      { min: (zoomSteps[0] ?? 0.1) * base, max: (zoomSteps[zoomSteps.length - 1] ?? 8) * base },
    )
    return `${r.x}|${r.y}|${r.w}|${r.h}`
  }, [editor, presenter])
  const [hx, hy, hw, hh] = (hole ?? '0|0|0|0').split('|').map(Number)

  // Controls and the pointer hide after a moment without movement (and come back on any input).
  const [idle, setIdle] = useState(false)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const wake = () => {
      setIdle(false)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setIdle(true), IDLE_MS)
    }
    wake()
    const root = rootRef.current
    root?.addEventListener('pointermove', wake)
    root?.addEventListener('pointerdown', wake)
    window.addEventListener('keydown', wake, true)
    return () => {
      if (timer) clearTimeout(timer)
      root?.removeEventListener('pointermove', wake)
      root?.removeEventListener('pointerdown', wake)
      window.removeEventListener('keydown', wake, true)
    }
  }, [])

  // Focus moves into the presentation (keys work anywhere, but assistive tech should land here).
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true })
  }, [])

  // Swipe left/right on touch screens.
  const swipe = useRef<{ x: number; y: number } | null>(null)

  // The slide list takes focus when it opens (on the current slide) and gives it back to its toggle.
  const gridRef = useRef<HTMLDivElement | null>(null)
  const gridToggleRef = useRef<HTMLButtonElement | null>(null)
  const wasGridOpen = useRef(false)
  useEffect(() => {
    if (gridOpen) {
      const current = gridRef.current?.querySelector<HTMLElement>('[aria-current="true"]')
      ;(current ?? gridRef.current?.querySelector<HTMLElement>('[data-slide-option]'))?.focus()
    } else if (wasGridOpen.current) {
      const active = document.activeElement
      if (!active || active === document.body || !rootRef.current?.contains(active)) {
        gridToggleRef.current?.focus()
      }
    }
    wasGridOpen.current = gridOpen
  }, [gridOpen])

  const title = slide ? slideTitle(slide.name, index) : ''
  const atStart = index <= 0
  const atEnd = index >= count - 1

  return (
    <section
      ref={setRoot}
      className="dr-present"
      data-testid="present-overlay"
      data-mode={mode}
      data-idle={idle && !gridOpen && count > 0 ? 'true' : 'false'}
      aria-roledescription="presentation"
      aria-label="Presentation"
      tabIndex={-1}
    >
      <div
        className="dr-present__mask"
        aria-hidden="true"
        style={{ transform: `translate(${hx}px, ${hy}px)`, width: hw, height: hh }}
      />
      <div
        className="dr-present__shield"
        aria-hidden="true"
        onPointerDown={(e) => {
          swipe.current = { x: e.clientX, y: e.clientY }
        }}
        onPointerUp={(e) => {
          const start = swipe.current
          swipe.current = null
          if (!start) return
          const dx = e.clientX - start.x
          const dy = e.clientY - start.y
          if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy)) presenter.go(dx < 0 ? 1 : -1)
        }}
        onContextMenu={(e) => e.preventDefault()}
      />

      {count === 0 ? (
        <div className="dr-present__empty" role="alert" data-testid="present-empty">
          <p>No slides left: the frames were removed or set to skip.</p>
          <button
            type="button"
            className="dr-btn dr-btn--primary"
            data-testid="present-empty-exit"
            onClick={() => presenter.stop()}
          >
            Back to the board
          </button>
        </div>
      ) : (
        <div className="dr-present__bar" data-testid="present-controls">
          <button
            type="button"
            className="dr-present__btn"
            data-testid="present-prev"
            aria-label="Previous slide"
            aria-disabled={atStart}
            onClick={() => presenter.go(-1)}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path
                d="M15 5l-7 7 7 7"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <span className="dr-present__counter" data-testid="present-counter" data-index={index}>
            {index + 1} / {count}
          </span>
          <button
            type="button"
            className="dr-present__btn"
            data-testid="present-next"
            aria-label="Next slide"
            aria-disabled={atEnd}
            onClick={() => presenter.go(1)}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path
                d="M9 5l7 7-7 7"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <span className="dr-present__title" title={title}>
            {title}
          </span>
          <button
            ref={gridToggleRef}
            type="button"
            className="dr-present__btn dr-present__btn--text"
            data-testid="present-grid-toggle"
            aria-expanded={gridOpen}
            aria-controls={gridOpen ? 'dr-present-grid' : undefined}
            aria-keyshortcuts="G"
            onClick={() => presenter.setGridOpen(!gridOpen)}
          >
            Slides
          </button>
          <button
            type="button"
            className="dr-present__btn dr-present__btn--text"
            data-testid="present-exit"
            aria-keyshortcuts="Escape"
            onClick={() => presenter.stop()}
          >
            Exit
          </button>
        </div>
      )}

      {gridOpen && count > 0 && (
        <div
          ref={gridRef}
          id="dr-present-grid"
          className="dr-present__grid"
          role="dialog"
          aria-label="Slides"
          data-testid="present-grid"
        >
          <ol>
            {slides.map((s, i) => (
              <li key={s.id}>
                <button
                  type="button"
                  data-slide-option={s.id}
                  aria-current={i === index ? 'true' : undefined}
                  onClick={() => presenter.goTo(i)}
                >
                  <span className="dr-present__grid-num">{i + 1}</span>
                  <span className="dr-present__grid-name">{slideTitle(s.name, i)}</span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}

      <p className="dr-sr-only" aria-live="polite">
        {count > 0 ? `Slide ${index + 1} of ${count}: ${title}` : 'No slides left'}
      </p>
    </section>
  )
}
