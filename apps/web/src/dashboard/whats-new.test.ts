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
import { readWhatsNewDismissed, readWhatsNewSeen, writeWhatsNewDismissed } from './prefs.ts'
import { byTestId, fire, textOf } from './test-tree.ts'
import { WhatsNewCard } from './WhatsNew.tsx'
import {
  introCard,
  planBoardTry,
  planHintTry,
  type TryAction,
  tryKey,
  unavailableTries,
  WHATS_NEW_ITEMS,
  WHATS_NEW_MAX_ITEMS,
  WHATS_NEW_MIN_ITEMS,
  WHATS_NEW_VERSION,
  type WhatsNewItem,
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
const nobody = { canCreate: false, startRow: false, internalOnly: false }
const creator = whatsNewFor(ownerCreator)
const ids = (who: Parameters<typeof whatsNewFor>[0]) => whatsNewFor(who).map((i) => i.id)

/**
 * Wave L's five items, the ones that had a "Try it" with a hint. Wave P's card has none (its items are found in the
 * board itself), but the mechanism stays for the next release: these keep its rules under test.
 */
const hintItem = (id: TryHint, title: string, forWho: WhatsNewItem['for']): WhatsNewItem => ({
  id,
  title,
  body: 'A sentence.',
  tryIt: { kind: 'board-hint', hint: id },
  for: forWho,
})
const HINT_ITEMS: readonly WhatsNewItem[] = [
  hintItem('palette', 'Ctrl+K: do it in words', 'everyone'),
  hintItem('ask', 'Ask this board / Wrap up', 'everyone'),
  hintItem('diagram', 'Diagram from words and Mermaid paste', 'creators'),
  hintItem('time-travel', 'Time travel: bring back just what you need', 'everyone'),
  hintItem('run-of-show', 'Run of show, spotlight and vote results', 'creators'),
]

describe('the card’s items (wave T)', () => {
  it('are three to six for a creator, each with a title, a sentence and a unique id', () => {
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

  it('are wave T’s four, in the card’s order, under the version that resets the dismissed card', () => {
    expect(WHATS_NEW_VERSION).toBe('2026-10-wave-t')
    expect(WHATS_NEW_ITEMS.map((i) => i.title)).toEqual([
      'Storyboards, from a script too',
      'Play a storyboard as an animatic',
      'Work cards, Kanban and the card table',
      'Timelines from your cards',
    ])
  })

  it('have no "Try it" that could look dead: what they describe is found in the board itself (P-002)', () => {
    for (const i of WHATS_NEW_ITEMS) expect(i.tryIt, i.id).toBeNull()
    const card = WhatsNewCard({ items: creator, onTry() {}, onTellUs() {}, onDismiss() {} })
    expect(renderToStaticMarkup(card)).not.toContain('Try it')
  })

  it('the old items’ hints still resolve to a board with a hint from the allowlist', () => {
    for (const i of HINT_ITEMS) {
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
    expect(HINT_ITEMS.map((i) => i.id)).toEqual([...USAGE_WHATS_NEW_IDS])
    expect(tryHintOf('?try=nope')).toBeNull()
    expect(tryHintOf('?try=')).toBeNull()
    expect(tryHintOf('')).toBeNull()
    expect(tryHintOf('?try=ask&try=palette')).toBe('ask')
  })

  it('the new version resets the dismissed state of the old card', () => {
    const store = memoryStore()
    writeWhatsNewDismissed('usr_alice', '2026-10-wave-l', store)
    expect(readWhatsNewDismissed('usr_alice', '2026-10-wave-l', store)).toBe(true)
    expect(readWhatsNewDismissed('usr_alice', WHATS_NEW_VERSION, store)).toBe(false)
    const seen = readWhatsNewSeen('usr_alice', store)
    expect(introCard({ items: HINT_ITEMS, guest: false, seen, landing: true })).toBe('whats-new')
  })

  it('show a person only what is true for them', () => {
    // an owner or admin who can create has all of it
    expect(creator.map((i) => i.id)).toEqual(WHATS_NEW_ITEMS.map((i) => i.id))
    // someone who cannot create: all of it (each is made on a board they can edit, or played and read where they can see)
    expect(ids(nobody)).toEqual(['storyboards', 'animatic', 'cards-kanban', 'timeline'])
    // and nobody gets an item for a thing that needs more than they have
    for (const who of [ownerCreator, nobody]) {
      for (const i of whatsNewFor(who)) {
        if (i.for === 'creators') expect(who.canCreate, i.id).toBe(true)
        if (i.for === 'start-row') expect(who.startRow, i.id).toBe(true)
        if (i.for === 'internal-only') expect(who.internalOnly, i.id).toBe(true)
      }
    }
  })
})

describe('which card greets a person (wave P, P-002, P-009)', () => {
  const base = { items: HINT_ITEMS, guest: false, landing: true }

  it('a first visit (nothing remembered) gets the Welcome, never a changelog of a product they have not seen', () => {
    expect(introCard({ ...base, seen: null })).toBe('welcome')
  })

  it('someone who has seen an earlier release gets What’s new, once; after it, neither', () => {
    expect(introCard({ ...base, seen: '2026-10-wave-l' })).toBe('whats-new')
    expect(introCard({ ...base, seen: '2026-10-wave-k' })).toBe('whats-new')
    expect(introCard({ ...base, seen: WHATS_NEW_VERSION })).toBeNull()
  })

  it('shows on the landing view only, and never to a name-only guest', () => {
    for (const seen of [null, '2026-10-wave-l']) {
      expect(introCard({ ...base, seen, landing: false })).toBeNull()
      expect(introCard({ ...base, seen, guest: true })).toBeNull()
    }
  })

  it('a returning person with nothing new to read gets nothing, a newcomer still gets the Welcome', () => {
    expect(introCard({ ...base, seen: '2026-10-wave-l', items: [] })).toBeNull()
    expect(introCard({ ...base, seen: null, items: [] })).toBe('welcome')
  })

  it('what this browser remembers is the version, per person; a blocked store reads as a first visit', () => {
    const store = memoryStore()
    expect(readWhatsNewSeen('usr_alice', store)).toBeNull()
    writeWhatsNewDismissed('usr_alice', WHATS_NEW_VERSION, store)
    expect(readWhatsNewSeen('usr_alice', store)).toBe(WHATS_NEW_VERSION)
    expect(readWhatsNewSeen('usr_bob', store)).toBeNull()
    expect(readWhatsNewSeen('usr_alice', null)).toBeNull()
    const blocked = {
      getItem: () => {
        throw new Error('SecurityError')
      },
    }
    expect(readWhatsNewSeen('usr_alice', blocked)).toBeNull()
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

describe('N1 (wave M follow-up 3): a "Try it" with nowhere to go is disabled and says why, never a button that does nothing', () => {
  const base = {
    boards: [] as readonly (typeof EDITOR_BOARD)[],
    startRow: false,
    items: HINT_ITEMS,
  }
  const hintKeys = HINT_ITEMS.flatMap((i) => (i.tryIt ? [tryKey(i.tryIt)] : []))

  it('while the board list has not arrived: the board button and every board hint wait', () => {
    expect(unavailableTries({ ...base, listReady: false })).toEqual(['board', ...hintKeys])
  })

  it('a person with no board and no Start row (a client, or one who hid the templates): every board hint is unavailable', () => {
    const none = unavailableTries({ ...base, listReady: true })
    expect(none).toEqual(hintKeys)
    // what planHintTry says for the same person
    expect(
      planHintTry({
        listReady: true,
        boards: [],
        hint: 'ask',
        startRow: false,
        boardAddress: boardTryPath,
      }),
    ).toEqual({ kind: 'none' })
  })

  it('a board they can open, or the Start row, is somewhere to go: nothing is unavailable', () => {
    expect(unavailableTries({ ...base, listReady: true, boards: [VIEWER_BOARD] })).toEqual([])
    expect(unavailableTries({ ...base, listReady: true, boards: [EDITOR_BOARD] })).toEqual([])
    expect(unavailableTries({ ...base, listReady: true, startRow: true })).toEqual([])
  })

  it('the card gives a disabled button its reason as its title, and an enabled one none', () => {
    const card = WhatsNewCard({
      items: HINT_ITEMS,
      unavailable: ['board-hint:ask'],
      unavailableReason: 'Open or make a board first.',
      onTry() {},
      onTellUs() {},
      onDismiss() {},
    })
    const buttons = byTestId(card, 'whats-new-try')
    const ask = buttons.find((b) => b.props['data-action'] === 'board-hint:ask')
    const palette = buttons.find((b) => b.props['data-action'] === 'board-hint:palette')
    expect(ask?.props.disabled).toBe(true)
    expect(ask?.props.title).toBe('Open or make a board first.')
    expect(palette?.props.title).toBeUndefined()
  })
})

describe('the card', () => {
  const calls = { onTry: vi.fn<(a: TryAction) => void>(), onTellUs: vi.fn(), onDismiss: vi.fn() }
  const card = WhatsNewCard({ items: HINT_ITEMS, ...calls })

  beforeEach(() => {
    for (const fn of Object.values(calls)) fn.mockClear()
  })

  it('lists each item with its words, and a "Try it" only where there is something to try', () => {
    const html = renderToStaticMarkup(card)
    expect(html).toContain('data-testid="whats-new"')
    expect(html).toContain('What’s new in Lobby')
    const items = byTestId(card, 'whats-new-item')
    expect(items).toHaveLength(HINT_ITEMS.length)
    for (const i of HINT_ITEMS) expect(html).toContain(i.title)
    const tries = byTestId(card, 'whats-new-try')
    expect(tries.map((t) => t.props['data-action'])).toEqual(
      HINT_ITEMS.filter((i) => i.tryIt).map((i) => tryKey(i.tryIt as TryAction)),
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
      expect(calls.onTry.mock.calls[0]?.[0]).toBe(HINT_ITEMS[n]?.tryIt)
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
      items: HINT_ITEMS,
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
    const keys = HINT_ITEMS.flatMap((i) => (i.tryIt ? [tryKey(i.tryIt)] : []))
    const waiting = WhatsNewCard({
      items: HINT_ITEMS,
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
    const idle = WhatsNewCard({ items: HINT_ITEMS, onTry() {}, onTellUs() {}, onDismiss() {} })
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
          renderToStaticMarkup(
            WhatsNewCard({ items: HINT_ITEMS, onTry() {}, onTellUs() {}, onDismiss() {} }),
          ),
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
