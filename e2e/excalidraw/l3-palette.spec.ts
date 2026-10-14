// W3 (wave L, L3-2): the Ctrl/Cmd+K command palette on the Excalidraw board page, in a real browser.
//  - Ctrl+K, "lock", Enter locks the selection in ONE undo step (Ctrl+Z unlocks it), through runCommand as
//    the menus do; the keyboard is the board's again afterwards;
//  - "Retro" goes to that frame (the camera only: nothing selected, nothing pushed);
//  - a workspace hit lands on the other board with the element selected (two boards);
//  - a name-only guest gets no workspace hit beyond their link's board (the server's filter, read on the wire);
//  - axe passes on the open palette; no request leaves Lobby's origins (the e2e network assertion).
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/l3-palette.spec.ts --project=chromium --workers=1
import { randomBytes } from 'node:crypto'
import AxeBuilder from '@axe-core/playwright'
import type { Page, Request } from '@playwright/test'
import {
  createItem,
  createNote,
  expect,
  expectSaved,
  item,
  openCanvasSession,
  pushedOps,
  select,
  selection,
  setViewport,
  test,
  waitForCanvas,
} from '../tests/support/canvas.ts'
import { API_URL, WEB_URL } from '../tests/support/ports.ts'
import { focusCanvas, inView, waitForNavigation } from './navigation-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

const palette = (page: Page) => page.getByTestId('command-palette')
const input = (page: Page) => page.getByTestId('command-palette-input')
const option = (page: Page, id: string) =>
  page.locator(`[data-testid="command-palette-option"][data-entry-id="${id}"]`)
const activeOption = (page: Page) =>
  page.locator('[data-testid="command-palette-option"][data-active="true"]')

/** Opens the palette with the real key on the board. */
async function openPalette(page: Page) {
  await focusCanvas(page)
  await page.keyboard.press('ControlOrMeta+k')
  await expect(palette(page)).toBeVisible()
  await expect(input(page)).toBeFocused()
}

/** A word no other board in this run contains. */
const word = (prefix: string) =>
  `${prefix}${[...randomBytes(6)].map((b) => String.fromCharCode(97 + (b % 26))).join('')}`

/** Every request of the page that left Lobby's own origins (the e2e network assertion: none may). */
function foreignRequests(page: Page) {
  const own = new Set([new URL(WEB_URL).origin, new URL(API_URL).origin])
  const foreign: string[] = []
  page.on('request', (r: Request) => {
    const url = new URL(r.url())
    if (url.protocol === 'data:' || url.protocol === 'blob:') return
    if (!own.has(url.origin)) foreign.push(r.url())
  })
  return foreign
}

test('Ctrl+K, "lock", Enter locks the selection in one undo step; Ctrl+Z unlocks it; the board has the keyboard again; nothing leaves Lobby’s origins', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const foreign = foreignRequests(a.page)
  const n1 = await createNote(a.page, { x: 0, y: 0, text: 'First' })
  await expectSaved(a.page)
  const n2 = await createNote(a.page, { x: 300, y: 0, text: 'Second' })
  await expectSaved(a.page)
  await select(a.page, [n1, n2])
  // nothing is asked of the api before the palette opens
  const searchesBefore: string[] = []
  a.page.on('request', (r) => {
    if (r.url().includes('/search?')) searchesBefore.push(r.url())
  })
  await openPalette(a.page)
  await a.page.keyboard.type('lock')
  await expect(activeOption(a.page)).toHaveAttribute('data-entry-id', 'cmd:canvas-ux.toggle-lock')
  await expect(activeOption(a.page)).toContainText('Lock or unlock')
  await a.page.keyboard.press('Enter')
  await expect(palette(a.page)).toHaveCount(0)
  await expect
    .poll(async () => [(await item(a.page, n1))?.locked, (await item(a.page, n2))?.locked])
    .toEqual([true, true])
  // the selection is kept (MAK-05), and the board has the keyboard again
  await expect.poll(async () => [...(await selection(a.page))].sort()).toEqual([n1, n2].sort())
  await expect.poll(() => a.page.evaluate(() => !!document.activeElement?.closest('.excalidraw'))).toBe(true)
  await expectSaved(a.page)
  // one undo step: one Ctrl+Z unlocks both
  await a.page.keyboard.press('ControlOrMeta+z')
  await expect
    .poll(async () => [(await item(a.page, n1))?.locked, (await item(a.page, n2))?.locked])
    .toEqual([false, false])
  // "lock" (four letters) is a search too: the board's own and the workspace's, after the pause
  expect(searchesBefore.length).toBeLessThanOrEqual(1)
  expect(foreign).toEqual([])
})

test('Ctrl+K, "Retro", Enter goes to that frame: the camera only, nothing selected, nothing pushed; Escape closes and gives the board the keyboard back', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const ideas = await createItem(a.page, 'frame', { x: 0, y: 0, width: 800, height: 600, name: 'Ideas' })
  await expectSaved(a.page)
  const retro = await createItem(a.page, 'frame', {
    x: 6000,
    y: 4000,
    width: 800,
    height: 600,
    name: 'Retro',
  })
  await expectSaved(a.page)
  await setViewport(a.page, { x: -200, y: -200, zoom: 1 })
  await expect.poll(() => inView(a.page, [retro])).toBe(false)
  const pushes = (await pushedOps(a.page)).length
  await openPalette(a.page)
  await a.page.keyboard.type('Retro')
  await expect(activeOption(a.page)).toHaveAttribute('data-entry-id', `frame:${retro}`)
  await a.page.keyboard.press('Enter')
  await expect(palette(a.page)).toHaveCount(0)
  await expect.poll(() => inView(a.page, [retro])).toBe(true)
  expect(await inView(a.page, [ideas])).toBe(false)
  expect(await selection(a.page)).toEqual([])
  expect((await pushedOps(a.page)).length).toBe(pushes)

  await openPalette(a.page)
  await a.page.keyboard.type('zzz')
  await a.page.keyboard.press('Escape')
  await expect(palette(a.page)).toHaveCount(0)
  await expect.poll(() => a.page.evaluate(() => !!document.activeElement?.closest('.excalidraw'))).toBe(true)
  // Ctrl+K again closes an open palette
  await openPalette(a.page)
  await a.page.keyboard.press('ControlOrMeta+k')
  await expect(palette(a.page)).toHaveCount(0)
})

/** Types `q` until the workspace group shows `id` (the index may still be catching up with a fresh board). */
async function workspaceHit(page: Page, q: string, id: string) {
  await expect
    .poll(
      async () => {
        if (!(await palette(page).count())) await openPalette(page)
        await input(page).fill(q)
        const hit = option(page, id)
        try {
          await expect(hit).toBeVisible({ timeout: 4_000 })
          return true
        } catch {
          await page.keyboard.press('Escape')
          return false
        }
      },
      { timeout: 45_000, intervals: [500, 1_000, 2_000] },
    )
    .toBe(true)
}

test('a workspace hit lands on the other board with the element selected (two boards)', async ({
  canvasSession,
  users,
  browser,
}) => {
  test.setTimeout(180_000)
  const key = word('quokka')
  // board B, with a note only it has
  const other = await users.createBoard('Palette other board')
  const alice = await users.get('alice')
  const b = await openCanvasSession(browser, other, alice)
  const target = await createNote(b.page, { x: 100, y: 100, text: `Book the ${key} venue` })
  await expectSaved(b.page)
  await b.context.close()

  const a = await canvasSession('alice')
  await workspaceHit(a.page, key, `ws:${other}:shape:${target}`)
  await option(a.page, `ws:${other}:shape:${target}`).click()
  await expect(a.page).toHaveURL(new RegExp(`/b/${other}`))
  await waitForNavigation(a.page)
  await expect.poll(() => selection(a.page)).toEqual([target])
  await expect.poll(() => inView(a.page, [target])).toBe(true)
})

test('a name-only guest gets no workspace hit beyond their link’s board (the server filters; read on the wire); axe passes on the open palette', async ({
  board,
  browser,
  canvasSession,
  users,
}) => {
  test.setTimeout(180_000)
  const key = word('pangolin')
  // board B (the guest has no link to it) and the link's board A both hold the word
  const other = await users.createBoard('Palette guest other board')
  const alice = await users.get('alice')
  const b = await openCanvasSession(browser, other, alice)
  const hidden = await createNote(b.page, { x: 0, y: 0, text: `Secret ${key} plan` })
  await expectSaved(b.page)
  await b.context.close()
  const a = await canvasSession('alice')
  const here = await createNote(a.page, { x: 0, y: 0, text: `Shared ${key} plan` })
  await expectSaved(a.page)
  // alice herself finds board B's note (so the guest's empty group is the server's filter, not a stale index)
  await workspaceHit(a.page, key, `ws:${other}:shape:${hidden}`)
  await a.page.keyboard.press('Escape')

  const aliceApi = await users.api('alice')
  const made = await aliceApi.fetch('POST', `/api/boards/${board}/review-links`, {
    role: 'commenter',
    allowGuests: true,
    expiresInHours: 3,
  })
  expect(made.status()).toBe(201)
  const link = ((await made.json()) as { url: string }).url
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  try {
    const g = await context.newPage()
    const foreign = foreignRequests(g)
    await g.goto(link)
    await g.getByTestId('invite-guest-name').fill('Sam')
    await g.getByTestId('invite-guest-join').click()
    await expect(g).toHaveURL(new RegExp(`/b/${board}$`), { timeout: 30_000 })
    await waitForCanvas(g)
    const answers: { groups: { board: { id: string } }[] }[] = []
    g.on('response', async (r) => {
      if (!r.url().includes('/search?') || r.status() !== 200) return
      try {
        answers.push(await r.json())
      } catch {
        // not JSON: not a search answer
      }
    })
    await openPalette(g)
    await g.keyboard.type(key)
    // this board's own hit is there; the workspace group has nothing (the server sent only this board)
    await expect(option(g, `board:${here}`)).toBeVisible({ timeout: 10_000 })
    await expect.poll(() => answers.length, { timeout: 15_000 }).toBeGreaterThan(0)
    for (const r of answers) for (const grp of r.groups) expect(grp.board.id).toBe(board)
    await expect(g.locator('[data-testid="command-palette-option"][data-entry-id^="ws:"]')).toHaveCount(0)
    await expect(option(g, `ws:${other}:shape:${hidden}`)).toHaveCount(0)
    // a read-only role's palette: no editing command in it
    await g.locator('[data-testid="command-palette-input"]').fill('lock')
    await expect(option(g, 'cmd:canvas-ux.toggle-lock')).toHaveCount(0)

    // axe on the open palette (with results in it)
    await g.locator('[data-testid="command-palette-input"]').fill('plan')
    await expect(option(g, `board:${here}`)).toBeVisible({ timeout: 10_000 })
    const results = await new AxeBuilder({ page: g })
      .include('[data-testid="command-palette"]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
      .analyze()
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    ).toEqual([])
    expect(foreign).toEqual([])
  } finally {
    await context.close()
  }
})

test('the dashboard’s palette: Ctrl+K lists this workspace’s boards (fetched when it opens) and, for a creator, New board from template; Enter opens a board', async ({
  canvasSession,
  users,
}) => {
  const title = `Palette target ${word('board')}`
  const target = await users.createBoard(title)
  const a = await canvasSession('alice')
  await a.page.getByRole('link', { name: 'Back to Dev Studio' }).click()
  await expect(a.page.getByTestId('dashboard')).toBeVisible()
  const lists: string[] = []
  a.page.on('request', (r) => {
    if (/\/api\/workspaces\/[^/]+\/boards(\?|$)/.test(r.url())) lists.push(r.url())
  })
  const listsBefore = lists.length
  await a.page.keyboard.press('ControlOrMeta+k')
  await expect(palette(a.page)).toBeVisible()
  await expect(input(a.page)).toBeFocused()
  await expect.poll(() => lists.length).toBeGreaterThan(listsBefore)
  await expect(option(a.page, 'new:retrospective')).toBeVisible()
  await a.page.keyboard.type(title)
  await expect(activeOption(a.page)).toHaveAttribute('data-entry-id', `board:${target}`)
  await a.page.keyboard.press('Enter')
  await expect(a.page).toHaveURL(new RegExp(`/b/${target}$`))
  await waitForCanvas(a.page)
})

// Wave L integration (the W3 review, minor): with nothing typed and no recents the first line was Undo, so a
// reflex Ctrl/Cmd+K, Enter undid the last change. Now no line is active until an arrow key or the pointer picks one.
test('Ctrl+K then Enter with nothing typed runs nothing (no recents): the last change stays; an arrow key picks the first line', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const n1 = await createNote(a.page, { x: 0, y: 0, text: 'Keep me' })
  await expectSaved(a.page)
  const pushes = (await pushedOps(a.page)).length
  await openPalette(a.page)
  await expect(activeOption(a.page)).toHaveCount(0)
  await a.page.keyboard.press('Enter')
  await expect(palette(a.page)).toBeVisible()
  expect(await item(a.page, n1)).not.toBeNull()
  expect((await pushedOps(a.page)).length).toBe(pushes)
  await a.page.keyboard.press('ArrowDown')
  await expect(activeOption(a.page)).toHaveCount(1)
  await a.page.keyboard.press('Escape')
  await expect(palette(a.page)).toHaveCount(0)
  expect(await item(a.page, n1)).not.toBeNull()
})
