import { DOMAIN_ACCESS_MESSAGES } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { exchangeErrorView } from './exchange-error.ts'

describe('Clerk sign-in: a refused exchange (domain access)', () => {
  it('a disabled account gets its message and no retry; an unreachable sign-in service gets a retry', () => {
    expect(exchangeErrorView({ code: 'ACCOUNT_DISABLED', message: 'x' })).toEqual({
      message: DOMAIN_ACCESS_MESSAGES.accountDisabled,
      retry: false,
    })
    expect(exchangeErrorView({ code: 'IDENTITY_UNAVAILABLE', message: 'x' })).toEqual({
      message: DOMAIN_ACCESS_MESSAGES.identityUnavailable,
      retry: true,
    })
  })

  it('anything else shows the server message (or a fallback) with a retry', () => {
    expect(exchangeErrorView({ code: 'RATE_LIMITED', message: 'Wait a minute.' })).toEqual({
      message: 'Wait a minute.',
      retry: true,
    })
    expect(exchangeErrorView(null)).toEqual({ message: 'Sign-in failed. Try again.', retry: true })
  })
})
