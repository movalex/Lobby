// Dashboard + sharing (docs/E2E-PLAN.md [dashboard-share]): the template gallery on "New board",
// stars and layouts, the card menu, duplicate/import, the board header sharing badge, the Share
// dialog (invites, access requests, ownership, removal notes) and review links. Every change made in
// one browser is checked where it matters: in another person's browser, in a fresh context loading
// from the server, or through the API as the person it affects. The last group ([platform]) runs the
// board socket against a separate sync origin, from two extra web builds.
import { rmSync, writeFileSync } from 'node:fs'
import type { Browser, Page } from '@playwright/test'
import { displayName, signInContext } from './support/api.ts'
import {
  edit,
  expectConn,
  getShape,
  read,
  signInThroughUi,
  waitForBoard,
  waitForValue,
} from './support/board.ts'
import {
  accessRequests,
  allowLoopbackSockets,
  boardDetail,
  boardList,
  buildWeb,
  cardIn,
  chooseFromMenu,
  closeShare,
  frameNames,
  freshHandle,
  invitations,
  inviteToken,
  mainCard,
  mainGrid,
  memberRow,
  menuActions,
  notifications,
  ORIGIN,
  openDashboard,
  openMoreWaysToShare,
  openShareFromButton,
  personalWorkspace,
  recordNavigations,
  recordSockets,
  removeMember,
  requestRow,
  serveBuild,
  setVisibility,
  shapeCount,
  shareDialog,
  shareState,
  shortDateInPage,
  signedInContext,
  starredGrid,
  starredIds,
  toast,
} from './support/dashboard-share.ts'
import { richText } from './support/editor.ts'
import { expect, test } from './support/fixtures.ts'
import { HOST, RUN_TAG, SYNC_PORT, SYNC_URL, WEB_PORT, WEB_URL } from './support/ports.ts'
import { capture } from './support/screenshots.ts'

// This file's own stack runs the sync server as production does, with an Origin allowlist: board
// sockets are accepted only from the web origin (through the preview proxy for most tests, directly
// for the separate-sync-origin group at the end).
test.use({ syncEnv: { ALLOWED_ORIGINS: WEB_URL } })

const RETRO_FRAMES = ['1 · Check-in', '2 · What went well', '3 · What to improve', '4 · Actions']
const TEMPLATE_IDS = [
  'brainstorm',
  'mood-board',
  'storyboard',
  'pitch-outline',
  'retrospective',
  'production-plan',
]
const MENU_ORDER = [
  'open',
  'copy-link',
  'share',
  'rename',
  'move',
  'duplicate',
  'star',
  'details',
  'archive',
  'trash',
]

const templateIds = (page: Page) =>
  page
    .getByTestId('template-card')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-template-id')).sort())

const canUndo = (page: Page) => read(page, (ed) => (ed as unknown as { getCanUndo(): boolean }).getCanUndo())

/** A note created in `page` and confirmed by the server (a second tab of the same person loads it). */
async function addNote(page: Page, id: string, text: string) {
  await edit(
    page,
    (ed, a) => ed.createShape({ id: a.id, type: 'note', x: 200, y: 160, props: { richText: a.text } }),
    { id, text: richText(text) },
  )
  const probe = await page.context().newPage()
  try {
    await probe.goto(page.url())
    await waitForBoard(probe)
    await expect.poll(() => getShape(probe, id).then((s) => s !== null)).toBe(true)
  } finally {
    await probe.close()
  }
}

// ---- PRE-01: template gallery ---------------------------------------------------------------------

test('new board from the template gallery: Blank is preselected, search and categories filter, and the retrospective is inserted exactly once', async ({
  browser,
  users,
}, testInfo) => {
  const alice = await signedInContext(browser, 'alice')
  const aliceApi = await users.api('alice')
  try {
    const { page } = alice
    await openDashboard(page, users.devStudioId)

    await test.step('New board opens the gallery: Blank board first and selected, six templates', async () => {
      await page.getByTestId('create-board').click()
      await expect(page.getByTestId('create-board-dialog')).toBeVisible()
      const gallery = page.getByTestId('template-gallery')
      await expect(gallery).toBeVisible()
      await expect(gallery.getByTestId('template-blank')).toHaveAttribute('aria-pressed', 'true')
      await expect(gallery.getByTestId('template-card')).toHaveCount(6)
      await expect.poll(() => templateIds(page)).toEqual([...TEMPLATE_IDS].sort())
      // Blank comes first in the grid.
      await expect(
        gallery.locator('.dr-gallery__grid > li').first().getByTestId('template-blank'),
      ).toBeVisible()
      await expect(page.getByTestId('create-board-submit')).toHaveText('Create board')
    })

    await test.step('search and categories narrow the templates (Blank always stays)', async () => {
      await page.getByTestId('template-search').fill('panel')
      await expect(page.getByTestId('template-card')).toHaveCount(1)
      await expect.poll(() => templateIds(page)).toEqual(['storyboard'])
      await expect(page.getByTestId('template-blank')).toBeVisible()
      await page.getByTestId('template-search').fill('zzz no such template')
      await expect(page.getByTestId('template-card')).toHaveCount(0)
      await expect(page.getByTestId('template-empty')).toBeVisible()
      await page.getByTestId('template-search').fill('')
      await page.locator('[data-testid="template-category"][data-category="visual"]').click()
      await expect.poll(() => templateIds(page)).toEqual(['mood-board', 'storyboard'])
      await page.locator('[data-testid="template-category"][data-category="plan"]').click()
      await expect.poll(() => templateIds(page)).toEqual(['pitch-outline', 'production-plan'])
      await page.locator('[data-testid="template-category"][data-category="review"]').click()
      await expect.poll(() => templateIds(page)).toEqual(['retrospective'])
      await expect(page.locator('[data-testid="template-category"][data-category="review"]')).toHaveAttribute(
        'aria-pressed',
        'true',
      )
    })

    const title = `Sprint retro ${freshHandle('r')}`
    const navigations = recordNavigations(page)
    let boardId = ''
    await test.step('create from Retrospective: the board opens with the four frames, nothing to undo', async () => {
      const retro = page.locator('[data-testid="template-card"][data-template-id="retrospective"]')
      await retro.click()
      await expect(retro).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByTestId('template-blank')).toHaveAttribute('aria-pressed', 'false')
      await expect(page.getByTestId('template-sections')).toContainText(RETRO_FRAMES.join(' · '))
      await expect(page.getByTestId('create-board-submit')).toHaveText('Create from Retrospective')
      await page.getByTestId('create-board-title').fill(title)
      await page.getByTestId('create-board-submit').click()
      // Once handled, the board page drops ?template= (a reload must not replay it).
      await expect(page).toHaveURL(/\/b\/b-[0-9a-z]{10}$/)
      boardId = new URL(page.url()).pathname.split('/')[2] ?? ''
      expect(navigations).toContain(`${WEB_URL}/b/${boardId}?template=retrospective`)
      await waitForBoard(page)
      await expect(page.getByTestId('board-title')).toHaveText(title)
      await expect.poll(() => frameNames(page)).toEqual(RETRO_FRAMES)
      expect(await page.evaluate(() => location.search)).toBe('')
      // The board starts with the template: there is no "insert" step to undo.
      expect(await canUndo(page)).toBe(false)
      const server = await boardDetail(aliceApi, boardId)
      expect(server.board).toMatchObject({ title, visibility: 'private', status: 'active' })
      await capture('template-retrospective.png', page, testInfo)
    })

    await test.step('the server holds one copy; a reload and the original ?template= link in a new tab add none', async () => {
      // Another browser loads the frames from the server. (Alone on a board, tldraw sends changes at
      // most once a second, so this is also what makes the reload below safe.)
      const fresh = await signedInContext(browser, 'alice')
      try {
        await fresh.page.goto(`/b/${boardId}`)
        await waitForBoard(fresh.page)
        await expect.poll(() => frameNames(fresh.page)).toEqual(RETRO_FRAMES)
      } finally {
        await fresh.context.close()
      }
      await page.reload()
      await waitForBoard(page)
      await expect.poll(() => frameNames(page)).toEqual(RETRO_FRAMES)
      expect(await canUndo(page)).toBe(false)
      // A new tab has its own session memory: only "the board is not empty" can stop a second insert.
      const tab = await alice.context.newPage()
      await tab.goto(`/b/${boardId}?template=retrospective`)
      await waitForBoard(tab)
      await expect(tab).toHaveURL(new RegExp(`/b/${boardId}$`)) // the start view ran and dropped the param
      expect(await frameNames(tab)).toEqual(RETRO_FRAMES)
      expect(await canUndo(tab)).toBe(false)
      await tab.close()
    })
  } finally {
    await alice.context.close()
  }
})

// Regression (found in the validation phase: a template inserted on a new board was lost when its
// creator went straight back to the dashboard). Alone on a board, tldraw sends changes at most once a
// second (SOLO_MODE_FPS), and unmounting the sync client drops what it has not sent, so an in-app
// navigation away is held until the board's changes are acknowledged (BoardPage's leave guard).
// Each step leaves while a change is still unsent; without the guard all three lose it.
test('leaving a board right away keeps its last changes: a new template board, an edit then “Back to Dev Studio”, an edit then the browser Back', async ({
  browser,
  users,
}) => {
  const alice = await signedInContext(browser, 'alice')
  const onServer = async <T>(boardId: string, fn: (page: Page) => Promise<T>) => {
    const fresh = await signedInContext(browser, 'alice')
    try {
      await fresh.page.goto(`/b/${boardId}`)
      await waitForBoard(fresh.page)
      return await fn(fresh.page)
    } finally {
      await fresh.context.close()
    }
  }
  const saved = async (page: Page) => {
    // Two frames first: the indicator has rendered the edit just made ("Saving…"), so a "Saved" seen
    // afterwards covers it.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved')
  }
  const addNote = (page: Page, id: string) =>
    edit(page, (ed, shapeId) => ed.createShape({ id: shapeId, type: 'note', x: 400, y: 300 }), id)
  const hasShape = (page: Page, id: string) => read(page, (ed, shapeId) => !!ed.getShape(shapeId), id)
  try {
    const { page } = alice
    await openDashboard(page, users.devStudioId)
    let boardId = ''
    await test.step('a new board from a template, left as soon as its frames show', async () => {
      await page.getByTestId('create-board').click()
      await page.locator('[data-testid="template-card"][data-template-id="retrospective"]').click()
      await page.getByTestId('create-board-submit').click()
      await expect(page).toHaveURL(/\/b\/b-[0-9a-z]{10}$/)
      boardId = new URL(page.url()).pathname.split('/')[2] ?? ''
      await waitForBoard(page)
      await expect.poll(() => frameNames(page)).toEqual(RETRO_FRAMES)
      await page.getByRole('link', { name: 'Back to Dev Studio' }).first().click()
      await expect(page.getByTestId('dashboard')).toBeVisible()
      await onServer(boardId, async (fresh) => {
        await expect.poll(() => frameNames(fresh)).toEqual(RETRO_FRAMES)
      })
    })
    await test.step('an edit within a second of the last save, then “Back to Dev Studio”', async () => {
      await mainCard(page, boardId)
        .getByRole('link', { name: /^Open / })
        .click()
      await waitForBoard(page)
      await addNote(page, 'shape:leave-first')
      await saved(page)
      // The edit and the click in one task: the sync client sends on a later animation frame at the
      // earliest, so the note is certainly unsent when the link's click handler runs.
      await edit(page, (ed) => {
        ed.createShape({ id: 'shape:leave-back-link', type: 'note', x: 700, y: 300 })
        const link = document.querySelector<HTMLAnchorElement>('a[aria-label="Back to Dev Studio"]')
        if (!link) throw new Error('no "Back to Dev Studio" link')
        link.click()
      })
      await expect(page.getByTestId('dashboard')).toBeVisible()
      await onServer(boardId, async (fresh) => {
        expect(await hasShape(fresh, 'shape:leave-first')).toBe(true)
        expect(await hasShape(fresh, 'shape:leave-back-link')).toBe(true)
      })
    })
    await test.step('an edit within a second of the last save, then the browser Back', async () => {
      await mainCard(page, boardId)
        .getByRole('link', { name: /^Open / })
        .click()
      await waitForBoard(page)
      await addNote(page, 'shape:leave-second')
      await saved(page)
      // Same as the Back button (a history traversal, then popstate), in the task that made the edit.
      await edit(page, (ed) => {
        ed.createShape({ id: 'shape:leave-browser-back', type: 'note', x: 700, y: 300 })
        history.back()
      })
      await expect(page.getByTestId('dashboard')).toBeVisible()
      await expect(page).toHaveURL(new RegExp(`/w/${users.devStudioId}$`))
      await onServer(boardId, async (fresh) => {
        expect(await hasShape(fresh, 'shape:leave-second')).toBe(true)
        expect(await hasShape(fresh, 'shape:leave-browser-back')).toBe(true)
      })
    })
  } finally {
    await alice.context.close()
  }
})

test('a viewer opening ?template= on an empty board gets nothing inserted; the owner with the same link does', async ({
  board,
  session,
}) => {
  const bob = await session('bob', { role: 'viewer' })
  await bob.page.goto(`/b/${board}?template=retrospective`)
  await waitForBoard(bob.page)
  await expect(bob.page).toHaveURL(new RegExp(`/b/${board}$`)) // handled (and dropped) by the start view
  await expect(bob.page.getByTestId('readonly-pill')).toHaveAttribute('data-role', 'viewer')
  expect(await shapeCount(bob.page)).toBe(0)
  // Nothing reached the server either: the owner's fresh load is empty.
  const alice = await session('alice')
  expect(await shapeCount(alice.page)).toBe(0)
  // The same link opened by someone who can edit inserts it, and the viewer sees it arrive.
  await alice.page.goto(`/b/${board}?template=retrospective`)
  await waitForBoard(alice.page)
  await expect.poll(() => frameNames(alice.page)).toEqual(RETRO_FRAMES)
  await expect.poll(() => frameNames(bob.page)).toEqual(RETRO_FRAMES)
})

test('"Don’t show templates on new boards": New board then makes an Untitled board directly; the choice is per user', async ({
  browser,
}) => {
  const handle = freshHandle('tess')
  const tess = await signedInContext(browser, handle, { name: 'Tess Moreau' })
  try {
    const { page } = tess
    const wid = personalWorkspace(tess.me)
    await openDashboard(page, wid)
    await expect(page.getByTestId('open-templates')).toHaveCount(0)

    await page.getByTestId('create-board').click()
    await expect(page.getByTestId('template-gallery')).toBeVisible()
    await page.getByTestId('template-dont-show').check()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('create-board-dialog')).toHaveCount(0)
    await expect(page.getByTestId('open-templates')).toBeVisible()
    // Nothing was created by ticking the box and leaving.
    await expect(page.getByTestId('dashboard-empty')).toBeVisible()

    await page.getByTestId('create-board').click()
    await expect(page).toHaveURL(/\/b\/b-[0-9a-z]{10}$/)
    await waitForBoard(page)
    await expect(page.getByTestId('board-title')).toHaveText('Untitled board')
    const created = await page.request.get(`/api/workspaces/${wid}/boards`)
    const boards = ((await created.json()) as { boards: { title: string }[] }).boards
    expect(boards.map((b) => b.title)).toEqual(['Untitled board'])

    // The choice survives a reload, and "Templates" still opens the gallery on demand.
    await openDashboard(page, wid)
    await page.reload()
    await expect(page.getByTestId('open-templates')).toBeVisible()
    await page.getByTestId('open-templates').click()
    await expect(page.getByTestId('template-gallery')).toBeVisible()
    await expect(page.getByTestId('template-dont-show')).toBeChecked()
    await page.keyboard.press('Escape')

    // Per user: someone else signing in on this same browser still gets the gallery.
    const other = freshHandle('uma')
    const me = await signInContext(tess.context, other, 'Uma Lind')
    await openDashboard(page, personalWorkspace(me))
    await expect(page.getByTestId('dev-identity-badge')).toHaveAttribute('data-user-id', me.user.id)
    await expect(page.getByTestId('open-templates')).toHaveCount(0)
    await page.getByTestId('create-board').click()
    await expect(page.getByTestId('template-gallery')).toBeVisible()
    await expect(page.getByTestId('template-dont-show')).not.toBeChecked()
  } finally {
    await tess.context.close()
  }
})

// ---- DSH-01: stars, grid/list --------------------------------------------------------------------

test('stars: a starred board leads the dashboard for that user only, survives reloads, and leaves Starred when access ends', async ({
  browser,
  users,
}) => {
  const title = `Starred moodboard ${freshHandle('s')}`
  const boardId = await users.createBoard(title)
  const bobUser = await users.grant(boardId, 'bob', 'editor')
  const aliceApi = await users.api('alice')
  const bobApi = await users.api('bob')
  const alice = await signedInContext(browser, 'alice')
  const bob = await signedInContext(browser, 'bob')
  try {
    const wid = users.devStudioId
    for (const p of [alice.page, bob.page]) {
      await openDashboard(p, wid)
      await p.getByTestId('dashboard-search').fill(title)
      await expect(mainCard(p, boardId)).toBeVisible()
    }

    await test.step('alice stars the board: it shows under Starred, and the server keeps it', async () => {
      const star = mainCard(alice.page, boardId).getByTestId('board-star')
      await expect(star).toHaveAttribute('aria-pressed', 'false')
      await expect(alice.page.getByTestId('starred-section')).toHaveCount(0)
      await star.click()
      await expect(star).toHaveAttribute('aria-pressed', 'true')
      await expect(cardIn(starredGrid(alice.page), boardId)).toBeVisible()
      await expect.poll(() => starredIds(aliceApi, wid)).toContain(boardId)
      const listed = (await boardList(aliceApi, wid)).find((b) => b.id === boardId)
      expect(listed?.starred).toBe(true)
      await alice.page.reload()
      await expect(cardIn(starredGrid(alice.page), boardId)).toBeVisible()
      await expect(cardIn(starredGrid(alice.page), boardId).getByTestId('board-star')).toHaveAttribute(
        'aria-pressed',
        'true',
      )
    })

    await test.step('stars are per user: bob sees the same board unstarred', async () => {
      await bob.page.reload()
      await bob.page.getByTestId('dashboard-search').fill(title)
      await expect(mainCard(bob.page, boardId).getByTestId('board-star')).toHaveAttribute(
        'aria-pressed',
        'false',
      )
      await expect(cardIn(starredGrid(bob.page), boardId)).toHaveCount(0)
      expect(await starredIds(bobApi, wid)).not.toContain(boardId)
    })

    await test.step('bob stars it too, then loses access: it leaves his Starred and the server hides it', async () => {
      await mainCard(bob.page, boardId).getByTestId('board-star').click()
      await expect(cardIn(starredGrid(bob.page), boardId)).toBeVisible()
      await expect.poll(() => starredIds(bobApi, wid)).toContain(boardId)
      await removeMember(aliceApi, boardId, bobUser.id)
      await bob.page.reload()
      await bob.page.getByTestId('dashboard-search').fill(title)
      await expect(bob.page.getByTestId('dashboard-empty')).toBeVisible()
      await expect(cardIn(starredGrid(bob.page), boardId)).toHaveCount(0)
      expect(await starredIds(bobApi, wid)).not.toContain(boardId)
      // Starring a board you cannot open is refused like any other access (no existence leak).
      expect((await bobApi.fetch('PUT', `/api/boards/${boardId}/star`)).status()).toBe(404)
    })

    await test.step('alice unstars it from the Starred card’s menu, which paints over the list below', async () => {
      const starredCard = cardIn(starredGrid(alice.page), boardId)
      await starredCard.getByTestId('board-card-menu').click()
      const item = starredCard.locator('[role="menuitem"][data-action="unstar"]')
      await expect(item).toHaveText('Remove star')
      const box = await item.boundingBox()
      if (!box) throw new Error('menu item has no box')
      const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      // The item sits over the same board's card in the list under Starred, and still gets the click.
      const below = await mainCard(alice.page, boardId).boundingBox()
      expect(below && at.y > below.y && at.y < below.y + below.height).toBe(true)
      const hit = await alice.page.evaluate(
        ({ x, y }) =>
          document.elementFromPoint(x, y)?.closest('[role="menuitem"]')?.getAttribute('data-action'),
        at,
      )
      expect(hit).toBe('unstar')
      await alice.page.mouse.click(at.x, at.y)
      await expect(cardIn(starredGrid(alice.page), boardId)).toHaveCount(0)
      await expect(mainCard(alice.page, boardId).getByTestId('board-star')).toHaveAttribute(
        'aria-pressed',
        'false',
      )
      await expect.poll(() => starredIds(aliceApi, wid)).not.toContain(boardId)
    })
  } finally {
    await Promise.all([alice.context.close(), bob.context.close()])
  }
})

test('grid/list toggle: the list layout persists across reloads; Ctrl+E jumps to board search', async ({
  browser,
}) => {
  const person = await signedInContext(browser, freshHandle('lena'), { name: 'Lena Voss' })
  try {
    const { page } = person
    const wid = personalWorkspace(person.me)
    const api = page.request
    for (const title of ['Board one', 'Board two']) {
      const res = await api.post(`/api/workspaces/${wid}/boards`, { headers: ORIGIN, data: { title } })
      expect(res.status()).toBe(201)
    }
    await openDashboard(page, wid)
    const toggle = page.getByTestId('view-toggle')
    await expect(toggle).toHaveAttribute('data-view', 'grid')
    await expect(mainGrid(page)).toHaveAttribute('data-view', 'grid')
    await toggle.locator('[data-view="list"]').click()
    await expect(toggle).toHaveAttribute('data-view', 'list')
    await expect(toggle.locator('[data-view="list"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(mainGrid(page)).toHaveAttribute('data-view', 'list')
    await expect(page.getByTestId('board-card').first()).toHaveClass(/dr-bcard--row/)
    await page.reload()
    await expect(page.getByTestId('view-toggle')).toHaveAttribute('data-view', 'list')
    await expect(mainGrid(page)).toHaveAttribute('data-view', 'list')
    await page.getByTestId('nav-all').click()
    await expect(mainGrid(page)).toHaveAttribute('data-view', 'list')
    await page.getByTestId('view-toggle').locator('[data-view="grid"]').click()
    await page.reload()
    await expect(mainGrid(page)).toHaveAttribute('data-view', 'grid')
    // DSH-06: Ctrl+E jumps to board search from anywhere on the dashboard.
    await page.getByTestId('dashboard-title').click()
    await expect(page.getByTestId('dashboard-search')).not.toBeFocused()
    await page.keyboard.press('Control+e')
    await expect(page.getByTestId('dashboard-search')).toBeFocused()
    await page.keyboard.type('two')
    await expect(page.getByTestId('board-card')).toHaveCount(1)
    await expect(page.getByTestId('board-card-title')).toHaveText('Board two')
  } finally {
    await person.context.close()
  }
})

// ---- DSH-02: card menu, duplicate, move, details, share, copy link; import ------------------------

test('card menu: the full action list, a first-row menu stays above the next row, and duplicate / move / details / share / copy link work', async ({
  browser,
}, testInfo) => {
  const person = await signedInContext(browser, freshHandle('max'), { name: 'Max Ferreira' })
  try {
    const { page, context } = person
    const wid = personalWorkspace(person.me)
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: WEB_URL })
    const ids: string[] = []
    for (const title of ['Launch plan', 'Shot list', 'Client review', 'Moodboard', 'Casting', 'Budget']) {
      const res = await page.request.post(`/api/workspaces/${wid}/boards`, {
        headers: ORIGIN,
        data: { title },
      })
      expect(res.status()).toBe(201)
      ids.push(((await res.json()) as { id: string }).id)
    }
    const project = (await (
      await page.request.post(`/api/workspaces/${wid}/projects`, {
        headers: ORIGIN,
        data: { name: 'Acme spring' },
      })
    ).json()) as { id: string; name: string }

    // The source board has content and is shared with the workspace: the copy keeps the first only.
    const source = ids[0] ?? ''
    await page.goto(`/b/${source}`)
    await waitForBoard(page)
    await addNote(page, 'shape:launch-note', 'Launch on Tuesday')
    const patched = await page.request.patch(`/api/boards/${source}`, {
      headers: ORIGIN,
      data: { visibility: 'workspace_edit' },
    })
    expect(patched.status()).toBe(200)

    await openDashboard(page, wid)
    await expect(page.getByTestId('board-card')).toHaveCount(6)

    await test.step('the menu lists every action, in order', async () => {
      expect(await menuActions(mainCard(page, source))).toEqual(MENU_ORDER)
    })

    let dupId = ''
    await test.step('a first-row card menu paints above the second row: Duplicate… opens its dialog, not the board below', async () => {
      const boxes = await page.getByTestId('board-card').evaluateAll((els) =>
        els.map((e) => {
          const r = e.getBoundingClientRect()
          return { id: e.getAttribute('data-board-id') ?? '', x: r.x, y: r.y, w: r.width, h: r.height }
        }),
      )
      // Rows by top edge, a few px apart at most: a hovered card lifts by 1 px, so exact y values would
      // split the first row in two.
      const rows: number[] = []
      for (const y of boxes.map((b) => b.y).sort((a, b) => a - b))
        if (!rows.length || y - (rows.at(-1) ?? 0) > 8) rows.push(y)
      expect(rows.length).toBeGreaterThanOrEqual(2)
      const inRow = (b: { y: number }, top: number | undefined) =>
        top !== undefined && Math.abs(b.y - top) <= 8
      const firstRow = boxes.filter((b) => inRow(b, rows[0]))
      const secondRow = boxes.filter((b) => inRow(b, rows[1]))
      // The first-row card whose Duplicate item lands on top of a second-row card.
      let target: { card: string; under: string; x: number; y: number } | null = null
      for (const b of firstRow) {
        const card = mainCard(page, b.id)
        await card.getByTestId('board-card-menu').click()
        const item = card.locator('[role="menuitem"][data-action="duplicate"]')
        const box = await item.boundingBox()
        if (!box) throw new Error('menu item has no box')
        const x = box.x + box.width / 2
        const y = box.y + box.height / 2
        const under = secondRow.find((s) => x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h)
        if (under) {
          target = { card: b.id, under: under.id, x, y }
          break
        }
        await page.keyboard.press('Escape')
      }
      if (!target) throw new Error(`no first-row menu overlaps the second row: ${JSON.stringify(boxes)}`)
      // What the pointer hits at that spot is the menu item, not the card underneath.
      const hit = await page.evaluate(
        ({ x, y }) =>
          document.elementFromPoint(x, y)?.closest('[role="menuitem"]')?.getAttribute('data-action'),
        target,
      )
      expect(hit).toBe('duplicate')
      await capture('card-menu-over-next-row.png', page, testInfo)
      const before = page.url()
      await page.mouse.click(target.x, target.y)
      await expect(page.getByTestId('duplicate-dialog')).toBeVisible()
      expect(page.url()).toBe(before)
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('duplicate-dialog')).toHaveCount(0)
    })

    await test.step('duplicate: "<title> (copy)" prefilled; the copy is private and has the content', async () => {
      await chooseFromMenu(mainCard(page, source), 'duplicate')
      const dialog = page.getByTestId('duplicate-dialog')
      await expect(dialog.getByTestId('duplicate-title')).toHaveValue('Launch plan (copy)')
      await expect(dialog.getByTestId('duplicate-keep-sharing')).not.toBeChecked()
      await dialog.getByTestId('duplicate-submit').click()
      await expect(dialog).toHaveCount(0)
      await expect(toast(page, 'Duplicated as “Launch plan (copy)”')).toBeVisible()
      await expect(page.getByTestId('board-card')).toHaveCount(7)
      const boards = (await (await page.request.get(`/api/workspaces/${wid}/boards`)).json()) as {
        boards: { id: string; title: string; visibility: string; role: string }[]
      }
      const copy = boards.boards.find((b) => b.title === 'Launch plan (copy)')
      expect(copy).toMatchObject({ visibility: 'private', role: 'owner' })
      dupId = copy?.id ?? ''
      await expect(mainCard(page, dupId)).toBeVisible()
      await mainCard(page, dupId).getByRole('link').click()
      await waitForBoard(page)
      await expect(page.getByTestId('board-title')).toHaveText('Launch plan (copy)')
      await expect
        .poll(() => read(page, (ed) => ed.getCurrentPageShapes().filter((s) => s.type === 'note').length))
        .toBe(1)
      await page.goBack()
      await expect(page.getByTestId('dashboard')).toBeVisible()
    })

    await test.step('duplicate with "keep sharing settings": the copy keeps the workspace access', async () => {
      await chooseFromMenu(mainCard(page, source), 'duplicate')
      const dialog = page.getByTestId('duplicate-dialog')
      await dialog.getByTestId('duplicate-title').fill('Launch plan (team copy)')
      await dialog.getByTestId('duplicate-keep-sharing').check()
      await dialog.getByTestId('duplicate-submit').click()
      await expect(dialog).toHaveCount(0)
      await expect(toast(page, 'Duplicated as “Launch plan (team copy)”')).toBeVisible()
      await expect(page.getByTestId('board-card')).toHaveCount(8)
      const boards = (await (await page.request.get(`/api/workspaces/${wid}/boards`)).json()) as {
        boards: { title: string; visibility: string }[]
      }
      expect(boards.boards.find((b) => b.title === 'Launch plan (team copy)')?.visibility).toBe(
        'workspace_edit',
      )
    })

    await test.step('move to project: the board is filed under the project', async () => {
      const target = ids[1] ?? ''
      await chooseFromMenu(mainCard(page, target), 'move')
      const dialog = page.getByTestId('move-dialog')
      await expect(dialog.getByTestId('move-submit')).toBeDisabled()
      await dialog.getByTestId('move-project').selectOption(project.id)
      await dialog.getByTestId('move-submit').click()
      await expect(dialog).toHaveCount(0)
      await expect(toast(page, '“Shot list” moved to Acme spring')).toBeVisible()
      const detail = (await (await page.request.get(`/api/boards/${target}`)).json()) as {
        board: { projectId: string | null }
      }
      expect(detail.board.projectId).toBe(project.id)
      await page.locator(`[data-testid="project-item"][data-project-id="${project.id}"] a`).first().click()
      await expect(page.getByTestId('dashboard-title')).toHaveText('Acme spring')
      await expect(page.getByTestId('board-card')).toHaveCount(1)
      await expect(mainCard(page, target)).toBeVisible()
      await page.getByTestId('nav-recent').click()
      await expect(page.getByTestId('board-card')).toHaveCount(8)
    })

    await test.step('details and share open from the menu', async () => {
      await chooseFromMenu(mainCard(page, source), 'details')
      const details = page.getByTestId('board-details')
      await expect(details).toBeVisible()
      await expect(details.getByTestId('board-details-owners')).toHaveText('Max Ferreira')
      await expect(details).toContainText('Everyone in the workspace can edit')
      await page.keyboard.press('Escape')
      await expect(details).toHaveCount(0)

      await chooseFromMenu(mainCard(page, source), 'share')
      await expect(shareDialog(page)).toBeVisible()
      await expect(shareDialog(page).getByTestId('share-workspace-name')).toHaveText(
        "Max Ferreira's workspace",
      )
      await expect(shareDialog(page).getByTestId('visibility-select')).toHaveValue('workspace_edit')
      await expect(memberRow(page, person.me.user.id)).toHaveAttribute('data-role', 'owner')
      await closeShare(page)
    })

    await test.step('copy link puts the board URL on the clipboard', async () => {
      await chooseFromMenu(mainCard(page, dupId), 'copy-link')
      await expect(toast(page, 'Board link copied', 'app-toast')).toBeVisible()
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${WEB_URL}/b/${dupId}`)
    })
  } finally {
    await person.context.close()
  }
})

test('import: an exported .json becomes a new board with its content; a non-JSON file or other JSON is refused with a clear message', async ({
  browser,
}, testInfo) => {
  const person = await signedInContext(browser, freshHandle('ivy'), { name: 'Ivy Park' })
  try {
    const { page } = person
    const wid = personalWorkspace(person.me)
    const created = await page.request.post(`/api/workspaces/${wid}/boards`, {
      headers: ORIGIN,
      data: { title: 'Pitch v2' },
    })
    const sourceId = ((await created.json()) as { id: string }).id
    await page.goto(`/b/${sourceId}`)
    await waitForBoard(page)
    await addNote(page, 'shape:pitch-note', 'Open with the client quote')

    // The file exactly as the Export .json button downloads it (name from Content-Disposition).
    const exported = await page.request.get(`/api/boards/${sourceId}/export`)
    expect(exported.status()).toBe(200)
    const disposition = exported.headers()['content-disposition'] ?? ''
    const fileName = /filename="([^"]+)"/.exec(disposition)?.[1] ?? ''
    expect(fileName).toBe('Pitch v2.lobby.json')
    const file = testInfo.outputPath(fileName)
    writeFileSync(file, await exported.body())

    await openDashboard(page, wid)
    await page.getByTestId('import-board-file').setInputFiles(file)
    await expect(toast(page, 'Imported “Pitch v2”')).toBeVisible()
    await expect(page.getByTestId('board-card')).toHaveCount(2)
    const boards = (await (await page.request.get(`/api/workspaces/${wid}/boards`)).json()) as {
      boards: { id: string; title: string; visibility: string }[]
    }
    const imported = boards.boards.find((b) => b.id !== sourceId)
    expect(imported).toMatchObject({ title: 'Pitch v2', visibility: 'private' })
    await mainCard(page, imported?.id ?? '')
      .getByRole('link')
      .click()
    await waitForBoard(page)
    await expect
      .poll(() =>
        read(page, (ed) =>
          ed
            .getCurrentPageShapes()
            .filter((s) => s.type === 'note')
            .map((s) => JSON.stringify(s.props.richText)),
        ),
      )
      .toEqual([JSON.stringify(richText('Open with the client quote'))])

    await openDashboard(page, wid)
    await page.getByTestId('import-board-file').setInputFiles({
      name: 'moodboard.png',
      mimeType: 'image/png',
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
    })
    await expect(toast(page, 'not a Lobby board export', 'app-toast')).toBeVisible()
    // JSON that is not a board archive: the server refuses it and says why.
    await page.getByTestId('import-board-file').setInputFiles({
      name: 'settings.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ theme: 'dark' })),
    })
    await expect(toast(page, "This file can't be imported", 'app-toast')).toBeVisible()
    await expect(page.getByTestId('board-card')).toHaveCount(2)
    const after = (await (await page.request.get(`/api/workspaces/${wid}/boards`)).json()) as {
      boards: unknown[]
    }
    expect(after.boards).toHaveLength(2)
  } finally {
    await person.context.close()
  }
})

test('trash explains what happens to deleted boards', async ({ browser }) => {
  const person = await signedInContext(browser, freshHandle('tom'), { name: 'Tom Reyes' })
  try {
    const wid = personalWorkspace(person.me)
    await openDashboard(person.page, wid, 'trash')
    await expect(person.page.getByTestId('trash-note')).toContainText('Deleted boards stay here')
    await expect(person.page.getByTestId('trash-note')).toContainText('until an owner restores them')
    await openDashboard(person.page, wid)
    await expect(person.page.getByTestId('trash-note')).toHaveCount(0)
  } finally {
    await person.context.close()
  }
})

// ---- PRS-03: the sharing badge ---------------------------------------------------------------------

test('share badge: Private, then Workspace: edit, then Link: comment · until <date>, live for another viewer; clicking it opens the Share dialog', async ({
  board,
  users,
  session,
}, testInfo) => {
  const aliceApi = await users.api('alice')
  const a = await session('alice')
  const b = await session('bob')
  const badgeA = a.page.getByTestId('share-badge')
  const badgeB = b.page.getByTestId('share-badge')
  for (const badge of [badgeA, badgeB]) {
    await expect(badge).toHaveAttribute('data-kind', 'private')
    await expect(badge).toHaveText('Private')
  }

  await test.step('the badge opens the Share dialog; workspace edit access shows as "Workspace: edit"', async () => {
    await badgeA.click()
    await expect(shareDialog(a.page)).toBeVisible()
    await shareDialog(a.page).getByTestId('visibility-select').selectOption('workspace_edit')
    await expect(badgeA).toHaveText('Workspace: edit')
    await expect(badgeA).toHaveAttribute('data-kind', 'workspace')
    expect((await shareState(aliceApi, board)).visibility).toBe('workspace_edit')
    // bob's header follows without a reload.
    await expect(badgeB).toHaveText('Workspace: edit', { timeout: 10_000 })
  })

  await test.step('a review link leads the badge: "Link: comment · until <expiry>"', async () => {
    await shareDialog(a.page).getByTestId('review-link-create').click()
    await expect(shareDialog(a.page).getByTestId('review-link-row')).toHaveCount(1)
    const link = (await invitations(aliceApi, board)).find((i) => i.kind === 'review')
    expect(link).toBeDefined()
    const until = await shortDateInPage(a.page, link?.expiresAt ?? '')
    await expect(badgeA).toHaveText(`Link: comment · until ${until}`)
    await expect(badgeA).toHaveAttribute('data-kind', 'link')
    await expect(badgeB).toHaveText(`Link: comment · until ${until}`, { timeout: 10_000 })
    await closeShare(a.page)
    await capture('share-badge-link.png', a.page, testInfo)
  })

  await test.step('bob (not a manager) opens the read-only Share dialog from the badge', async () => {
    await badgeB.click()
    await expect(shareDialog(b.page)).toBeVisible()
    await expect(shareDialog(b.page).getByTestId('share-invite-input')).toHaveCount(0)
    await expect(shareDialog(b.page)).toContainText('Only board owners can change who has access.')
    await expect(shareDialog(b.page).getByTestId('visibility-select')).toBeDisabled()
  })
})

// ---- PRS-02: invites -----------------------------------------------------------------------------

test('invite: @bob gets editor access at once; an email address gets a one-time commenter link (no email sent) that the owner can revoke', async ({
  board,
  users,
  session,
  browser,
}) => {
  const aliceApi = await users.api('alice')
  const bob = await users.get('bob')
  const a = await session('alice')
  await openShareFromButton(a.page)
  const dialog = shareDialog(a.page)

  await test.step('@bob is a Dev Studio member: invited as editor right away', async () => {
    await dialog.getByTestId('share-invite-input').fill('@bob')
    await expect(dialog.getByTestId('share-invite-hint')).toHaveText(
      'Bob Chen is in Dev Studio: they get access right away.',
    )
    await expect(dialog.getByTestId('share-invite-role')).toHaveValue('editor')
    await expect(dialog.getByTestId('share-invite-submit')).toHaveText('Invite')
    await dialog.getByTestId('share-invite-submit').click()
    await expect(memberRow(a.page, bob.id)).toHaveAttribute('data-role', 'editor')
    await expect(memberRow(a.page, bob.id)).toHaveAttribute('data-source', 'grant')
    await expect(dialog.getByTestId('share-invite-notice')).toHaveText('Bob Chen can now open this board.')
    const members = await aliceApi.members(board)
    expect(members.find((m) => m.user.id === bob.id)).toMatchObject({ role: 'editor', source: 'grant' })
  })

  await test.step('bob opens the board as an editor', async () => {
    const b = await session('bob', { role: null })
    await expect(b.page.getByTestId('readonly-pill')).toHaveCount(0)
    expect(await read(b.page, (ed) => ed.getIsReadonly())).toBe(false)
  })

  let token = ''
  await test.step('pat@client.example defaults to commenter and gets a link to send (no email is sent)', async () => {
    await dialog.getByTestId('share-invite-input').fill('pat@client.example')
    await expect(dialog.getByTestId('share-invite-role')).toHaveValue('commenter')
    await expect(dialog.getByTestId('share-invite-hint')).toContainText('Lobby does not send email')
    await expect(dialog.getByTestId('share-invite-submit')).toHaveText('Create invite link')
    await dialog.getByTestId('share-invite-submit').click()
    const link = dialog.getByTestId('share-invite-link')
    await expect(link).toHaveValue(new RegExp(`^${WEB_URL}/invite/[A-Za-z0-9_-]{43}$`))
    token = inviteToken(await link.inputValue())
    await expect(dialog.getByTestId('share-invite-result')).toContainText('no email is sent')
    await expect(dialog.getByTestId('share-invite-result')).toContainText('pat@client.example')
    // Domain access: the link is locked to that address.
    await expect(dialog.getByTestId('share-invite-lock-note')).toContainText(
      'Only pat@client.example can use this link, once, until',
    )
    await expect(dialog.getByTestId('share-invite-lock-note')).toContainText(
      'Anyone else who opens it is turned away.',
    )
    const pending = await invitations(aliceApi, board)
    expect(pending).toEqual([expect.objectContaining({ kind: 'invite', role: 'commenter', uses: 0 })])
    expect((await aliceApi.fetch('GET', `/api/invitations/${token}`)).status()).toBe(200)
  })

  await test.step('the pending link is listed and revoking it makes the link answer 410', async () => {
    // DANA-03: one-time invite links are under "More ways to share", whose summary counts them.
    await expect(dialog.getByTestId('share-more-summary')).toHaveText('1 unused invite link')
    await openMoreWaysToShare(a.page)
    const row = dialog.getByTestId('invitation-row')
    await expect(row).toHaveCount(1)
    await expect(row).toContainText('Can comment')
    await row.getByTestId('invitation-revoke').click()
    await expect(row).toHaveCount(0)
    expect(await invitations(aliceApi, board)).toEqual([])
    const visitor = await browser.newContext()
    try {
      expect((await visitor.request.get(`${WEB_URL}/api/invitations/${token}`)).status()).toBe(410)
      const page = await visitor.newPage()
      await page.goto(`/invite/${token}`)
      await expect(page.getByTestId('invite-invalid')).toContainText('This invitation is no longer valid')
    } finally {
      await visitor.close()
    }
  })
})

// ---- PRS-04: access requests ---------------------------------------------------------------------

test('request access: dave asks for edit from the no-access screen, alice sees it (notification, badge, Share dialog) and approves, and dave’s page opens the board', async ({
  board,
  users,
  session,
  browser,
}, testInfo) => {
  const aliceApi = await users.api('alice')
  const a = await session('alice')
  await edit(a.page, (ed) => ed.createShape({ id: 'shape:brief', type: 'note', x: 100, y: 100 }))
  const dave = await signedInContext(browser, 'dave')
  try {
    const d = dave.page
    await test.step('dave (a Dev Studio member without access) sees the request form', async () => {
      await d.goto(`/b/${board}`)
      await expect(d.getByTestId('no-access')).toContainText("You don't have access to this board")
      await expect(d.getByTestId('access-request-form')).toBeVisible()
      const roles = await d.getByTestId('access-request-role').locator('option').allTextContents()
      expect(roles).toEqual(['Edit', 'Comment', 'View'])
      // Someone who never had access starts from Comment (PRI-16).
      await expect(d.getByTestId('access-request-role')).toHaveValue('commenter')
      await d.getByTestId('access-request-role').selectOption('editor')
      await d.getByTestId('access-request-message').fill('I need to add the storyboard notes')
      await d.getByTestId('access-request-button').click()
      await expect(d.getByTestId('access-request-status')).toContainText('Edit access requested just now')
    })

    await test.step('alice is told: an access_request notification, a badge count and a request row', async () => {
      await expect
        .poll(async () =>
          (await notifications(aliceApi)).some(
            (n) => n.kind === 'access_request' && n.boardId === board && n.actor?.id === dave.me.user.id,
          ),
        )
        .toBe(true)
      const badge = a.page.getByTestId('share-badge')
      await expect(badge).toHaveAttribute('data-requests', '1', { timeout: 10_000 })
      const pending = await accessRequests(aliceApi, board)
      expect(pending).toEqual([
        expect.objectContaining({
          user: expect.objectContaining({ id: dave.me.user.id }),
          roleRequested: 'editor',
          message: 'I need to add the storyboard notes',
          status: 'pending',
        }),
      ])
      await badge.click()
      const row = requestRow(a.page, dave.me.user.id)
      await expect(row).toContainText('Asks to edit')
      await expect(row).toContainText('I need to add the storyboard notes')
      await expect(row.getByTestId('access-request-grant-role')).toHaveValue('editor')
      await capture('access-request-row.png', a.page, testInfo)
    })

    await test.step('approve: dave’s waiting page opens the board by itself within 10 s', async () => {
      const started = Date.now()
      await requestRow(a.page, dave.me.user.id).getByTestId('access-request-approve').click()
      await expect(requestRow(a.page, dave.me.user.id)).toHaveCount(0)
      await expect(memberRow(a.page, dave.me.user.id)).toHaveAttribute('data-role', 'editor')
      await d.waitForFunction(() => window.editor !== undefined, undefined, { timeout: 10_000 })
      const ms = Date.now() - started
      testInfo.annotations.push({ type: 'approval latency', description: `${ms} ms (target < 10000 ms)` })
      console.log(`[dashboard-share] access approval -> dave sees the board: ${ms} ms`)
      expect(ms).toBeLessThan(10_000)
      await waitForBoard(d)
      await expect(d.getByTestId('readonly-pill')).toHaveCount(0)
      await expect.poll(() => getShape(d, 'shape:brief').then((s) => s?.type ?? null)).toBe('note')
      await expect(a.page.getByTestId('share-badge')).toHaveAttribute('data-requests', '0')
      expect(await accessRequests(aliceApi, board)).toEqual([])
    })
  } finally {
    await dave.context.close()
  }
})

test('request access variants: a request shows up live in the open Share dialog; a denied request leaves no access; a board id that does not exist gets the same screen and the same API answer', async ({
  board,
  users,
  session,
  browser,
}) => {
  const aliceApi = await users.api('alice')
  const a = await session('alice')
  // alice already has the Share dialog open when the request comes in.
  await openShareFromButton(a.page)
  await expect(shareDialog(a.page).getByTestId('access-request-list')).toHaveCount(0)
  const requester = await signedInContext(browser, freshHandle('nia'), { name: 'Nia Brooks' })
  try {
    const p = requester.page
    await p.goto(`/b/${board}`)
    await p.getByTestId('access-request-role').selectOption('commenter')
    await p.getByTestId('access-request-button').click()
    await expect(p.getByTestId('access-request-status')).toContainText('Comment access requested')

    await test.step('alice denies: the request disappears and nobody gets access', async () => {
      const row = requestRow(a.page, requester.me.user.id)
      await expect(row).toContainText('Asks to comment', { timeout: 10_000 })
      await expect(a.page.getByTestId('share-badge')).toHaveAttribute('data-requests', '1')
      await row.getByTestId('access-request-deny').click()
      await expect(row).toHaveCount(0)
      await expect(memberRow(a.page, requester.me.user.id)).toHaveCount(0)
      expect(await accessRequests(aliceApi, board)).toEqual([])
      expect((await p.request.get(`/api/boards/${board}`)).status()).toBe(404)
      await p.reload()
      await expect(p.getByTestId('no-access')).toBeVisible()
      await expect(a.page.getByTestId('share-badge')).toHaveAttribute('data-requests', '0')
    })

    await test.step('a board id that does not exist: the same no-access screen and the same 202 answer', async () => {
      const missing = 'b-0000000000'
      const realScreen = await p.getByTestId('no-access').innerText()
      await p.goto(`/b/${missing}`)
      await expect(p.getByTestId('access-request-form')).toBeVisible()
      // The page only differs by what it remembered sending for the real board.
      const fresh = await signedInContext(browser, freshHandle('oto'), { name: 'Oto Varga' })
      try {
        await fresh.page.goto(`/b/${board}`)
        await expect(fresh.page.getByTestId('access-request-form')).toBeVisible()
        const onReal = await fresh.page.getByTestId('no-access').innerText()
        await fresh.page.goto(`/b/${missing}`)
        await expect(fresh.page.getByTestId('access-request-form')).toBeVisible()
        expect(await fresh.page.getByTestId('no-access').innerText()).toBe(onReal)
        const answers = []
        for (const id of [board, missing]) {
          const res = await fresh.page.request.post(`/api/boards/${id}/access-requests`, {
            headers: ORIGIN,
            data: { role: 'viewer' },
          })
          answers.push({ status: res.status(), body: await res.text() })
        }
        expect(answers[1]).toEqual(answers[0])
        expect(answers[0]).toEqual({ status: 202, body: JSON.stringify({ status: 'sent' }) })
      } finally {
        await fresh.context.close()
      }
      await p.getByTestId('access-request-button').click()
      await expect(p.getByTestId('access-request-status')).toContainText('access requested')
      expect(realScreen).toContain("You don't have access to this board")
    })
  } finally {
    await requester.context.close()
  }
})

test('a viewer asks for edit from the Share dialog; after alice approves, the read-only pill goes away within 15 s', async ({
  board,
  users,
  session,
}, testInfo) => {
  const aliceApi = await users.api('alice')
  const b = await session('bob', { role: 'viewer' })
  const a = await session('alice')
  await expect(b.page.getByTestId('readonly-pill')).toHaveAttribute('data-role', 'viewer')

  await test.step('bob: "Need more access?" offers Edit and Comment', async () => {
    await openShareFromButton(b.page)
    const dialog = shareDialog(b.page)
    await expect(dialog.getByRole('heading', { name: 'Need more access?' })).toBeVisible()
    const options = await dialog.getByTestId('access-request-role').locator('option').allTextContents()
    expect(options).toEqual(['Edit', 'Comment'])
    await expect(dialog.getByTestId('access-request-button')).toHaveText('Request edit access')
    await dialog.getByTestId('access-request-button').click()
    await expect(dialog.getByTestId('access-request-status')).toContainText('Edit access requested just now')
    // The server remembers it for bob too (he can view the board, so he may ask about his own request).
    await closeShare(b.page)
    await openShareFromButton(b.page)
    await expect(shareDialog(b.page).getByTestId('access-request-status')).toContainText(
      'Edit access requested',
    )
  })

  await test.step('alice approves; bob becomes an editor without reloading', async () => {
    await expect(a.page.getByTestId('share-badge')).toHaveAttribute('data-requests', '1', { timeout: 10_000 })
    await openShareFromButton(a.page)
    const started = Date.now()
    await requestRow(a.page, b.id).getByTestId('access-request-approve').click()
    await expect(memberRow(a.page, b.id)).toHaveAttribute('data-role', 'editor')
    await expect(b.page.getByTestId('readonly-pill')).toHaveCount(0, { timeout: 15_000 })
    const ms = Date.now() - started
    testInfo.annotations.push({ type: 'upgrade latency', description: `${ms} ms (target < 15000 ms)` })
    console.log(`[dashboard-share] edit approval -> read-only pill gone: ${ms} ms`)
    expect(ms).toBeLessThan(15_000)
    await expect.poll(() => read(b.page, (ed) => ed.getIsReadonly())).toBe(false)
    await edit(b.page, (ed) => ed.createShape({ id: 'shape:by-bob', type: 'note', x: 300, y: 200 }))
    await expect.poll(() => getShape(a.page, 'shape:by-bob').then((s) => s?.type ?? null)).toBe('note')
    expect((await aliceApi.members(board)).find((m) => m.user.id === b.id)).toMatchObject({
      role: 'editor',
      source: 'grant',
    })
  })
})

// ---- PRS-02: ownership and removal notes ----------------------------------------------------------

test('transfer ownership: the new owner’s row says owner, the old owner becomes an editor, and the dialog switches to the non-manager view', async ({
  users,
  browser,
}) => {
  // bob (a plain Dev Studio member) owns this board through his own grant only.
  const bobApi = await users.api('bob')
  const daveUser = await users.get('dave')
  const bobUser = await users.get('bob')
  const boardId = (await bobApi.createBoard(users.devStudioId, `Bob's shot list ${freshHandle('t')}`)).id
  await bobApi.putMember(boardId, daveUser.id, 'editor')
  const bob = await signedInContext(browser, 'bob')
  try {
    const page = bob.page
    await page.goto(`/b/${boardId}`)
    await waitForBoard(page)
    await openShareFromButton(page)
    const dialog = shareDialog(page)
    await expect(dialog.getByTestId('share-invite-input')).toBeVisible()
    await expect(memberRow(page, bobUser.id)).toHaveAttribute('data-role', 'owner')
    await memberRow(page, daveUser.id).getByTestId('member-transfer').click()
    await expect(memberRow(page, daveUser.id).getByTestId('member-transfer-confirm')).toBeVisible()
    await expect(memberRow(page, daveUser.id)).toContainText(
      'Make Dave Okafor the owner? You become an editor.',
    )
    await memberRow(page, daveUser.id).getByTestId('member-transfer-confirm').click()
    await expect(memberRow(page, daveUser.id)).toHaveAttribute('data-role', 'owner')
    await expect(memberRow(page, bobUser.id)).toHaveAttribute('data-role', 'editor')
    await expect(dialog.getByTestId('share-invite-input')).toHaveCount(0)
    await expect(dialog).toContainText('Only board owners can change who has access.')
    await expect(dialog.getByTestId('member-transfer')).toHaveCount(0)

    const members = await bobApi.members(boardId)
    expect(members.find((m) => m.user.id === daveUser.id)).toMatchObject({ role: 'owner', source: 'grant' })
    expect(members.find((m) => m.user.id === bobUser.id)).toMatchObject({ role: 'editor', source: 'grant' })
    // The server enforces it: bob can no longer manage access.
    expect((await bobApi.fetch('GET', `/api/boards/${boardId}/invitations`)).status()).toBe(403)
    // bob's open board follows: reopening the dialog shows the non-manager view, not a broken manager one.
    await closeShare(page)
    await expect(page.locator('.dr-board')).toHaveAttribute('data-role', 'editor', { timeout: 15_000 })
    await openShareFromButton(page)
    await expect(shareDialog(page).getByTestId('share-invite-input')).toHaveCount(0)
    await expect(memberRow(page, daveUser.id)).toHaveAttribute('data-role', 'owner')
    await expect(shareDialog(page).getByTestId('share-error')).toHaveCount(0)
    await closeShare(page)

    // dave, in his own browser, now gets the manager view.
    const dave = await signedInContext(browser, 'dave')
    try {
      await dave.page.goto(`/b/${boardId}`)
      await waitForBoard(dave.page)
      await openShareFromButton(dave.page)
      await expect(shareDialog(dave.page).getByTestId('share-invite-input')).toBeVisible()
      await expect(memberRow(dave.page, daveUser.id)).toHaveAttribute('data-role', 'owner')
    } finally {
      await dave.context.close()
    }
  } finally {
    await bob.context.close()
  }
})

test('removal note: removing an explicit editor grant on a workspace_view board leaves bob a workspace viewer, live in his tab', async ({
  board,
  users,
  session,
}) => {
  const aliceApi = await users.api('alice')
  await setVisibility(aliceApi, board, 'workspace_view')
  const b = await session('bob', { role: 'editor' })
  await expect(b.page.getByTestId('readonly-pill')).toHaveCount(0)
  const a = await session('alice')
  await openShareFromButton(a.page)
  const row = memberRow(a.page, b.id)
  await expect(row).toHaveAttribute('data-role', 'editor')
  await expect(row).toHaveAttribute('data-source', 'grant')
  await expect(row.getByTestId('member-fallback')).toHaveText(
    'Removing their invite leaves “Can view” through the workspace.',
  )
  await row.getByTestId('member-remove').click()
  // PRI-21: asked first, and told what bob keeps.
  await expect(row.getByTestId('member-remove-question')).toHaveText(
    `Remove ${b.name}’s invite? Removing their invite leaves “Can view” through the workspace.`,
  )
  await row.getByTestId('member-remove-confirm').click()
  await expect(row).toHaveAttribute('data-role', 'viewer')
  await expect(row).toHaveAttribute('data-source', 'workspace')
  await expect(row.getByTestId('member-source')).toContainText('Everyone in Dev Studio can view')
  await expect(row.getByTestId('member-fallback')).toHaveCount(0)
  expect((await aliceApi.members(board)).find((m) => m.user.id === b.id)).toMatchObject({
    role: 'viewer',
    source: 'workspace',
  })
  // bob's open board turns read-only.
  await expect(b.page.getByTestId('readonly-pill')).toHaveAttribute('data-role', 'viewer', {
    timeout: 15_000,
  })
})

// ---- PRS-08: review links ------------------------------------------------------------------------

async function joinThroughReviewLink(
  page: Page,
  link: string,
  who: { handle: string; name: string },
  board: string,
) {
  await page.goto(link)
  await expect(page.getByTestId('invite-page')).toBeVisible()
  await expect(page.getByTestId('invite-role-label')).toHaveText('Can comment')
  await page.getByTestId('invite-signin').click()
  // PRI-16: the sign-in page says what it is for, and signing in accepts (no second click).
  await expect(page.getByTestId('signin-heading')).toContainText('Sign in to join “')
  await expect(page.getByTestId('signin-handle')).toBeFocused()
  await signInThroughUi(page, who)
  await expect(page).toHaveURL(new RegExp(`/b/${board}$`))
  await waitForBoard(page)
  await expect(page.getByTestId('readonly-pill')).toHaveAttribute('data-role', 'commenter')
}

test('review link: two outsiders join as commenters; revoking with "remove access" sends both to no-access within 15 s, and one asks back in', async ({
  users,
  browser,
}, testInfo) => {
  const aliceUser = await users.get('alice')
  const aliceApi = await users.api('alice')
  // alice's personal workspace: nobody else is a member, so both visitors are real outsiders.
  const boardId = (await aliceApi.createBoard(aliceUser.personalWorkspaceId, 'Client review')).id
  const alice = await signedInContext(browser, 'alice')
  const visitors = [
    { handle: 'carol', name: displayName('carol') },
    { handle: freshHandle('rita'), name: 'Rita Okoye' },
  ]
  const contexts = [alice.context]
  try {
    const a = alice.page
    await a.goto(`/b/${boardId}`)
    await waitForBoard(a)
    await openShareFromButton(a)
    const dialog = shareDialog(a)
    await expect(dialog.getByTestId('review-link-role')).toHaveValue('commenter')
    await expect(dialog.getByTestId('review-link-expiry')).toHaveValue('14')
    await dialog.getByTestId('review-link-create').click()
    const url = dialog.getByTestId('review-link-url')
    await expect(url).toHaveValue(new RegExp(`^${WEB_URL}/invite/[A-Za-z0-9_-]{43}$`))
    const link = await url.inputValue()
    const [stored] = await invitations(aliceApi, boardId)
    // DANA-03 / F3: "Share with a client" lets people join with just a name unless unticked; an
    // account still works ("Sign in instead", used below).
    expect(stored).toMatchObject({ kind: 'review', role: 'commenter', uses: 0, url: link, allowGuests: true })
    await expect(dialog.getByTestId('review-link-row')).toHaveAttribute('data-allow-guests', 'true')
    const days = (Date.parse(stored?.expiresAt ?? '') - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(13.9)
    expect(days).toBeLessThanOrEqual(14)
    // Review links never hand out edit rights; an edit link is a workshop link of 24 h at most.
    const refused = await aliceApi.fetch('POST', `/api/boards/${boardId}/review-links`, {
      role: 'editor',
      expiresInDays: 7,
    })
    expect(refused.status()).toBe(400)

    const pages: Page[] = []
    for (const v of visitors) {
      const context = await browser.newContext()
      contexts.push(context)
      const page = await context.newPage()
      await joinThroughReviewLink(page, link, v, boardId)
      pages.push(page)
    }

    await closeShare(a)
    await openShareFromButton(a)
    const row = shareDialog(a).getByTestId('review-link-row')
    await expect(row).toContainText('2 people joined')
    const carol = await users.get('carol')
    await expect(memberRow(a, carol.id)).toHaveAttribute('data-role', 'commenter')
    const until = await shortDateInPage(a, stored?.expiresAt ?? '')
    await expect(memberRow(a, carol.id).getByTestId('member-source')).toContainText(
      `Joined with a review link · until ${until}`,
    )
    await capture('review-link-joined.png', a, testInfo)

    const started = Date.now()
    await row.getByTestId('review-link-revoke').click()
    await expect(row.getByTestId('review-link-remove-access')).toBeChecked()
    await row.getByTestId('review-link-revoke-confirm').click()
    for (const page of pages) await expect(page.getByTestId('no-access')).toBeVisible({ timeout: 15_000 })
    const ms = Date.now() - started
    testInfo.annotations.push({ type: 'review-link revocation', description: `${ms} ms (target < 15000 ms)` })
    console.log(`[dashboard-share] review link revoked -> both visitors on no-access: ${ms} ms`)
    expect(ms).toBeLessThan(15_000)
    await expect(memberRow(a, carol.id)).toHaveCount(0)
    for (const page of pages) expect((await page.request.get(`/api/boards/${boardId}`)).status()).toBe(404)

    // carol's "no longer have access" screen lets her ask again; once alice approves, it opens the board.
    const [carolPage, ritaPage] = pages as [Page, Page]
    await expect(carolPage.getByTestId('no-access')).toContainText('You no longer have access to this board')
    await carolPage.getByTestId('access-request-role').selectOption('commenter')
    await carolPage.getByTestId('access-request-message').fill('The link stopped working')
    // Her previous role is preselected (PRI-16), and the screen no longer points at the dead link.
    await expect(carolPage.getByTestId('no-access')).not.toContainText('open the invite link')
    await carolPage.getByTestId('access-request-button').click()
    await expect(carolPage.getByTestId('access-request-status')).toContainText('Comment access requested')
    await closeShare(a)
    await expect(a.getByTestId('share-badge')).toHaveAttribute('data-requests', '1', { timeout: 10_000 })
    await openShareFromButton(a)
    await expect(requestRow(a, carol.id)).toContainText('The link stopped working')
    await requestRow(a, carol.id).getByTestId('access-request-approve').click()
    await expect(memberRow(a, carol.id)).toHaveAttribute('data-role', 'commenter')
    await carolPage.waitForFunction(() => window.editor !== undefined, undefined, { timeout: 10_000 })
    await waitForBoard(carolPage)
    await expect(carolPage.getByTestId('readonly-pill')).toHaveAttribute('data-role', 'commenter')
    // The other visitor did not ask and stays out.
    await expect(ritaPage.getByTestId('no-access')).toBeVisible()
  } finally {
    await Promise.all(contexts.map((c) => c.close()))
  }
})

test('review link revoked without removing access: carol keeps her access (reopening the link opens the board) and a new visitor gets "no longer valid" naming alice', async ({
  users,
  browser,
}) => {
  const aliceUser = await users.get('alice')
  const aliceApi = await users.api('alice')
  const boardId = (await aliceApi.createBoard(aliceUser.personalWorkspaceId, 'Rough cut v3')).id
  const alice = await signedInContext(browser, 'alice')
  const contexts = [alice.context]
  try {
    const a = alice.page
    await a.goto(`/b/${boardId}`)
    await waitForBoard(a)
    await openShareFromButton(a)
    await shareDialog(a).getByTestId('review-link-create').click()
    const link = await waitForValue(async () => {
      const v = await shareDialog(a)
        .getByTestId('review-link-url')
        .inputValue()
        .catch(() => '')
      return v || null
    })

    const context = await browser.newContext()
    contexts.push(context)
    const carolPage = await context.newPage()
    await joinThroughReviewLink(carolPage, link, { handle: 'carol', name: displayName('carol') }, boardId)

    await closeShare(a)
    await openShareFromButton(a)
    const row = shareDialog(a).getByTestId('review-link-row')
    await expect(row).toContainText('1 person joined')
    await row.getByTestId('review-link-revoke').click()
    await row.getByTestId('review-link-remove-access').uncheck()
    await row.getByTestId('review-link-revoke-confirm').click()
    await expect(row).toHaveCount(0)
    await expect(a.getByTestId('share-badge')).toHaveText('Private')

    // A newcomer with the same link: "no longer valid", and the API says 410.
    const newcomer = await browser.newContext()
    contexts.push(newcomer)
    const n = await newcomer.newPage()
    await n.goto(link)
    await expect(n.getByTestId('invite-invalid')).toContainText('This invitation is no longer valid')
    // PRI-04: it says whom to ask, and reveals nothing about the board.
    await expect(n.getByTestId('invite-invalid')).toContainText(`Ask ${displayName('alice')} for a new link.`)
    await expect(n.getByTestId('invite-invalid')).not.toContainText('Rough cut')
    await signInContext(newcomer, freshHandle('vic'), 'Vic Stone')
    await n.reload()
    await expect(n.getByTestId('invite-invalid')).toContainText(`Ask ${displayName('alice')} for a new link.`)
    expect(n.url()).toContain('/invite/')
    expect(
      (
        await newcomer.request.post(`${WEB_URL}/api/invitations/${inviteToken(link)}/accept`, {
          headers: ORIGIN,
        })
      ).status(),
    ).toBe(410)

    // carol still has her commenter access (the server says so, and her board stays open).
    const carol = await users.get('carol')
    await expect(memberRow(a, carol.id)).toHaveAttribute('data-role', 'commenter')
    expect((await carolPage.request.get(`/api/boards/${boardId}`)).status()).toBe(200)
    await carolPage.reload()
    await waitForBoard(carolPage)
    await expect(carolPage.getByTestId('readonly-pill')).toHaveAttribute('data-role', 'commenter')

    // PRI-04: reopening the old link is no dead end for carol, who still has access: it opens the board.
    await carolPage.goto(link)
    await expect(carolPage).toHaveURL(new RegExp(`/b/${boardId}$`), { timeout: 15_000 })
    await waitForBoard(carolPage)
    await expect(carolPage.getByTestId('readonly-pill')).toHaveAttribute('data-role', 'commenter')
  } finally {
    await Promise.all(contexts.map((c) => c.close()))
  }
})

// ---- platform: a separate sync origin (Render static sites cannot proxy WebSockets) ---------------

test.describe('separate sync origin', () => {
  let splitBuild = ''
  let pathBuild = ''
  test.beforeAll(async () => {
    test.setTimeout(180_000)
    // Two extra web builds (about a second each), served from WEB_URL by route interception (serveBuild).
    splitBuild = await buildWeb(`dist/${RUN_TAG}-split-origin`, { VITE_DRAFTROOM_SYNC_ORIGIN: SYNC_URL })
    pathBuild = await buildWeb(`dist/${RUN_TAG}-sync-path`, {
      VITE_DRAFTROOM_SYNC_ORIGIN: `${SYNC_URL}/sync`,
    })
  })
  test.afterAll(() => {
    for (const dir of [splitBuild, pathBuild]) if (dir) rmSync(dir, { recursive: true, force: true })
  })

  /** `handle` signed in on a context that serves `dir` as the web app, with `boardId` open. */
  async function openSplit(browser: Browser, dir: string, handle: string, boardId: string) {
    const person = await signedInContext(browser, handle)
    await serveBuild(person.context, dir)
    const sockets = recordSockets(person.page)
    await person.page.goto(`/b/${boardId}`)
    await waitForBoard(person.page)
    return { ...person, sockets }
  }

  test('board sockets go straight to the sync origin, which refuses a foreign page; edits survive a sync restart', async ({
    board,
    users,
    stack,
    browser,
  }) => {
    await users.grant(board, 'bob', 'editor')
    const socketBase = `ws://${HOST}:${SYNC_PORT}/connect/${board}?`
    const a = await openSplit(browser, splitBuild, 'alice', board)
    const b = await openSplit(browser, splitBuild, 'bob', board)
    const contexts = [a.context, b.context]
    try {
      await test.step('both are online through the sync origin; bob sees alice’s note', async () => {
        for (const p of [a, b]) {
          await expectConn(p.page, 'online')
          expect(p.sockets.length).toBeGreaterThan(0)
          for (const url of p.sockets) expect(url.startsWith(socketBase), url).toBe(true)
        }
        await edit(a.page, (ed) => ed.createShape({ id: 'shape:split-1', type: 'note', x: 100, y: 100 }))
        await expect.poll(() => getShape(b.page, 'shape:split-1').then((s) => s?.type ?? null)).toBe('note')
      })

      await test.step('a page on another origin, even with a valid ticket, is refused before the upgrade', async () => {
        const ticket = await (await users.api('alice')).ticket(board)
        const foreign = await browser.newContext()
        contexts.push(foreign)
        const foreignOrigin = `http://foreign.localhost:${WEB_PORT}`
        await allowLoopbackSockets(foreign, foreignOrigin)
        await foreign.route(`${foreignOrigin}/**`, (route) =>
          route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Not Draftroom</title>' }),
        )
        const page = await foreign.newPage()
        await page.goto(`${foreignOrigin}/`)
        const url = `${socketBase}${new URLSearchParams({ ticket: ticket.ticket, sessionId: 'foreign-page' })}`
        const outcome = await page.evaluate(
          (u) =>
            new Promise<string | number>((done) => {
              const ws = new WebSocket(u)
              ws.onopen = () => done('open')
              ws.onclose = (e) => done(e.code)
            }),
          url,
        )
        expect(outcome).toBe(1006)
        await expect
          .poll(() => stack.sync.logs())
          .toContain(`refused: Origin "${foreignOrigin}" is not in ALLOWED_ORIGINS`)
        expect(stack.sync.logs()).not.toContain(ticket.ticket)
      })

      await test.step('sync SIGKILL + restart: both reconnect to the sync origin and no acknowledged edit is lost', async () => {
        await edit(b.page, (ed) => ed.createShape({ id: 'shape:split-2', type: 'note', x: 400, y: 100 }))
        // Acknowledged: the server broadcast it to alice.
        await expect.poll(() => getShape(a.page, 'shape:split-2').then((s) => s !== null)).toBe(true)
        const before = a.sockets.length
        await stack.sync.kill()
        await expect(a.page.getByTestId('conn-status')).not.toHaveAttribute('data-state', 'online')
        await stack.sync.start()
        for (const p of [a, b]) await expectConn(p.page, 'online')
        expect(a.sockets.length).toBeGreaterThan(before)
        for (const p of [a, b])
          for (const url of p.sockets) expect(url.startsWith(socketBase), url).toBe(true)
        const c = await openSplit(browser, splitBuild, 'alice', board)
        contexts.push(c.context)
        await expect
          .poll(async () => [
            await getShape(c.page, 'shape:split-1'),
            await getShape(c.page, 'shape:split-2'),
          ])
          .toEqual([expect.objectContaining({ type: 'note' }), expect.objectContaining({ type: 'note' })])
      })
    } finally {
      await Promise.all(contexts.map((c) => c.close()))
    }
  })

  test('a sync origin with a path is reported once in the console and the board falls back to the same-origin socket', async ({
    board,
    browser,
  }) => {
    const person = await signedInContext(browser, 'alice')
    try {
      await serveBuild(person.context, pathBuild)
      const errors: string[] = []
      person.page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text())
      })
      const sockets = recordSockets(person.page)
      await person.page.goto(`/b/${board}`)
      await waitForBoard(person.page)
      await expectConn(person.page, 'online')
      expect(errors.filter((e) => e.includes('must be an origin only'))).toHaveLength(1)
      expect(sockets.length).toBeGreaterThan(0)
      for (const url of sockets)
        expect(url.startsWith(`ws://${HOST}:${WEB_PORT}/connect/${board}?`), url).toBe(true)
      await edit(person.page, (ed) => ed.createShape({ id: 'shape:fallback', type: 'note', x: 0, y: 0 }))
      await expect(person.page.getByTestId('conn-status')).toHaveAttribute('data-state', 'online')
    } finally {
      await person.context.close()
    }
  })
})
