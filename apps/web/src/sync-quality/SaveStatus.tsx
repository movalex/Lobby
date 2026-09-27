import { SAVE_LABEL, saveTitle } from './copy.ts'
import type { Rejection } from './saveTracker.ts'
import type { DisplayState } from './useSaveStatus.ts'
import './sync-quality.css'

export interface SaveStatusView {
  state: DisplayState
  rejection: Rejection | null
  readonly: boolean
  /** This tab's file uploads in flight. */
  uploading?: number
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
export function SaveStatus({ view }: { view: SaveStatusView }) {
  const { state } = view
  return (
    <span
      className={`dr-save dr-save--${TONE[state]}`}
      data-testid="save-status"
      data-state={state}
      role="status"
      aria-live="polite"
      title={saveTitle(state, view.rejection, view.readonly, view.uploading)}
    >
      <Icon state={state} />
      <span className="dr-save__label">{SAVE_LABEL[state]}</span>
    </span>
  )
}
