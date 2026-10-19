// XBROWSER (wave C4): a short smoke that runs on WebKit (Safari's engine: Macs, iPads, iPhones) and Firefox as
// well as chromium, so a break that only another browser shows is seen by a run, not by a reviewer on a Mac.
// Until now only chromium ran at all (docs/PROGRESS.md: "Unmeasured: ... iPad/Safari, Firefox"). What it covers
// is what depends on browser details: the dev sign-in form, the dashboard, a new board opening through the
// real socket, the keys the board lets through (N for the note tool, a printable key on a selected note), the
// text-lease handshake (the click is held until the lease is granted, then Excalidraw's textarea has the
// keyboard and the buffered keys replay), "Saved", and a reload that brings the same words back, then a phone
// viewport with touch. Every test also fails on an uncaught page error: a missing browser API throws one.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e xbrowser         (webkit and firefox)
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/xbrowser-smoke.spec.ts --project=chromium  (control)
//
// The webkit and firefox projects (playwright.config.ts) run only this file; chromium runs it with the rest.
// A failure here that chromium does not show is a real cross-browser finding: record it, do not skip it.
//
// Where it can run: Linux (CI's `xbrowser` job: `playwright install --with-deps webkit firefox`) and a Mac. On the
// Windows development PC (Smart App Control on) WebKit starts since wave V, but Firefox does not: `spawn UNKNOWN`,
// because Windows cannot build firefox.exe's activation context (Application log, SideBySide event 33: "Dependent
// Assembly mozglue ... could not be found", although the unsigned mozglue.dll and its manifest are there). Wave C4
// saw Smart App Control block Firefox's softokn3.dll; turning it off is a system-wide change, so it stays on.
import { signInContext } from '../tests/support/api.ts'
import { signInThroughUi } from '../tests/support/board.ts'
import {
  clickItem,
  createNote,
  editingId,
  expect,
  expectSaved,
  select,
  test,
  tool,
  waitForTextEditor,
} from '../tests/support/canvas.ts'
import { PHONE } from './a11y-kit.ts'
import { focusBoard, settled } from './board-kit.ts'
import { clickScene, labelText, notes, waitForCanvasUx } from './canvas-ux-kit.ts'
import { noHorizontalScroll, waitForLobbyBoard } from './guests-kit.ts'
// Uncaught exceptions in the page, collected from the call on. WebKit's ResizeObserver loop notice, matched exactly,
// is not one (a browser notice, not a throw; see BENIGN_PAGE_ERRORS); every other page error fails the test.
import { pageErrors } from './support/page-errors.ts'

test('sign in, the dashboard, a new board, a note typed through the lease, and a reload that keeps it', async ({
  browser,
  stackReady: _,
}, testInfo) => {
  const user = {
    handle: `xb-${testInfo.project.name}-${Date.now().toString(36).slice(-5)}`,
    name: 'Xena Brown',
  }
  const context = await browser.newContext({ viewport: { width: 1360, height: 860 } })
  try {
    const page = await context.newPage()
    const errors = pageErrors(page)

    await test.step('signed out, the app sends you to the dev sign-in form, and signing in lands on the dashboard', async () => {
      await page.goto('/')
      await expect(page).toHaveURL(/\/signin$/)
      await signInThroughUi(page, user)
      await expect(page.getByTestId('dashboard')).toBeVisible()
      await expect(page.getByTestId('dev-identity-badge')).toHaveAttribute('title', /Xena Brown/)
    })

    await test.step('a board is created from the dashboard and opens live', async () => {
      await page.getByTestId('create-board').click()
      await expect(page.getByTestId('create-board-dialog')).toBeVisible()
      await page.getByTestId('create-board-title').fill('Cross-browser smoke')
      await page.getByTestId('create-board-submit').click()
      await expect(page).toHaveURL(/\/b\/b-[0-9a-z]{10}$/)
      await waitForLobbyBoard(page)
      await expect(page.getByTestId('board-title')).toHaveText('Cross-browser smoke')
      await waitForCanvasUx(page)
    })

    await test.step('N, a click and typing make a note: the lease is granted before the keys land', async () => {
      await focusBoard(page)
      await page.keyboard.press('n')
      await expect.poll(() => tool(page)).toBe('note')
      await clickScene(page, { x: 300, y: 300 })
      const id = await waitForTextEditor(page)
      // spike B's open O2 race: the new note's own ack can overtake the first keys (board-kit `settled`)
      await expectSaved(page)
      await page.keyboard.type('Hello from the smoke', { delay: 15 })
      await expect.poll(() => labelText(page, id)).toBe('Hello from the smoke')
      await page.keyboard.press('Escape')
      await expect.poll(() => editingId(page)).toBeNull()
      await expectSaved(page)
    })

    await test.step('after a reload the board has the note, with its words', async () => {
      await page.reload()
      await waitForLobbyBoard(page)
      await waitForCanvasUx(page)
      await expect.poll(async () => (await notes(page)).map((n) => n.text)).toEqual(['Hello from the smoke'])
      await expect(page.getByTestId('board-title')).toHaveText('Cross-browser smoke')
      await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved')
    })

    expect(errors, 'uncaught page errors').toEqual([])
  } finally {
    await context.close()
  }
})

test('a printable key on a selected note opens the editor and the buffered key lands (type to edit)', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const errors = pageErrors(a.page)
  await waitForCanvasUx(a.page)
  const id = await settled(a.page, createNote(a.page, { x: 300, y: 220, text: 'A' }))
  await clickItem(a.page, id)
  await expect.poll(() => a.page.evaluate(() => !!document.activeElement?.closest('.excalidraw'))).toBe(true)
  await select(a.page, [id])
  // not the note tool's own key and not a shortcut: it must reach the note, once the lease is granted
  await a.page.keyboard.type('x', { delay: 15 })
  await expect.poll(() => labelText(a.page, id)).toBe('Ax')
  await a.page.keyboard.press('Escape')
  await expect.poll(() => editingId(a.page)).toBeNull()
  await expectSaved(a.page)
  expect(errors, 'uncaught page errors').toEqual([])
})

test('a phone-sized viewport with touch: the board opens, nothing scrolls sideways and the Board actions sheet opens', async ({
  browser,
  board,
}) => {
  const context = await browser.newContext({ viewport: PHONE, hasTouch: true })
  try {
    const page = await context.newPage()
    const errors = pageErrors(page)
    await signInContext(context, 'alice', 'Alice Park')
    await page.goto(`/b/${board}`)
    await waitForLobbyBoard(page)
    expect(await noHorizontalScroll(page)).toBe(true)
    await page.getByTestId('phone-sheet-open').tap()
    await expect(page.getByTestId('phone-sheet')).toBeVisible()
    await page.getByTestId('phone-sheet-close').tap()
    await expect(page.getByTestId('phone-sheet')).toHaveCount(0)
    expect(errors, 'uncaught page errors').toEqual([])
  } finally {
    await context.close()
  }
})
