import { navigate, signInPath } from '../lib/routing.ts'
import { MessageScreen } from '../ui/screens.tsx'
import { forgetGuestTab } from './guest.tsx'
import { GUEST_ENDED_COPY } from './model.ts'
import './invite.css'

/**
 * The one message a guest sees when their access ends (DANA2-07): the same words on the board's
 * "revoked" screen and on this one, which follows seconds later when their session ends, so the page
 * does not change its story under them. A guest has no boards to go to and usually no account, so
 * there is no button that leads nowhere: what to do is in the text, and signing in with an account
 * is a quiet link for the few who have one.
 */
export function GuestAccessEndedBody() {
  return (
    <>
      <p>{GUEST_ENDED_COPY.what}</p>
      <p>{GUEST_ENDED_COPY.next}</p>
    </>
  )
}

export function GuestAccountSignIn({ testId, onSignIn }: { testId: string; onSignIn(): void }) {
  return (
    <p className="dr-muted dr-guest-ended__account">
      Have a Lobby account?{' '}
      <button type="button" className="dr-linkbtn" data-testid={testId} onClick={onSignIn}>
        Sign in
      </button>
    </p>
  )
}

/**
 * A guest's session ended (the link was revoked or expired, an owner removed them, or they signed
 * out): they have no account to sign back in with, so say what happened and how to come back.
 */
export function GuestEndedScreen() {
  const here = `${location.pathname}${location.search}`
  return (
    <MessageScreen
      testId="guest-ended"
      title={GUEST_ENDED_COPY.title}
      body={<GuestAccessEndedBody />}
      actions={
        <GuestAccountSignIn
          testId="guest-ended-signin"
          onSignIn={() => {
            forgetGuestTab()
            navigate(signInPath(here), { replace: true })
          }}
        />
      }
    />
  )
}
