// What the Clerk sign-in shows when trading the Clerk session for a Lobby session fails
// (POST /api/auth/clerk/session). Domain access (docs/DOMAIN-ACCESS-CONTRACTS.md §9): a banned or
// locked account is refused for good (403 ACCOUNT_DISABLED), and a first sign-in while the sign-in
// service cannot be reached is refused for now (503 IDENTITY_UNAVAILABLE), which a retry can fix.

import { DOMAIN_ACCESS_CODES, DOMAIN_ACCESS_MESSAGES } from '@draftroom/contracts'

export interface ExchangeErrorView {
  message: string
  /** Offer "Try again" (a retry can succeed); "Use another account" is always offered. */
  retry: boolean
}

export function exchangeErrorView(error: { code: string; message: string } | null): ExchangeErrorView {
  switch (error?.code) {
    case DOMAIN_ACCESS_CODES.accountDisabled:
      return { message: DOMAIN_ACCESS_MESSAGES.accountDisabled, retry: false }
    case DOMAIN_ACCESS_CODES.identityUnavailable:
      return { message: DOMAIN_ACCESS_MESSAGES.identityUnavailable, retry: true }
    default:
      return { message: error?.message || 'Sign-in failed. Try again.', retry: true }
  }
}
