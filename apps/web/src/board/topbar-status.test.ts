// K2-5 (wave K, UXD-01, UXP-11, F3): the top bar's status dot, its title and its Feedback pill, rendered to
// static markup (no DOM in the unit tests). The layout by width is topbar-fit.test.ts; the e2e half is
// e2e/excalidraw/k2-topbar.spec.ts.
import type { Board } from '@draftroom/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { feedbackRequest } from '../features/feedback/state.ts'
import type { SaveStatusView } from '../sync-quality/SaveStatus.tsx'
import { BoardStatus, BoardTitle, FeedbackPill, TopBarFrame } from './TopBarFrame.tsx'
import type { ConnState } from './topbar-fit.ts'

const view = (state: SaveStatusView['state'], extra: Partial<SaveStatusView> = {}): SaveStatusView => ({
  state,
  rejection: null,
  readonly: false,
  ...extra,
})

const dot = (save: SaveStatusView, conn: ConnState, saveHidden = false) =>
  renderToStaticMarkup(createElement(BoardStatus, { save, conn, saveHidden }))

/** The text of the element with `testId` in `html` ('' when it is empty). */
const textOf = (html: string, testId: string) => {
  const m = new RegExp(`data-testid="${testId}"[^>]*>([^<]*)<`).exec(html)
  return m ? m[1] : null
}
const titleOf = (html: string) => /data-testid="board-status"[^>]*title="([^"]*)"/.exec(html)?.[1] ?? null

describe('the status dot (K2-5)', () => {
  it('saved and live: the dot alone; its tooltip and its screen-reader words say Saved and Live', () => {
    const html = dot(view('saved'), 'online')
    expect(html).toContain('data-tone="ok"')
    expect(html).not.toContain('dr-status__label')
    expect(textOf(html, 'save-status')).toBe('Saved')
    expect(textOf(html, 'conn-status')).toBe('Live')
    expect(titleOf(html)).toMatch(/^Saved: .*Connected: /)
  })

  it('offline: the words beside the dot, the tooltip says what happens to changes', () => {
    const html = dot(view('offline-pending', { label: 'Offline — 2 changes on this device' }), 'offline')
    expect(html).toContain('data-tone="warn"')
    expect(html).toMatch(/class="dr-status__label"[^>]*>Offline — 2 changes on this device</)
    expect(textOf(html, 'conn-status')).toBe('Offline')
    expect(titleOf(html)).toMatch(/^Offline: changes are kept in this tab only/)
  })

  it('never says Saved before sync is live (connecting with a saved engine state)', () => {
    for (const conn of ['connecting', 'offline', 'error'] as const) {
      const html = dot(view('saved'), conn)
      expect(textOf(html, 'save-status'), conn).toBe('')
      expect(titleOf(html), conn).not.toMatch(/Saved/)
      expect(html.replace(/data-state="saved"/, ''), conn).not.toMatch(/Saved/)
    }
  })

  it('"Saved" is read once: one save-status and one conn-status, and no empty status node', () => {
    const html = dot(view('saved'), 'online')
    expect(html.match(/Saved/g)).toHaveLength(2) // the words and the tooltip
    expect(html).not.toContain('role="status"')
    // the live region that speaks problems and recoveries is not a status node
    expect(html).toMatch(/aria-live="polite"[^>]*data-testid="save-announcer"/)
  })

  it('a viewer with the role pill: save-status is hidden and the dot is the connection', () => {
    const html = dot(view('readonly', { readonly: true }), 'online', true)
    expect(html).toMatch(/data-testid="save-status"[^>]*hidden=""/)
    expect(textOf(html, 'conn-status')).toBe('Live')
  })
})

describe('the board title (UXP-11)', () => {
  it("the H1's accessible name is the title only; the button is 'Rename board'", () => {
    const html = renderToStaticMarkup(
      createElement(BoardTitle, { title: 'Launch plan', canRename: true, onRename: () => {} }),
    )
    const labelledBy = /<h1[^>]*aria-labelledby="([^"]+)"/.exec(html)?.[1]
    expect(labelledBy).toBeTruthy()
    // the element it names is the title's own text
    expect(html).toContain(`<span id="${labelledBy}">Launch plan</span>`)
    expect(html).toMatch(/<button[^>]*aria-label="Rename board"/)
    expect(html).toMatch(new RegExp(`aria-describedby="${labelledBy}"`))
    expect(html).not.toContain(', rename board')
  })

  it('someone who cannot rename gets the title as a plain heading', () => {
    const html = renderToStaticMarkup(
      createElement(BoardTitle, { title: 'Read me', canRename: false, onRename: () => {} }),
    )
    expect(html).toMatch(/<h1[^>]*>Read me<\/h1>/)
  })
})

describe('the Feedback pill (F3)', () => {
  it('opens wave J5’s dialog about this board through openFeedback', () => {
    const html = renderToStaticMarkup(createElement(FeedbackPill, { board: { id: 'b1', title: 'Plan' } }))
    expect(html).toContain('data-testid="topbar-feedback"')
    expect(html).toContain('aria-label="Send feedback"')
    expect(html).toContain('>Feedback<')
  })

  it('is in the wide bar, first on the right side, with one status dot and no comment tool', () => {
    feedbackRequest.set(null)
    const board = {
      id: 'b-top',
      title: 'Launch plan',
      status: 'active',
      visibility: 'workspace',
    } as unknown as Board
    const html = renderToStaticMarkup(
      createElement(TopBarFrame, {
        board,
        role: 'owner',
        workspace: { id: 'w1', name: 'Dev Studio' },
        conn: 'online',
        save: view('saved'),
        onRename: () => {},
        onShare: () => {},
        onRequestAccess: () => {},
        people: () => null,
        items: () => null,
      }),
    )
    expect(html.match(/data-testid="topbar-feedback"/g)).toHaveLength(1)
    expect(html.match(/data-testid="board-status"/g)).toHaveLength(1)
    expect(html).not.toContain('data-testid="comment-tool"')
    // in DOM (= Tab) order: Feedback, the dot, then Share
    const at = (id: string) => html.indexOf(`data-testid="${id}"`)
    expect(at('topbar-feedback')).toBeLessThan(at('board-status'))
    expect(at('board-status')).toBeLessThan(at('share-button'))
  })
})
