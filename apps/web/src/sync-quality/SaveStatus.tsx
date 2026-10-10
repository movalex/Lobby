import { useEffect, useRef, useState } from 'react'
import { saveLabel, saveTitle } from './copy.ts'
import type { DisplayState, Rejection } from './save-state.ts'
import './sync-quality.css'

export interface SaveStatusView {
  state: DisplayState
  rejection: Rejection | null
  readonly: boolean
  /** This tab's file uploads in flight. */
  uploading?: number
  /** The caller's board role: a commenter's read-only line says her comments are saved. */
  role?: string
  /**
   * The Excalidraw engine's own words (./engineSave.ts): its offline line counts the changes on this
   * device, and a refused change says why from its reject code. The tldraw page leaves both unset.
   */
  label?: string
  title?: string
}

const TONE: Record<DisplayState, 'quiet' | 'busy' | 'warn' | 'danger'> = {
  connecting: 'busy',
  cached: 'busy',
  saved: 'quiet',
  saving: 'busy',
  offline: 'warn',
  'offline-pending': 'warn',
  rejected: 'danger',
  error: 'danger',
  unsupported: 'quiet',
  readonly: 'quiet',
  retrying: 'warn',
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

/** States worth interrupting a screen-reader user for: something is not being saved. */
const TROUBLE: ReadonlySet<DisplayState> = new Set([
  'offline',
  'offline-pending',
  'rejected',
  'error',
  'retrying',
])

export interface Announcement {
  /** What the live region says now, or null to stay quiet. */
  say: string | null
  /** The problem state we are waiting to recover from, if any. */
  trouble: DisplayState | null
}

/**
 * A11Y-14: what the save indicator announces when its state goes from `prev` to `next`. Only problems
 * (offline, a change not saved, the connection ended) and the recovery from one are spoken; the
 * "Saving…" / "Saved" that follow every edit stay visual, or a screen reader would repeat them while
 * someone types in a note. A recovery is announced once everything is stored again, not at the first
 * "Saving…" after it.
 */
export function saveAnnouncement(
  prev: DisplayState | null,
  next: DisplayState,
  trouble: DisplayState | null,
  role?: string,
  label?: string,
): Announcement {
  if (TROUBLE.has(next))
    return { say: prev === next ? null : (label ?? saveLabel(next, role)), trouble: next }
  if (!trouble) return { say: null, trouble: null }
  // Still on the way back: say it when it is all stored (or, read-only, simply connected again).
  if (next === 'saving' || next === 'connecting' || next === 'cached') return { say: null, trouble }
  const wasOffline = trouble !== 'rejected'
  if (next === 'saved')
    return { say: wasOffline ? 'Back online. All changes saved.' : 'Saved.', trouble: null }
  return { say: wasOffline ? 'Back online.' : null, trouble: null }
}

/** The words for the hidden live region, updated only when saveAnnouncement has something to say. */
function useSaveAnnouncement(state: DisplayState, role?: string, label?: string): string {
  const [text, setText] = useState('')
  const prev = useRef<DisplayState | null>(null)
  const trouble = useRef<DisplayState | null>(null)
  useEffect(() => {
    const a = saveAnnouncement(prev.current, state, trouble.current, role, label)
    prev.current = state
    trouble.current = a.trouble
    const say = a.say
    // The same words twice (offline again) must change the region's text to be spoken again.
    if (say) setText((t) => (t === say ? `${say} ` : say))
  }, [state, role, label])
  return text
}

/**
 * The truthful save indicator (WRK-03). "Saved" only once the server acknowledged every document
 * change this tab made (docs/research/saved-indicator.md). The live connection pill stays separate.
 * The pill itself is not a live region (A11Y-14): a hidden one next to it speaks only problems and
 * recoveries.
 */
export function SaveStatus({ view, hidden = false }: { view: SaveStatusView; hidden?: boolean }) {
  const { state } = view
  const announcement = useSaveAnnouncement(state, view.role, view.label)
  return (
    <>
      <span
        className={`dr-save dr-save--${TONE[state]}`}
        data-testid="save-status"
        data-state={state}
        data-role={view.role}
        // Hidden, not removed, when the role pill already says it: it comes back by itself if the
        // session goes offline or errors.
        hidden={hidden}
        title={view.title ?? saveTitle(state, view.rejection, view.readonly, view.uploading, view.role)}
      >
        <Icon state={state} />
        <span className="dr-save__label">{view.label ?? saveLabel(state, view.role)}</span>
      </span>
      <span className="dr-sr-only" role="status" aria-live="polite" data-testid="save-announcer">
        {announcement}
      </span>
    </>
  )
}
