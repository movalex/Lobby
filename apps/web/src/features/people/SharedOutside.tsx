// Wave J: the "Shared outside" marker on the board's top bar and its dashboard card, while someone
// outside Dark Burn Creative and Trailer Park Group (an outside account or a name-only guest) can open the
// board, or a review, workshop or guest link is open. The server computes it (ShareState.sharedOutside,
// the board lists' sharedOutside, the board's outside list); this only draws it, with its meaning in
// words (title and screen-reader text).
import { SHARED_OUTSIDE_LABEL, SHARED_OUTSIDE_TITLE } from '@draftroom/contracts'
import './outside.css'

export function SharedOutsideMarker({
  testId = 'shared-outside',
  compact = false,
}: {
  testId?: string
  compact?: boolean
}) {
  return (
    <span className="dr-shared-outside" data-testid={testId} title={SHARED_OUTSIDE_TITLE} role="note">
      <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
        <path
          d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3.5 12h17M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
      </svg>
      <span className={compact ? 'dr-sr-only' : undefined}>{SHARED_OUTSIDE_LABEL}</span>
      <span className="dr-sr-only">: {SHARED_OUTSIDE_TITLE}</span>
    </span>
  )
}
