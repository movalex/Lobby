import { NEW_CANVAS_BOARD_MESSAGE } from '@draftroom/contracts'
import { linkClick } from '../lib/routing.ts'
import { MessageScreen } from '../ui/screens.tsx'

const MESSAGES: Record<string, string> = {
  NOT_AUTHENTICATED: 'The board server did not accept this connection ticket. Retry to get a new one.',
  FORBIDDEN: 'You do not have access to this board.',
  NOT_FOUND: 'This board does not exist.',
  CLIENT_TOO_OLD: 'Lobby has been updated. Reload the page to continue.',
  SERVER_TOO_OLD: 'The board server is running an older version than this page. Reload to continue.',
  INVALID_RECORD: 'The board server rejected a change from this tab. Reload to continue.',
  RATE_LIMITED: 'Too many changes were sent too quickly. Wait a moment, then retry.',
  ROOM_FULL: 'This board has too many people on it right now.',
  UNKNOWN_ERROR: 'The board could not be opened.',
  // Bridge release R0 (docs/EXCALIDRAW-MIGRATION.md §5.10): the board server's maintenance mode, and a
  // board made on the new canvas, which this build cannot open.
  MAINTENANCE: 'Lobby is updating. Your board opens again in a few minutes: retry then.',
  NEW_CANVAS_BOARD: NEW_CANVAS_BOARD_MESSAGE,
}

/** A heading of its own where "Can't reach this board" would mislead. */
const TITLES: Record<string, string> = {
  MAINTENANCE: 'Lobby is updating',
  NEW_CANVAS_BOARD: 'Made on the new canvas',
}

/**
 * Why a board made on the new canvas does not open: this build only meets one during a rollback to the
 * previous canvas (bridge release R0), after its users have already worked on the new one.
 */
const NOTES: Record<string, string> = {
  NEW_CANVAS_BOARD:
    'Lobby is back on its previous canvas for now. Boards made on the new canvas are kept as they are.',
}

export function describeSyncError(reason: string): string {
  return MESSAGES[reason] ?? 'The connection to this board ended unexpectedly.'
}

export function syncErrorTitle(reason: string): string {
  return TITLES[reason] ?? "Can't reach this board"
}

export function syncErrorNote(reason: string): string | null {
  return NOTES[reason] ?? null
}

type SyncErrorAction = 'retry' | 'reload' | 'boards'

/**
 * The screen's buttons. A board made on the new canvas cannot open on this canvas, so Retry (it would
 * meet the same refusal) and Reload give way to the way back to the boards.
 */
export function syncErrorActions(reason: string): { primary: SyncErrorAction; secondary: SyncErrorAction[] } {
  if (reason === 'NEW_CANVAS_BOARD') return { primary: 'boards', secondary: [] }
  if (reason === 'CLIENT_TOO_OLD' || reason === 'SERVER_TOO_OLD')
    return { primary: 'reload', secondary: ['retry'] }
  return { primary: 'retry', secondary: ['reload'] }
}

function ActionButton({
  action,
  primary,
  onRetry,
}: {
  action: SyncErrorAction
  primary: boolean
  onRetry(): void
}) {
  const cls = `dr-btn ${primary ? 'dr-btn--primary' : ''}`
  if (action === 'boards')
    return (
      <a className={cls} href="/" onClick={linkClick('/')} data-testid="sync-boards">
        Go to your boards
      </a>
    )
  if (action === 'retry')
    return (
      <button type="button" className={cls} data-testid="sync-retry" onClick={onRetry}>
        Retry
      </button>
    )
  return (
    <button type="button" className={cls} onClick={() => location.reload()}>
      Reload page
    </button>
  )
}

/** Terminal sync errors are not retried by useSync; Retry remounts the board (new socket, new store). */
export function SyncErrorScreen({ reason, onRetry }: { reason: string; onRetry(): void }) {
  const { primary, secondary } = syncErrorActions(reason)
  const note = syncErrorNote(reason)
  // Buttons keep their places: the primary one first, as before.
  const order = primary === 'reload' ? ['retry', 'reload'] : [primary, ...secondary]
  return (
    <div className="dr-screen dr-screen--overlay" data-testid="sync-error" role="alert">
      <div className="dr-card dr-card--narrow">
        <h1 className="dr-card__title">{syncErrorTitle(reason)}</h1>
        <p>{describeSyncError(reason)}</p>
        {note && (
          <p className="dr-muted" data-testid="sync-error-note">
            {note}
          </p>
        )}
        <p className="dr-muted">
          Reason: <code data-testid="sync-error-reason">{reason}</code>
        </p>
        <div className="dr-row">
          {(order as SyncErrorAction[]).map((a) => (
            <ActionButton key={a} action={a} primary={a === primary} onRetry={onRetry} />
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * A board the api marks as made on the new canvas (Board.newCanvas), before any socket: the same words
 * as the sync refusal, as a page of its own.
 */
export function NewCanvasBoardScreen() {
  return (
    <MessageScreen
      testId="new-canvas-board"
      reason="NEW_CANVAS_BOARD"
      title={syncErrorTitle('NEW_CANVAS_BOARD')}
      body={
        <>
          <p>{describeSyncError('NEW_CANVAS_BOARD')}</p>
          <p>{syncErrorNote('NEW_CANVAS_BOARD')}</p>
        </>
      }
    />
  )
}
