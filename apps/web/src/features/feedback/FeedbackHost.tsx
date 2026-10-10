// Renders the feedback dialog when something asked for it (state.ts openFeedback). Mounted once, at the root
// of the app, inside the session: the board's menu and the account menu both close as they run their
// entries, so neither can own the dialog.
import { useValue } from '../../lib/signals.ts'
import { FeedbackDialog } from './FeedbackDialog.tsx'
import { closeFeedback, feedbackRequest } from './state.ts'

export function FeedbackHost() {
  const request = useValue(feedbackRequest)
  if (!request) return null
  const { restoreFocus } = request
  return (
    <FeedbackDialog
      key={request.seq}
      board={request.board}
      prefill={request.prefill}
      onClose={() => {
        closeFeedback()
        // after the dialog has gone (its own cleanup puts the keyboard on the page, which is no place for it)
        if (restoreFocus) requestAnimationFrame(restoreFocus)
      }}
    />
  )
}
