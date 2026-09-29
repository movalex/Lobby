import type { ReactNode } from 'react'
import type { ExchangeErrorView } from './exchange-error.ts'

/**
 * The step after Clerk's form: trading the Clerk session for a Lobby session, or why that was refused
 * (domain access, docs/DOMAIN-ACCESS-CONTRACTS.md §9: ACCOUNT_DISABLED without a retry,
 * IDENTITY_UNAVAILABLE with one). Kept apart from the Clerk hooks so a test can render it.
 */
export function ExchangeStatus({
  error,
  onRetry,
  actions,
  problem = null,
}: {
  /** Null while the exchange runs. */
  error: ExchangeErrorView | null
  onRetry(): void
  /** Shown next to "Try again" after a refusal ("Use another account"). */
  actions: ReactNode
  /** A problem with those actions (signing this browser out of Clerk failed). */
  problem?: ReactNode
}) {
  return (
    <div role={error ? 'alert' : 'status'}>
      <p className="dr-muted" data-testid={error ? 'clerk-exchange-error' : undefined}>
        {error?.message ?? 'Signing you in to Lobby…'}
      </p>
      {error && (
        <div className="dr-row dr-row--wrap">
          {error.retry && (
            <button
              type="button"
              className="dr-btn dr-btn--primary"
              data-testid="clerk-exchange-retry"
              onClick={onRetry}
            >
              Try again
            </button>
          )}
          {actions}
        </div>
      )}
      {problem}
    </div>
  )
}
