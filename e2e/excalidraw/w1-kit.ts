// OWNER: WS1 (wave W, doc cards). What the w1-* specs and the stale pair share: the doc cards' web switch turned on in
// a page (a dev-auth build reads localStorage FORMATS_FLAG_KEYS.docCards, apps/web/src/features/formats/flags.ts; the
// e2e stack runs the api with DRAFTROOM_DOC_CARDS=on), the palette's insert, the panel and the face by their test ids,
// and a doc card placed through the canvas in one transact (the shape the feature's insert makes).
import type { BrowserContext, Locator, Page } from '@playwright/test'
import {
  type CanvasElement,
  type CanvasSession,
  expect,
  item,
  selection,
  TEXT_EDITOR,
  waitForCanvas,
} from '../tests/support/canvas.ts'
import { API_URL, WEB_URL } from '../tests/support/ports.ts'
import { withCanvas } from './canvas-ux-kit.ts'

/** The doc cards' web switch, as a dev-auth page reads it. */
export const DOC_CARDS_KEY = 'lobby.formatsDocCards'

/** Turns the switch on for every page of `context` (from its next navigation). */
export async function docCardsOn(context: BrowserContext): Promise<void> {
  await context.addInitScript((key: string) => {
    try {
      localStorage.setItem(key, '1')
    } catch {
      // a blocked store: the switch stays off and the spec fails on what it looks for
    }
  }, DOC_CARDS_KEY)
}

/**
 * Turns the switch OFF for every page of `context` (from its next navigation): the shipped switch is on since the
 * wave W integration, so a spec of the switch-off case forces it ('0', the dev-auth override).
 */
export async function docCardsOff(context: BrowserContext): Promise<void> {
  await context.addInitScript((key: string) => {
    try {
      localStorage.setItem(key, '0')
    } catch {
      // a blocked store: the shipped switch (on) stays, and the spec fails on what it looks for
    }
  }, DOC_CARDS_KEY)
}

/** A session with the switch on: the init script, then a reload of its board. */
export async function withDocCards(s: CanvasSession): Promise<CanvasSession> {
  await docCardsOn(s.context)
  await s.page.reload()
  await waitForCanvas(s.page)
  return s
}

/** Every request a page makes that leaves Lobby's own origins (none may: the e2e network assertion). */
export function foreignRequestsOf(page: Page): string[] {
  const own = new Set([new URL(WEB_URL).origin, new URL(API_URL).origin])
  const out: string[] = []
  page.on('request', (r) => {
    const url = new URL(r.url())
    if (url.protocol === 'data:' || url.protocol === 'blob:') return
    if (!own.has(url.origin)) out.push(r.url())
  })
  return out
}

export const panel = (page: Page): Locator => page.getByTestId('doc-editor')
export const panelText = (page: Page): Locator => page.getByTestId('doc-editor-text')
export const panelStatus = (page: Page): Locator => page.getByTestId('doc-editor-status')
export const face = (page: Page, id: string): Locator => page.locator(`[data-lobby-doc-card="${id}"]`)

/** The board's keyboard (the palette and Enter go to the focused canvas). */
export async function focusBoard(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelector<HTMLElement>('.excalidraw')?.focus())
}

/** Ctrl/Cmd+K, `words`, Enter: runs the palette's command `id`. */
export async function runPalette(page: Page, words: string, id: string): Promise<void> {
  await focusBoard(page)
  await page.keyboard.press('ControlOrMeta+k')
  const input = page.getByTestId('command-palette-input')
  await expect(input).toBeFocused()
  await page.keyboard.type(words)
  await expect(page.locator('[data-testid="command-palette-option"][data-active="true"]')).toHaveAttribute(
    'data-entry-id',
    `cmd:${id}`,
  )
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('command-palette')).toHaveCount(0)
}

/** The palette's "Doc card": a new card, selected, its panel open for typing (the lease granted). Returns its id. */
export async function insertFromPalette(page: Page): Promise<string> {
  await runPalette(page, 'Doc card', 'doc-card.insert')
  await expect(panel(page)).toBeVisible()
  await expect(panel(page)).toHaveAttribute('data-writable', 'true')
  const [id] = await selection(page)
  if (!id) throw new Error('the inserted doc card is not selected')
  return id
}

/** The panel is open for typing on `id` (granted, writable, the keyboard in it). */
export async function expectEditing(page: Page): Promise<void> {
  await expect(panel(page)).toHaveAttribute('data-phase', 'open')
  await expect(panel(page)).toHaveAttribute('data-writable', 'true')
  await expect(panelText(page)).toHaveJSProperty('readOnly', false)
}

/** Types into the panel's textarea, after the words it holds (the caret at the end). */
export async function typeInPanel(page: Page, words: string): Promise<void> {
  const ta = panelText(page)
  await ta.focus()
  await ta.press('ControlOrMeta+End')
  await page.keyboard.type(words, { delay: 10 })
}

/** The id of the card's bound label (this tab's scene), or null. */
export async function labelIdOf(page: Page, cardId: string): Promise<string | null> {
  const card = await item(page, cardId)
  const refs = (card?.boundElements ?? []) as readonly { id: string; type: string }[]
  return refs.find((b) => b.type === 'text')?.id ?? null
}

/** The card's words as this tab's scene holds them (its bound label's originalText). */
export async function wordsOf(page: Page, cardId: string): Promise<string | null> {
  const ref = await labelIdOf(page, cardId)
  if (!ref) return null
  const label = await item(page, ref)
  return label && !label.isDeleted ? String(label.originalText ?? '') : null
}

/** No Excalidraw text editor is open in the page (the in-place editor never opens on a doc card from the panel). */
export async function expectNoInPlaceEditor(page: Page): Promise<void> {
  await expect(page.locator(TEXT_EDITOR)).toHaveCount(0)
}

/**
 * A doc card with `words` placed through the canvas in one transact (what the feature's insert writes: a rectangle of
 * kind 'doc-card' and its bound, top-left label), for a tab whose switch is off or a build without the feature.
 */
export async function placeDocCard(page: Page, words: string, at = { x: 0, y: 0 }): Promise<string> {
  return withCanvas(
    page,
    (c, a) => {
      const bytes = new Uint8Array(12)
      crypto.getRandomValues(bytes)
      const id = `dc${Array.from(bytes, (x) => (x % 36).toString(36)).join('')}`
      c.transact('e2e: a doc card', (tx) => {
        tx.create('rectangle', {
          id,
          x: a.at.x,
          y: a.at.y,
          width: 640,
          height: 400,
          strokeColor: '#c4bfb0',
          backgroundColor: '#ffffff',
          fillStyle: 'solid',
          strokeWidth: 1,
          roughness: 0,
          roundness: { type: 3, value: 8 },
          boundElements: [{ id: `${id}.t`, type: 'text' }],
          customData: { lobby: { kind: 'doc-card' } },
        })
        tx.create('text', {
          id: `${id}.t`,
          x: a.at.x + 5,
          y: a.at.y + 5,
          text: a.words,
          originalText: a.words,
          fontFamily: 6,
          fontSize: 16,
          textAlign: 'left',
          verticalAlign: 'top',
          strokeColor: '#1b2330',
          containerId: id,
          autoResize: true,
        })
      })
      return id
    },
    { words, at },
  )
}

export const kindOf = (el: CanvasElement | null | undefined) =>
  ((el?.customData?.lobby ?? {}) as { kind?: unknown }).kind ?? null
