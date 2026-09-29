// Small helpers for the board page's own ported specs (board-*.spec.ts): reads through the page's debug
// handle (`window.__lobbyBoard`, dev-auth builds only) for what the wave-1 facade verbs will cover once
// 2E lands them, and real-pointer helpers over empty canvas.
import { expect, type Page } from '@playwright/test'
import { expectSaved, pushedOps } from '../tests/support/canvas.ts'

/** The page's debug handle, typed on what these specs read. */
export interface BoardHandleView {
  canvas: {
    readOnly(): boolean
    editingId(): string | null
    settings: { get(): { focusMode: boolean }; set(p: { focusMode?: boolean }): void }
  }
  installProbe?(): void
  uninstallProbe?(): void
}

declare global {
  interface Window {
    __lobbyBoard?: BoardHandleView
  }
}

/** The canvas's read-only mode (LobbyCanvas.readOnly; the facade verb is 2E's). */
export const canvasReadOnly = (page: Page) =>
  page.evaluate(() => {
    const b = window.__lobbyBoard
    if (!b) throw new Error('no window.__lobbyBoard (not the Excalidraw board page?)')
    return b.canvas.readOnly()
  })

/** Pushes this tab has sent so far (document writes; presence is not a push). */
export const pushCount = async (page: Page) => (await pushedOps(page)).length

/** A point on the canvas away from the content the specs create (right half, lower third). */
export async function emptyCanvasPoint(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.locator('[data-lobby-board-canvas]').boundingBox()
  if (!box) throw new Error('no board canvas')
  return { x: box.x + box.width * 0.8, y: box.y + box.height * 0.75 }
}

/** A real click on empty canvas: the board takes the keyboard (and a user gesture is on record). */
export async function focusBoard(page: Page): Promise<void> {
  const p = await emptyCanvasPoint(page)
  await page.mouse.click(p.x, p.y)
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('.excalidraw'))).toBe(true)
}

/** The connection pill (`data-state`: connecting, online, offline, error). */
export const connPill = (page: Page) => page.getByTestId('conn-status')

/**
 * A facade write, then "Saved" before the next one. Spike B's open O2 defect (docs/research/excalidraw/
 * spike-b/M3.md "Open problems"): a local write that a server frame (the previous write's ack) overtakes
 * before Excalidraw reports it is lost. Specs that seed several elements in a row wait for Saved between
 * writes so they test the board page, not that race; remove once O2's fix is merged.
 */
export async function settled<T>(page: Page, write: Promise<T>): Promise<T> {
  const out = await write
  await expectSaved(page)
  return out
}
