// GAP PASS (browser-test gaps on the Excalidraw canvas): a board's STATUS on the new canvas, and DEMO 0:00.
//
//  - DEMO.md local checklist 9: "archived boards open read-only". The api maps an archived board to the
//    viewer role for everyone (apps/api/src/access.ts) and tells sync (`notifier.accessChanged`), but no
//    Excalidraw spec archives a board: here every open tab turns read-only, a fresh open is read-only and a
//    real drag changes nothing, and a restore makes it editable again.
//  - A board moved to the trash while people are on it: nobody can open a trashed board ("trashed boards
//    serve nothing"); the open tabs must lose it, as permissions-canvas shows for a removed grant.
//  - DEMO 0:00: "New board, pick Lobby tour, Create from Lobby tour" from the DASHBOARD (navigation-templates
//    covers the board page's picker and a hand-typed ?template=; the dashboard's dialog is the demo's path),
//    then 4:45 "Back to the dashboard. The board is in the list".
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw gaps-board-status
import type { Page } from '@playwright/test'
import {
  createNote,
  dragItem,
  expect,
  expectConverged,
  expectSaved,
  item,
  items,
  openCanvasSession,
  pushedOps,
  readOnly,
  saveState,
  test,
  waitForCanvas,
  waitForItem,
} from '../tests/support/canvas.ts'
import { mainCard, openDashboard, signedInContext } from '../tests/support/dashboard-share.ts'
import { noAccessScreen, pushCount } from '../tests/support/excalidraw.ts'

const TOUR_SECTIONS = [
  '1 · Welcome',
  '2 · Brainstorm',
  '3 · Plan',
  '4 · Mood board',
  '5 · Retro',
  '6 · Tips and shortcuts',
]

const place = async (page: Page, id: string) => {
  const e = await item(page, id)
  return e ? { x: Math.round(e.x), y: Math.round(e.y) } : null
}

/** The board's frames, left to right, by name. */
async function frameNames(page: Page): Promise<string[]> {
  return (await items(page))
    .filter((e) => e.type === 'frame')
    .sort((p, q) => p.x - q.x)
    .map((e) => (e as { name?: string | null }).name ?? '')
}

test('archived: every open tab turns read-only within 15 s (the owner too), a fresh open is read-only and a drag changes nothing; a restore makes it editable again, live', async ({
  canvasSession,
  users,
  browser,
  board,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const aliceApi = await users.api('alice')
  const note = await createNote(a.page, { x: 300, y: 240, text: 'Archive me' })
  await expectSaved(a.page)
  await waitForItem(b.page, note)
  expect(await readOnly(a.page)).toBe(false)
  expect(await readOnly(b.page)).toBe(false)

  await test.step('archive: both open tabs become read-only, with the pill', async () => {
    const res = await aliceApi.fetch('POST', `/api/boards/${board}/archive`)
    expect(res.status(), await res.text()).toBe(200)
    const started = Date.now()
    await expect.poll(() => readOnly(a.page), { timeout: 20_000 }).toBe(true)
    await expect.poll(() => readOnly(b.page), { timeout: 20_000 }).toBe(true)
    expect(Date.now() - started).toBeLessThan(15_000)
    await expect(a.page.getByTestId('readonly-pill')).toBeVisible()
    await expect(b.page.getByTestId('readonly-pill')).toBeVisible()
  })

  await test.step('a fresh open is read-only: a real drag moves nothing and pushes nothing', async () => {
    const fresh = await openCanvasSession(browser, board, await users.get('bob'))
    try {
      expect(await readOnly(fresh.page)).toBe(true)
      await expect(fresh.page.getByTestId('readonly-pill')).toBeVisible()
      const before = await place(fresh.page, note)
      await dragItem(fresh.page, note, { x: 90, y: 60 })
      await fresh.page.waitForTimeout(500)
      expect(await place(fresh.page, note)).toEqual(before)
      // nothing at all: neither the open (DEF-GAPS-1: creates of the server's own elements at base 0) nor the drag
      expect(await pushCount(fresh.page)).toBe(0)
      expect(await place(a.page, note)).toEqual(before)
    } finally {
      await fresh.context.close()
    }
  })

  await test.step('restore: the open tabs are editable again and bob’s drag lands for alice', async () => {
    const res = await aliceApi.fetch('POST', `/api/boards/${board}/restore`)
    expect(res.status(), await res.text()).toBe(200)
    await expect.poll(() => readOnly(a.page), { timeout: 20_000 }).toBe(false)
    await expect.poll(() => readOnly(b.page), { timeout: 20_000 }).toBe(false)
    await expect(b.page.getByTestId('readonly-pill')).toHaveCount(0)
    const before = (await place(b.page, note)) as { x: number; y: number }
    await dragItem(b.page, note, { x: 90, y: 60 })
    await expect
      .poll(async () => ((await place(b.page, note)) as { x: number }).x)
      .toBeGreaterThan(before.x + 40)
    await expectSaved(b.page)
    await expectConverged(b.page, [a.page])
  })
})

test('archived: nothing was changed, so the owner’s open tab pushes nothing again and never says "Change not saved" (DEF-GAPS-1)', async ({
  canvasSession,
  users,
  board,
}) => {
  // DEF-GAPS-1 (the gap pass, wave C; fixed in wave D, D2): the archive gives the owner a viewer ticket, and the
  // page then started a new session (a new engine core) on the same canvas; that core took the previous one's
  // copies for local creates and pushed them behind the room's cached reset snapshot (READ_ONLY: 'Change not
  // saved'). The core now never classifies the scene it starts on (apps/web/src/canvas/sync/core/start-scene.test.ts).
  // Since wave E (E2) a role change starts no new session at all: the room closes the tab's socket, the same
  // session reconnects with the viewer ticket, and its welcome carries the new role. Either way nothing is pushed.
  const a = await canvasSession('alice')
  await createNote(a.page, { x: 300, y: 240, text: 'Archive me' })
  await expectSaved(a.page)
  // pushes from here on, by time: it is the same session after the archive (a role change starts no new one), so
  // its push log still holds the note's creation
  const archivedAt = await a.page.evaluate(() => Date.now())
  const res = await (await users.api('alice')).fetch('POST', `/api/boards/${board}/archive`)
  expect(res.status(), await res.text()).toBe(200)
  await expect.poll(() => readOnly(a.page), { timeout: 20_000 }).toBe(true)
  // the tab reconnects under its new role: give it time to say anything it is going to say
  await a.page.waitForTimeout(2_000)
  expect((await saveState(a.page)).state, 'nothing changed: still Saved').toBe('saved')
  expect((await saveState(a.page)).lastReject, 'no change was refused').toBeNull()
  expect(
    (await pushedOps(a.page)).filter((p) => p.at >= archivedAt),
    'and nothing was sent',
  ).toEqual([])
})

test('trashed while open: both open tabs lose the board within 15 s and a fresh open is refused; after a restore from the trash the board opens with its content', async ({
  canvasSession,
  users,
  browser,
  board,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const aliceApi = await users.api('alice')
  const note = await createNote(a.page, { x: 300, y: 240, text: 'Trash and back' })
  await expectSaved(a.page)
  await waitForItem(b.page, note)

  await test.step('trash: the editor’s and the owner’s open tabs show the board is gone', async () => {
    const res = await aliceApi.fetch('POST', `/api/boards/${board}/trash`)
    expect(res.status(), await res.text()).toBe(200)
    const started = Date.now()
    await expect(noAccessScreen(b.page)).toBeVisible({ timeout: 15_000 })
    await expect(noAccessScreen(a.page)).toBeVisible({ timeout: 15_000 })
    expect(Date.now() - started).toBeLessThan(15_000)
    await expect(b.page.locator('[data-lobby-board-canvas]')).toHaveCount(0)
    await expect(a.page.locator('[data-lobby-board-canvas]')).toHaveCount(0)
  })

  await test.step('a fresh open by the owner is refused too', async () => {
    const fresh = await signedInContext(browser, 'alice')
    try {
      await fresh.page.goto(`/b/${board}`)
      await expect(noAccessScreen(fresh.page)).toBeVisible({ timeout: 15_000 })
      await expect(fresh.page.locator('[data-lobby-board-canvas]')).toHaveCount(0)
    } finally {
      await fresh.context.close()
    }
  })

  await test.step('restore from the trash: it opens again with its note', async () => {
    const res = await aliceApi.fetch('POST', `/api/boards/${board}/restore`)
    expect(res.status(), await res.text()).toBe(200)
    const fresh = await openCanvasSession(browser, board, await users.get('bob'))
    try {
      await waitForItem(fresh.page, note)
      expect(await readOnly(fresh.page)).toBe(false)
    } finally {
      await fresh.context.close()
    }
  })
})

test('DEMO 0:00 → 4:45: New board → Lobby tour → "Create from Lobby tour" opens the new canvas with the six frames, saved; a colleague sees them; Back to the dashboard lists the board', async ({
  browser,
  users,
}) => {
  const alice = await signedInContext(browser, 'alice')
  const aliceApi = await users.api('alice')
  let created = ''
  try {
    const page = alice.page
    await openDashboard(page, users.devStudioId)
    await page.getByTestId('create-board').click()
    const tour = page.locator('[data-testid="template-sample"][data-template-id="lobby-tour"]')
    await expect(tour).toBeVisible()
    await tour.click()
    const submit = page.getByTestId('create-board-submit')
    await expect(submit).toHaveText('Create from Lobby tour')
    await submit.click()

    await test.step('the board opens on the Excalidraw canvas with the tour’s six frames, saved, the parameter gone', async () => {
      await expect(page).toHaveURL(/\/b\/b-[0-9a-z]{10}/)
      created = new URL(page.url()).pathname.split('/')[2] ?? ''
      await waitForCanvas(page)
      await expect(page.getByTestId('lobby-board')).toHaveAttribute('data-engine', 'excalidraw')
      await expect.poll(() => frameNames(page), { timeout: 20_000 }).toEqual(TOUR_SECTIONS)
      await expectSaved(page)
      await expect(page).toHaveURL(new RegExp(`/b/${created}$`))
    })

    await test.step('a colleague given access sees the same six frames', async () => {
      const bob = await users.get('bob')
      await aliceApi.putMember(created, bob.id, 'editor')
      const b = await openCanvasSession(browser, created, bob)
      try {
        await expect.poll(() => frameNames(b.page), { timeout: 20_000 }).toEqual(TOUR_SECTIONS)
        await expectConverged(page, [b.page])
      } finally {
        await b.context.close()
      }
    })

    await test.step('4:45: Back to the dashboard, the board is in the list', async () => {
      await page.getByRole('link', { name: 'Back to Dev Studio' }).first().click()
      await expect(page.getByTestId('dashboard')).toBeVisible()
      await expect(mainCard(page, created)).toBeVisible()
    })
  } finally {
    await alice.context.close()
  }
})
