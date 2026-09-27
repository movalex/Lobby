import { saveLabel, saveTitle } from './copy.ts'
import type { Rejection } from './saveTracker.ts'
import type { DisplayState } from './useSaveStatus.ts'
import './sync-quality.css'

export interface SaveStatusView {
  state: DisplayState
  rejection: Rejection | null
  readonly: boolean
  /** This tab's file uploads in flight. */
  uploading?: number
  /** The caller's board role: a commenter's read-only line says her comments are saved. */
  role?: string
}

const TONE: Record<DisplayState, 'quiet' | 'busy' | 'warn' | 'danger'> = {
  connecting: 'busy',
  saved: 'quiet',
  saving: 'busy',
  offline: 'warn',
  'offline-pending': 'warn',
  rejected: 'danger',
  error: 'danger',
  unsupported: 'quiet',
  readonly: 'quiet',
}

function Icon({ state }: { state: DisplayState }) {
  if (state === 'saved')
    return (
      <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
        <path
          d="M5 12.5l4.2 4.2L19 7"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  if (state === 'rejected' || state === 'error')
    return (
      <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
        <path d="M12 7v6m0 4h.01" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      </svg>
    )
  return <span className="dr-save__dot" aria-hidden="true" />
}

/**
 * The truthful save indicator (WRK-03). "Saved" only once the server acknowledged every document
 * change this tab made (docs/research/saved-indicator.md). The live connection pill stays separate.
 */
export function SaveStatus({ view, hidden = false }: { view: SaveStatusView; hidden?: boolean }) {
  const { state } = view
  return (
    <span
      className={`dr-save dr-save--${TONE[state]}`}
      data-testid="save-status"
      data-state={state}
      data-role={view.role}
      role="status"
      aria-live="polite"
      // Hidden, not removed, when the role pill already says it: it comes back by itself if the
      // session goes offline or errors.
      hidden={hidden}
      title={saveTitle(state, view.rejection, view.readonly, view.uploading, view.role)}
    >
      <Icon state={state} />
      <span className="dr-save__label">{saveLabel(state, view.role)}</span>
    </span>
  )
}
