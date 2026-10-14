// Wave P (P-002, P-009, P-010): the Welcome card a first visit gets, and the Help menu. Component tests in Node (the
// card is a plain function of its props); the page behaviour is e2e/excalidraw/p-first-run.spec.ts.
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { helpMenuItems } from './HelpMenu.tsx'
import { START_TILES, type StartChoice, startTitle } from './start-row-model.ts'
import { byTestId, fire, textOf } from './test-tree.ts'
import { WelcomeCard } from './Welcome.tsx'
import { helpShortcuts, isApplePlatform, WELCOME_STARTS, welcomeShortcuts } from './welcome.ts'

describe('the Welcome card', () => {
  const calls = {
    onStart: vi.fn<(c: StartChoice) => void>(),
    onMoreTemplates: vi.fn(),
    onDismiss: vi.fn(),
  }
  const card = WelcomeCard({ canCreate: true, ...calls })

  beforeEach(() => {
    for (const fn of Object.values(calls)) fn.mockClear()
  })

  it('says what Lobby is and offers three one-click starts: a blank board, a template, the Lobby tour', () => {
    const html = renderToStaticMarkup(card)
    expect(html).toContain('Welcome to Lobby')
    expect(html).toContain('shared board')
    const starts = byTestId(card, 'welcome-start')
    expect(starts.map((s) => s.props['data-template-id'])).toEqual(['blank', 'brainstorm', 'lobby-tour'])
    // each one is a tile of the Start row, under the same name
    for (const s of WELCOME_STARTS)
      expect(START_TILES.find((t) => t.choice === s.choice)?.name, s.choice).toBe(s.name)
  })

  it('makes the board of the start that was pressed, and offers more templates and a dismiss', () => {
    for (const s of byTestId(card, 'welcome-start')) {
      calls.onStart.mockClear()
      fire(s)
      expect(calls.onStart).toHaveBeenCalledWith(s.props['data-template-id'])
    }
    fire(byTestId(card, 'welcome-more-templates')[0] as never)
    expect(calls.onMoreTemplates).toHaveBeenCalledTimes(1)
    fire(byTestId(card, 'welcome-dismiss')[0] as never)
    expect(calls.onDismiss).toHaveBeenCalledTimes(1)
  })

  it('lists the keys to know, written for this platform', () => {
    expect(renderToStaticMarkup(WelcomeCard({ canCreate: true, apple: false, ...calls }))).toContain('Ctrl+K')
    const mac = renderToStaticMarkup(WelcomeCard({ canCreate: true, apple: true, ...calls }))
    expect(mac).toContain('⌘K')
    expect(mac).not.toContain('Ctrl+')
    expect(welcomeShortcuts(false).map((k) => k.keys)).toContain('N · T · R')
  })

  it('waits for the board being made: every start is disabled and the pressed one says "Creating…"', () => {
    const busy = WelcomeCard({ canCreate: true, pending: 'brainstorm', ...calls })
    const starts = byTestId(busy, 'welcome-start')
    expect(starts.every((s) => s.props.disabled === true)).toBe(true)
    expect(textOf(starts.find((s) => s.props['data-template-id'] === 'brainstorm'))).toContain('Creating…')
    expect(textOf(starts.find((s) => s.props['data-template-id'] === 'blank'))).toContain('Blank board')
  })

  it('for someone who may not make boards: no starts, and how boards reach them', () => {
    const viewer = WelcomeCard({ canCreate: false, ...calls })
    expect(byTestId(viewer, 'welcome-start')).toHaveLength(0)
    expect(byTestId(viewer, 'welcome-more-templates')).toHaveLength(0)
    expect(textOf(byTestId(viewer, 'welcome-no-create')[0])).toContain('shares one with you')
  })

  it('has no changelog wording: nothing about "What’s new" or a "Try it" button', () => {
    const html = renderToStaticMarkup(card)
    expect(html).not.toContain('Try it')
    expect(html).not.toContain('What’s new')
  })
})

describe('the Help menu', () => {
  it('offers the tour (to people who can make a board), the keyboard shortcuts and Send feedback', () => {
    expect(helpMenuItems(true).map((i) => i.label)).toEqual([
      'Take the Lobby tour',
      'Keyboard shortcuts',
      'Send feedback',
    ])
    expect(helpMenuItems(false).map((i) => i.action)).toEqual(['shortcuts', 'feedback'])
  })

  it('lists the dashboard’s keys and the board’s, with the platform’s modifier', () => {
    const sections = helpShortcuts(false)
    expect(sections.map((s) => s.title)).toEqual(['On a board', 'On the dashboard'])
    const rows = sections.flatMap((s) => s.rows)
    expect(rows.some((r) => r.keys === 'Ctrl+E' && /boards/i.test(r.does))).toBe(true)
    expect(
      helpShortcuts(true)
        .flatMap((s) => s.rows)
        .every((r) => !r.keys.includes('Ctrl+')),
    ).toBe(true)
  })

  it('knows a Mac from the rest', () => {
    expect(isApplePlatform({ platform: 'MacIntel', userAgent: '' })).toBe(true)
    expect(isApplePlatform({ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0)' })).toBe(false)
    expect(isApplePlatform(undefined)).toBe(false)
  })
})

describe('the title of a board made from the Welcome card (before the catalog has loaded)', () => {
  it('is the tile’s name for a template, and "Untitled board" for a blank one', () => {
    expect(startTitle(null, 'brainstorm')).toBe('Brainstorm')
    expect(startTitle(null, 'lobby-tour')).toBe('Lobby tour')
    expect(startTitle(null, 'blank')).toBe('Untitled board')
    expect(startTitle(null)).toBe('Untitled board')
  })
})
