import type { ReactNode } from 'react'
import { useSession } from '../auth/session.tsx'
import { Wordmark } from '../brand/Wordmark.tsx'
import { linkClick } from '../lib/routing.ts'

export function LoadingScreen({ label = 'Loading…', testId }: { label?: string; testId?: string }) {
  return (
    <div className="dr-screen dr-screen--page" data-testid={testId} role="status" aria-live="polite">
      <span className="dr-spinner" aria-hidden="true" />
      <span className="dr-sr-only">{label}</span>
    </div>
  )
}

export function MessageScreen({
  title,
  body,
  testId,
  actions,
}: {
  title: string
  body: ReactNode
  testId?: string
  actions?: ReactNode
}) {
  return (
    <main className="dr-screen dr-screen--page" data-testid={testId}>
      <div className="dr-card dr-card--narrow">
        <a href="/" onClick={linkClick('/')} className="dr-card__brand" aria-label="Draftroom home">
          <Wordmark />
        </a>
        <h1 className="dr-card__title">{title}</h1>
        <div className="dr-muted dr-card__body">{body}</div>
        <div className="dr-row dr-row--wrap">
          {actions ?? (
            <a className="dr-btn dr-btn--primary" href="/" onClick={linkClick('/')}>
              Go to your boards
            </a>
          )}
        </div>
      </div>
    </main>
  )
}

/**
 * One screen for "not found" and "forbidden": the API answers 404 for both so a board's existence
 * never leaks, and the UI does not try to tell them apart either.
 */
export function NoAccessScreen({
  thing = 'board',
  revoked = false,
}: {
  thing?: 'board' | 'workspace'
  revoked?: boolean
}) {
  const { signOut } = useSession()
  const here = `${location.pathname}${location.search}`
  return (
    <MessageScreen
      testId="no-access"
      title={
        revoked ? `You no longer have access to this ${thing}` : `You don't have access to this ${thing}`
      }
      body={
        <>
          <p>
            {revoked
              ? `Your access was removed or changed while you had it open, or the ${thing} was moved to trash.`
              : `It may not exist, it may have been moved to trash, or it hasn't been shared with you.`}
          </p>
          <p>Ask its owner to share it with you, or open the invite link they sent you.</p>
        </>
      }
      actions={
        <>
          <a className="dr-btn dr-btn--primary" href="/" onClick={linkClick('/')}>
            Go to your boards
          </a>
          <button type="button" className="dr-btn" onClick={() => void signOut({ returnTo: here })}>
            Sign in as someone else
          </button>
        </>
      }
    />
  )
}
