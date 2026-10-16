// Wave R, WS1: import from Miro, in a real browser against the real api, sync and preview worker, with the fake Miro
// (e2e/tests/support/miro.ts: Miro's documented answer shapes over the fixture boards; never the real Miro). What
// must hold:
//  - the dialog ("Beta"): the token in a password field, the board picker, the progress, the report; two boards, one
//    of every item type, become private boards of alice's: notes, a frame and its children, bound arrows with a
//    label, an image that loads (its file streamed into a version of the board), placeholders for what the API
//    cannot represent;
//  - a cancel removes the board in hand;
//  - pause, an api restart, then resume with the token again: done, no file downloaded twice;
//  - a token Miro refuses says so, and nothing is imported;
//  - the creator rules: a non-creator and a name-only guest are refused by the api;
//  - the browser never calls Miro: no request of the page leaves Lobby's own origins.
//
//   E2E_PORT_BASE=7720 pnpm exec playwright test excalidraw/r1-miro-import --project=chromium --workers=1   (from e2e/)
import type { Browser, BrowserContext, Locator, Page, Request } from '@playwright/test'
import { importJobPath, miroBoardsPath, miroImportPath } from '../../packages/contracts/src/index.ts'
import { signInContext } from '../tests/support/api.ts'
import { test as base, expect, items, waitForCanvas } from '../tests/support/canvas.ts'
import {
  FAKE_MIRO_TOKEN,
  type FakeMiro,
  MIRO_API_ENV,
  MIRO_MENU_STORAGE,
  RETRO_ID,
  resetFakeMiro,
  SPRINT_ID,
  startE2eFakeMiro,
} from '../tests/support/miro.ts'
import { API_URL, WEB_URL } from '../tests/support/ports.ts'
import type { Users } from '../tests/support/users.ts'
import { expectLoadedImage } from './media-kit.ts'

const test = base.extend<object, { miro: FakeMiro }>({
  miro: [
    async ({ stack: _ }, use) => {
      const fake = await startE2eFakeMiro()
      await use(fake)
      await fake.close()
    },
    { scope: 'worker' },
  ],
})

test.use({ viewport: { width: 1440, height: 900 }, apiEnv: MIRO_API_ENV })
test.describe.configure({ timeout: 240_000 })
test.beforeEach(({ miro }) => resetFakeMiro(miro))

/** Every request of the page that left Lobby's own origins (none may: the e2e network assertion). */
function foreignRequests(page: Page): string[] {
  const own = new Set([new URL(WEB_URL).origin, new URL(API_URL).origin])
  const foreign: string[] = []
  page.on('request', (r: Request) => {
    const url = new URL(r.url())
    if (url.protocol === 'data:' || url.protocol === 'blob:') return
    if (!own.has(url.origin)) foreign.push(r.url())
  })
  return foreign
}

interface Dashboard {
  context: BrowserContext
  page: Page
  foreign: string[]
}

/** Alice's dashboard (All boards) with the Import menu's "Import from Miro (beta)…" switched on (a dev-auth page's switches). */
async function aliceDashboard(browser: Browser, users: Users): Promise<Dashboard> {
  const context = await browser.newContext()
  await context.addInitScript((flags: Record<string, string>) => {
    for (const [k, v] of Object.entries(flags)) localStorage.setItem(k, v)
  }, MIRO_MENU_STORAGE)
  const alice = await users.get('alice')
  await signInContext(context, alice.handle, alice.name)
  const page = await context.newPage()
  const foreign = foreignRequests(page)
  await page.goto(`/w/${users.devStudioId}`)
  await page.getByTestId('nav-all').click()
  return { context, page, foreign }
}

async function openMiroDialog(page: Page): Promise<Locator> {
  await page.getByTestId('import-menu').click()
  await page.getByRole('menuitem', { name: 'Import from Miro (beta)…' }).click()
  const dialog = page.getByTestId('miro-import-dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

/** The token step, then the picker: `ids` checked, the import started. Returns the job's id. */
async function importBoards(
  page: Page,
  dialog: Locator,
  wid: string,
  ids: readonly string[],
): Promise<string> {
  await dialog.getByTestId('miro-token').fill(FAKE_MIRO_TOKEN)
  await dialog.getByTestId('miro-token-submit').click()
  await expect(dialog.getByTestId('miro-team')).toContainText('Fixture team')
  for (const id of ids)
    await dialog
      .locator(`[data-testid="miro-board-row"][data-board-id="${id}"] [data-testid="miro-board-check"]`)
      .check()
  const started = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith(miroImportPath(wid)),
  )
  await dialog.getByTestId('miro-start').click()
  const res = await started
  expect(res.status()).toBe(202)
  const { importId } = (await res.json()) as { importId: string }
  await expect(dialog.getByTestId('miro-progress')).toBeVisible()
  return importId
}

const holdFiles = (miro: FakeMiro) => {
  let open = () => {}
  miro.behaviour.holdFiles = new Promise<void>((r) => {
    open = r
  })
  return () => {
    miro.behaviour.holdFiles = null
    open()
  }
}

test('R1: two Miro boards, one of every item type, become private boards: notes, frames, bound arrows, an image that loads, placeholders', async ({
  browser,
  users,
  miro,
}) => {
  const d = await aliceDashboard(browser, users)
  const dialog = await openMiroDialog(d.page)

  await test.step('the dialog: Beta, a password field for the token, the steps to get one', async () => {
    await expect(dialog.getByTestId('miro-beta')).toBeVisible()
    await expect(dialog.getByTestId('miro-token')).toHaveAttribute('type', 'password')
    await expect(dialog.getByTestId('miro-token')).toHaveAttribute('autocomplete', 'off')
    await dialog.getByTestId('miro-token-help').locator('summary').click()
    await expect(dialog.getByTestId('miro-token-help')).toContainText('boards:read')
  })

  const importId = await importBoards(d.page, dialog, users.devStudioId, [SPRINT_ID, RETRO_ID])

  let boardId = ''
  await test.step('progress, then the report: counts, types, notes, comments stay in Miro', async () => {
    const report = dialog.getByTestId('miro-report')
    await expect(report).toBeVisible({ timeout: 120_000 })
    await expect(dialog.getByTestId('miro-board-report')).toHaveCount(2)
    await expect(dialog.locator('[data-testid="miro-board-report"][data-status="done"]')).toHaveCount(2)
    await expect(dialog.getByTestId('miro-summary').first()).toContainText(
      'of 33 items imported as native elements',
    )
    await expect(report).toContainText('Comments stay in Miro')
    await expect(dialog.getByTestId('miro-revoke')).toBeVisible()
    await expect(dialog.getByTestId('miro-report-csv')).toHaveAttribute(
      'href',
      `${importJobPath(importId)}/report.csv`,
    )
    const view = await d.page.evaluate(async (path) => (await fetch(path)).json(), importJobPath(importId))
    boardId = (view as { boards: { boardId: string }[] }).boards[0]?.boardId ?? ''
    expect(boardId).toMatch(/^[a-z0-9][a-z0-9_-]{2,63}$/)
  })

  await test.step('the files came from the files origin without the token; Miro only ever got it on its API origin', async () => {
    const files = miro.requests.filter((r) => r.origin === 'files')
    expect(files).toHaveLength(2)
    expect(files.every((r) => r.auth === 'none')).toBe(true)
    expect(miro.requests.filter((r) => r.origin === 'api').every((r) => r.auth === 'token')).toBe(true)
  })

  await test.step('the board opens on the canvas with what Miro had', async () => {
    await dialog.getByTestId('miro-open-board').first().click()
    await expect(d.page).toHaveURL(new RegExp(`/b/${boardId}$`))
    await waitForCanvas(d.page, 60_000)
    const all = (await items(d.page)) as unknown as Record<string, unknown>[]
    const of = (t: string) => all.filter((e) => e.type === t)
    expect(of('stickynote').length).toBe(4)
    expect(of('frame').map((f) => f.name)).toEqual(
      expect.arrayContaining(['Sprint 42', 'Not imported from Miro']),
    )
    const sprint = of('frame').find((f) => f.name === 'Sprint 42')
    expect(all.filter((e) => e.frameId === sprint?.id).length).toBeGreaterThan(5)
    const arrows = of('arrow')
    expect(arrows.length).toBe(5)
    expect(arrows.filter((a) => a.startBinding && a.endBinding).length).toBeGreaterThanOrEqual(4)
    const labelled = arrows.find((a) =>
      (a.boundElements as { type: string }[] | null)?.some((b) => b.type === 'text'),
    )
    const label = all.find((e) => e.type === 'text' && e.containerId === labelled?.id)
    expect(label?.originalText).toBe('next')
    const placeholders = all.filter(
      (e) => (e.customData as { lobby?: { kind?: string } } | undefined)?.lobby?.kind === 'placeholder',
    )
    expect(placeholders.length).toBe(5)
    const images = of('image')
    expect(images).toHaveLength(3)
    const picture = images.find(
      (e) => (e.customData as { lobby?: { file?: { kind?: string } } }).lobby?.file?.kind === 'image',
    )
    await expectLoadedImage(d.page, picture?.id as string, boardId, 90_000)
  })

  expect(d.foreign).toEqual([])
  await d.context.close()
})

test('R1: cancel mid-import removes the board in hand; nothing is left on the dashboard', async ({
  browser,
  users,
  miro,
}) => {
  const release = holdFiles(miro)
  const d = await aliceDashboard(browser, users)
  const before = (await (await users.api('alice')).listBoards(users.devStudioId)).length
  const dialog = await openMiroDialog(d.page)
  const importId = await importBoards(d.page, dialog, users.devStudioId, [SPRINT_ID])
  await expect(dialog.getByTestId('miro-board-progress').first()).toContainText('Images and documents', {
    timeout: 60_000,
  })
  await dialog.getByTestId('miro-cancel').click()
  release()
  await expect(dialog.locator('[data-testid="miro-board-report"][data-status="cancelled"]')).toHaveCount(1, {
    timeout: 60_000,
  })
  const view = await d.page.evaluate(async (path) => (await fetch(path)).json(), importJobPath(importId))
  expect(view).toMatchObject({ status: 'cancelled', boards: [{ status: 'cancelled', boardId: null }] })
  expect((await (await users.api('alice')).listBoards(users.devStudioId)).length).toBe(before)
  expect(d.foreign).toEqual([])
  await d.context.close()
})

test('R1: pause, an api restart, then resume with the token again: the import finishes, no file downloaded twice', async ({
  browser,
  users,
  miro,
  stack,
}) => {
  const release = holdFiles(miro)
  const d = await aliceDashboard(browser, users)
  let dialog = await openMiroDialog(d.page)
  const importId = await importBoards(d.page, dialog, users.devStudioId, [SPRINT_ID])
  await expect(dialog.getByTestId('miro-board-progress').first()).toContainText('Images and documents', {
    timeout: 60_000,
  })
  await dialog.getByTestId('miro-pause').click()
  release()
  await expect(dialog.getByTestId('miro-resume')).toBeVisible({ timeout: 60_000 })
  const downloadsBefore = miro.requests.filter((r) => r.origin === 'files').length

  await test.step('the api restarts (its memory, and the token in it, is gone); the job waits, paused', async () => {
    await stack.api.restart()
    await d.page.reload()
    await d.page.getByTestId('nav-all').click()
    dialog = await openMiroDialog(d.page)
    await expect(dialog.getByTestId('miro-progress')).toHaveAttribute('data-status', 'paused')
  })

  await test.step('resume asks for the token again; with it the import finishes', async () => {
    await expect(dialog.getByTestId('miro-resume-token')).toBeVisible()
    await dialog.getByTestId('miro-resume-token').fill(FAKE_MIRO_TOKEN)
    await dialog.getByTestId('miro-resume').click()
    await expect(dialog.locator('[data-testid="miro-board-report"][data-status="done"]')).toHaveCount(1, {
      timeout: 120_000,
    })
  })

  const downloads = miro.requests.filter((r) => r.origin === 'files').length
  // two files in all (the image shown twice, the document): each downloaded once across the pause and the restart
  expect(downloads).toBe(2)
  expect(downloadsBefore).toBeLessThanOrEqual(2)
  const view = await d.page.evaluate(async (path) => (await fetch(path)).json(), importJobPath(importId))
  expect(view).toMatchObject({ status: 'done' })
  expect(d.foreign).toEqual([])
  await d.context.close()
})

test('R1: a token Miro refuses is said so in the dialog; nothing is imported', async ({
  browser,
  users,
  miro,
}) => {
  const d = await aliceDashboard(browser, users)
  const dialog = await openMiroDialog(d.page)
  await dialog.getByTestId('miro-token').fill('not-the-fake-token-0123456789abcdef')
  await dialog.getByTestId('miro-token-submit').click()
  await expect(dialog.getByTestId('miro-error')).toContainText('Miro did not accept that token')
  await expect(dialog.getByTestId('miro-picker')).toHaveCount(0)
  expect(miro.requests.map((r) => r.auth)).toEqual(['other'])
  expect(d.foreign).toEqual([])
  await d.context.close()
})

test('R1: the creator rules: a non-creator and a name-only guest are refused by the api', async ({
  browser,
  users,
  playwright,
  miro,
}) => {
  const outsider = await browser.newContext()
  await signInContext(outsider, `r1-pat-${Date.now().toString(36)}`, 'Pat Client', {
    email: 'pat@client.example.test',
  })
  const refused = await outsider.request.post(`${WEB_URL}${miroBoardsPath(users.devStudioId)}`, {
    headers: { origin: WEB_URL },
    data: { token: FAKE_MIRO_TOKEN },
  })
  expect(refused.status()).toBe(403)
  expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('CREATOR_REQUIRED')

  // a name-only guest of one of alice's boards
  const aliceApi = await users.api('alice')
  const board = await users.createBoard('R1 guest board')
  const link = (await (
    await aliceApi.request.post(`${WEB_URL}/api/boards/${board}/review-links`, {
      headers: { origin: WEB_URL },
      data: { role: 'commenter', allowGuests: true },
    })
  ).json()) as { url: string }
  const guest = await playwright.request.newContext({
    baseURL: WEB_URL,
    extraHTTPHeaders: { origin: WEB_URL },
  })
  const joined = await guest.post(`/api/invitations/${link.url.split('/').pop()}/guest`, {
    data: { name: 'Gia' },
  })
  expect(joined.status()).toBe(201)
  for (const path of [miroBoardsPath(users.devStudioId), miroImportPath(users.devStudioId)]) {
    const res = await guest.post(path, {
      data: { token: FAKE_MIRO_TOKEN, boards: [{ miroBoardId: SPRINT_ID }] },
    })
    expect(res.status(), path).toBe(403)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('GUEST_ACCOUNT_REQUIRED')
  }
  // Miro was never asked
  expect(miro.requests).toEqual([])
  await guest.dispose()
  await outsider.close()
})
