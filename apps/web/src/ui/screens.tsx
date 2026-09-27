import { type ReactNode, useCallback } from 'react'
import { api } from '../api/client.ts'
import { useSession } from '../auth/session.tsx'
import { Wordmark } from '../brand/Wordmark.tsx'
import { RequestAccess } from '../features/sharing/RequestAccess.tsx'
import type { BoardRole } from '../lib/permissions.ts'
import { linkClick, matchRoute } from '../lib/routing.ts'

export function LoadingScreen({ label = 'Loading…', testId }: { label?: string; testId?: string }) {
  return (
    <div className="dr-screen dr-screen--page" data-testid={testId} role="status" aria-live="polite">
      <span className="dr-spinner" aria-hidden="true" />
      <span className="dr-sr-only">{label}</span>
    </div>
  )
}

export function MessageScreen({
  title,
  body,
  testId,
  actions,
}: {
  title: string
  body: ReactNode
  testId?: string
  actions?: ReactNode
}) {
  return (
    <main className="dr-screen dr-screen--page" data-testid={testId}>
      <div className="dr-card dr-card--narrow">
        <a href="/" onClick={linkClick('/')} className="dr-card__brand" aria-label="Draftroom home">
          <Wordmark />
        </a>
        <h1 className="dr-card__title">{title}</h1>
        <div className="dr-muted dr-card__body">{body}</div>
        <div className="dr-row dr-row--wrap">
          {actions ?? (
            <a className="dr-btn dr-btn--primary" href="/" onClick={linkClick('/')}>
              Go to your boards
            </a>
          )}
        </div>
      </div>
    </main>
  )
}

/**
 * One screen for "not found" and "forbidden": the API answers 404 for both so a board's existence
 * never leaks, and the UI does not try to tell them apart either. On a board link, a signed-in user
 * can request access (PRS-04); the server answers the same whether or not the board exists.
 */
export function NoAccessScreen({
  thing = 'board',
  revoked = false,
  previousRole = null,
}: {
  thing?: 'board' | 'workspace'
  revoked?: boolean
  /** The role they had before it ended (revoked while open): the request form starts from it. */
  previousRole?: BoardRole | null
}) {
  const { signOut, state } = useSession()
  const here = `${location.pathname}${location.search}`
  const route = matchRoute(location.pathname)
  const boardId = thing === 'board' && route.name === 'board' ? route.boardId : null
  const userId = state.status === 'signed-in' ? state.me.user.id : null
  // Once the owner approves, the board opens: reload when the API starts answering for it.
  const checkApproved = useCallback(() => {
    if (!boardId) return
    api.getBoard(boardId).then(
      () => location.reload(),
      () => {},
    )
  }, [boardId])
  return (
    <MessageScreen
      testId="no-access"
      title={
        revoked ? `You no longer have access to this ${thing}` : `You don't have access to this ${thing}`
      }
      body={
        <>
          <p>
            {revoked
              ? `Your access was removed or changed while you had it open, or the ${thing} was moved to trash.`
              : `It may not exist, it may have been moved to trash, or it hasn't been shared with you.`}
          </p>
          {/* An old invite link cannot bring back access that was removed (PRI-04). */}
          <p>
            {revoked
              ? 'Ask its owner for access again: they see your request in their Share dialog.'
              : 'Ask its owner to share it with you, or open the invite link they sent you.'}
          </p>
          {boardId && userId && (
            <div className="dr-noaccess__request">
              <RequestAccess
                key={`${userId}:${boardId}`}
                boardId={boardId}
                userId={userId}
                currentRole={null}
                defaultRole={previousRole === 'owner' ? 'editor' : previousRole}
                onApprovedCheck={checkApproved}
              />
            </div>
          )}
        </>
      }
      actions={
        <>
          <a className="dr-btn dr-btn--primary" href="/" onClick={linkClick('/')}>
            Go to your boards
          </a>
          <button type="button" className="dr-btn" onClick={() => void signOut({ returnTo: here })}>
            Sign in as someone else
          </button>
        </>
      }
    />
  )
}
