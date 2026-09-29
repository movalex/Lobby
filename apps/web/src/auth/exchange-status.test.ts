import { DOMAIN_ACCESS_MESSAGES } from '@draftroom/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ExchangeStatus } from './ExchangeStatus.tsx'
import { exchangeErrorView } from './exchange-error.ts'

/** The markup ClerkSignIn shows after Clerk's form, for a refused (or running) exchange. */
function render(code: string | null): string {
  const error = code === null ? null : exchangeErrorView({ code, message: 'server words' })
  return renderToStaticMarkup(
    createElement(ExchangeStatus, {
      error,
      onRetry: () => {},
      actions: createElement('button', { type: 'button', 'data-testid': 'clerk-use-another' }, 'Use another'),
    }),
  )
}

/** The text of the element carrying `testid` in `html` (null when there is none). */
function textOf(html: string, testid: string): string | null {
  const m = new RegExp(`<[a-z]+[^>]*data-testid="${testid}"[^>]*>([^<]*)<`).exec(html)
  return m ? (m[1] ?? '') : null
}

const decoded = (s: string | null) =>
  s
    ?.replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')

describe('Clerk sign-in: a refused exchange is rendered (domain access, §9)', () => {
  it('a disabled account: its message in an alert, no "Try again", and another account offered', () => {
    const html = render('ACCOUNT_DISABLED')
    expect(html).toMatch(/^<div role="alert">/)
    expect(decoded(textOf(html, 'clerk-exchange-error'))).toBe(DOMAIN_ACCESS_MESSAGES.accountDisabled)
    expect(html).not.toContain('clerk-exchange-retry')
    expect(html).toContain('data-testid="clerk-use-another"')
  })

  it('the sign-in service unreachable: its message in an alert, with "Try again"', () => {
    const html = render('IDENTITY_UNAVAILABLE')
    expect(html).toMatch(/^<div role="alert">/)
    expect(decoded(textOf(html, 'clerk-exchange-error'))).toBe(DOMAIN_ACCESS_MESSAGES.identityUnavailable)
    expect(textOf(html, 'clerk-exchange-retry')).toBe('Try again')
    expect(html).toContain('data-testid="clerk-use-another"')
  })

  it('while the exchange runs: a status, no error and no actions', () => {
    const html = render(null)
    expect(html).toMatch(/^<div role="status">/)
    expect(html).toContain('Signing you in to Lobby…')
    expect(html).not.toContain('clerk-exchange-error')
    expect(html).not.toContain('clerk-use-another')
  })
})
