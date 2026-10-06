// The Send feedback dialog and the entries that open it, rendered to markup (no browser: node + react-dom/server).
// The behaviour in a real browser (typing, sending, the board's menu, the inbox) is e2e/excalidraw/feedback.spec.ts.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FeedbackDialog } from './FeedbackDialog.tsx'
import { closeFeedback, feedbackRequest, openFeedback } from './state.ts'

const UA = 'Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0'
beforeEach(() => {
  vi.stubGlobal('location', { pathname: '/b/b-abc1234567' })
  vi.stubGlobal('navigator', { userAgent: UA })
  vi.stubGlobal('window', { innerWidth: 1280, innerHeight: 720 })
})
afterEach(() => {
  vi.unstubAllGlobals()
  closeFeedback()
})

const render = (board: { id: string; title: string } | null) =>
  renderToStaticMarkup(createElement(FeedbackDialog, { board, onClose: () => {}, send: async () => {} }))

describe('the dialog', () => {
  it('asks what happened (required) and what was expected (optional), plain text, 4,000 characters each', () => {
    const html = render(null)
    expect(html).toContain('data-testid="feedback-dialog"')
    expect(html).toContain('Send feedback')
    expect(html).toContain('What happened?')
    expect(html).toContain('What did you expect?')
    expect(html).toContain('(optional)')
    expect(html).toMatch(
      /<textarea[^>]*data-testid="feedback-text"[^>]*maxLength="4000"|<textarea[^>]*maxlength="4000"[^>]*data-testid="feedback-text"/i,
    )
    expect(html).toMatch(/<textarea[^>]*data-testid="feedback-expected"/)
    expect(html).toMatch(/<textarea[^>]*data-testid="feedback-text"[^>]*required/)
    expect(html).toContain('0 / 4,000')
    // nothing to send yet
    expect(html).toMatch(/<button[^>]*data-testid="feedback-submit"[^>]*disabled/)
  })

  it('lists what is attached, before sending: page, browser, window, build and time', () => {
    const html = render(null)
    expect(html).toContain('Sent with your message')
    expect(html).toContain('data-testid="feedback-context-page"')
    expect(html).toContain('/b/b-abc1234567')
    expect(html).toContain(UA)
    expect(html).toContain('1280 × 720')
    expect(html).toContain('data-testid="feedback-context-build"')
    expect(html).toContain('>dev<')
    expect(html).toContain('data-testid="feedback-context-time"')
    // off a board there is no board row
    expect(html).not.toContain('feedback-context-board')
  })

  it('names the board by title and id when opened from one', () => {
    const html = render({ id: 'b-abc1234567', title: 'Q4 <b>plan</b>' })
    expect(html).toContain('data-testid="feedback-context-board"')
    // as text: the title is escaped, never markup
    expect(html).toContain('Q4 &lt;b&gt;plan&lt;/b&gt; (b-abc1234567)')
    expect(html).not.toContain('<b>plan</b>')
  })

  it('never lists a query string or a fragment', () => {
    vi.stubGlobal('location', { pathname: '/b/b-abc1234567?token=SECRET#frag' })
    const html = render(null)
    expect(html).not.toContain('SECRET')
    expect(html).not.toContain('frag')
  })
})

describe('opening it', () => {
  it('openFeedback asks for the dialog, with the board when there is one; every open is a fresh form', () => {
    expect(feedbackRequest.get()).toBeNull()
    openFeedback({ id: 'b-abc1234567', title: 'Q4 plan' })
    const first = feedbackRequest.get()
    expect(first).toMatchObject({ board: { id: 'b-abc1234567', title: 'Q4 plan' } })
    openFeedback()
    const second = feedbackRequest.get()
    expect(second?.board).toBeNull()
    expect(second?.seq).toBeGreaterThan(first?.seq ?? 0)
    closeFeedback()
    expect(feedbackRequest.get()).toBeNull()
  })
})
