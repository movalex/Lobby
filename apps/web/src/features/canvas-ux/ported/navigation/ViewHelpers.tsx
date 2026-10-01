// Two helpers of the navigation overlay on the new canvas (wave-5 review):
//
//  - "Back to content" (W5-54, tldraw's BackToContent helper button): when the board has content and none
//    of it is in view, a button appears after a second of rest; it brings the selection, else all content,
//    into view at no more than the zoom now (tldraw's back-to-content: zoomToBounds with targetZoom
//    min(1, zoom), 220 ms; immediate under reduced motion, the 3b part's rule).
//  - The outline of a connector or line this feature selected by code (W5-39): a `?el=` link or a search
//    result selects the element through `canvas.select`, and Excalidraw draws no box and no point handles
//    for a lone two-point arrow or line it did not select itself, so the linked connector looked unselected.
//    While that selection stands, Lobby draws the selection outline (a click on the element makes the
//    engine's own handles take over: any change of the selection drops it). The port-level fix (`select`
//    of a lone linear element sets the engine's `selectedLinearElement`) is CR 3b-11 to 2C.
import { useEffect, useState } from 'react'
import type { CanvasFeatureContext } from '../../../../canvas/api/index.ts'
import { react, untracked, useValue } from '../../../../lib/signals.ts'
import { BACK_TO_CONTENT_DELAY_MS, backToContent, codeSelectionBoxes, viewIsEmpty } from './view-helpers.ts'

/** The check runs once the camera is at rest this long (not on every frame of a pan: it reads every item). */
const SETTLE_MS = 150

export function BackToContent({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const [show, setShow] = useState(false)
  useEffect(() => {
    let settle: ReturnType<typeof setTimeout> | null = null
    let appear: ReturnType<typeof setTimeout> | null = null
    const clear = () => {
      if (settle) clearTimeout(settle)
      if (appear) clearTimeout(appear)
      settle = appear = null
    }
    const check = () => {
      settle = null
      if (!viewIsEmpty(canvas)) {
        if (appear) clearTimeout(appear)
        appear = null
        setShow(false)
        return
      }
      appear ??= setTimeout(() => {
        appear = null
        if (viewIsEmpty(canvas)) setShow(true)
      }, BACK_TO_CONTENT_DELAY_MS - SETTLE_MS)
    }
    const stop = react('nav-back-to-content', () => {
      // re-check when the camera or the content changes (the reads themselves are untracked)
      canvas.viewport.get()
      canvas.items()
      untracked(() => {
        if (settle) clearTimeout(settle)
        settle = setTimeout(check, SETTLE_MS)
      })
    })
    return () => {
      stop()
      clear()
    }
  }, [canvas])
  if (!show) return null
  return (
    <button
      type="button"
      className="dr-cnav-back"
      data-testid="navigation.back-to-content"
      onClick={(e) => {
        backToContent(canvas)
        setShow(false)
        if (e.detail > 0) canvas.focus({ preventScroll: true })
      }}
    >
      <svg
        viewBox="0 0 24 24"
        width="16"
        height="16"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M19 12H5M12 19l-7-7 7-7" />
      </svg>
      <span>Back to content</span>
    </button>
  )
}

export function CodeSelectionOutline({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const view = useValue('nav-code-selection-boxes', () => {
    const boxes = codeSelectionBoxes(canvas)
    if (!boxes.length) return null
    const v = canvas.viewport.get()
    return { w: v.width * v.zoom, h: v.height * v.zoom, boxes }
  }, [canvas])
  if (!view) return null
  return (
    <svg
      className="dr-cnav-linked"
      width={view.w}
      height={view.h}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
      data-testid="navigation.code-selection"
      aria-hidden="true"
    >
      {view.boxes.map((b) => (
        <rect
          key={b.id}
          x={b.x}
          y={b.y}
          width={Math.max(0, b.w)}
          height={Math.max(0, b.h)}
          rx="4"
          className="dr-cnav-linked__box"
          data-shape-id={b.id}
        />
      ))}
    </svg>
  )
}
