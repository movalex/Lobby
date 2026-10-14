// The always-visible "Feedback" pill (wave K, K4-5). Feedback sat in two menus and nobody found it: no real item
// arrived in the first week while eight people opened boards. The pill is one click from the dashboard (the
// board's own pill, K2, uses the same opener) and opens the existing dialog through `openFeedback`
// (state.ts), which FeedbackHost renders at the root of the app. A plain function of its props, so a component
// test can press it.
import { useMayGiveFeedback } from './audience.ts'
import type { FeedbackBoard } from './model.ts'
import { openFeedback } from './state.ts'
import './feedback.css'

export function FeedbackPill({ board = null }: { board?: FeedbackBoard | null }) {
  return (
    <button
      type="button"
      className="dr-fbpill"
      data-testid="feedback-pill"
      onClick={(e) => {
        // the dialog is the app's, not ours: give the keyboard back to this button when it closes
        const button = e.currentTarget
        openFeedback(board, () => button.focus())
      }}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path
          d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 17h-8l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
      </svg>
      Feedback
    </button>
  )
}

/** P-023: the pill for the people Feedback is offered to (the team): nothing for an external client or a guest. */
export function TeamFeedbackPill({ board = null }: { board?: FeedbackBoard | null }) {
  return useMayGiveFeedback() ? <FeedbackPill board={board} /> : null
}
