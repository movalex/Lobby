import type { InvitationPreview } from '@draftroom/contracts'
import { type FormEvent, lazy, type ReactNode, Suspense, useEffect, useId, useState } from 'react'
import { api, isApiError } from '../api/client.ts'
import { Wordmark } from '../brand/Wordmark.tsx'
import { signInHeading } from '../invite/model.ts'
import { colorForUser, DEV_HANDLE_RE, DEV_QUICK_PICKS, initialsFor } from '../lib/identity.ts'
import { matchRoute, navigate, safeReturnTo } from '../lib/routing.ts'
import { useSession } from './session.tsx'

// Clerk's SDK is only downloaded when the server actually uses Clerk.
const ClerkSignIn = lazy(() => import('./ClerkSignIn.tsx'))

export function SignInPage() {
  const { config, configStatus, retryConfig, state } = useSession()
  const returnTo = safeReturnTo(new URLSearchParams(location.search).get('returnTo'))
  const done = () => navigate(returnTo ?? '/', { replace: true })
  // PRI-16: coming from an invitation, say what signing in is for (the preview is public).
  const invite = useInvitePreview(returnTo)
  const heading = signInHeading(invite)

  let body: ReactNode
  if (configStatus === 'loading') {
    body = (
      <div className="dr-signin__loading" role="status">
        <span className="dr-spinner" aria-hidden="true" />
        <span className="dr-sr-only">Loading sign-in options…</span>
      </div>
    )
  } else if (configStatus === 'error' || !config) {
    body = (
      <div role="alert">
        <h1 className="dr-card__title">Can't reach Draftroom</h1>
        <p className="dr-muted">The sign-in service did not respond. Check that the API server is running.</p>
        <button type="button" className="dr-btn dr-btn--primary" onClick={retryConfig}>
          Try again
        </button>
      </div>
    )
  } else if (config.providers.includes('dev')) {
    body = <DevSignIn onDone={done} heading={heading} />
  } else if (config.providers.includes('clerk') && config.clerkPublishableKey) {
    body = (
      <Suspense
        fallback={
          <div className="dr-signin__loading" role="status">
            <span className="dr-spinner" aria-hidden="true" />
          </div>
        }
      >
        {invite && (
          <h1 className="dr-card__title" data-testid="signin-heading">
            {heading}
          </h1>
        )}
        <ClerkSignIn publishableKey={config.clerkPublishableKey} onDone={done} />
      </Suspense>
    )
  } else {
    body = (
      <div role="alert">
        <h1 className="dr-card__title">Sign-in is not configured</h1>
        <p className="dr-muted">This server has no sign-in provider enabled.</p>
      </div>
    )
  }

  return (
    <main className="dr-signin" data-testid="signin-page">
      <div className="dr-signin__inner">
        <Wordmark size="lg" />
        <p className="dr-home__tagline">
          A shared canvas for sketching, planning and reviewing work together.
        </p>
        <section className="dr-card dr-signin__card">
          {state.status === 'signed-in' && (
            <div className="dr-signin__current">
              <span>
                Signed in as <strong>{state.me.user.name}</strong>
              </span>
              <button type="button" className="dr-btn dr-btn--ghost" onClick={done}>
                Continue
              </button>
            </div>
          )}
          {body}
        </section>
      </div>
    </main>
  )
}

/** The invitation behind `returnTo` (/invite/:token), for the sign-in heading; null otherwise. */
function useInvitePreview(returnTo: string | null): InvitationPreview | null {
  const [inv, setInv] = useState<InvitationPreview | null>(null)
  const token = (() => {
    if (!returnTo) return null
    const route = matchRoute(new URL(returnTo, location.origin).pathname)
    return route.name === 'invite' ? route.token : null
  })()
  useEffect(() => {
    if (!token) return
    const controller = new AbortController()
    api.getInvitation(token, controller.signal).then(setInv, () => setInv(null))
    return () => controller.abort()
  }, [token])
  return token ? inv : null
}

function DevSignIn({ onDone, heading }: { onDone(): void; heading: string }) {
  const { refresh } = useSession()
  const handleId = useId()
  const nameId = useId()
  const errorId = useId()
  const [handle, setHandle] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)

  const signIn = async (h: string, displayName?: string) => {
    setPending(h)
    setError(null)
    try {
      // Switching user needs no logout first: the API revokes this browser's old session on sign-in.
      await api.devLogin(displayName ? { handle: h, name: displayName } : { handle: h })
      const me = await refresh()
      if (!me) throw new Error('no session after sign-in')
      onDone()
    } catch (e) {
      setError(isApiError(e) ? e.message : 'Sign-in failed. Try again.')
      setPending(null)
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const h = handle.trim().toLowerCase()
    if (!DEV_HANDLE_RE.test(h)) {
      setError('Handles are 1–32 lowercase letters, digits or "-".')
      return
    }
    const n = name.trim()
    if (n.length > 80) {
      setError('Display names can be at most 80 characters.')
      return
    }
    void signIn(h, n || undefined)
  }

  return (
    <>
      <div className="dr-devnotice" data-testid="dev-signin-notice" role="note">
        <span className="dr-devbadge__tag">DEV</span>
        <div>
          <strong>Development sign-in</strong>
          <p>
            No password: anyone who can reach this server can sign in as any handle. It exists only on servers
            started with <code>DRAFTROOM_DEV_AUTH=1</code>.
          </p>
        </div>
      </div>
      <h1 className="dr-card__title" data-testid="signin-heading">
        {heading}
      </h1>
      <fieldset className="dr-presets-fieldset" disabled={pending !== null}>
        <legend className="dr-signin__legend">Quick pick</legend>
        <div className="dr-presets">
          {DEV_QUICK_PICKS.map((h) => (
            <button
              key={h}
              type="button"
              className="dr-preset"
              data-testid={`signin-quick-${h}`}
              aria-busy={pending === h || undefined}
              onClick={() => void signIn(h)}
            >
              <span
                className="dr-avatar dr-avatar--static"
                style={{ background: colorForUser(h) }}
                aria-hidden="true"
              >
                {initialsFor(h)}
              </span>
              {h}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="dr-divider">
        <span>or</span>
      </div>
      <form className="dr-signin__form" data-testid="signin-form" onSubmit={submit} noValidate>
        <label htmlFor={handleId}>Handle</label>
        <input
          id={handleId}
          className="dr-input dr-input--block"
          data-testid="signin-handle"
          value={handle}
          onChange={(e) => {
            setHandle(e.target.value)
            setError(null)
          }}
          placeholder="e.g. dana"
          // biome-ignore lint/a11y/noAutofocus: the page exists to type a handle (PRI-16)
          autoFocus
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
        />
        <label htmlFor={nameId}>
          Display name <span className="dr-optional">(optional)</span>
        </label>
        <input
          id={nameId}
          className="dr-input dr-input--block"
          data-testid="signin-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Dana Rivera"
          autoComplete="name"
          maxLength={80}
        />
        {error && (
          <p id={errorId} className="dr-field-error" data-testid="signin-error" role="alert">
            {error}
          </p>
        )}
        <button
          type="submit"
          className="dr-btn dr-btn--primary dr-btn--lg dr-signin__submit"
          data-testid="signin-submit"
          disabled={pending !== null}
        >
          {pending !== null ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </>
  )
}
