// The feedback entries of the account menu (wave J5): "Send feedback" for everybody signed in (a name-only
// guest included), and "Feedback inbox" for the people the api says read it (GET /api/feedback/access, asked
// when the menu opens; a failure shows nothing, never a guess). The dialog is FeedbackHost's: this only asks.
import { useEffect, useState } from 'react'
import { linkClick } from '../../lib/routing.ts'
import { feedbackApi } from './api.ts'
import { openFeedback } from './state.ts'
import './feedback.css'

export const FEEDBACK_PATH = '/feedback'

/** What the api answered for each person this page load has seen (the answer holds until the page reloads). */
const adminByUser = new Map<string, boolean>()

function useFeedbackAdmin(userId: string, enabled: boolean): boolean {
  const [admin, setAdmin] = useState(() => adminByUser.get(userId) ?? false)
  useEffect(() => {
    if (!enabled) return
    const known = adminByUser.get(userId)
    if (known !== undefined) return setAdmin(known)
    const controller = new AbortController()
    feedbackApi()
      .access(controller.signal)
      .then(
        (a) => {
          adminByUser.set(userId, a.admin)
          if (!controller.signal.aborted) setAdmin(a.admin)
        },
        () => {},
      )
    return () => controller.abort()
  }, [userId, enabled])
  return admin
}

export function FeedbackMenuEntries({
  userId,
  guest,
  onDone,
}: {
  userId: string
  guest: boolean
  /** Closes the menu (the entries close it as they run). */
  onDone(): void
}) {
  const admin = useFeedbackAdmin(userId, !guest)
  return (
    <div className="dr-account__feedback">
      <button
        type="button"
        className="dr-btn"
        data-testid="feedback-send"
        onClick={() => {
          openFeedback(null)
          onDone()
        }}
      >
        Send feedback
      </button>
      {admin && (
        <a
          className="dr-btn"
          href={FEEDBACK_PATH}
          data-testid="feedback-inbox-link"
          onClick={(e) => {
            linkClick(FEEDBACK_PATH)(e)
            onDone()
          }}
        >
          Feedback inbox
        </a>
      )}
    </div>
  )
}
