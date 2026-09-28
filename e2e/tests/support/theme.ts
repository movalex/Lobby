// Theme (dark mode) helpers: what the app chrome and the tldraw canvas actually render.
import { type BrowserContext, expect, type Page } from '@playwright/test'

export type ThemeChoice = 'system' | 'light' | 'dark'
export type Mode = 'light' | 'dark'

export const THEME_KEY = 'draftroom:theme'

/** --dr-paper / --dr-surface of each theme (apps/web/src/styles.css), as computed styles report them. */
export const PAPER: Record<Mode, string> = { light: 'rgb(246, 244, 238)', dark: 'rgb(20, 22, 27)' }
export const SURFACE: Record<Mode, string> = { light: 'rgb(255, 255, 255)', dark: 'rgb(29, 32, 39)' }

const html = (page: Page) => page.locator('html')

/** html[data-theme] (what styles.css switches on) and its stored source. */
export async function expectChrome(page: Page, mode: Mode, choice?: ThemeChoice) {
  await expect(html(page)).toHaveAttribute('data-theme', mode)
  if (choice) await expect(html(page)).toHaveAttribute('data-theme-pref', choice)
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .toBe(PAPER[mode])
}

/** The background actually painted by an element (e.g. the board top bar). */
export const backgroundOf = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundColor)

/** tldraw's own view of the theme: the editor's dark-mode flag and the container class. */
export async function canvasMode(page: Page): Promise<Mode | 'mixed'> {
  return page.evaluate(() => {
    const ed = window.editor as unknown as { user: { getIsDarkMode(): boolean } } | undefined
    const container = document.querySelector('.tl-container')
    if (!ed || !container) throw new Error('no mounted editor')
    const flag = ed.user.getIsDarkMode()
    const cls = container.classList.contains('tl-theme__dark')
    return flag === cls ? (flag ? 'dark' : 'light') : 'mixed'
  })
}

export async function expectCanvas(page: Page, mode: Mode) {
  await expect.poll(() => canvasMode(page)).toBe(mode)
}

/**
 * Page function (pass to page.evaluate or context.addInitScript): records the theme the tldraw
 * container shows at each animation frame, i.e. before each paint, as a list of distinct runs; frames
 * where it is invisible paint nothing and are skipped. A canvas that opened light and then turned dark
 * reads ['light', 'dark'].
 */
export function recordCanvasFrames() {
  const w = window as unknown as { __tlFrames?: string[] }
  if (w.__tlFrames) return
  const frames: string[] = []
  w.__tlFrames = frames
  const tick = () => {
    const container = document.querySelector('.tl-container')
    if (container && getComputedStyle(container).visibility !== 'hidden') {
      const mode = container.classList.contains('tl-theme__dark') ? 'dark' : 'light'
      if (frames[frames.length - 1] !== mode) frames.push(mode)
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

export const canvasFrames = (page: Page) =>
  page.evaluate(() => (window as unknown as { __tlFrames?: string[] }).__tlFrames ?? null)

/** tldraw's stored user preference (localStorage TLDRAW_USER_DATA_v3 user.colorScheme). */
export const tldrawStoredScheme = (page: Page) =>
  page.evaluate(() => {
    try {
      return (JSON.parse(localStorage.getItem('TLDRAW_USER_DATA_v3') ?? 'null')?.user?.colorScheme ?? null) as
        | string
        | null
    } catch {
      return null
    }
  })

export const storedChoice = (page: Page) => page.evaluate((k) => localStorage.getItem(k), THEME_KEY)

/** Opens the account menu (the dev identity badge in the e2e build) and picks a theme. */
export async function pickTheme(page: Page, choice: ThemeChoice) {
  const picker = page.getByTestId('theme-picker')
  if (!(await picker.isVisible())) await page.getByTestId('dev-identity-badge').click()
  await expect(picker).toBeVisible()
  await picker.locator(`[data-testid="theme-option"][data-value="${choice}"]`).click()
  await expect(picker).toHaveAttribute('data-preference', choice)
  await expect(picker.locator(`input[value="${choice}"]`)).toBeChecked()
}

export async function closeAccountMenu(page: Page) {
  if (await page.getByTestId('theme-picker').isVisible()) await page.keyboard.press('Escape')
  await expect(page.getByTestId('theme-picker')).toHaveCount(0)
}

/** A new context whose OS-level setting (prefers-color-scheme) is `os`. */
export const themedContext = (
  browser: { newContext(o: object): Promise<BrowserContext> },
  os: Mode,
  viewport = { width: 1280, height: 800 },
) => browser.newContext({ colorScheme: os, viewport })
