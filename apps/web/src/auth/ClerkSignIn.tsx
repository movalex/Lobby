// Verified against the live Clerk development instance on staging (2026-09-27): sign-in, then
// POST /api/auth/clerk/session 200 and a Draftroom session.
// Flow: Clerk's hosted <SignIn> signs the user in to Clerk in the browser; we then trade the Clerk
// session token for a Draftroom session cookie (api.clerkExchange) and from then on only the
// Draftroom session is used. The API verifies the token server-side with @clerk/backend.
//
// SCA-1: after an explicit sign-out in this tab (signOutMark.ts), a Clerk session that is still live is
// NOT traded in on its own: the page asks "Continue as <name>" first, so the next person at a shared
// computer does not land in the previous person's account. Without the mark (an expired session, a
// first visit) the exchange stays automatic.
//
// <SignIn> follows the app's light/dark theme (clerkAppearance.ts).
import { ClerkProvider, SignIn, useAuth, useUser } from '@clerk/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, isApiError } from '../api/client.ts'
import { useTheme } from '../theme/useTheme.ts'
import { type ClerkAppearance, clerkAppearance, readThemeTokens } from './clerkAppearance.ts'
import { type ExchangeErrorView, exchangeErrorView } from './exchange-error.ts'
import { useSession } from './session.tsx'
import { clerkAccountLabel, clerkSignInView } from './signOut.ts'
import { signedOutMarks } from './signOutMark.ts'

export default function ClerkSignIn({ publishableKey, onDone }: { publishableKey: string; onDone(): void }) {
  // html[data-theme] is already switched when the theme store notifies, so the tokens read here are
  // the new theme's.
  const { colorMode } = useTheme()
  const appearance = useMemo(() => clerkAppearance(readThemeTokens(), colorMode), [colorMode])
  return (
    <ClerkProvider publishableKey={publishableKey}>
      <ClerkExchange onDone={onDone} appearance={appearance} />
    </ClerkProvider>
  )
}

function ClerkExchange({ onDone, appearance }: { onDone(): void; appearance: ClerkAppearance }) {
  const auth = useAuth()
  const { user } = useUser()
  const { refresh } = useSession()
  // Read once per visit to this page: a sign-in that completes here clears it.
  const [mark] = useState(() => signedOutMarks.read())
  const [confirmed, setConfirmed] = useState(false)
  const [error, setError] = useState<ExchangeErrorView | null>(null)
  const [switchError, setSwitchError] = useState<string | null>(null)
  const exchanging = useRef(false)
  const view = clerkSignInView({
    loaded: auth.isLoaded,
    signedIn: auth.isSignedIn === true,
    explicitSignOut: mark !== null,
    confirmed,
    failed: error !== null,
  })

  useEffect(() => {
    if (view !== 'exchange' || exchanging.current) return
    exchanging.current = true
    void (async () => {
      try {
        const token = await auth.getToken()
        if (!token) throw new Error('no Clerk session token')
        await api.clerkExchange(token)
        if (await refresh()) {
          signedOutMarks.clear()
          onDone()
        } else setError({ message: 'Signed in with Clerk, but Lobby did not start a session.', retry: true })
      } catch (e) {
        // Domain access: ACCOUNT_DISABLED (no retry) and IDENTITY_UNAVAILABLE (retry) have their words.
        setError(exchangeErrorView(isApiError(e) ? e : null))
      } finally {
        exchanging.current = false
      }
    })()
  }, [view, auth, refresh, onDone])

  // Signs this browser out of Clerk and reloads this sign-in page (returnTo kept) with Clerk's form.
  const switchAccount = () => {
    setSwitchError(null)
    auth.signOut({ redirectUrl: `${location.pathname}${location.search}` }).catch(() => {
      setSwitchError(
        'Could not sign this browser out of the account. Close the browser before you leave this computer.',
      )
    })
  }
  const switchButton = (
    <button type="button" className="dr-btn" data-testid="clerk-use-another" onClick={switchAccount}>
      Use another account
    </button>
  )
  const switchProblem = switchError && (
    <p className="dr-field-error" role="alert">
      {switchError}
    </p>
  )

  if (view === 'loading') {
    return (
      <div className="dr-signin__loading" role="status">
        <span className="dr-spinner" aria-hidden="true" />
      </div>
    )
  }
  if (view === 'confirm') {
    const name = clerkAccountLabel(user)
    return (
      <div className="dr-clerk-continue" data-testid="clerk-continue">
        {mark?.clerk === 'failed' && (
          <p className="dr-clerk-warning" role="alert">
            When you signed out, this browser could not be signed out of your account as well. On a shared
            computer, choose “Use another account” before you leave.
          </p>
        )}
        <p className="dr-muted">
          You signed out of Lobby in this tab. This browser is still signed in to your account as{' '}
          <strong>{name}</strong>.
        </p>
        <div className="dr-row dr-row--wrap">
          <button
            type="button"
            className="dr-btn dr-btn--primary"
            data-testid="clerk-continue-as"
            onClick={() => setConfirmed(true)}
          >
            Continue as {name}
          </button>
          {switchButton}
        </div>
        {switchProblem}
      </div>
    )
  }
  if (view === 'exchange' || view === 'error') {
    return (
      <div role={error ? 'alert' : 'status'}>
        <p className="dr-muted" data-testid={error ? 'clerk-exchange-error' : undefined}>
          {error?.message ?? 'Signing you in to Lobby…'}
        </p>
        {error && (
          <div className="dr-row dr-row--wrap">
            {error.retry && (
              <button type="button" className="dr-btn dr-btn--primary" onClick={() => setError(null)}>
                Try again
              </button>
            )}
            {switchButton}
          </div>
        )}
        {switchProblem}
      </div>
    )
  }
  // Hash routing keeps Clerk's multi-step flow inside /signin without touching our router.
  return <SignIn routing="hash" appearance={appearance} />
}
