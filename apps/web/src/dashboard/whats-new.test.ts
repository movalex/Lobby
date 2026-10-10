// Wave K (K4-5): the Feedback pill and the What's new card on the dashboard. Zero real feedback items arrived in
// the first week, and pilot users had no way to learn what wave K moved. Component tests in Node (the pill and
// the card are plain functions of their props); the page behaviour (the pill sends one item to the api, the card
// dismisses and stays dismissed after a reload) is e2e/excalidraw/k4-dashboard.spec.ts.
import { USAGE_WHATS_NEW_IDS } from '@draftroom/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { boardTryPath, isTryHint, type TryHint, tryHintOf } from '../features/command-palette/try-hints.ts'
import { FeedbackHost } from '../features/feedback/FeedbackHost.tsx'
import { FeedbackPill } from '../features/feedback/FeedbackPill.tsx'
import { closeFeedback, feedbackRequest } from '../features/feedback/state.ts'
import { readWhatsNewDismissed, writeWhatsNewDismissed } from './prefs.ts'
import { byTestId, fire, textOf } from './test-tree.ts'
import { WhatsNewCard } from './WhatsNew.tsx'
import {
  planBoardTry,
  planHintTry,
  showWhatsNew,
  type TryAction,
  tryKey,
  WHATS_NEW_ITEMS,
  WHATS_NEW_MAX_ITEMS,
  WHATS_NEW_MIN_ITEMS,
  WHATS_NEW_VERSION,
  whatsNewFor,
} from './whats-new.ts'

/** An in-memory stand-in for localStorage. */
const memoryStore = () => {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  }
}

// the people the card is for, in the terms the dashboard computes them
const ownerCreator = { canCreate: true, startRow: true, internalOnly: true }
const creator = whatsNewFor(ownerCreator)
const ids = (who: Parameters<typeof whatsNewFor>[0]) => whatsNewFor(who).map((i) => i.id)

describe('the card’s items (wave L, M3-3)', () => {
  it('are three to five for a creator, each with a title, a sentence and a unique id', () => {
    expect(creator.length).toBeGreaterThanOrEqual(WHATS_NEW_MIN_ITEMS)
    expect(creator.length).toBeLessThanOrEqual(WHATS_NEW_MAX_ITEMS)
    expect(WHATS_NEW_ITEMS.length).toBeLessThanOrEqual(WHATS_NEW_MAX_ITEMS)
    expect(new Set(WHATS_NEW_ITEMS.map((i) => i.id)).size).toBe(WHATS_NEW_ITEMS.length)
    for (const i of WHATS_NEW_ITEMS) {
      expect(i.title.length, i.id).toBeGreaterThan(8)
      expect(i.body, i.id).toMatch(/[.]$/)
      expect(i.body.length, i.id).toBeLessThan(160)
    }
  })

  it('are wave L’s five, in the card’s order, under the version that resets everybody’s dismissed card', () => {
    expect(WHATS_NEW_VERSION).toBe('2026-10-wave-l')
    expect(WHATS_NEW_ITEMS.map((i) => i.title)).toEqual([
      'Ctrl+K: do it in words',
      'Ask this board / Wrap up',
      'Diagram from words and Mermaid paste',
      'Time travel: bring back just what you need',
      'Run of show, spotlight and vote results',
    ])
    // each item’s id is its hint: the same names count \`whatsnew.try:<id>\` (the contract’s USAGE_WHATS_NEW_IDS)
    expect(WHATS_NEW_ITEMS.map((i) => i.id)).toEqual([...USAGE_WHATS_NEW_IDS])
  })

  it('go to something: each "Try it" is a board with a hint from the allowlist, resolved to a URL', () => {
    for (const i of WHATS_NEW_ITEMS) {
      expect(i.tryIt, i.id).toMatchObject({ kind: 'board-hint', hint: i.id })
      const plan = planHintTry({
        listReady: true,
        boards: [EDITOR_BOARD],
        hint: (i.tryIt as { hint: TryHint }).hint,
        startRow: true,
        boardAddress: boardTryPath,
      })
      expect(plan.kind, i.id).toBe('open')
      if (plan.kind !== 'open') continue
      expect(plan.to).toBe(`/b/b-edit?try=${i.id}`)
      // read back by the board page: only a listed hint is ever put on an address, and only a listed one is read
      expect(tryHintOf(new URL(plan.to, 'http://lobby.invalid').search)).toBe(i.id)
      expect(isTryHint(i.id)).toBe(true)
    }
    expect(tryHintOf('?try=nope')).toBeNull()
    expect(tryHintOf('?try=')).toBeNull()
    expect(tryHintOf('')).toBeNull()
    expect(tryHintOf('?try=ask&try=palette')).toBe('ask')
  })

  it('the new version resets the dismissed state of the old card', () => {
    const store = memoryStore()
    writeWhatsNewDismissed('usr_alice', '2026-10-wave-k', store)
    expect(readWhatsNewDismissed('usr_alice', '2026-10-wave-k', store)).toBe(true)
    expect(readWhatsNewDismissed('usr_alice', WHATS_NEW_VERSION, store)).toBe(false)
    expect(
      showWhatsNew({
        items: creator,
        guest: false,
        dismissed: readWhatsNewDismissed('usr_alice', WHATS_NEW_VERSION, store),
        landing: true,
      }),
    ).toBe(true)
  })

  it('show a person only what is true for them', () => {
    // an owner or admin who can create has all of it
    expect(creator.map((i) => i.id)).toEqual(WHATS_NEW_ITEMS.map((i) => i.id))
    // someone who can neither create nor open the Internal only control: what a viewer, a commenter or a plain member can use
    expect(ids({ canCreate: false, startRow: false, internalOnly: false })).toEqual([
      'palette',
      'ask',
      'time-travel',
    ])
    // a creator who asked to be spared the template row still gets all of wave L’s items
    expect(ids({ canCreate: true, startRow: false, internalOnly: false })).toEqual(
      WHATS_NEW_ITEMS.map((i) => i.id),
    )
    // and nobody gets a "Try it" for a thing that needs more than they have
    for (const who of [ownerCreator, { canCreate: false, startRow: false, internalOnly: false }]) {
      for (const i of whatsNewFor(who)) {
        if (i.for === 'creators') expect(who.canCreate, i.id).toBe(true)
        if (i.for === 'start-row') expect(who.startRow, i.id).toBe(true)
        if (i.for === 'internal-only') expect(who.internalOnly, i.id).toBe(true)
      }
    }
  })

  it('show on the landing view for people with something to read, never to a name-only guest or after dismissal', () => {
    const base = { items: creator, guest: false, dismissed: false, landing: true }
    expect(showWhatsNew(base)).toBe(true)
    expect(showWhatsNew({ ...base, dismissed: true })).toBe(false)
    expect(showWhatsNew({ ...base, guest: true })).toBe(false)
    expect(showWhatsNew({ ...base, landing: false })).toBe(false)
    expect(showWhatsNew({ ...base, items: [] })).toBe(false)
  })
})

const EDITOR_BOARD = { id: 'b-edit', role: 'editor', status: 'active' } as const
const VIEWER_BOARD = { id: 'b-view', role: 'viewer', status: 'active' } as const

describe('"Try it" on a wave L item opens the board they opened last that they can edit (M3-3)', () => {
  const plan = (over: Partial<Parameters<typeof planHintTry>[0]> = {}) =>
    planHintTry({
      listReady: true,
      boards: [],
      hint: 'ask',
      startRow: false,
      boardAddress: boardTryPath,
      ...over,
    })

  it('waits for the board list, then takes the first board of the list (the most recently opened) they can edit', () => {
    expect(plan({ listReady: false, boards: [EDITOR_BOARD] })).toEqual({ kind: 'wait' })
    // the viewer board was opened last, but it is not one they can edit: the next one is
    expect(plan({ boards: [VIEWER_BOARD, EDITOR_BOARD] })).toMatchObject({
      kind: 'open',
      boardId: 'b-edit',
      hint: 'ask',
      to: '/b/b-edit?try=ask',
    })
    // an archived or trashed board is not one to try things on
    expect(
      plan({ boards: [{ id: 'b-old', role: 'owner', status: 'archived' }, EDITOR_BOARD] }),
    ).toMatchObject({
      boardId: 'b-edit',
    })
  })

  it('with no board they can edit it is the Start row, when they get it; nothing is made either way', () => {
    expect(plan({ boards: [VIEWER_BOARD], startRow: true })).toEqual({ kind: 'start-row' })
    expect(plan({ boards: [], startRow: true })).toEqual({ kind: 'start-row' })
  })

  it('someone who can only look still lands on their latest board (the palette, Ask and Time travel are theirs too)', () => {
    expect(plan({ boards: [VIEWER_BOARD] })).toMatchObject({
      kind: 'open',
      boardId: 'b-view',
      to: '/b/b-view?try=ask',
    })
    expect(plan({ boards: [] })).toEqual({ kind: 'none' })
  })
})

describe('the card', () => {
  const calls = { onTry: vi.fn<(a: TryAction) => void>(), onTellUs: vi.fn(), onDismiss: vi.fn() }
  const card = WhatsNewCard({ items: creator, ...calls })

  beforeEach(() => {
    for (const fn of Object.values(calls)) fn.mockClear()
  })

  it('lists each item with its words, and a "Try it" only where there is something to try', () => {
    const html = renderToStaticMarkup(card)
    expect(html).toContain('data-testid="whats-new"')
    expect(html).toContain('What’s new in Lobby')
    const items = byTestId(card, 'whats-new-item')
    expect(items).toHaveLength(creator.length)
    for (const i of creator) expect(html).toContain(i.title)
    const tries = byTestId(card, 'whats-new-try')
    expect(tries.map((t) => t.props['data-action'])).toEqual(
      creator.filter((i) => i.tryIt).map((i) => tryKey(i.tryIt as TryAction)),
    )
    expect(tries.map((t) => t.props['data-action'])).toEqual([
      'board-hint:palette',
      'board-hint:ask',
      'board-hint:diagram',
      'board-hint:time-travel',
      'board-hint:run-of-show',
    ])
  })

  it('names each "Try it" button for its item, so a screen reader hears more than "Try it" five times', () => {
    for (const t of byTestId(card, 'whats-new-try'))
      expect(String(t.props['aria-label'])).toMatch(/^Try it: /)
  })

  it('sends a "Try it" to its place, "Tell us" to the feedback dialog, and the close button to dismiss', () => {
    for (const [n, t] of byTestId(card, 'whats-new-try').entries()) {
      calls.onTry.mockClear()
      fire(t)
      expect(calls.onTry).toHaveBeenCalledTimes(1)
      expect(calls.onTry.mock.calls[0]?.[0]).toBe(creator[n]?.tryIt)
    }
    fire(byTestId(card, 'whats-new-tell-us')[0] as never)
    expect(calls.onTellUs).toHaveBeenCalledTimes(1)
    expect(textOf(byTestId(card, 'whats-new-tell-us')[0])).toBe('Tell us')
    const dismiss = byTestId(card, 'whats-new-dismiss')[0]
    expect(dismiss?.props['aria-label']).toBe('Dismiss what’s new')
    fire(dismiss as never)
    expect(calls.onDismiss).toHaveBeenCalledTimes(1)
  })
})

describe('"Try it" on the board’s top bar leaves nothing behind (K4-5 review)', () => {
  it('waits for the board list, then opens the board they opened last', () => {
    expect(planBoardTry({ listReady: false, latestBoardId: null, canCreate: true })).toEqual({ kind: 'wait' })
    expect(planBoardTry({ listReady: false, latestBoardId: 'b-1', canCreate: true })).toEqual({
      kind: 'wait',
    })
    expect(planBoardTry({ listReady: true, latestBoardId: 'b-1', canCreate: true })).toEqual({
      kind: 'open',
      boardId: 'b-1',
    })
    // a viewer who cannot create still sees the board they have
    expect(planBoardTry({ listReady: true, latestBoardId: 'b-1', canCreate: false })).toEqual({
      kind: 'open',
      boardId: 'b-1',
    })
  })

  it('makes the Lobby tour only for someone with no board at all, and only if they may', () => {
    expect(planBoardTry({ listReady: true, latestBoardId: null, canCreate: true })).toEqual({
      kind: 'make-tour',
    })
    expect(planBoardTry({ listReady: true, latestBoardId: null, canCreate: false })).toEqual({ kind: 'none' })
  })
})

describe('the card while a "Try it" is under way', () => {
  const enabled = (node: ReturnType<typeof WhatsNewCard>) =>
    byTestId(node, 'whats-new-try').map((t) => [t.props['data-action'], t.props.disabled === true] as const)

  it('shows "Opening…" on the button in flight and disables every "Try it" until it is done', () => {
    const busy = WhatsNewCard({
      items: creator,
      pending: 'board-hint:ask',
      onTry() {},
      onTellUs() {},
      onDismiss() {},
    })
    expect(enabled(busy).every(([, off]) => off)).toBe(true)
    const buttons = byTestId(busy, 'whats-new-try')
    const mine = buttons.find((b) => b.props['data-action'] === 'board-hint:ask')
    expect(textOf(mine)).toBe('Opening…')
    expect(mine?.props['aria-busy']).toBe(true)
    // the others keep their words, and tell nobody they are busy
    const other = buttons.find((b) => b.props['data-action'] === 'board-hint:palette')
    expect(textOf(other)).toBe('Try it')
    expect(other?.props['aria-busy']).toBeUndefined()
  })

  it('disables only the "Try it" whose place is not ready yet (the board list has not arrived)', () => {
    const keys = creator.flatMap((i) => (i.tryIt ? [tryKey(i.tryIt)] : []))
    const waiting = WhatsNewCard({
      items: creator,
      unavailable: keys.filter((k) => k !== 'board-hint:palette'),
      onTry() {},
      onTellUs() {},
      onDismiss() {},
    })
    expect(enabled(waiting)).toEqual([
      ['board-hint:palette', false],
      ['board-hint:ask', true],
      ['board-hint:diagram', true],
      ['board-hint:time-travel', true],
      ['board-hint:run-of-show', true],
    ])
    // nothing pending, nothing unavailable: all enabled
    const idle = WhatsNewCard({ items: creator, onTry() {}, onTellUs() {}, onDismiss() {} })
    expect(enabled(idle).every(([, off]) => !off)).toBe(true)
  })
})

describe('dismissing it is remembered per viewer', () => {
  const memory = () => {
    const m = new Map<string, string>()
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    }
  }

  it('for that person and that version only', () => {
    const store = memory()
    expect(readWhatsNewDismissed('usr_alice', WHATS_NEW_VERSION, store)).toBe(false)
    writeWhatsNewDismissed('usr_alice', WHATS_NEW_VERSION, store)
    expect(readWhatsNewDismissed('usr_alice', WHATS_NEW_VERSION, store)).toBe(true)
    // somebody else on this browser still sees it, and so does a card with new words
    expect(readWhatsNewDismissed('usr_bob', WHATS_NEW_VERSION, store)).toBe(false)
    expect(readWhatsNewDismissed('usr_alice', `${WHATS_NEW_VERSION}-2`, store)).toBe(false)
  })

  describe('storage that throws or is missing (a private window, blocked site data)', () => {
    const blocked = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
      removeItem: () => {
        throw new Error('SecurityError')
      },
    }

    it('reads as "not dismissed" and writes nothing, never throwing', () => {
      expect(readWhatsNewDismissed('usr_alice', WHATS_NEW_VERSION, blocked)).toBe(false)
      expect(() => writeWhatsNewDismissed('usr_alice', WHATS_NEW_VERSION, blocked)).not.toThrow()
      expect(readWhatsNewDismissed('usr_alice', WHATS_NEW_VERSION, null)).toBe(false)
      expect(() => writeWhatsNewDismissed('usr_alice', WHATS_NEW_VERSION, null)).not.toThrow()
    })

    it('also when the browser throws on touching localStorage at all, and the card still renders', () => {
      const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get() {
          throw new Error('SecurityError: access denied')
        },
      })
      try {
        expect(readWhatsNewDismissed('usr_alice', WHATS_NEW_VERSION)).toBe(false)
        expect(() => writeWhatsNewDismissed('usr_alice', WHATS_NEW_VERSION)).not.toThrow()
        expect(
          renderToStaticMarkup(WhatsNewCard({ items: creator, onTry() {}, onTellUs() {}, onDismiss() {} })),
        ).toContain('data-testid="whats-new"')
      } finally {
        if (original) Object.defineProperty(globalThis, 'localStorage', original)
        else Reflect.deleteProperty(globalThis, 'localStorage')
      }
    })
  })
})

describe('the Feedback pill', () => {
  beforeEach(() => {
    vi.stubGlobal('location', { pathname: '/w/wsp_0123456789abcdefghij' })
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0' })
    vi.stubGlobal('window', { innerWidth: 1280, innerHeight: 720 })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    closeFeedback()
  })

  it('is a button named Feedback, on the page', () => {
    const html = renderToStaticMarkup(createElement(FeedbackPill))
    expect(html).toMatch(/<button[^>]*data-testid="feedback-pill"[^>]*>.*Feedback<\/button>/)
  })

  it('opens the feedback dialog (the dashboard is no board, so none is named), and gives the keyboard back to itself', () => {
    expect(feedbackRequest.get()).toBeNull()
    const focus = vi.fn()
    fire(byTestId(FeedbackPill({}), 'feedback-pill')[0] as never, 'onClick', { currentTarget: { focus } })
    const asked = feedbackRequest.get()
    expect(asked).not.toBeNull()
    expect(asked?.board).toBeNull()
    asked?.restoreFocus?.()
    expect(focus).toHaveBeenCalledTimes(1)
    // the host that sits at the root of the app then shows the dialog
    expect(renderToStaticMarkup(createElement(FeedbackHost))).toContain('data-testid="feedback-dialog"')
  })

  it('shows no dialog until it is pressed', () => {
    expect(renderToStaticMarkup(createElement(FeedbackHost))).toBe('')
  })
})
