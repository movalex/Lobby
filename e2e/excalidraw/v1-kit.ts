// OWNER: WS2 (wave V, V1). What the v1-* specs share: the live activities' web switch turned on in a page (a dev-auth
// build reads localStorage LIVE_FLAG_KEYS, features/live/flags.ts; the e2e stack runs the api with
// DRAFTROOM_LIVE_ACTIVITIES=on), a name-only guest on a workshop link (a phone at 375 px by default), starting an
// activity from the Facilitate menu, answering in the panel, and reads of what was placed on the board.
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test'
import { expectSaved, items } from '../tests/support/canvas.ts'
import { API_URL, WEB_URL } from '../tests/support/ports.ts'
import { openFacilitate } from '../tests/support/workshops.ts'
import {
  type CanvasElement,
  expect,
  post,
  reloadBoard,
  type WorkshopCanvasSession,
  waitForWorkshopBoard,
} from './workshops-kit.ts'

export * from './workshops-kit.ts'

/** The live activities' web switch, as a dev-auth page reads it (features/live/flags.ts LIVE_FLAG_KEYS). */
export const LIVE_ACTIVITIES_KEY = 'lobby.liveActivities'

/** A phone at 375 px (the narrowest layout the acceptance names). */
export const PHONE_375 = {
  viewport: { width: 375, height: 812 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
} as const

/** Turns the switch on for every page of `context` (from its next navigation). */
export async function liveActivitiesOn(context: BrowserContext): Promise<void> {
  await context.addInitScript((key: string) => {
    try {
      localStorage.setItem(key, '1')
    } catch {
      // a blocked store: the switch stays off and the spec fails on what it looks for
    }
  }, LIVE_ACTIVITIES_KEY)
}

/** A joined session with the switch on: the init script, then a reload. */
export async function withLive(s: WorkshopCanvasSession): Promise<WorkshopCanvasSession> {
  await liveActivitiesOn(s.context)
  await reloadBoard(s)
  return s
}

/** Every request a context makes that leaves Lobby's own origins (none may: the e2e network assertion). */
export function foreignRequestsOf(context: BrowserContext): string[] {
  const own = new Set([new URL(WEB_URL).origin, new URL(API_URL).origin])
  const out: string[] = []
  context.on('request', (r) => {
    const url = new URL(r.url())
    if (url.protocol === 'data:' || url.protocol === 'blob:') return
    if (!own.has(url.origin)) out.push(r.url())
  })
  return out
}

/** A workshop link (multi-use editor, name-only guests allowed) made by `owner`. */
export async function workshopLink(owner: WorkshopCanvasSession, board: string): Promise<string> {
  const r = await post(owner, `/api/boards/${board}/review-links`, { role: 'editor', allowGuests: true })
  expect(r.status(), await r.text()).toBe(201)
  return ((await r.json()) as { url: string }).url
}

export interface GuestSession {
  readonly context: BrowserContext
  readonly page: Page
  readonly id: string
  readonly name: string
  readonly foreign: string[]
}

/** A fresh browser with no account (a 375 px phone unless `options` say otherwise) that joins `url` as `name`. */
export async function guestJoins(
  browser: Browser,
  url: string,
  name: string,
  opened: BrowserContext[],
  options: Parameters<Browser['newContext']>[0] = PHONE_375,
): Promise<GuestSession> {
  const context = await browser.newContext(options)
  opened.push(context)
  await liveActivitiesOn(context)
  const foreign = foreignRequestsOf(context)
  const page = await context.newPage()
  await page.goto(url)
  await page.getByTestId('invite-guest-name').fill(name)
  await page.getByTestId('invite-guest-join').click()
  await expect(page).toHaveURL(/\/b\/[a-z0-9-]+$/, { timeout: 30_000 })
  await waitForWorkshopBoard(page)
  const id = (await page.getByTestId('user-menu').getAttribute('data-user-id')) ?? ''
  return { context, page, id, name, foreign }
}

// ---- the facilitator ---------------------------------------------------------------------------------------------

export interface StartOptions {
  kind: 'poll' | 'scale' | 'words'
  prompt: string
  options?: string[]
  /** a poll's "Each person picks" (1 = one option) */
  maxChoices?: number
  /** a scale's range index (0: 1-5, 1: 1-7, 2: 0-10) */
  range?: number
  minLabel?: string
  maxLabel?: string
  maxWords?: number
  anonymous?: boolean
  resultsLive?: boolean
}

/** Opens the setup dialog from the Facilitate menu ("Poll or word cloud"). */
export async function openSetup(page: Page): Promise<Locator> {
  const menu = await openFacilitate(page)
  await menu.getByTestId('facilitate-activities').click()
  const dialog = page.getByTestId('la-setup-dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

/** Starts an activity through the setup dialog; the panel opens on it. */
export async function startActivity(page: Page, o: StartOptions): Promise<void> {
  const d = await openSetup(page)
  await d.getByTestId(`la-kind-${o.kind}`).check()
  await d.getByTestId('la-prompt-input').fill(o.prompt)
  if (o.kind === 'poll') {
    const opts = o.options ?? ['Yes', 'No']
    for (let i = 0; i < opts.length; i++) {
      if (i >= 2) await d.getByTestId('la-add-option').click()
      await d.getByTestId(`la-option-${i}`).fill(opts[i] ?? '')
    }
    if (o.maxChoices) await d.getByTestId('la-max-choices').selectOption(String(o.maxChoices))
  }
  if (o.kind === 'scale') {
    if (o.range !== undefined) await d.getByTestId('la-scale-range').selectOption(String(o.range))
    if (o.minLabel) await d.getByTestId('la-min-label').fill(o.minLabel)
    if (o.maxLabel) await d.getByTestId('la-max-label').fill(o.maxLabel)
  }
  if (o.kind === 'words' && o.maxWords) await d.getByTestId('la-max-words').selectOption(String(o.maxWords))
  if (o.anonymous === false) await d.getByTestId('la-anonymous').uncheck()
  if (o.resultsLive) await d.getByTestId('la-results-live').check()
  await d.getByTestId('la-setup-submit').click()
  await expect(d).toHaveCount(0)
  await expect(panel(page)).toHaveAttribute('data-status', 'open')
}

// ---- everyone -----------------------------------------------------------------------------------------------------

export const panel = (page: Page) => page.getByTestId('la-panel')

/** Opens the panel: the start notice's "Answer", else the dock tab (on a phone behind the rail's button). */
export async function openActivityPanel(page: Page): Promise<Locator> {
  const p = panel(page)
  if (await p.isVisible()) return p
  const answer = page.getByTestId('la-start-toast-answer')
  if (await answer.isVisible()) await answer.click()
  else {
    const tab = page.getByTestId('dock-tab-live-activity')
    if (!(await tab.isVisible())) await page.getByTestId('dock-rail-toggle').click()
    await tab.click()
  }
  await expect(p).toBeVisible()
  return p
}

/** Picks poll option(s) `choices` (indexes) and sends. */
export async function answerPoll(page: Page, choices: number[]): Promise<void> {
  const p = await openActivityPanel(page)
  for (const c of choices) await p.getByTestId(`la-choice-${c}`).check()
  await p.getByTestId('la-answer-send').click()
  await expect(p.getByTestId('la-answer-status')).toContainText('Your answer is in')
}

/** Types `words` into the word boxes and sends. */
export async function answerWords(page: Page, words: string[]): Promise<void> {
  const p = await openActivityPanel(page)
  for (let i = 0; i < words.length; i++) await p.getByTestId(`la-word-${i}`).fill(words[i] ?? '')
  await p.getByTestId('la-answer-send').click()
  await expect(p.getByTestId('la-answer-status')).toContainText('Your answer is in')
}

/** Waits until the panel says `n` answered (the api's tally window: up to 5 s). */
export async function expectAnswered(page: Page, n: number): Promise<void> {
  await expect(panel(page).getByTestId('la-answered')).toHaveAttribute('data-count', String(n), {
    timeout: 20_000,
  })
}

/** The board's elements of `kind` (customData.lobby.kind) in this page. */
export async function placed(page: Page, kind: string): Promise<CanvasElement[]> {
  return (await items(page)).filter(
    (e) => (e.customData as { lobby?: { kind?: unknown } } | undefined)?.lobby?.kind === kind,
  )
}

/** Every string anywhere in a value (deep): what an element could carry. */
export const stringsIn = (v: unknown): string[] =>
  typeof v === 'string'
    ? [v]
    : Array.isArray(v)
      ? v.flatMap(stringsIn)
      : v && typeof v === 'object'
        ? Object.values(v).flatMap(stringsIn)
        : []

// ---- the keyboard run (v1-scale-keyboard, and the web half against the fake api) ---------------------------------

/**
 * A named 1-5 scale with end labels, set up by `alice` and answered by `bob` with the keyboard only (both pages have
 * the switch on and nothing running); the reveal, the facilitator's named answers (never the participant's), and
 * Results to board.
 */
export async function namedScaleByKeyboard(
  alice: WorkshopCanvasSession,
  bob: WorkshopCanvasSession,
): Promise<void> {
  const a = alice.page

  // the Facilitate menu by keyboard: the button, Enter, arrow down to the entry, Enter
  await a.getByTestId('facilitate-button').focus()
  await a.keyboard.press('Enter')
  await expect(a.getByTestId('facilitate-menu')).toBeVisible()
  for (let i = 0; i < 12; i++) {
    const at = await a.evaluate(() => document.activeElement?.getAttribute('data-testid'))
    if (at === 'facilitate-activities') break
    await a.keyboard.press('ArrowDown')
  }
  await expect(a.getByTestId('facilitate-activities')).toBeFocused()
  await a.keyboard.press('Enter')
  const d = a.getByTestId('la-setup-dialog')
  await expect(d).toBeVisible()
  // the dialog opens on the question; the kind is the radio group before it
  await expect(d.getByTestId('la-prompt-input')).toBeFocused()
  await a.keyboard.type('How confident are you in the plan?')
  await a.keyboard.press('Shift+Tab')
  await a.keyboard.press('ArrowRight')
  await expect(d.getByTestId('la-kind-scale')).toBeChecked()
  await d.getByTestId('la-min-label').focus()
  await a.keyboard.type('Not at all')
  await a.keyboard.press('Tab')
  await a.keyboard.type('Completely')
  // Anonymous off: the dialog says what the facilitator will see
  await d.getByTestId('la-anonymous').focus()
  await a.keyboard.press('Space')
  await expect(d.getByTestId('la-anonymous-hint')).toContainText(
    'Answers show who gave them to you after the reveal',
  )
  await d.getByTestId('la-setup-submit').focus()
  await a.keyboard.press('Enter')
  await expect(d).toHaveCount(0)
  await expect(panel(a)).toHaveAttribute('data-kind', 'scale')

  // the participant: the notice's Answer, then Tab into the numbers and the arrows
  const b = bob.page
  const answer = b.getByTestId('la-start-toast-answer')
  await answer.focus()
  await b.keyboard.press('Enter')
  const sheet = panel(b)
  await expect(sheet.getByTestId('la-anonymity')).toContainText('Named')
  await expect(sheet.getByRole('radio', { name: '5, Completely' })).toBeAttached()
  await expect(sheet.getByRole('radio', { name: '1, Not at all' })).toBeAttached()
  await sheet.getByRole('radio', { name: '1, Not at all' }).focus()
  await b.keyboard.press('ArrowRight')
  await b.keyboard.press('ArrowRight')
  await b.keyboard.press('ArrowRight')
  await expect(sheet.getByTestId('la-scale-4')).toBeChecked()
  await sheet.getByTestId('la-answer-send').focus()
  await b.keyboard.press('Enter')
  await expect(sheet.getByTestId('la-answer-status')).toContainText('Your answer is in')

  await expectAnswered(a, 1)
  await panel(a).getByTestId('la-reveal').click()
  await expect(panel(a).getByTestId('la-scale-summary')).toHaveText('Average 4 · median 4')
  await expect(panel(b).getByTestId('la-scale-summary')).toHaveText('Average 4 · median 4')

  // who answered what: the facilitator, after the reveal; never the participant
  await panel(a).getByTestId('la-named').locator('summary').click()
  await expect(panel(a).getByTestId('la-named-list')).toContainText(`${bob.name}: 4`)
  await expect(panel(b).getByTestId('la-named')).toHaveCount(0)
  await expect(panel(b)).not.toContainText(bob.name)

  await panel(a).getByTestId('la-to-board').click()
  await expectSaved(a)
  const chart = await placed(a, 'poll-chart')
  expect(chart.filter((e) => e.type === 'rectangle')).toHaveLength(1)
  // a named activity's chart still names nobody: it is the aggregate
  const texts = chart.map((e) => (e as unknown as { text?: string }).text ?? '').join('\n')
  expect(texts).not.toContain(bob.name)
  expect(texts).toContain('5 = Completely')
}
