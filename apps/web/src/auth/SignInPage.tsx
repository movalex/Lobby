import { AccountEmail } from '@draftroom/contracts'
import { type FormEvent, lazy, type ReactNode, Suspense, useEffect, useId, useState } from 'react'
import { api, isApiError } from '../api/client.ts'
import { Wordmark } from '../brand/Wordmark.tsx'
import { fetchInvitation, type GuestAwarePreview } from '../invite/guest.tsx'
import { signInHeading } from '../invite/model.ts'
import { colorForUser, DEV_HANDLE_RE, DEV_QUICK_PICKS, initialsFor } from '../lib/identity.ts'
import { matchRoute, navigate, safeReturnTo } from '../lib/routing.ts'
import { useSession } from './session.tsx'
import { signedOutMarks } from './signOutMark.ts'

// Clerk's SDK is only downloaded when the server actually uses Clerk.
const ClerkSignIn = lazy(() => import('./ClerkSignIn.tsx'))

/**
 * DANA-08: what the dashboard shows, in the same words: a workspace holds project lobbies (the
 * sidebar's "Project lobbies"), each keeping one project's boards. Nothing makes lobbies on its own yet,
 * so the line does not promise that every project already has one.
 */
export const SIGN_IN_TAGLINE =
  'Shared boards for sketching, planning and reviewing work together, with a lobby for each DBC project.'

/** Open email sign-in (docs/OPEN-SIGNIN.md): the same promise, without DBC, for the shared workspace. */
export const openSignInTagline = (workspaceName: string | undefined) =>
  `Shared boards for sketching and planning together${workspaceName ? ` at ${workspaceName}` : ''}.`

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
        <h1 className="dr-card__title">Can't reach Lobby</h1>
        <p className="dr-muted">The sign-in service did not respond. Check that the API server is running.</p>
        <button type="button" className="dr-btn dr-btn--primary" onClick={retryConfig}>
          Try again
        </button>
      </div>
    )
  } else if (config.providers.includes('dev')) {
    body = <DevSignIn onDone={done} heading={heading} />
  } else if (config.providers.includes('email')) {
    body = <EmailSignIn onDone={done} heading={heading} />
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

  // Open email sign-in serves a shared workspace that is not DBC's: no DBC lockup or DBC tagline.
  const open = config?.providers.includes('email') === true
  return (
    <main className="dr-signin" data-testid="signin-page">
      <div className="dr-signin__inner">
        {/* The glowing hero already carries the mark, so the "DBC Lobby" lockup beside it is text only. */}
        <header className="dr-signin__brand">
          <img
            className="dr-signin__hero"
            src="/brand/lobby-hero.svg"
            width={104}
            height={104}
            alt=""
            draggable={false}
          />
          <Wordmark size="lg" variant={open ? 'short' : 'dbc'} mark={false} />
          <p className="dr-home__tagline" data-testid="signin-tagline">
            {open ? openSignInTagline(config?.sharedWorkspaceName) : SIGN_IN_TAGLINE}
          </p>
        </header>
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

/**
 * The invitation behind `returnTo` (/invite/:token), for the sign-in heading (with the masked address
 * of an invitation locked to one, domain access); null otherwise.
 */
function useInvitePreview(returnTo: string | null): GuestAwarePreview | null {
  const [inv, setInv] = useState<GuestAwarePreview | null>(null)
  const token = (() => {
    if (!returnTo) return null
    const route = matchRoute(new URL(returnTo, location.origin).pathname)
    return route.name === 'invite' ? route.token : null
  })()
  useEffect(() => {
    if (!token) return
    const controller = new AbortController()
    fetchInvitation(token, controller.signal).then(setInv, () => setInv(null))
    return () => controller.abort()
  }, [token])
  return token ? inv : null
}

function DevSignIn({ onDone, heading }: { onDone(): void; heading: string }) {
  const { refresh } = useSession()
  const handleId = useId()
  const nameId = useId()
  const emailId = useId()
  const errorId = useId()
  const [handle, setHandle] = useState('')
  const [name, setName] = useState('')
  // Domain access (dev builds only): the address this dev account signs in with, trusted as verified by
  // the dev-guarded api route. Without one the account is <handle>@dev.invalid, a creator.
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)

  const signIn = async (h: string, displayName?: string, devEmail?: string) => {
    setPending(h)
    setError(null)
    try {
      // Switching user needs no logout first: the API revokes this browser's old session on sign-in.
      await api.devLogin({
        handle: h,
        ...(displayName ? { name: displayName } : {}),
        ...(devEmail ? { email: devEmail } : {}),
      })
      const me = await refresh()
      if (!me) throw new Error('no session after sign-in')
      // A completed sign-in ends the explicit sign-out of this tab (SCA-1, signOutMark.ts).
      signedOutMarks.clear()
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
    let devEmail: string | undefined
    if (email.trim()) {
      const checked = AccountEmail.safeParse(email)
      if (!checked.success) {
        setError(checked.error.issues[0]?.message ?? 'Enter a valid email address.')
        return
      }
      devEmail = checked.data
    }
    void signIn(h, n || undefined, devEmail)
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
        <label htmlFor={emailId}>
          Email (dev only) <span className="dr-optional">(optional)</span>
        </label>
        <input
          id={emailId}
          type="email"
          inputMode="email"
          className="dr-input dr-input--block"
          data-testid="dev-login-email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value)
            setError(null)
          }}
          placeholder="e.g. pat@client.example.test"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
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

/**
 * Open email sign-in (docs/OPEN-SIGNIN.md): an address and a name, nothing verified. The address is the
 * account (the same address next time finds the same boards); the name is what other people see.
 */
function EmailSignIn({ onDone, heading }: { onDone(): void; heading: string }) {
  const { refresh } = useSession()
  const emailId = useId()
  const nameId = useId()
  const errorId = useId()
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const checked = AccountEmail.safeParse(email)
    if (!checked.success) {
      setError(checked.error.issues[0]?.message ?? 'Enter a valid email address.')
      return
    }
    const n = name.trim()
    if (!n) {
      setError('Enter your name, so people know who is on the board.')
      return
    }
    if (n.length > 80) {
      setError('Names can be at most 80 characters.')
      return
    }
    setPending(true)
    setError(null)
    try {
      await api.emailLogin({ email: checked.data, name: n })
      const me = await refresh()
      if (!me) throw new Error('no session after sign-in')
      signedOutMarks.clear()
      onDone()
    } catch (err) {
      setError(isApiError(err) ? err.message : 'Sign-in failed. Try again.')
      setPending(false)
    }
  }

  return (
    <>
      <h1 className="dr-card__title" data-testid="signin-heading">
        {heading}
      </h1>
      <form
        className="dr-signin__form"
        data-testid="email-signin-form"
        onSubmit={(e) => void submit(e)}
        noValidate
      >
        <label htmlFor={emailId}>Email</label>
        <input
          id={emailId}
          type="email"
          inputMode="email"
          className="dr-input dr-input--block"
          data-testid="email-signin-email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value)
            setError(null)
          }}
          placeholder="you@example.com"
          // biome-ignore lint/a11y/noAutofocus: the page exists to type an address
          autoFocus
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          required
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
        />
        <label htmlFor={nameId}>Your name</label>
        <input
          id={nameId}
          className="dr-input dr-input--block"
          data-testid="email-signin-name"
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            setError(null)
          }}
          placeholder="e.g. Dana Rivera"
          autoComplete="name"
          maxLength={80}
          required
        />
        {error && (
          <p id={errorId} className="dr-field-error" data-testid="signin-error" role="alert">
            {error}
          </p>
        )}
        <button
          type="submit"
          className="dr-btn dr-btn--primary dr-btn--lg dr-signin__submit"
          data-testid="email-signin-submit"
          disabled={pending}
        >
          {pending ? 'Signing in…' : 'Continue'}
        </button>
        <p className="dr-muted" data-testid="email-signin-note">
          No password. Use the same email next time to get back to your boards.
        </p>
      </form>
    </>
  )
}
