import { DOMAIN_ACCESS_CODES, GUEST_NAME_MAX, guestNameProblem } from '@draftroom/contracts'
import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react'
import { api, isApiError } from '../api/client.ts'
import { useSession } from '../auth/session.tsx'
import { Wordmark } from '../brand/Wordmark.tsx'
import { formatDateTime } from '../lib/format.ts'
import { boardPath, invitePath, linkClick, navigate, signInPath, workspacePath } from '../lib/routing.ts'
import { useResource } from '../lib/useResource.ts'
import { LoadingScreen, MessageScreen } from '../ui/screens.tsx'
import { fetchInvitation, joinAsGuest, rememberGuestTab, seedUserKind, useUserKind } from './guest.tsx'
import './invite.css'
import {
  acceptErrorCopy,
  emailMismatchCopy,
  fetchGoneDetails,
  type GoneDetails,
  goneCopy,
  guestJoinError,
  guestJoinHint,
  invitationSummary,
  isEmailMismatch,
  lockedHint,
  lockedSignInLabel,
  rememberAcceptIntent,
  safeSessionStorage,
  shouldAutoAccept,
  takeAcceptIntent,
} from './model.ts'

/**
 * /invite/:token — public preview; accepting needs a session (sign in first, then come back here).
 * A guest link (wave 3) also offers "Join as a guest" with just a name.
 */
export function InvitePage({ token }: { token: string }) {
  const { state, refresh, signOut, signingOut } = useSession()
  const kind = useUserKind()
  const load = useCallback((signal: AbortSignal) => fetchInvitation(token, signal), [token])
  const preview = useResource(load)
  const [accepting, setAccepting] = useState(false)
  const [acceptError, setAcceptError] = useState<{ gone: boolean; message: string; retry?: boolean } | null>(
    null,
  )
  // Domain access: accepting answered 403 INVITATION_EMAIL_MISMATCH (the signed-in account has no
  // verified address the invitation is locked to). Nothing was redeemed; the link still works for them.
  const [mismatchAtAccept, setMismatchAtAccept] = useState(false)
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

  const failed = useCallback((e: unknown, fallback: string) => {
    setAccepting(false)
    // A used-up, revoked or expired link: the effect above opens the board for someone who still
    // has access (e.g. who joined earlier), or explains whom to ask.
    setAcceptError({
      gone: isApiError(e) && e.kind === 'gone',
      message: isApiError(e) ? guestJoinError(e.code, e.message) : fallback,
    })
  }, [])

  const accept = useCallback(async () => {
    setAccepting(true)
    setAcceptError(null)
    setMismatchAtAccept(false)
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
      if (isApiError(e) && e.code === DOMAIN_ACCESS_CODES.emailMismatch) {
        // The page already has the masked address from the preview; the 403 body is not read.
        setAccepting(false)
        setMismatchAtAccept(true)
        return
      }
      if (isApiError(e) && e.kind !== 'gone') {
        // 503 IDENTITY_UNAVAILABLE: a retry; 409 ROLE_REQUIRES_CREATOR and the rest: the server's words.
        setAccepting(false)
        setAcceptError({ gone: false, ...acceptErrorCopy(e.code, e.message) })
        return
      }
      failed(e, 'The invitation could not be accepted. Try again.')
    }
  }, [token, refresh, failed])

  /** Joins as a guest: a new guest with `name`, or (signed in as a guest) one more board. */
  const joinGuest = useCallback(
    async (name?: string) => {
      setAccepting(true)
      setAcceptError(null)
      try {
        const joined = await joinAsGuest(token, name)
        seedUserKind(joined.user.id, 'guest')
        rememberGuestTab()
        await refresh()
        // A guest lands straight on the board.
        navigate(boardPath(joined.boardId), { replace: true })
      } catch (e) {
        failed(e, 'You could not join right now. Try again.')
      }
    },
    [token, refresh, failed],
  )

  // PRI-16: back from "Sign in to accept": accept right away (once), no second click.
  const autoAccepted = useRef(false)
  const ready = preview.status === 'ready' && state.status === 'signed-in' && kind === 'account'
  const previewData = preview.status === 'ready' ? preview.data : null
  useEffect(() => {
    if (!ready || autoAccepted.current) return
    if (!takeAcceptIntent(safeSessionStorage(), token)) return
    autoAccepted.current = true
    // Domain access: never on the wrong account. The intent is consumed above, so it cannot loop.
    if (!shouldAutoAccept(previewData)) return
    void accept()
  }, [ready, token, accept, previewData])

  const signedIn = state.status === 'signed-in'
  if (
    preview.status === 'loading' ||
    state.status === 'loading' ||
    gone === 'loading' ||
    (signedIn && kind === null && preview.status === 'ready')
  ) {
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
  const here = invitePath(token)
  const guestLink = inv.allowGuests && inv.board !== null
  // Domain access: an invitation locked to one address (never a guest link) names it, masked.
  const hint = lockedHint(inv)
  const mismatch = signedIn && kind === 'account' && isEmailMismatch(inv, mismatchAtAccept)

  let actions: ReactNode
  if (signedIn && kind === 'guest') {
    actions = guestLink ? (
      <>
        <button
          type="button"
          className="dr-btn dr-btn--primary dr-btn--lg"
          data-testid="invite-guest-continue"
          disabled={accepting}
          onClick={() => void joinGuest()}
        >
          {accepting ? 'Joining…' : 'Join and open board'}
        </button>
        <p className="dr-invite-card__as">
          You'll join as <strong>{state.me.user.name}</strong>.
        </p>
      </>
    ) : (
      <>
        <p className="dr-invite-guest__note" data-testid="invite-needs-account">
          You're signed in as a guest (<strong>{state.me.user.name}</strong>). This invitation needs an
          account. Signing in ends your guest access.
        </p>
        <button
          type="button"
          className="dr-btn dr-btn--primary dr-btn--lg"
          data-testid="invite-guest-signin"
          disabled={signingOut}
          onClick={() => {
            rememberAcceptIntent(safeSessionStorage(), token)
            void signOut({ returnTo: here })
          }}
        >
          {signingOut ? 'Signing out…' : 'Sign in with an account'}
        </button>
      </>
    )
  } else if (signedIn && mismatch) {
    // State 3: the wrong account. One way on: sign in with the invited address (and accept after it).
    const copy = emailMismatchCopy({
      hint,
      email: state.me.access.email,
      invitedBy: inv.invitedBy.name,
      sentByYou: inv.sentByYou,
    })
    actions = (
      <>
        <div className="dr-invite-mismatch" role="alert" data-testid="invite-email-mismatch">
          <p className="dr-invite-mismatch__title">
            <strong>{copy.title}</strong>
          </p>
          <p data-testid="invite-email-mismatch-body">{copy.body}</p>
        </div>
        <button
          type="button"
          className="dr-btn dr-btn--primary dr-btn--lg"
          data-testid="invite-mismatch-switch"
          disabled={signingOut}
          aria-busy={signingOut || undefined}
          onClick={() => {
            rememberAcceptIntent(safeSessionStorage(), token)
            void signOut({ returnTo: here })
          }}
        >
          {signingOut ? 'Signing out…' : 'Sign in with a different account'}
        </button>
      </>
    )
  } else if (signedIn) {
    actions = (
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
    )
  } else if (guestLink) {
    actions = (
      <>
        <GuestJoinForm busy={accepting} onJoin={(name) => void joinGuest(name)} />
        <p className="dr-divider" aria-hidden="true">
          or
        </p>
        <a
          className="dr-btn dr-btn--lg dr-invite-guest__signin"
          data-testid="invite-signin"
          href={signInPath(here)}
          onClick={(e) => {
            rememberAcceptIntent(safeSessionStorage(), token)
            linkClick(signInPath(here))(e)
          }}
        >
          Sign in instead
        </a>
        <p className="dr-invite-card__as">With an account, you join right after signing in.</p>
      </>
    )
  } else {
    actions = (
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
          {hint ? lockedSignInLabel(hint) : 'Sign in to accept'}
        </a>
        <p className="dr-invite-card__as">
          {hint
            ? 'Only an account with that email address can accept it. You join right after signing in.'
            : "You'll join right after signing in."}
        </p>
      </>
    )
  }

  return (
    <main className="dr-screen dr-screen--page" data-testid="invite-page" data-allow-guests={guestLink}>
      <div className="dr-card dr-card--narrow dr-invite-card">
        <a href="/" onClick={linkClick('/')} className="dr-card__brand" aria-label="Lobby home">
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
          {hint && (
            <div>
              <dt>For</dt>
              <dd data-testid="invite-locked-hint">{hint}</dd>
            </div>
          )}
        </dl>
        {acceptError && !mismatch && (
          <div className="dr-invite-error">
            <p className="dr-field-error" role="alert" data-testid="invite-error">
              {acceptError.message}
            </p>
            {acceptError.retry && (
              <button
                type="button"
                className="dr-btn"
                data-testid="invite-retry"
                disabled={accepting}
                onClick={() => void accept()}
              >
                Try again
              </button>
            )}
          </div>
        )}
        {actions}
      </div>
    </main>
  )
}

/** "Join as a guest": a name (1-40 characters), checked here the same way the API checks it. */
function GuestJoinForm({ busy, onJoin }: { busy: boolean; onJoin(name: string): void }) {
  const inputId = useId()
  const hintId = useId()
  const errorId = useId()
  const [name, setName] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const p = guestNameProblem(name)
    setProblem(p)
    if (!p) onJoin(name.trim())
  }
  return (
    <form className="dr-invite-guest" data-testid="invite-guest-form" onSubmit={submit} noValidate>
      <label htmlFor={inputId} className="dr-invite-guest__label">
        Your name
      </label>
      <input
        id={inputId}
        className="dr-input dr-input--block"
        data-testid="invite-guest-name"
        autoComplete="name"
        // A little room over the limit so a paste is not cut silently; the check below explains.
        maxLength={GUEST_NAME_MAX + 20}
        value={name}
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? `${errorId} ${hintId}` : hintId}
        onChange={(e) => {
          setName(e.target.value)
          if (problem) setProblem(null)
        }}
      />
      {problem && (
        <p id={errorId} className="dr-field-error" role="alert" data-testid="invite-guest-name-error">
          {problem}
        </p>
      )}
      <p id={hintId} className="dr-invite-guest__hint">
        {guestJoinHint(name)}
      </p>
      <button
        type="submit"
        className="dr-btn dr-btn--primary dr-btn--lg"
        data-testid="invite-guest-join"
        disabled={busy}
      >
        {busy ? 'Joining…' : 'Join as a guest'}
      </button>
    </form>
  )
}
