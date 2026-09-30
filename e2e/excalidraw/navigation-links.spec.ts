// 3b navigation on the Excalidraw board page: copy link and deep links (docs/EXCALIDRAW-MIGRATION.md §3.6:
// `?el=<id>,<id>`, `?view=<x>,<y>,<w>,<h>`, and the legacy tldraw `?d=` still opens), and the dashboard's
// "Inside boards" results that land on an object (ported from canvas-ux.spec.ts "copy link" and
// search.spec.ts's first test, its landing steps). The selection bar's Copy link button is 3a's shell:
// the same command runs here through the page's registry (window.__lobbyNavigation).
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw -- navigation-links
import { randomBytes } from 'node:crypto'
import type { Page } from '@playwright/test'
import { createItem, createNote, expect, expectSaved, select, test } from '../tests/support/canvas.ts'
import { WEB_URL } from '../tests/support/ports.ts'
import {
  grantClipboard,
  inView,
  navRun,
  openPath,
  readClipboardText,
  seed,
  sortedSelection,
  startView,
  viewport,
  waitForNavigation,
} from './navigation-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

const frameRow = (page: Page, id: string) => page.locator(`[data-testid="frame-row"][data-frame-id="${id}"]`)

test('copy link: the selection’s link and a frame row’s copy /b/<id>?el=…; bob opens them zoomed to that element with the parameter removed; a legacy ?d= link and a ?view= link open too; a user without access gets no-access', async ({
  canvasSession,
  browser,
  board,
  users,
}) => {
  const a = await canvasSession('alice')
  await grantClipboard(a.context)
  await waitForNavigation(a.page)
  const [ORIGIN, N, F] = (await seed(a.page, [
    () => createNote(a.page, { x: 0, y: 0, text: 'Start here' }),
    () => createNote(a.page, { x: 5200, y: 3400, text: 'Deep in the board' }),
    () => createItem(a.page, 'frame', { x: -4200, y: 2600, width: 640, height: 420, name: 'Act two' }),
  ])) as [string, string, string]
  await users.grant(board, 'bob', 'editor')
  const bob = await users.get('bob')
  const opened: { close(): Promise<void> }[] = []
  try {
    let link = ''
    await test.step('Copy link to selection', async () => {
      await select(a.page, [N])
      expect(await navRun(a.page, 'navigation.copy-link')).toBe(true)
      await expect(a.page.getByTestId('copy-link-notice')).toHaveText('Link to this object copied.')
      link = await readClipboardText(a.page)
      const url = new URL(link)
      expect(url.origin + url.pathname).toBe(`${WEB_URL}/b/${board}`)
      expect(url.searchParams.get('el')).toBe(N)
      expect(url.searchParams.has('d')).toBe(false)
    })

    await test.step('bob opens it: the note is selected and in view, and the address bar lost ?el', async () => {
      const b = await openPath(browser, bob, link)
      opened.push(b.context)
      expect(await startView(b.page)).toBe('deep-link')
      expect(await sortedSelection(b.page)).toEqual([N])
      expect(await inView(b.page, [N])).toBe(true)
      expect(await inView(b.page, [ORIGIN])).toBe(false)
      expect(await b.page.evaluate(() => location.search)).toBe('')

      await test.step('frame-copy-link in the outline does the same for a frame', async () => {
        await a.page.getByTestId('dock-tab-frames').click()
        await frameRow(a.page, F).getByTestId('frame-copy-link').click()
        await expect(a.page.getByTestId('copy-link-notice')).toHaveText('Link to this frame copied.')
        const frameLink = await readClipboardText(a.page)
        expect(new URL(frameLink).searchParams.get('el')).toBe(F)
        await b.page.goto(frameLink)
        await waitForNavigation(b.page)
        expect(await startView(b.page)).toBe('deep-link')
        await expect.poll(() => sortedSelection(b.page)).toEqual([F])
        expect(await inView(b.page, [F])).toBe(true)
        expect(await b.page.evaluate(() => location.search)).toBe('')
      })

      await test.step('a legacy tldraw link (?d=s<id>, dots encoded) opens on the element too', async () => {
        const legacy = new URL(`${WEB_URL}/b/${board}`)
        legacy.searchParams.set('d', `s${encodeURIComponent(N).replace(/\./g, '%2E')}`)
        await b.page.goto(legacy.toString())
        await waitForNavigation(b.page)
        expect(await startView(b.page)).toBe('deep-link')
        await expect.poll(() => sortedSelection(b.page)).toEqual([N])
        expect(await inView(b.page, [N])).toBe(true)
        expect(await b.page.evaluate(() => location.search)).toBe('')
      })

      await test.step('a ?view= link shows exactly that rectangle (letterboxed)', async () => {
        await b.page.goto(`/b/${board}?view=-4300,2500,840,620`)
        await waitForNavigation(b.page)
        expect(await startView(b.page)).toBe('deep-link')
        expect(await inView(b.page, [F])).toBe(true)
        const v = await viewport(b.page)
        // the rectangle fills the view along one side (inset 0)
        const fill = Math.max(840 / v.width, 620 / v.height)
        expect(fill).toBeGreaterThan(0.98)
        expect(fill).toBeLessThanOrEqual(1.001)
      })
    })

    await test.step('dave (signed in, no access) opening the link gets no-access', async () => {
      const d = await openPath(browser, await users.get('dave'), link, { board: false })
      opened.push(d.context)
      await expect(d.page.getByTestId('no-access')).toBeVisible()
    })
  } finally {
    await Promise.all(opened.map((c) => c.close()))
  }
})

/** A word nobody else's board contains (letters only). */
const word = (prefix: string) =>
  `${prefix}${[...randomBytes(6)].map((b) => String.fromCharCode(97 + (b % 26))).join('')}`

async function searchFor(page: Page, q: string) {
  await page.getByTestId('dashboard-search').fill(q)
  const section = page.getByTestId('content-search')
  await expect(section).toHaveAttribute('data-query', q)
  await expect(section).toHaveAttribute('data-state', /^(ready|error)$/, { timeout: 20_000 })
  await expect(section).toHaveAttribute('data-state', 'ready')
}

test('content search: a dashboard hit opens the new board page on the object (?el=), selected and in view; the keyboard path lands on a far frame', async ({
  canvasSession,
  board,
}) => {
  const a = await canvasSession('alice')
  await waitForNavigation(a.page)
  const [noteWord, frameWord] = [word('quokka'), word('pangolin')]
  const [NOTE] = await seed(a.page, [
    () => createNote(a.page, { x: 0, y: 0, text: `Launch plan: book the ${noteWord} venue before Friday` }),
  ])
  const FRAME = await createItem(a.page, 'frame', {
    x: 5200,
    y: 3600,
    width: 640,
    height: 420,
    name: `Research ${frameWord}`,
  })
  await expectSaved(a.page)
  const hit = (id: string) =>
    a.page.locator(`[data-testid="content-search-hit"][data-object-id="shape:${id}"]`)

  await test.step('the dashboard finds the note; its link is ?el=<element id>', async () => {
    await a.page.getByRole('link', { name: 'Back to Dev Studio' }).click()
    await expect(a.page.getByTestId('dashboard')).toBeVisible()
    await searchFor(a.page, noteWord)
    await expect(hit(NOTE as string)).toHaveAttribute('data-kind', 'note')
    const href = await hit(NOTE as string).getAttribute('href')
    expect(href).toBe(`/b/${board}?el=${NOTE}`)
  })

  await test.step('a click opens the board zoomed to the note, with it selected', async () => {
    await hit(NOTE as string).click()
    await expect(a.page).toHaveURL(new RegExp(`/b/${board}`))
    await waitForNavigation(a.page)
    expect(await startView(a.page)).toBe('deep-link')
    await expect.poll(() => sortedSelection(a.page)).toEqual([NOTE])
    await expect.poll(() => inView(a.page, [NOTE as string])).toBe(true)
  })

  await test.step('by keyboard: ArrowDown, ArrowDown, Enter lands on the far-away frame', async () => {
    await a.page.getByRole('link', { name: 'Back to Dev Studio' }).click()
    await expect(a.page.getByTestId('dashboard')).toBeVisible()
    await searchFor(a.page, frameWord)
    await expect(hit(FRAME)).toHaveAttribute('data-kind', 'frame')
    await a.page.getByTestId('dashboard-search').press('ArrowDown')
    await a.page.keyboard.press('ArrowDown')
    await expect(hit(FRAME)).toBeFocused()
    await a.page.keyboard.press('Enter')
    await waitForNavigation(a.page)
    await expect.poll(() => sortedSelection(a.page)).toEqual([FRAME])
    await expect.poll(() => inView(a.page, [FRAME])).toBe(true)
    expect(await inView(a.page, [NOTE as string])).toBe(false)
  })
})
