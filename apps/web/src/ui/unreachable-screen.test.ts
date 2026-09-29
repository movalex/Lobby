import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { UnreachableScreen } from './screens.tsx'

// Fixer round 3 (docs/DOMAIN-ACCESS-CONTRACTS.md §21): RequireSession and the invite page show the same
// "Can't reach Lobby" screen, with a retry.
describe("Can't reach Lobby", () => {
  it('says so, with the reason and one "Try again" button', () => {
    const html = renderToStaticMarkup(
      createElement(UnreachableScreen, { message: 'Lobby had a problem handling that.', onRetry: () => {} }),
    )
    expect(html).toContain('data-testid="api-unreachable"')
    expect(html).toContain('Can&#x27;t reach Lobby')
    expect(html).toContain('Lobby had a problem handling that.')
    expect(html).toMatch(
      /<button type="button"[^>]*data-testid="api-unreachable-retry"[^>]*>Try again<\/button>/,
    )
    // Nothing about signing in or access.
    expect(html).not.toMatch(/Sign in|access/i)
  })
})
