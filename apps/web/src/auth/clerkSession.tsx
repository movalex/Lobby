// Ends this browser's Clerk session (SCA-1). Signing out must end it too: the sign-in page trades a
// live Clerk session for a new Draftroom session, so revoking only `dr_session` signed the same person
// straight back in.
//
// Clerk runs only on the sign-in page (ClerkSignIn.tsx), so on the dashboard or a board it is not loaded.
// This loads it for the sign-out alone: a hidden, separate React root with its own <ClerkProvider>
// (clerk-js comes from Clerk's CDN, and is reused when this page loaded it before), waits until Clerk
// knows the session, signs it out and unmounts again. The session provider imports this module only
// when the server uses Clerk, so the dev provider never downloads the Clerk SDK.
//
// The session provider navigates to /signin once this resolves, so Clerk must not navigate on its own:
// signOut() is given a callback (the `SignOut` overload in @clerk/shared: clerk-js runs it where it
// would otherwise navigate to `afterSignOutUrl`), and, should the options of this provider be the ones
// clerk-js uses, its router hooks are no-ops and `afterSignOutUrl` is this page. If clerk-js was loaded
// earlier on this page with other options and navigates anyway, that is a full load of a page whose
// Draftroom session is already revoked: it lands on /signin, where the explicit sign-out mark holds.
// None of this could be run against a live Clerk instance from this change (no keys here).

import { ClerkProvider, useAuth } from '@clerk/react'
import { useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'

/** Clerk had this long to load and sign out; after it the sign-out is reported as not finished. */
export const CLERK_SIGN_OUT_TIMEOUT_MS = 15_000

const stayHere = () => {}

export function endClerkSession(
  publishableKey: string,
  timeoutMs = CLERK_SIGN_OUT_TIMEOUT_MS,
): Promise<void> {
  const host = document.createElement('div')
  host.hidden = true
  host.setAttribute('data-clerk-sign-out', '')
  document.body.append(host)
  const root = createRoot(host)
  const here = `${location.pathname}${location.search}`
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Clerk did not sign out in time')), timeoutMs)
    const finish = (error?: unknown) => {
      clearTimeout(timer)
      if (error === undefined) resolve()
      else reject(error)
    }
    root.render(
      <ClerkProvider
        publishableKey={publishableKey}
        afterSignOutUrl={here}
        routerPush={stayHere}
        routerReplace={stayHere}
      >
        <SignOutWhenLoaded onFinish={finish} />
      </ClerkProvider>,
    )
  }).finally(() => {
    // Not from inside Clerk's own callbacks: React refuses to unmount a root while it renders.
    setTimeout(() => {
      root.unmount()
      host.remove()
    }, 0)
  })
}

function SignOutWhenLoaded({ onFinish }: { onFinish(error?: unknown): void }) {
  const { isLoaded, isSignedIn, signOut } = useAuth()
  const started = useRef(false)
  useEffect(() => {
    if (!isLoaded || started.current) return
    started.current = true
    if (!isSignedIn) {
      onFinish()
      return
    }
    // Every session of this browser's Clerk client (the default without a sessionId); the callback
    // stands in for Clerk's own post-sign-out navigation.
    signOut(stayHere).then(
      () => onFinish(),
      (e: unknown) => onFinish(e ?? new Error('Clerk sign-out failed')),
    )
  }, [isLoaded, isSignedIn, signOut, onFinish])
  return null
}
