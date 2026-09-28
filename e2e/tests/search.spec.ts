// Wave 4 "search" (docs/WAVE4-CONTRACTS.md; checklist DSH-08): search across boards from the dashboard,
// content included. Real api + sync + web: text written on a board is found from the dashboard, a
// result opens the board zoomed to the object (selected) or with the comment thread open, edits show
// up right away, deleted objects and trashed boards leave the results, and people find only the boards
// they can open (a member without access, a viewer, a name-only guest), and the keyboard keeps its place
// after "Show more boards" and "Try again". Screenshots: light, dark, 390 px.
import { randomBytes } from 'node:crypto'
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test'
import { edit, read, waitForBoard } from './support/board.ts'
import { waitForSaved } from './support/canvas-ux.ts'
import { threadPopover } from './support/comments.ts'
import { openDashboard, signedInContext } from './support/dashboard-share.ts'
import { richText } from './support/editor.ts'
import { expect, test } from './support/fixtures.ts'
import { WEB_URL } from './support/ports.ts'
import { capture } from './support/screenshots.ts'
import { THEME_KEY } from './support/theme.ts'

const ORIGIN = { origin: WEB_URL }

/** A word nobody else's board contains (letters only: a search word is letters and digits). */
const word = (prefix: string) =>
  `${prefix}${[...randomBytes(6)].map((b) => String.fromCharCode(97 + (b % 26))).join('')}`

const searchBox = (page: Page) => page.getByTestId('dashboard-search')
const section = (page: Page) => page.getByTestId('content-search')
const status = (page: Page) => page.getByTestId('content-search-status')
const hits = (page: Page) => page.getByTestId('content-search-hit')
const hit = (page: Page, objectId: string) =>
  page.locator(`[data-testid="content-search-hit"][data-object-id="${objectId}"]`)
const group = (page: Page, boardId: string) =>
  page.locator(`[data-testid="content-search-board"][data-board-id="${boardId}"]`)

/** Types `q` into the dashboard search box and waits for the "Inside boards" answer to it. */
async function searchFor(page: Page, q: string) {
  await searchBox(page).fill(q)
  await expect(section(page)).toHaveAttribute('data-query', q)
  await expect(section(page)).toHaveAttribute('data-state', /^(ready|error)$/, { timeout: 20_000 })
  await expect(section(page)).toHaveAttribute('data-state', 'ready')
}

/** From a board: once its changes are saved (the sync server has them), back to the dashboard. */
async function backToDashboard(page: Page) {
  await waitForSaved(page)
  await page.getByRole('link', { name: 'Back to Dev Studio' }).click()
  await expect(page.getByTestId('dashboard')).toBeVisible()
}

const selectedIds = (page: Page) => read(page, (ed) => ed.getSelectedShapeIds())

/** The shape's page bounds lie inside the viewport (the camera went to it). */
const inViewport = (page: Page, id: string) =>
  page.evaluate((shapeId) => {
    type Box = { x: number; y: number; w: number; h: number }
    const ed = window.editor as
      | { getShapePageBounds(id: string): Box | undefined; getViewportPageBounds(): Box }
      | undefined
    const b = ed?.getShapePageBounds(shapeId)
    const v = ed?.getViewportPageBounds()
    if (!b || !v) return false
    return b.x >= v.x - 1 && b.y >= v.y - 1 && b.x + b.w <= v.x + v.w + 1 && b.y + b.h <= v.y + v.h + 1
  }, id)

async function apiSearch(context: BrowserContext, workspaceId: string, q: string) {
  const res = await context.request.get(`/api/workspaces/${workspaceId}/search?${new URLSearchParams({ q })}`)
  return { status: res.status(), body: await res.text() }
}

test('search: find text inside a board from the dashboard and land on it; edits show up, deleted objects and trashed boards leave', async ({
  session,
  board,
  users,
}, testInfo) => {
  const alice = await session('alice')
  const { page } = alice
  const [noteWord, frameWord, newWord] = [word('quokka'), word('pangolin'), word('axolotl')]
  const NOTE = 'shape:searchnote1'
  const FRAME = 'shape:searchframe1'

  await test.step('alice writes a note and, far away, names a frame', async () => {
    await edit(
      page,
      (ed, a) => {
        ed.createShapes([
          { id: a.note, type: 'note', x: 0, y: 0, props: { color: 'yellow', richText: a.noteText } },
          { id: a.frame, type: 'frame', x: 5200, y: 3600, props: { w: 640, h: 420, name: a.frameName } },
        ])
      },
      {
        note: NOTE,
        frame: FRAME,
        noteText: richText(`Launch plan: book the ${noteWord} venue before Friday`),
        frameName: `Research ${frameWord}`,
      },
    )
    await backToDashboard(page)
  })

  await test.step('the dashboard finds the note inside the board, with the word marked', async () => {
    await searchFor(page, noteWord)
    await expect(status(page)).toHaveText('1 match in 1 board')
    await expect(hits(page)).toHaveCount(1)
    const h = hit(page, NOTE)
    await expect(h).toHaveAttribute('data-kind', 'note')
    await expect(h).toContainText('Note')
    await expect(h.locator('mark')).toHaveText(noteWord)
    await expect(group(page, board).getByTestId('content-search-board-link')).toContainText('Search')
    // No board is titled like that: the title list says so in one line (no big empty box).
    await expect(page.getByTestId('dashboard-empty')).toHaveText(`No board titles match “${noteWord}”.`)
    await expect(h).toHaveAccessibleName(new RegExp(`Note.*${noteWord}.*, in Search`))
  })

  await test.step('screenshots: light, dark and 390 px wide (no sideways scrolling)', async () => {
    await capture('search-dashboard-light.png', page, testInfo)
    await page.evaluate(([key]) => localStorage.setItem(key as string, 'dark'), [THEME_KEY])
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await searchFor(page, noteWord)
    await expect(hit(page, NOTE).locator('mark')).toHaveText(noteWord)
    await capture('search-dashboard-dark.png', page, testInfo)
    await page.setViewportSize({ width: 390, height: 844 })
    await section(page).scrollIntoViewIfNeeded()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    const box = await hit(page, NOTE).boundingBox()
    expect(box?.width ?? 999).toBeLessThanOrEqual(390)
    await capture('search-dashboard-390.png', page, testInfo)
    await page.evaluate(([key]) => localStorage.setItem(key as string, 'light'), [THEME_KEY])
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.reload()
  })

  await test.step('a click opens the board zoomed to the note, with it selected', async () => {
    await searchFor(page, noteWord)
    await hit(page, NOTE).click()
    await expect(page).toHaveURL(new RegExp(`/b/${board}`))
    await waitForBoard(page)
    await expect.poll(() => selectedIds(page)).toEqual([NOTE])
    await expect.poll(() => inViewport(page, NOTE)).toBe(true)
  })

  await test.step('by keyboard: ArrowDown from the search box, then Enter, lands on the far-away frame', async () => {
    await backToDashboard(page)
    await searchFor(page, frameWord)
    await expect(hit(page, FRAME)).toHaveAttribute('data-kind', 'frame')
    await searchBox(page).press('ArrowDown')
    await expect(group(page, board).getByTestId('content-search-board-link')).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(hit(page, FRAME)).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(searchBox(page)).toBeFocused()
    await searchBox(page).press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await waitForBoard(page)
    await expect.poll(() => selectedIds(page)).toEqual([FRAME])
    await expect.poll(() => inViewport(page, FRAME)).toBe(true)
    expect(await inViewport(page, NOTE)).toBe(false)
  })

  await test.step('an edit shows up right away: the new word is found, the old one is gone', async () => {
    await edit(
      page,
      (ed, a) => {
        ed.updateShape({ id: a.id, type: 'note', props: { richText: a.text } })
      },
      { id: NOTE, text: richText(`Launch plan: book the ${newWord} venue before Friday`) },
    )
    await backToDashboard(page)
    await searchFor(page, newWord)
    await expect(hit(page, NOTE).locator('mark')).toHaveText(newWord)
    await searchFor(page, noteWord)
    await expect(status(page)).toHaveText('No matches inside boards.')
    await expect(hits(page)).toHaveCount(0)
  })

  await test.step('a deleted frame leaves the results', async () => {
    await page.goto(`/b/${board}`)
    await waitForBoard(page)
    await edit(page, (ed, id) => ed.deleteShapes([id]), FRAME)
    await backToDashboard(page)
    await searchFor(page, frameWord)
    await expect(status(page)).toHaveText('No matches inside boards.')
  })

  await test.step('a trashed board leaves the results at once', async () => {
    const aliceApi = await users.api('alice')
    await searchFor(page, newWord)
    await expect(hits(page)).toHaveCount(1)
    expect((await aliceApi.fetch('POST', `/api/boards/${board}/trash`)).status()).toBe(200)
    await searchFor(page, `${newWord} venue`)
    await expect(status(page)).toHaveText('No matches inside boards.')
    const res = await apiSearch(alice.context, users.devStudioId, newWord)
    expect(res.status).toBe(200)
    expect(res.body).not.toContain(board)
  })
})

async function joinAsGuest(browser: Browser, link: string, name: string) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  const page = await context.newPage()
  await page.goto(link)
  await expect(page.getByTestId('invite-page')).toHaveAttribute('data-allow-guests', 'true')
  await page.getByTestId('invite-guest-name').fill(name)
  await page.getByTestId('invite-guest-join').click()
  await expect(page).toHaveURL(/\/b\/[a-z0-9-]+$/, { timeout: 30_000 })
  await waitForBoard(page)
  return { context, page }
}

const guestText = (l: Locator) => l.evaluateAll((els) => els.map((e) => e.textContent ?? ''))

test('search: people find only boards they can open, comment threads included', async ({
  session,
  board,
  users,
  browser,
}, testInfo) => {
  const alice = await session('alice')
  const aliceApi = await users.api('alice')
  const [secret, shared, remark] = [word('marmoset'), word('capybara'), word('wombat')]
  const NOTE = 'shape:secretnote1'
  const contexts: BrowserContext[] = []
  try {
    // The private board: a note and a comment thread.
    await edit(
      alice.page,
      (ed, a) => {
        ed.createShapes([{ id: a.id, type: 'note', x: 0, y: 0, props: { richText: a.text } }])
      },
      { id: NOTE, text: richText(`Private pricing ${secret}`) },
    )
    await waitForSaved(alice.page)
    const created = await aliceApi.fetch('POST', `/api/boards/${board}/threads`, {
      anchor: { kind: 'shape', shapeId: NOTE, u: 0.5, v: 0.5 },
      body: `Check the ${remark} numbers before the ${secret} review`,
    })
    expect(created.status()).toBe(201)
    const threadId = ((await created.json()) as { thread: { id: string } }).thread.id
    // A second board, shared with the whole workspace (view).
    const sharedBoard = await users.createBoard('Shared search board')
    await aliceApi.patchBoard(sharedBoard, { visibility: 'workspace_view' })
    await alice.page.goto(`/b/${sharedBoard}`)
    await waitForBoard(alice.page)
    await edit(
      alice.page,
      (ed, text) => {
        ed.createShapes([{ type: 'text', x: 0, y: 0, props: { richText: text } }])
      },
      richText(`Team handbook ${shared} ${secret}`),
    )
    await backToDashboard(alice.page)

    const bob = await signedInContext(browser, 'bob')
    contexts.push(bob.context)

    await test.step('bob, a member without access to the private board, finds only the shared board', async () => {
      await openDashboard(bob.page, users.devStudioId)
      await searchFor(bob.page, secret)
      await expect(bob.page.getByTestId('content-search-board')).toHaveCount(1)
      await expect(group(bob.page, sharedBoard)).toBeVisible()
      await expect(group(bob.page, board)).toHaveCount(0)
      const res = await apiSearch(bob.context, users.devStudioId, secret)
      expect(res.body).not.toContain(board)
      expect(res.body).not.toContain('pricing')
      expect(res.body).not.toContain(remark) // the thread on the private board
      await searchFor(bob.page, remark)
      await expect(status(bob.page)).toHaveText('No matches inside boards.')
    })

    await test.step('as a viewer he finds the note and the comment thread; the thread opens on the board', async () => {
      await users.grant(board, 'bob', 'viewer')
      await searchFor(bob.page, secret)
      await expect(bob.page.getByTestId('content-search-board')).toHaveCount(2)
      await expect(status(bob.page)).toHaveText('3 matches in 2 boards')
      await expect(hit(bob.page, NOTE)).toBeVisible()
      await expect(hit(bob.page, threadId)).toBeVisible()
      await capture('search-two-boards-light.png', bob.page, testInfo)
      await bob.page.setViewportSize({ width: 390, height: 844 })
      await bob.page.getByTestId('content-search').scrollIntoViewIfNeeded()
      expect(await bob.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
      await capture('search-two-boards-390-light.png', bob.page, testInfo)
      await bob.page.setViewportSize({ width: 1360, height: 860 })
      await searchFor(bob.page, remark)
      await expect(hit(bob.page, threadId)).toHaveAttribute('data-kind', 'comment')
      await expect(hit(bob.page, threadId)).toContainText('Comment')
      await hit(bob.page, threadId).click()
      await waitForBoard(bob.page)
      await expect(threadPopover(bob.page, threadId)).toBeVisible()
      await expect(threadPopover(bob.page, threadId)).toContainText(remark)
    })

    await test.step('a name-only guest on a review link finds only that board, not the one shared with members', async () => {
      const link = await aliceApi.fetch('POST', `/api/boards/${board}/review-links`, {
        role: 'viewer',
        allowGuests: true,
      })
      expect(link.status()).toBe(201)
      const { url } = (await link.json()) as { url: string }
      const guest = await joinAsGuest(browser, url, 'Sam Rivera')
      contexts.push(guest.context)
      await openDashboard(guest.page, users.devStudioId)
      await searchFor(guest.page, secret)
      await expect(guest.page.getByTestId('content-search-board')).toHaveCount(1)
      await expect(group(guest.page, board)).toBeVisible()
      expect(await guestText(guest.page.getByTestId('content-search-board'))).not.toContain(shared)
      await searchFor(guest.page, shared)
      await expect(status(guest.page)).toHaveText('No matches inside boards.')
      const res = await apiSearch(guest.context, users.devStudioId, shared)
      expect(res.status).toBe(200)
      expect(res.body).not.toContain(sharedBoard)
      // Another workspace does not exist for the guest.
      const bobMe = await users.get('bob')
      expect((await apiSearch(guest.context, bobMe.personalWorkspaceId, secret)).status).toBe(404)
    })

    await test.step('long queries are refused by the server; the box stops at 200 characters', async () => {
      const res = await bob.context.request.get(
        `/api/workspaces/${users.devStudioId}/search?${new URLSearchParams({ q: 'x'.repeat(201) })}`,
        { headers: ORIGIN },
      )
      expect(res.status()).toBe(400)
      await openDashboard(bob.page, users.devStudioId)
      await searchBox(bob.page).pressSequentially('y'.repeat(205), { delay: 0 })
      expect(await searchBox(bob.page).inputValue()).toHaveLength(200)
    })
  } finally {
    await Promise.all(contexts.map((c) => c.close()))
  }
})

test('search: the keyboard keeps its place after "Show more boards" and "Try again"', async ({
  users,
  browser,
}) => {
  const aliceApi = await users.api('alice')
  const topic = word('tapir')
  // Six boards whose only match is a comment thread (no canvas needed): one more than is shown.
  for (let i = 1; i <= 6; i++) {
    const id = await users.createBoard(`Keyboard board ${i}`)
    const res = await aliceApi.fetch('POST', `/api/boards/${id}/threads`, {
      anchor: { kind: 'point', x: 0, y: 0 },
      body: `Notes about the ${topic} number ${i}`,
    })
    expect(res.status()).toBe(201)
  }
  const alice = await signedInContext(browser, 'alice')
  const { page } = alice
  try {
    await openDashboard(page, users.devStudioId)
    await searchFor(page, topic)
    await expect(page.getByTestId('content-search-board')).toHaveCount(5)

    await test.step('"Show 1 more board" by keyboard: focus lands on the board it revealed', async () => {
      const more = page.getByTestId('content-search-more-boards')
      await expect(more).toHaveText('Show 1 more board')
      await more.focus()
      await page.keyboard.press('Enter')
      await expect(page.getByTestId('content-search-board')).toHaveCount(6)
      await expect(page.getByTestId('content-search-board-link').nth(5)).toBeFocused()
      await page.keyboard.press('ArrowUp') // the arrows go on from there
      await expect(hits(page).nth(4)).toBeFocused()
    })

    await test.step('"Try again" by keyboard after an error: focus goes back to the search box', async () => {
      let failing = true
      await page.route('**/search?*', (route) =>
        failing
          ? route.fulfill({
              status: 503,
              contentType: 'application/json',
              body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Search is resting.' } }),
            })
          : route.continue(),
      )
      await searchBox(page).fill(`${topic} notes`)
      await expect(section(page)).toHaveAttribute('data-state', 'error')
      await expect(status(page)).toHaveText('Search is resting.')
      failing = false
      await page.getByTestId('content-search-retry').focus()
      await page.keyboard.press('Enter')
      await expect(section(page)).toHaveAttribute('data-state', 'ready')
      await expect(status(page)).toHaveText('6 matches in 6 boards')
      await expect(searchBox(page)).toBeFocused()
      await page.unroute('**/search?*')
    })
  } finally {
    await alice.context.close()
  }
})
