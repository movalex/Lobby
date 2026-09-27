import { useCallback, useEffect, useRef, useState } from 'react'
import { api, isApiError } from '../api/client.ts'
import { useSession } from '../auth/session.tsx'
import { Wordmark } from '../brand/Wordmark.tsx'
import { formatDateTime } from '../lib/format.ts'
import { boardPath, invitePath, linkClick, navigate, signInPath, workspacePath } from '../lib/routing.ts'
import { useResource } from '../lib/useResource.ts'
import { LoadingScreen, MessageScreen } from '../ui/screens.tsx'
import {
  fetchGoneDetails,
  type GoneDetails,
  goneCopy,
  invitationSummary,
  rememberAcceptIntent,
  safeSessionStorage,
  takeAcceptIntent,
} from './model.ts'

/** /invite/:token — public preview; accepting needs a session (sign in first, then come back here). */
export function InvitePage({ token }: { token: string }) {
  const { state, refresh } = useSession()
  const load = useCallback((signal: AbortSignal) => api.getInvitation(token, signal), [token])
  const preview = useResource(load)
  const [accepting, setAccepting] = useState(false)
  const [acceptError, setAcceptError] = useState<{ gone: boolean; message: string } | null>(null)
  // A link that no longer works (PRI-04): who sent it, and — only for someone who can open the board
  // right now — the board, which then opens instead of a dead end.
  const [gone, setGone] = useState<GoneDetails | 'loading' | null>(null)
  const previewGone = preview.status === 'error' && preview.error.kind === 'gone'
  const signedInId = state.status === 'signed-in' ? state.me.user.id : null
  useEffect(() => {
    if (!previewGone && !acceptError?.gone) return
    let live = true
    setGone('loading')
    void fetchGoneDetails(token).then((d) => {
      if (!live) return
      if (d?.boardId) navigate(boardPath(d.boardId), { replace: true })
      else setGone(d ?? { invitedBy: null, boardId: null })
    })
    return () => {
      live = false
    }
    // The answer depends on who is signed in (the board id is only for people with access).
  }, [previewGone, acceptError?.gone, token, signedInId])

  const accept = useCallback(async () => {
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
      setAccepting(false)
      // A used-up, revoked or expired link: the effect above opens the board for someone who still
      // has access (e.g. who joined earlier), or explains whom to ask.
      setAcceptError({
        gone: isApiError(e) && e.kind === 'gone',
        message: isApiError(e) ? e.message : 'The invitation could not be accepted. Try again.',
      })
    }
  }, [token, refresh])

  // PRI-16: back from "Sign in to accept": accept right away (once), no second click.
  const autoAccepted = useRef(false)
  const ready = preview.status === 'ready' && state.status === 'signed-in'
  useEffect(() => {
    if (!ready || autoAccepted.current) return
    if (!takeAcceptIntent(safeSessionStorage(), token)) return
    autoAccepted.current = true
    void accept()
  }, [ready, token, accept])

  if (preview.status === 'loading' || state.status === 'loading' || gone === 'loading') {
    return <LoadingScreen label="Loading invitation…" testId="invite-loading" />
  }
  if (previewGone || acceptError?.gone) {
    const copy = goneCopy(gone)
    return <MessageScreen testId="invite-invalid" title={copy.title} body={copy.body} />
  }
  if (preview.status === 'error') {
    const missing = preview.error.kind === 'not-found'
    return (
      <MessageScreen
        testId="invite-invalid"
        title={missing ? 'Invitation not found' : 'Invitation unavailable'}
        body={missing ? 'Check that you copied the whole link, or ask for a new one.' : preview.error.message}
      />
    )
  }

  const inv = preview.data
  const summary = invitationSummary(inv)
  const signedIn = state.status === 'signed-in'
  const here = invitePath(token)

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
              onClick={(e) => {
                rememberAcceptIntent(safeSessionStorage(), token)
                linkClick(signInPath(here))(e)
              }}
            >
              Sign in to accept
            </a>
            <p className="dr-invite-card__as">You'll join right after signing in.</p>
          </>
        )}
      </div>
    </main>
  )
}
