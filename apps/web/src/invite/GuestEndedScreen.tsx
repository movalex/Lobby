import { navigate, signInPath } from '../lib/routing.ts'
import { MessageScreen } from '../ui/screens.tsx'
import { forgetGuestTab } from './guest.tsx'
import './invite.css'

/**
 * A guest's session ended (the link was revoked or expired, an owner removed them, or they signed
 * out): they have no account to sign back in with, so say what happened and how to come back.
 */
export function GuestEndedScreen() {
  const here = `${location.pathname}${location.search}`
  return (
    <MessageScreen
      testId="guest-ended"
      title="Your guest access has ended"
      body={
        <>
          <p>
            You joined with a link, as a guest. That access has ended: the link was revoked or expired, you
            were removed from the board, or you signed out.
          </p>
          <p>Open the link again if it still works, or ask whoever shared it for a new one.</p>
        </>
      }
      actions={
        <button
          type="button"
          className="dr-btn dr-btn--primary"
          data-testid="guest-ended-signin"
          onClick={() => {
            forgetGuestTab()
            navigate(signInPath(here), { replace: true })
          }}
        >
          Sign in with an account
        </button>
      }
    />
  )
}
