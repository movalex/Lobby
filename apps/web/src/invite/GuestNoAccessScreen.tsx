import { MeKind } from '@draftroom/contracts'
import { useEffect } from 'react'
import { api } from '../api/client.ts'
import { useSession } from '../auth/session.tsx'
import { linkClick } from '../lib/routing.ts'
import { MessageScreen } from '../ui/screens.tsx'
import { GuestAccessEndedBody, GuestAccountSignIn } from './GuestEndedScreen.tsx'
import { forgetGuestTab } from './guest.tsx'
import { GUEST_ENDED_COPY } from './model.ts'
import './invite.css'

/** After a guest lost a board, how often (and how long) to look for the end of their whole session. */
const SESSION_END_CHECK_MS = 2_000
const SESSION_END_CHECK_FOR_MS = 30_000

/**
 * The no-access screen for a name-only guest (F16). Guests cannot request access (the server refuses),
 * so this never offers it or tells them to ask the owner "again": it says what happened in the words
 * of the guest-ended screen, which follows once their session ends too.
 *
 * - `revoked`: the board closed while they had it open (the link was revoked or expired, or they were
 *   removed). Their session usually ends a few seconds later, when it holds no board any more: this
 *   checks for that now and then, so the guest-ended screen (the same words) follows in seconds, not at the next
 *   10-second check.
 * - otherwise: they opened a board they never joined with a link.
 */
export function GuestNoAccessScreen({ revoked }: { revoked: boolean }) {
  const { signOut } = useSession()
  const here = `${location.pathname}${location.search}`

  useEffect(() => {
    if (!revoked) return
    const started = Date.now()
    // A 401 signs this tab out through the api client; App then shows the guest-ended screen.
    const t = setInterval(() => {
      if (Date.now() - started > SESSION_END_CHECK_FOR_MS) clearInterval(t)
      else api.request('GET', '/api/me', { schema: MeKind }).catch(() => {})
    }, SESSION_END_CHECK_MS)
    return () => clearInterval(t)
  }, [revoked])

  const signIn = () => {
    // An account's sign-in, not the guest-ended screen: this tab is no longer a guest's.
    forgetGuestTab()
    void signOut({ returnTo: here })
  }

  // DANA2-07: a revoked guest reads the guest-ended screen's message word for word (that screen
  // follows within seconds), with no button that leads nowhere: no "Go to your boards" (they have
  // none left), and signing in with an account as a quiet link.
  if (revoked)
    return (
      <MessageScreen
        testId="no-access"
        title={GUEST_ENDED_COPY.title}
        body={
          <div data-testid="guest-no-access" data-revoked="true">
            <GuestAccessEndedBody />
          </div>
        }
        actions={<GuestAccountSignIn testId="guest-no-access-signin" onSignIn={signIn} />}
      />
    )

  return (
    <MessageScreen
      testId="no-access"
      title="You don’t have access to this board"
      body={
        <div data-testid="guest-no-access">
          <p>As a guest, you can open only the boards you joined with a link.</p>
          <p>Open the link you were given for this board, or ask whoever shared it for one.</p>
        </div>
      }
      actions={
        <>
          <a className="dr-btn dr-btn--primary" href="/" onClick={linkClick('/')}>
            Go to your boards
          </a>
          <button type="button" className="dr-btn" data-testid="guest-no-access-signin" onClick={signIn}>
            Sign in with an account
          </button>
        </>
      }
    />
  )
}
