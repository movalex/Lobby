// Verified against the live Clerk development instance on staging (2026-09-27): sign-in, then
// POST /api/auth/clerk/session 200 and a Draftroom session.
// Flow: Clerk's hosted <SignIn> signs the user in to Clerk in the browser; we then trade the Clerk
// session token for a Draftroom session cookie (api.clerkExchange) and from then on only the
// Draftroom session is used. The API verifies the token server-side with @clerk/backend.
import { ClerkProvider, SignIn, useAuth } from '@clerk/react'
import { useEffect, useRef, useState } from 'react'
import { api, isApiError } from '../api/client.ts'
import { useSession } from './session.tsx'

export default function ClerkSignIn({ publishableKey, onDone }: { publishableKey: string; onDone(): void }) {
  return (
    <ClerkProvider publishableKey={publishableKey}>
      <ClerkExchange onDone={onDone} />
    </ClerkProvider>
  )
}

function ClerkExchange({ onDone }: { onDone(): void }) {
  const auth = useAuth()
  const { refresh } = useSession()
  const [error, setError] = useState<string | null>(null)
  const exchanging = useRef(false)

  useEffect(() => {
    if (!auth.isLoaded || !auth.isSignedIn || exchanging.current || error) return
    exchanging.current = true
    void (async () => {
      try {
        const token = await auth.getToken()
        if (!token) throw new Error('no Clerk session token')
        await api.clerkExchange(token)
        if (await refresh()) onDone()
        else setError('Signed in with Clerk, but Draftroom did not start a session.')
      } catch (e) {
        setError(isApiError(e) ? e.message : 'Sign-in failed. Try again.')
      } finally {
        exchanging.current = false
      }
    })()
  }, [auth, error, refresh, onDone])

  if (!auth.isLoaded) {
    return (
      <div className="dr-signin__loading" role="status">
        <span className="dr-spinner" aria-hidden="true" />
      </div>
    )
  }
  if (auth.isSignedIn) {
    return (
      <div role={error ? 'alert' : 'status'}>
        <p className="dr-muted">{error ?? 'Signing you in to Draftroom…'}</p>
        {error && (
          <div className="dr-row">
            <button type="button" className="dr-btn dr-btn--primary" onClick={() => setError(null)}>
              Try again
            </button>
            <button type="button" className="dr-btn" onClick={() => void auth.signOut()}>
              Use another account
            </button>
          </div>
        )}
      </div>
    )
  }
  // Hash routing keeps Clerk's multi-step flow inside /signin without touching our router.
  return <SignIn routing="hash" />
}
