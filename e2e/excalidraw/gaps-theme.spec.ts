// GAP PASS (browser-test gaps on the Excalidraw canvas): the theme CHOICE on the new canvas.
//
// PROGRESS.md (wave 2): "dark mode (System / Light / Dark, app and canvas)". On the Excalidraw page the
// ported specs set the OS scheme with emulateMedia (a11y-contrast) or check Preferences ▸ Theme flips it once
// (canvas-ux-review W5-33); the tldraw suite's theme.spec ("a dark choice persists, paints before the app
// loads, and reaches the board canvas"; "System follows the OS live") was never ported. Here: the account
// menu's picker on the board page, the stored choice, the canvas (LobbyCanvas.theme() and Excalidraw's
// `theme--dark` container class), a reload that paints dark from its first frame, and System following the
// OS live.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw gaps-theme
import type { Page } from '@playwright/test'
import { signInContext } from '../tests/support/api.ts'
import { expect, test, waitForCanvas } from '../tests/support/canvas.ts'
import { expectChrome, pickTheme, storedChoice, themedContext } from '../tests/support/theme.ts'
import { withCanvas } from './canvas-ux-kit.ts'

type Mode = 'light' | 'dark'

/** The canvas's colour mode: what LobbyCanvas reports AND what Excalidraw's container class shows. */
async function canvasMode(page: Page): Promise<Mode | 'mixed' | 'none'> {
  const t = await withCanvas(page, (c) => c.theme(), null)
  const cls = await page.evaluate(() => {
    const el = document.querySelector('.excalidraw')
    return el ? el.classList.contains('theme--dark') : null
  })
  if (cls === null) return 'none'
  return (cls ? 'dark' : 'light') === t ? t : 'mixed'
}
const expectCanvas = (page: Page, mode: Mode) => expect.poll(() => canvasMode(page)).toBe(mode)

/**
 * Page function (context.addInitScript): records the theme Excalidraw's container shows at each animation
 * frame, as a list of distinct runs. A canvas that opened light and then turned dark reads ['light', 'dark'].
 */
function recordCanvasFrames() {
  const w = window as unknown as { __exFrames?: string[] }
  if (w.__exFrames) return
  const frames: string[] = []
  w.__exFrames = frames
  const tick = () => {
    const el = document.querySelector('.excalidraw')
    if (el) {
      const mode = el.classList.contains('theme--dark') ? 'dark' : 'light'
      if (frames[frames.length - 1] !== mode) frames.push(mode)
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}
const canvasFrames = (page: Page) =>
  page.evaluate(() => (window as unknown as { __exFrames?: string[] }).__exFrames ?? null)

test('Dark picked in the account menu darkens the chrome and the Excalidraw canvas, is stored, and a reload paints the canvas dark from its first frame; Light turns both back', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await expectChrome(a.page, 'light')
  await expectCanvas(a.page, 'light')

  await test.step('Dark: chrome, canvas and the stored choice', async () => {
    await pickTheme(a.page, 'dark')
    await expectChrome(a.page, 'dark', 'dark')
    await expectCanvas(a.page, 'dark')
    expect(await storedChoice(a.page)).toBe('dark')
    await a.page.keyboard.press('Escape')
  })

  await test.step('a reload paints the canvas dark from the first frame it shows (no light flash)', async () => {
    await a.context.addInitScript(recordCanvasFrames)
    await a.page.reload()
    await waitForCanvas(a.page)
    await expectChrome(a.page, 'dark', 'dark')
    await expectCanvas(a.page, 'dark')
    await expect.poll(() => canvasFrames(a.page)).toEqual(['dark'])
  })

  await test.step('Light: chrome and canvas follow, the choice is stored', async () => {
    await pickTheme(a.page, 'light')
    await expectChrome(a.page, 'light', 'light')
    await expectCanvas(a.page, 'light')
    expect(await storedChoice(a.page)).toBe('light')
  })
})

test('System follows the OS live on the board: a dark OS opens a dark canvas; the OS turning light turns the chrome and the canvas light with no reload, and back', async ({
  browser,
  users,
  board,
}) => {
  const alice = await users.get('alice')
  const context = await themedContext(browser, 'dark')
  try {
    await signInContext(context, alice.handle, alice.name)
    const page = await context.newPage()
    await page.goto(`/b/${board}`)
    await waitForCanvas(page)

    await pickTheme(page, 'system')
    await expectChrome(page, 'dark', 'system')
    await expectCanvas(page, 'dark')
    // System is the default: it is stored as nothing (as the tldraw suite's theme spec pins)
    expect(await storedChoice(page)).toBeNull()
    await page.keyboard.press('Escape')

    await page.emulateMedia({ colorScheme: 'light' })
    await expectChrome(page, 'light', 'system')
    await expectCanvas(page, 'light')

    await page.emulateMedia({ colorScheme: 'dark' })
    await expectChrome(page, 'dark', 'system')
    await expectCanvas(page, 'dark')
  } finally {
    await context.close()
  }
})
