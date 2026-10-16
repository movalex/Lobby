// Wave R (WS4): board backup and restore (`.lobby`; docs/WAVE-R-CONTRACTS.md §5), as on Render: the api runs with
// DRAFTROOM_EVENTS_ORIGIN = its own URL, another origin than the page's, so a backup downloads straight from the api
// origin (a ticket minted same-origin, then a plain navigation the answer makes a file), never through the page's
// /api proxy.
//  - the round trip with images: alice puts an image and a PDF on a board, downloads "Download backup (.lobby)" from
//    the board menu, restores the file into her own workspace and opens the new board: the same items, the image
//    loaded from the new board's own files, the PDF card ready; the original board is unchanged; every request of
//    both pages went to Lobby's own origins;
//  - the export policy: a viewer has the backup line; with downloads off for viewers, none, and the api refuses the
//    ticket;
//  - a non-creator's restore is refused (403 CREATOR_REQUIRED) and makes nothing;
//  - hostile files (not a ZIP, a traversal name, a truncated archive) are refused at once (400) and make nothing.
// The dashboard's restore dialog is not opened here: its Import line is the lead's (DashboardPage); the restore goes
// through the same route the dialog calls.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw r5-
import type { APIRequestContext, Page } from '@playwright/test'
import { Api } from '../tests/support/api.ts'
import {
  expect,
  expectSaved,
  items,
  openCanvasSession,
  test,
  waitForCanvas,
} from '../tests/support/canvas.ts'
import { freshHandle } from '../tests/support/dashboard-share.ts'
import { API_URL, SYNC_URL, WEB_URL } from '../tests/support/ports.ts'
import { downloadFrom } from '../tests/support/present-export.ts'
import { FIXTURES_DIR } from '../tests/support/stack.ts'
import type { Users } from '../tests/support/users.ts'
import {
  allIds,
  cardItems,
  expectLoadedImage,
  fileCard,
  imageItems,
  insertFiles,
  newItems,
} from './media-kit.ts'

test.use({ apiEnv: { DRAFTROOM_EVENTS_ORIGIN: API_URL } })

const BACKUP_TYPE = 'application/vnd.lobby.board+zip'

/** Opens Board menu ▸ Export and returns the backup line. */
async function backupLine(page: Page) {
  await page.getByTestId('main-menu.button').click()
  await page.getByTestId('main-menu-sub.export-button').click()
  await expect(page.getByTestId('main-menu.export-dialog')).toBeVisible()
  return page.getByTestId('main-menu.backup')
}

/** Opens the board menu and its Export submenu when there is one (with exporting off there is none). */
async function exportMenuIfAny(page: Page) {
  await page.getByTestId('main-menu.button').click()
  await expect(page.getByRole('menuitem', { name: 'Board', exact: true })).toBeVisible()
  const sub = page.getByTestId('main-menu-sub.export-button')
  if (await sub.count()) await sub.click()
}

/** Every request a page makes, to check none leaves Lobby's own origins. */
function recordOrigins(page: Page) {
  const urls: string[] = []
  page.on('request', (r) => urls.push(r.url()))
  return urls
}
const ours = (url: string) =>
  url.startsWith(`${WEB_URL}/`) ||
  url.startsWith(`${API_URL}/`) ||
  url.startsWith(SYNC_URL.replace('http', 'ws')) ||
  url.startsWith('data:') ||
  url.startsWith('blob:')

/** A backup of `board` as alice gets it through the api: a ticket, then the direct download (no cookie). */
async function backupOf(api: Api, request: APIRequestContext, board: string): Promise<Buffer> {
  const t = await api.fetch('POST', `/api/boards/${board}/backup/ticket`)
  expect(t.status(), await t.text()).toBe(200)
  const { url } = (await t.json()) as { url: string }
  expect(url.startsWith(`${API_URL}/api/boards/${board}/backup?ticket=bkt_`)).toBe(true)
  const file = await request.get(url)
  expect(file.status()).toBe(200)
  expect(file.headers()['content-type']).toBe(BACKUP_TYPE)
  return file.body()
}

const restore = (api: Api, workspaceId: string, bytes: Buffer) =>
  api.fetch('POST', `/api/workspaces/${workspaceId}/backups`, bytes)

const boardIds = async (api: Api, workspaceId: string) =>
  new Set((await api.listBoards(workspaceId)).map((b) => b.id))

/** The board a restore made, once its job activated it (the job routes are WS1's; the dashboard's list tells). */
async function restoredBoard(api: Api, workspaceId: string, before: ReadonlySet<string>, title: string) {
  let found: string | null = null
  await expect
    .poll(
      async () => {
        const all = await api.listBoards(workspaceId)
        const fresh = all.filter((b) => !before.has(b.id) && b.title === title)
        found = fresh[0]?.id ?? null
        return fresh.length
      },
      { timeout: 60_000, message: 'the restored board is on the dashboard' },
    )
    .toBe(1)
  return found as unknown as string
}

async function noNewBoards(api: Api, users: Users, before: ReadonlySet<string>) {
  // a refused restore makes no board, now or once its job settled
  await new Promise((r) => setTimeout(r, 1_000))
  expect([...(await boardIds(api, users.devStudioId))].filter((id) => !before.has(id))).toEqual([])
}

test('backup round trip: a board with an image and a PDF comes back as a new board with its files, from the board menu', async ({
  canvasSession,
  board,
  users,
  browser,
}, testInfo) => {
  const a = await canvasSession('alice')
  const pageUrls = recordOrigins(a.page)
  const before = await allIds(a.page)
  await insertFiles(a.page, [`${FIXTURES_DIR}/image.png`, `${FIXTURES_DIR}/document.pdf`])
  const [image] = await newItems(a.page, imageItems, before, 1)
  await newItems(a.page, cardItems, before, 1)
  await expect(fileCard(a.page, 'document.pdf')).toHaveAttribute('data-status', 'ready', { timeout: 60_000 })
  await expectLoadedImage(a.page, (image as { id: string }).id, board)
  await expectSaved(a.page)
  const original = (await items(a.page)).map((e) => e.id).sort()
  const title = (await (await users.api('alice')).getBoard(board)).board.title

  const file =
    await test.step('Board menu ▸ Export ▸ Download backup (.lobby) downloads the file', async () => {
      const line = await backupLine(a.page)
      await expect(line).toHaveText(/Download backup \(\.lobby\)/)
      const got = await downloadFrom(a.page, () => line.click())
      expect(got.name).toBe(`${title}.lobby`)
      expect(got.bytes.subarray(0, 2).toString('latin1')).toBe('PK')
      await expect(a.page.getByTestId('backup-download-notice')).toContainText('Your backup is downloading')
      await testInfo.attach('board.lobby', { body: got.bytes, contentType: BACKUP_TYPE })
      return got.bytes
    })
  // the download went straight to the api's own origin, never through the page's /api proxy
  const downloads = pageUrls.filter((u) => u.includes('/backup?ticket='))
  expect(downloads).toHaveLength(1)
  expect(downloads[0]?.startsWith(`${API_URL}/`)).toBe(true)

  const aliceApi = await users.api('alice')
  const alice = await users.get('alice')
  const target = alice.personalWorkspaceId
  const known = await boardIds(aliceApi, target)
  const res = await restore(aliceApi, target, file)
  expect(res.status(), await res.text()).toBe(202)
  const newBoard = await restoredBoard(aliceApi, target, known, title)
  expect(newBoard).not.toBe(board)

  const b = await openCanvasSession(browser, newBoard, alice)
  try {
    const restoredUrls = recordOrigins(b.page)
    await test.step('the new board shows the same items, with its own files', async () => {
      await expect.poll(async () => (await items(b.page)).length).toBe(original.length)
      const [copy] = await imageItems(b.page)
      expect(copy?.fileId).not.toBe((image as { fileId: string }).fileId)
      await expectLoadedImage(b.page, (copy as { id: string }).id, newBoard)
      await expect(fileCard(b.page, 'document.pdf')).toHaveAttribute('data-status', 'ready', {
        timeout: 60_000,
      })
      // a private board of hers, in her own workspace
      const detail = await aliceApi.getBoard(newBoard)
      expect(detail.board).toMatchObject({ visibility: 'private', workspaceId: target })
    })
    await test.step('the original is unchanged, and nothing left Lobby’s origins', async () => {
      expect((await items(a.page)).map((e) => e.id).sort()).toEqual(original)
      expect([...pageUrls, ...restoredUrls].filter((u) => !ours(u))).toEqual([])
    })
  } finally {
    await b.context.close()
  }
})

test('backup export policy: a viewer has the backup line; with downloads off for viewers, no line and no ticket', async ({
  canvasSession,
  board,
  users,
}) => {
  const aliceApi = await users.api('alice')
  const policy = (exportPolicy: string) =>
    aliceApi.fetch('PUT', `/api/boards/${board}/export-policy`, { exportPolicy })
  expect((await policy('everyone')).status()).toBe(200)
  const v = await canvasSession('bob', { role: 'viewer' })
  // viewers export while the policy lets them (the line is a menu action read-only roles get)
  await expect(await backupLine(v.page)).toBeVisible()
  await v.page.keyboard.press('Escape')
  await v.page.keyboard.press('Escape')
  expect((await policy('editors')).status()).toBe(200)
  await v.page.reload()
  await waitForCanvas(v.page)
  await exportMenuIfAny(v.page)
  await expect(v.page.getByTestId('main-menu.backup')).toHaveCount(0)
  const bobApi = await users.api('bob')
  const ticket = await bobApi.fetch('POST', `/api/boards/${board}/backup/ticket`)
  expect(ticket.status()).toBe(403)
  expect(((await ticket.json()) as { error: { code: string } }).error.code).toBe('EXPORT_DISABLED')
  // the owner still has it
  const a = await canvasSession('alice')
  await expect(await backupLine(a.page)).toBeVisible()
})

test('backup restore by a non-creator is refused and makes nothing', async ({ board, users, playwright }) => {
  const aliceApi = await users.api('alice')
  const request = await playwright.request.newContext()
  const outsider = await Api.signIn(playwright, freshHandle('client'), 'Casey Client', {
    email: `${freshHandle('casey')}@client.example.test`,
  })
  try {
    const bytes = await backupOf(aliceApi, request, board)
    const before = await boardIds(aliceApi, users.devStudioId)
    const res = await restore(outsider.api, users.devStudioId, bytes)
    expect(res.status()).toBe(403)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('CREATOR_REQUIRED')
    await noNewBoards(aliceApi, users, before)
  } finally {
    await outsider.api.dispose()
    await request.dispose()
  }
})

test('backup restore of hostile files: not a ZIP, a traversal name, a truncated archive are refused at once', async ({
  board,
  users,
  playwright,
}) => {
  const aliceApi = await users.api('alice')
  const request = await playwright.request.newContext()
  // a creator of their own (a member of Dev Studio): every restore starts a job, and a person starts at most ten a day
  const restorer = await Api.signIn(playwright, freshHandle('restorer'), 'Riley Restorer')
  try {
    const good = await backupOf(aliceApi, request, board)
    // an entry renamed out of the archive (same length, so the ZIP stays well-formed otherwise)
    const traversal = Buffer.from(good)
    for (let at = traversal.indexOf('board.json'); at >= 0; at = traversal.indexOf('board.json', at + 1))
      traversal.write('../x.jsonx', at, 'latin1')
    const before = await boardIds(aliceApi, users.devStudioId)
    for (const [name, bytes] of [
      ['not a zip', Buffer.from('{"format":"lobby-board","version":2,"elements":[]}')],
      ['traversal', traversal],
      ['truncated', good.subarray(0, good.length - 40)],
    ] as const) {
      const res = await restore(restorer.api, users.devStudioId, bytes)
      expect(res.status(), name).toBe(400)
      expect(((await res.json()) as { error: { code: string } }).error.code, name).toBe('BACKUP_INVALID')
    }
    await noNewBoards(aliceApi, users, before)
    // and the real one still restores (the refusals left no job in the way)
    const ok = await restore(restorer.api, users.devStudioId, good)
    expect(ok.status(), await ok.text()).toBe(202)
  } finally {
    await restorer.api.dispose()
    await request.dispose()
  }
})
