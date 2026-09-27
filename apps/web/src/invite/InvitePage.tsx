import { useCallback, useState } from 'react'
import { api, isApiError } from '../api/client.ts'
import { useSession } from '../auth/session.tsx'
import { Wordmark } from '../brand/Wordmark.tsx'
import { formatDateTime } from '../lib/format.ts'
import { boardPath, invitePath, linkClick, navigate, signInPath, workspacePath } from '../lib/routing.ts'
import { useResource } from '../lib/useResource.ts'
import { LoadingScreen, MessageScreen } from '../ui/screens.tsx'
import { invitationSummary } from './model.ts'

/** /invite/:token — public preview; accepting needs a session (sign in first, then come back here). */
export function InvitePage({ token }: { token: string }) {
  const { state, refresh } = useSession()
  const load = useCallback((signal: AbortSignal) => api.getInvitation(token, signal), [token])
  const preview = useResource(load)
  const [accepting, setAccepting] = useState(false)
  const [acceptError, setAcceptError] = useState<{ gone: boolean; message: string } | null>(null)

  if (preview.status === 'loading' || state.status === 'loading') {
    return <LoadingScreen label="Loading invitation…" testId="invite-loading" />
  }
  if (preview.status === 'error' || acceptError?.gone) {
    const gone = acceptError?.gone || (preview.status === 'error' && preview.error.kind === 'gone')
    const missing = preview.status === 'error' && preview.error.kind === 'not-found'
    return (
      <MessageScreen
        testId="invite-invalid"
        title={
          gone
            ? 'This invitation is no longer valid'
            : missing
              ? 'Invitation not found'
              : 'Invitation unavailable'
        }
        body={
          gone
            ? 'It has expired, was revoked, or was already used by someone else. Ask the person who invited you for a new link.'
            : missing
              ? 'Check that you copied the whole link, or ask for a new one.'
              : preview.status === 'error'
                ? preview.error.message
                : ''
        }
      />
    )
  }

  const inv = preview.data
  const summary = invitationSummary(inv)
  const signedIn = state.status === 'signed-in'
  const here = invitePath(token)

  const accept = async () => {
    setAccepting(true)
    setAcceptError(null)
    try {
      const result = await api.acceptInvitation(token)
      // A board invitation can add a workspace (guest) membership: refresh before navigating so the
      // dashboard and board pages see it.
      await refresh()
      navigate(result.boardId ? boardPath(result.boardId) : workspacePath(result.workspaceId), {
        replace: true,
      })
    } catch (e) {
      if (isApiError(e) && e.kind === 'unauthorized') {
        setAccepting(false)
        return // the session guard shows sign-in
      }
      // A used-up, revoked or expired link: if this account already joined the board (e.g. through
      // a review link earlier), just open it instead of showing a dead end.
      if (isApiError(e) && e.kind === 'gone' && inv.board) {
        const opened = await api.getBoard(inv.board.id).then(
          () => true,
          () => false,
        )
        if (opened) {
          navigate(boardPath(inv.board.id), { replace: true })
          return
        }
      }
      setAccepting(false)
      setAcceptError({
        gone: isApiError(e) && e.kind === 'gone',
        message: isApiError(e) ? e.message : 'The invitation could not be accepted. Try again.',
      })
    }
  }

  return (
    <main className="dr-screen dr-screen--page" data-testid="invite-page">
      <div className="dr-card dr-card--narrow dr-invite-card">
        <a href="/" onClick={linkClick('/')} className="dr-card__brand" aria-label="Draftroom home">
          <Wordmark />
        </a>
        <p className="dr-invite-card__eyebrow">{summary.eyebrow}</p>
        <h1 className="dr-card__title" data-testid="invite-title">
          {summary.title}
        </h1>
        <dl className="dr-invite-card__facts">
          <div>
            <dt>Invited by</dt>
            <dd data-testid="invite-inviter">{inv.invitedBy.name}</dd>
          </div>
          <div>
            <dt>Workspace</dt>
            <dd>{inv.workspace.name}</dd>
          </div>
          <div>
            <dt>Your role</dt>
            <dd data-testid="invite-role-label">{summary.roleLabel}</dd>
          </div>
          <div>
            <dt>Expires</dt>
            <dd>{formatDateTime(inv.expiresAt)}</dd>
          </div>
        </dl>
        {acceptError && (
          <p className="dr-field-error" role="alert">
            {acceptError.message}
          </p>
        )}
        {signedIn ? (
          <>
            <button
              type="button"
              className="dr-btn dr-btn--primary dr-btn--lg"
              data-testid="invite-accept"
              disabled={accepting}
              onClick={() => void accept()}
            >
              {accepting ? 'Joining…' : summary.acceptLabel}
            </button>
            <p className="dr-invite-card__as">
              You'll join as <strong>{state.me.user.name}</strong>.{' '}
              <a href={signInPath(here)} onClick={linkClick(signInPath(here))}>
                Not you?
              </a>
            </p>
          </>
        ) : (
          <>
            <a
              className="dr-btn dr-btn--primary dr-btn--lg"
              data-testid="invite-signin"
              href={signInPath(here)}
              onClick={linkClick(signInPath(here))}
            >
              Sign in to accept
            </a>
            <p className="dr-invite-card__as">You'll come back here after signing in.</p>
          </>
        )}
      </div>
    </main>
  )
}
