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
}

export function describeSyncError(reason: string): string {
  return MESSAGES[reason] ?? 'The connection to this board ended unexpectedly.'
}

/** Terminal sync errors are not retried by useSync; Retry remounts the board (new socket, new store). */
export function SyncErrorScreen({ reason, onRetry }: { reason: string; onRetry(): void }) {
  const reloadFirst = reason === 'CLIENT_TOO_OLD' || reason === 'SERVER_TOO_OLD'
  return (
    <div className="dr-screen dr-screen--overlay" data-testid="sync-error" role="alert">
      <div className="dr-card dr-card--narrow">
        <h1 className="dr-card__title">Can't reach this board</h1>
        <p>{describeSyncError(reason)}</p>
        <p className="dr-muted">
          Reason: <code data-testid="sync-error-reason">{reason}</code>
        </p>
        <div className="dr-row">
          <button
            type="button"
            className={`dr-btn ${reloadFirst ? '' : 'dr-btn--primary'}`}
            data-testid="sync-retry"
            onClick={onRetry}
          >
            Retry
          </button>
          <button
            type="button"
            className={`dr-btn ${reloadFirst ? 'dr-btn--primary' : ''}`}
            onClick={() => location.reload()}
          >
            Reload page
          </button>
        </div>
      </div>
    </div>
  )
}
