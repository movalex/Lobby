// Helpers for canvas-ux's ported specs (canvas-ux-*.spec.ts, owner 3a): reads through the board page's
// debug handle (`window.__lobbyBoard.canvas`, dev-auth builds) for what the facade verbs do not cover yet,
// and the canvas-ux chrome by its test ids. Writes still go through the facade (tests/support/canvas.ts)
// or the real UI.
import type { Page } from '@playwright/test'
import type { LobbyCanvas } from '../../apps/web/src/canvas/api/lobby-canvas.ts'
import { expect, item, items, sceneToScreen, waitForCanvas } from '../tests/support/canvas.ts'

/** Runs `fn(canvas, arg)` in the page against the board page's LobbyCanvas (serialized into the page). */
export async function withCanvas<T, A>(
  page: Page,
  fn: (canvas: LobbyCanvas, arg: A) => T | Promise<T>,
  arg: A,
): Promise<T> {
  return (await page.evaluate(
    async ({ src, arg }) => {
      const b = (window as unknown as { __lobbyBoard?: { canvas: unknown } }).__lobbyBoard
      if (!b) throw new Error('no window.__lobbyBoard')
      const f = new Function(`return (${src})`)() as (c: unknown, a: unknown) => unknown
      return await f(b.canvas, arg)
    },
    { src: fn.toString(), arg },
  )) as T
}

/** canvas-ux is installed: its toolbar is in the toolbar host slot. */
export async function waitForCanvasUx(page: Page): Promise<void> {
  await expect(page.locator('[data-lobby-slot="toolbar"][data-feature="canvas-ux"]')).toBeVisible()
}

/** The main toolbar's buttons, by test id, in order. */
export const toolbarIds = (page: Page) =>
  page
    .getByTestId('main-toolbar')
    .locator(':scope > button')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? ''))

/** A note's label text (the bound text's words), or null. */
export async function labelText(page: Page, id: string): Promise<string | null> {
  const note = await item(page, id)
  const labelId = (
    (note as { boundElements?: { id: string; type: string }[] } | null)?.boundElements ?? []
  ).find((e) => e.type === 'text')?.id
  const label = (await items(page)).find((e) => e.id === labelId) as { originalText?: string } | undefined
  return label?.originalText ?? null
}

/** The notes on the board with their words, sorted by their words. */
export async function notes(page: Page) {
  const all = await items(page)
  const out: { id: string; text: string; x: number; y: number; frameId: string | null; color: string }[] = []
  for (const e of all) {
    if (e.type !== 'stickynote' || (e as { isDeleted?: boolean }).isDeleted) continue
    out.push({
      id: e.id,
      text: (await labelText(page, e.id)) ?? '',
      x: e.x,
      y: e.y,
      frameId: e.frameId ?? null,
      color: String((e as { backgroundColor?: string }).backgroundColor),
    })
  }
  return out.sort((a, b) => a.text.localeCompare(b.text))
}

/** A click on the canvas at a scene point (the real pointer). */
export async function clickScene(
  page: Page,
  p: { x: number; y: number },
  opts: { button?: 'left' | 'right' } = {},
) {
  const s = await sceneToScreen(page, p)
  await page.mouse.click(s.x, s.y, { button: opts.button ?? 'left' })
}

export async function dblclickScene(page: Page, p: { x: number; y: number }) {
  const s = await sceneToScreen(page, p)
  await page.mouse.dblclick(s.x, s.y)
}

/** Whether the board's canvas (Excalidraw's container) has the keyboard. */
export const boardHasFocus = (page: Page) =>
  page.evaluate(() => !!document.activeElement?.closest('.excalidraw'))

/** The notice region's texts (the board page's NoticeRegion). */
export const noticeTexts = (page: Page) =>
  page.locator('.dr-notice').evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()))

/** The board's own undo key (Lobby's Ctrl/Cmd+Z), with the keyboard on the canvas (no click: the selection stays). */
export async function undoKey(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelector<HTMLElement>('.excalidraw')?.focus())
  await page.keyboard.press('ControlOrMeta+z')
}
export async function redoKey(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelector<HTMLElement>('.excalidraw')?.focus())
  await page.keyboard.press('ControlOrMeta+Shift+z')
}

/**
 * P-021 (wave P): the style panel opens only on request (the selection bar's Styles button), a choice this browser
 * keeps. Specs that work in the panel open it the way a returning person has it: the choice stored, the board
 * opened again.
 */
export async function showStylePanel(page: Page): Promise<void> {
  await page.evaluate(() => localStorage.setItem('lobby:style-panel-open', 'true'))
  await page.reload()
  await waitForCanvas(page)
  await waitForCanvasUx(page)
}
