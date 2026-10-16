// OWNER: WS4 (wave S, the client review page). The `?view=review` overlay on the board route (docs/WAVE-S-CONTRACTS.md
// §6): a modal <dialog> filling the screen, portalled to <body> like the PDF and review viewers, over the mounted board
// in focus mode (the board's chrome is hidden under it; the board keeps its ticket, sync session and access checks).
// It renders nothing unless the review page switch is on and the address says `?view=review`. "Open the board" and Escape
// leave it (the address goes back to the board); keys pressed in it stop at the dialog, so the board's shortcuts and
// Excalidraw never see them.
import { REVIEW_VIEW_PARAM, REVIEW_VIEW_VALUE } from '@draftroom/contracts'
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { boardPath, navigate, useLocationKey } from '../../lib/routing.ts'
import { reviewFlags } from '../review/flags.ts'
import { ReviewPage } from './ReviewPage.tsx'
import './review-page.css'

/** Whether an address's query asks for the review page. */
export const isReviewView = (search: string): boolean =>
  new URLSearchParams(search).get(REVIEW_VIEW_PARAM) === REVIEW_VIEW_VALUE

export function ReviewPageHost({ ctx }: { ctx: CanvasFeatureContext }) {
  useLocationKey() // re-render when the address changes
  const on = reviewFlags().reviewPage && isReviewView(location.search)
  if (!on) return null
  return createPortal(<ReviewDialog ctx={ctx} />, document.body)
}

function ReviewDialog({ ctx }: { ctx: CanvasFeatureContext }) {
  const ref = useRef<HTMLDialogElement>(null)
  const close = () => navigate(boardPath(ctx.board.id), { replace: true })
  const closeRef = useRef(close)
  closeRef.current = close

  // Focus mode while the page is open (the board under it hides its chrome); restored as it was.
  useEffect(() => {
    const before = ctx.canvas.settings.get().focusMode
    if (!before) ctx.canvas.settings.set({ focusMode: true })
    return () => {
      if (!before) ctx.canvas.settings.set({ focusMode: false })
    }
  }, [ctx.canvas])

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (!dialog.open) dialog.showModal()
    const keydown = (e: KeyboardEvent) => e.stopPropagation()
    const outside = (e: KeyboardEvent) => {
      if (e.target instanceof Node && dialog.contains(e.target)) return
      e.stopPropagation()
      dialog.focus({ preventScroll: true })
    }
    dialog.addEventListener('keydown', keydown)
    window.addEventListener('keydown', outside, true)
    return () => {
      dialog.removeEventListener('keydown', keydown)
      window.removeEventListener('keydown', outside, true)
      if (dialog.open) dialog.close()
    }
  }, [])

  return (
    <dialog
      ref={ref}
      className="dr-rp"
      data-testid="review-page"
      data-board-id={ctx.board.id}
      tabIndex={-1}
      aria-labelledby="dr-rp-title"
      onCancel={(e) => {
        e.preventDefault() // we leave through the address instead of letting the browser close it
        closeRef.current()
      }}
    >
      <ReviewPage ctx={ctx} close={() => closeRef.current()} />
    </dialog>
  )
}
