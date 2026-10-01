// Skip links (A11Y-09): the first Tab stop of a page, hidden until it has the keyboard focus. The
// dashboard's "Skip to boards" jumps past the sidebar to the board list's heading; the board's "Skip to
// canvas" jumps past the top bar and the panel rail to the canvas.
import './skip-link.css'

/**
 * Dispatched on `document` after a skip link's own `onSkip` ran. The board page's a11y feature
 * (features/a11y/ported) listens for it and enters the canvas the way F6 does (the first element in
 * reading order selected when nothing is).
 */
export const SKIP_TO_CANVAS_EVENT = 'draftroom:skip-to-canvas'

export function SkipLink({ label, testId, onSkip }: { label: string; testId: string; onSkip(): void }) {
  return (
    <button
      type="button"
      className="dr-skip"
      data-testid={testId}
      onClick={() => {
        onSkip()
        if (testId === 'skip-to-canvas') document.dispatchEvent(new CustomEvent(SKIP_TO_CANVAS_EVENT))
      }}
    >
      {label}
    </button>
  )
}

/** A11Y2-09: the accessible name of the board's canvas region ("Lobby tour board"). */
export function boardRegionName(title: string): string {
  const t = title.trim()
  return t ? `${t} board` : 'Untitled board'
}
