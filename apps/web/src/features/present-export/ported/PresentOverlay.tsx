// The presentation chrome on the Excalidraw page (the port of ../PresentOverlay.tsx; same markup, test ids
// and copy): a screen-layer overlay that stays in focus mode, inside the board's canvas region (so inside
// the fullscreen element): a dark surround with a hole at the current frame, an input shield over the
// canvas, a small auto-hiding control bar (previous / counter / next / slide list / exit) and a
// screen-reader announcement. present-live's controls come through ./live-slots.ts.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { CanvasFeatureContext, LobbyCanvas } from '../../../canvas/api/index.ts'
import { useValue } from '../../../lib/signals.ts'
import { Dialog } from '../../../ui/Dialog.tsx'
import { fittedSlideRect, type Insets, slideTitle } from '../slides.ts'
import { type Controller, getController } from './controller.ts'
import { presentInsets, presentTopChromeOf } from './insets.ts'
import { presentLiveOf } from './live-slots.ts'
import { canvasSize, PRESENT_ZOOM_RANGE, type Presenter } from './presenter.ts'

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

/** The canvas's size in screen px, re-read when the canvas resizes (fullscreen, a window resize). */
function useViewSize(canvas: LobbyCanvas): { w: number; h: number } {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const bump = () => setTick((n) => n + 1)
    const off = canvas.on('resize', bump)
    // the region's own layout too: the engine's resize report lags it (fullscreen, the chrome)
    const root = canvas.container()
    const ro = root && typeof ResizeObserver === 'function' ? new ResizeObserver(bump) : null
    if (root) ro?.observe(root)
    return () => {
      off()
      ro?.disconnect()
    }
  }, [canvas])
  const key = useValue('lobby-present-screen', () => {
    canvas.viewport.screenRect() // re-read when the engine's view changes too
    const r = canvasSize(canvas)
    return `${Math.round(r.w)}x${Math.round(r.h)}`
  }, [canvas, tick])
  const [w, h] = key.split('x').map(Number)
  return { w: w ?? 0, h: h ?? 0 }
}

export function PresentOverlay({ ctx }: { ctx: CanvasFeatureContext }) {
  const controller = getController(ctx.canvas)
  const presenter = controller.presenter
  const presenting = useValue('lobby-presenting', () => presenter.isPresenting(), [presenter])
  const choice = useValue('lobby-present-choice', () => controller.presentChoice.get(), [controller])
  // Leaving the board (unmount, access lost, sync error) ends the presentation and restores everything.
  // A live presentation to everyone is not ended from here: the api ends it after its grace unless
  // this tab comes back (present-live).
  useEffect(() => () => presenter.stop({ reason: 'unmount' }), [presenter])
  useEffect(() => () => controller.cancelPresent(), [controller])
  if (!presenting)
    return choice ? (
      <PresentChoiceDialog key={choice.seq} count={choice.count} controller={controller} />
    ) : null
  return <PresentChrome ctx={ctx} presenter={presenter} />
}

/**
 * Wave K.1 (K3-5, follow-up 3): with other people on the board, Present asks before anything goes live to them.
 * "Present to everyone (N here)" is the default button (it has the focus: Enter takes it); "Just me" presents
 * in this tab only ("Invite everyone" stays in the bar). Escape, × or a click outside starts nothing. The
 * dialog is closed (and the focus back on what opened it) before present mode starts, in the same gesture,
 * so full screen is still allowed and the presentation gives the focus back to the Present button after.
 */
function PresentChoiceDialog({ count, controller }: { count: number; controller: Controller }) {
  // the default: Enter presents to everyone, as Present did before it asked (focused after the dialog's own
  // first focus: a parent's effect runs after its child's)
  const everyoneRef = useRef<HTMLButtonElement>(null)
  useEffect(() => everyoneRef.current?.focus(), [])
  // K.1 refix: the key repeat of an Enter (or Space) held down on Present, or on Ctrl/Cmd+Alt+Enter, would land
  // on the focused default and go live to everyone without a choice: only a fresh key press chooses.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat && (e.key === 'Enter' || e.key === ' ')) e.preventDefault()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  const choose = (audience: 'everyone' | 'me') => {
    flushSync(() => controller.cancelPresent())
    controller.presentTo(audience)
  }
  const people = count === 1 ? '1 other person is' : `${count} other people are`
  return (
    <Dialog
      title="Present to everyone?"
      description={`${people} on this board. Presenting to everyone shows them your slides as you present (they can follow or not).`}
      testId="present-choice"
      onClose={() => controller.cancelPresent()}
    >
      <div className="dr-dialog__actions">
        <button type="button" className="dr-btn" data-testid="present-choice-me" onClick={() => choose('me')}>
          Just me
        </button>
        <button
          type="button"
          className="dr-btn dr-btn--primary"
          data-testid="present-choice-everyone"
          ref={everyoneRef}
          onClick={() => choose('everyone')}
        >
          Present to everyone ({count} here)
        </button>
      </div>
    </Dialog>
  )
}

function PresentChrome({ ctx, presenter }: { ctx: CanvasFeatureContext; presenter: Presenter }) {
  const canvas = ctx.canvas
  const rootRef = useRef<HTMLElement | null>(null)
  const setRoot = useCallback(
    (el: HTMLElement | null) => {
      rootRef.current = el
      presenter.setOverlayElement(el)
    },
    [presenter],
  )
  const index = useValue('lobby-present-index', () => presenter.current().index, [presenter])
  const count = useValue('lobby-present-count', () => presenter.current().count, [presenter])
  const slide = useValue('lobby-present-slide', () => presenter.current().slide, [presenter])
  const slides = useValue('lobby-present-slides', () => presenter.slides(), [presenter])
  const gridOpen = useValue('lobby-present-grid', () => presenter.state.get()?.gridOpen ?? false, [presenter])
  const mode = useValue('lobby-present-mode', () => presenter.state.get()?.mode ?? 'window', [presenter])
  // present-live: following someone's presentation (no slide controls), or presenting it to everyone.
  const following = useValue('lobby-present-following', () => presenter.state.get()?.role === 'follower', [
    presenter,
  ])
  const live = useValue('lobby-present-live', () => presentLiveOf(canvas).get(), [canvas])
  const liveHere = useValue('lobby-present-live-here', () => live?.presentingLive() ?? false, [live])
  const view = useViewSize(canvas)
  // K3-4: the band the timer, the hands, the live banner (top) and the control bar (bottom) float in is
  // kept free, so they never cover the slide (./insets.ts).
  const insetsKey = useValue('lobby-present-insets', () => {
    const top = { ...presentTopChromeOf(canvas), banner: live?.banner?.() ?? false }
    const i = presentInsets(view, top, count > 0)
    return `${i.top}|${i.right}|${i.bottom}|${i.left}`
  }, [canvas, live, view.w, view.h, count])
  const insets = useMemo<Insets>(() => {
    const [top = 0, right = 0, bottom = 0, left = 0] = insetsKey.split('|').map(Number)
    return { top, right, bottom, left }
  }, [insetsKey])

  // The window in the surround is where the slide sits once fitted: it stays put while the camera flies
  // between slides (content passes behind it, like a projector screen), so nothing flickers. The camera
  // is set from the same numbers.
  const hole = slide ? fittedSlideRect(slide.bounds, view, PRESENT_ZOOM_RANGE, insets) : null

  // Fit the camera to the slide: animated when the slide changes (unless reduced motion), immediate when
  // the view (entering fullscreen, window resize), the insets (a timer starts) or the frame itself changes.
  const fitKey = slide
    ? `${slide.id}|${slide.bounds.x}|${slide.bounds.y}|${slide.bounds.w}|${slide.bounds.h}|${view.w}x${view.h}|${insetsKey}`
    : ''
  const lastSlideId = useRef<string | null>(null)
  // Runs when fitKey changes (slide id, frame bounds or view size); `slide` is this render's value.
  useLayoutEffect(() => {
    if (!slide || !hole || view.w <= 0 || view.h <= 0) return
    const animate =
      lastSlideId.current !== null && lastSlideId.current !== slide.id && !prefersReducedMotion()
    lastSlideId.current = slide.id
    const zoom = hole.zoom
    canvas.viewport.set(
      { x: slide.bounds.x - hole.x / zoom, y: slide.bounds.y - hole.y / zoom, zoom },
      animate ? { animate: { durationMs: SLIDE_ANIMATION_MS }, force: true } : { force: true },
    )
  }, [fitKey, canvas])

  // A collaborator deleted/skipped the current frame: stay on the slide now shown.
  const slideId = slide?.id ?? null
  useEffect(() => {
    if (slideId) presenter.settle()
  }, [presenter, slideId, index])

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
  const LiveTop = live?.Top
  const LiveBar = live?.Bar

  return (
    <section
      ref={setRoot}
      className="dr-present"
      data-testid="present-overlay"
      data-mode={mode}
      data-idle={idle && !gridOpen && count > 0 ? 'true' : 'false'}
      data-insets={insetsKey}
      aria-roledescription="presentation"
      aria-label="Presentation"
      tabIndex={-1}
    >
      {/* W5-24: the window is the slide's exact rectangle: in focus mode the board session turns the
          engine's frame outline and names off (canvas/board/session.ts applyFocusFrames), so there is
          no edge to cover and nothing of the slide goes under the surround. */}
      <div
        className="dr-present__mask"
        aria-hidden="true"
        data-testid="present-mask"
        style={
          hole
            ? {
                transform: `translate(${hole.x}px, ${hole.y}px)`,
                width: Math.max(0, hole.w),
                height: Math.max(0, hole.h),
              }
            : { width: 0, height: 0 }
        }
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
        onWheel={(e) => e.stopPropagation()}
      />

      {LiveTop ? <LiveTop ctx={ctx} /> : null}

      {count === 0 ? (
        <div className="dr-present__empty" role="alert" data-testid="present-empty">
          <p>No slides left: the frames were removed or set to skip.</p>
          <button
            type="button"
            className="dr-btn dr-btn--primary"
            data-testid="present-empty-exit"
            onClick={() => presenter.stop({ reason: 'local', view: following ? 'here' : 'restore' })}
          >
            Back to the board
          </button>
        </div>
      ) : following ? (
        // Following a live presentation: where we are; the presenter changes the slides, and the
        // banner at the top has "Stop following".
        <div className="dr-present__bar" data-testid="present-controls" data-role="follower">
          <span className="dr-present__counter" data-testid="present-counter" data-index={index}>
            {index + 1} / {count}
          </span>
          <span className="dr-present__title" title={title}>
            {title}
          </span>
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
          {LiveBar ? <LiveBar ctx={ctx} /> : null}
          <button
            type="button"
            className="dr-present__btn dr-present__btn--text"
            data-testid="present-exit"
            aria-keyshortcuts="Escape"
            aria-label={liveHere ? 'End the presentation for everyone' : undefined}
            title={liveHere ? 'End the presentation for everyone (Esc)' : undefined}
            onClick={() => presenter.stop()}
          >
            {liveHere ? 'End' : 'Exit'}
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
