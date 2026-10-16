// Wave R integration ("Bring the team over"): the four workstreams together on one stack, the real api, sync and
// preview worker, with the shipped switches (no dev-auth overrides: the Import menu and its two entries are on), the
// fake Miro (e2e/tests/support/miro.ts) and the fake webhook receiver (r3-chat-kit.ts). Never the real Miro, Slack or
// Teams. What must hold:
//  - Import ▸ "Import from Miro (beta)…" imports a fake Miro board end to end; it opens with its notes and its image;
//  - a board with an image is backed up from its menu, restored as a new board through the dashboard's Import ▸
//    "Lobby backup (.lobby)…" dialog, and opens with the image loaded from its own files;
//  - a PSD and a TIFF upload become cards with a flattened preview;
//  - a channel added from the workspace menu's "Chat notifications…" gets the mention made on a board;
//  - the refusals: a name-only guest and a non-creator, for each of them (a preview's upload: a guest who may only
//    comment, and someone the board is not shared with);
//  - no request of the pages leaves Lobby's own origins.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/r-int --project=chromium --workers=1   (from e2e/)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Browser, BrowserContext, Page, PlaywrightWorkerArgs, Request } from '@playwright/test'
import { miroBoardsPath, miroImportPath } from '../../packages/contracts/src/index.ts'
import { Api, signInContext } from '../tests/support/api.ts'
import { test as base, expect, items, openCanvasSession, waitForCanvas } from '../tests/support/canvas.ts'
import { commentsApi, mentionToken } from '../tests/support/comments.ts'
import { freshHandle, openDashboard, signedInContext } from '../tests/support/dashboard-share.ts'
import type { FilePayload } from '../tests/support/files.ts'
import {
  FAKE_MIRO_TOKEN,
  type FakeMiro,
  MIRO_API_ENV,
  resetFakeMiro,
  SPRINT_ID,
  startE2eFakeMiro,
} from '../tests/support/miro.ts'
import { API_URL, SYNC_URL, WEB_URL } from '../tests/support/ports.ts'
import { downloadFrom } from '../tests/support/present-export.ts'
import { FIXTURES_DIR } from '../tests/support/stack.ts'
import type { Users } from '../tests/support/users.ts'
import { allIds, expectLoadedImage, fileCard, imageItems, insertFiles, newItems } from './media-kit.ts'
import {
  CHAT_API_ENV,
  CHAT_RECEIVER_PORT,
  closeChatDialog,
  type FakeReceiver,
  SLACK_SECRET_PART,
  slackHookUrl,
  startFakeReceiver,
} from './r3-chat-kit.ts'

const test = base.extend<object, { miro: FakeMiro; receiver: FakeReceiver }>({
  miro: [
    async ({ stack: _ }, use) => {
      const fake = await startE2eFakeMiro()
      await use(fake)
      await fake.close()
    },
    { scope: 'worker' },
  ],
  receiver: [
    async ({ stack: _ }, use) => {
      const fake = await startFakeReceiver(CHAT_RECEIVER_PORT)
      await use(fake)
      await fake.close()
    },
    { scope: 'worker' },
  ],
})

// as on Render: the api's own origin serves the backup download (DRAFTROOM_EVENTS_ORIGIN), Miro and the chat
// services are the fakes (local dev only), and chat hooks have their key
test.use({
  viewport: { width: 1440, height: 900 },
  apiEnv: { ...MIRO_API_ENV, ...CHAT_API_ENV, DRAFTROOM_EVENTS_ORIGIN: API_URL },
})
test.describe.configure({ timeout: 240_000 })
test.beforeEach(({ miro, receiver }) => {
  resetFakeMiro(miro)
  receiver.reset()
})

/** Every request of `page` that left Lobby's own origins (none may). */
function foreignRequests(page: Page): string[] {
  const own = (url: string) =>
    url.startsWith(`${WEB_URL}/`) ||
    url.startsWith(`${API_URL}/`) ||
    url.startsWith(SYNC_URL.replace('http', 'ws')) ||
    url.startsWith('data:') ||
    url.startsWith('blob:')
  const foreign: string[] = []
  page.on('request', (r: Request) => {
    if (!own(r.url())) foreign.push(r.url())
  })
  return foreign
}

interface Signed {
  context: BrowserContext
  page: Page
  foreign: string[]
}

/** alice on Dev Studio's All boards, with nothing switched on by the test (the shipped Import menu). */
async function aliceDashboard(browser: Browser, users: Users): Promise<Signed> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const alice = await users.get('alice')
  await signInContext(context, alice.handle, alice.name)
  const page = await context.newPage()
  const foreign = foreignRequests(page)
  await openDashboard(page, users.devStudioId, 'all')
  return { context, page, foreign }
}

/** Import ▸ `entry` (the shipped menu: no dev-auth switch was set). */
async function importEntry(page: Page, entry: string) {
  await page.getByTestId('import-menu').click()
  await page.getByRole('menuitem', { name: entry }).click()
}

/** A name-only guest of `board` (a commenter link that lets guests in), as a request context with its cookie. */
async function guestOf(users: Users, playwright: PlaywrightWorkerArgs['playwright'], board: string) {
  const alice = await users.api('alice')
  const link = (await (
    await alice.request.post(`${WEB_URL}/api/boards/${board}/review-links`, {
      headers: { origin: WEB_URL },
      data: { role: 'commenter', allowGuests: true },
    })
  ).json()) as { url: string }
  const guest = await playwright.request.newContext({
    baseURL: WEB_URL,
    extraHTTPHeaders: { origin: WEB_URL },
  })
  const joined = await guest.post(`/api/invitations/${link.url.split('/').pop()}/guest`, {
    data: { name: 'Gia Guest' },
  })
  expect(joined.status(), await joined.text()).toBe(201)
  return guest
}

/** An account that is not a creator (an outside address), signed in through the api. */
async function outsider(playwright: PlaywrightWorkerArgs['playwright']) {
  const { api } = await Api.signIn(playwright, freshHandle('rint-client'), 'Casey Client', {
    email: `${freshHandle('casey')}@client.example.test`,
  })
  return api
}

const codeOf = async (res: { json(): Promise<unknown> }) =>
  ((await res.json()) as { error?: { code?: string } }).error?.code

test('r-int Miro: Import ▸ Import from Miro (beta) imports a fake Miro board; it opens with its notes and its image; a guest and a non-creator are refused', async ({
  browser,
  users,
  miro,
  playwright,
}) => {
  const d = await aliceDashboard(browser, users)
  let boardId = ''
  await test.step('the shipped Import menu has the Miro entry; the dialog imports one board', async () => {
    await importEntry(d.page, 'Import from Miro (beta)…')
    const dialog = d.page.getByTestId('miro-import-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('miro-beta')).toBeVisible()
    await dialog.getByTestId('miro-token').fill(FAKE_MIRO_TOKEN)
    await dialog.getByTestId('miro-token-submit').click()
    await dialog
      .locator(
        `[data-testid="miro-board-row"][data-board-id="${SPRINT_ID}"] [data-testid="miro-board-check"]`,
      )
      .check()
    const started = d.page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().endsWith(miroImportPath(users.devStudioId)),
    )
    await dialog.getByTestId('miro-start').click()
    expect((await started).status()).toBe(202)
    await expect(dialog.locator('[data-testid="miro-board-report"][data-status="done"]')).toHaveCount(1, {
      timeout: 120_000,
    })
    await dialog.getByTestId('miro-open-board').first().click()
    await expect(d.page).toHaveURL(/\/b\/[a-z0-9][a-z0-9_-]{2,63}$/)
    boardId = new URL(d.page.url()).pathname.split('/').pop() as string
  })

  await test.step('the board opens on the canvas with what the fake Miro board had', async () => {
    await waitForCanvas(d.page, 60_000)
    const all = (await items(d.page)) as unknown as Record<string, unknown>[]
    expect(all.filter((e) => e.type === 'stickynote')).toHaveLength(4)
    expect(all.filter((e) => e.type === 'arrow').length).toBeGreaterThan(0)
    const picture = all.find(
      (e) =>
        e.type === 'image' &&
        (e.customData as { lobby?: { file?: { kind?: string } } } | undefined)?.lobby?.file?.kind === 'image',
    )
    await expectLoadedImage(d.page, picture?.id as string, boardId, 90_000)
  })

  await test.step('a name-only guest and a non-creator are refused; Miro is never asked for them', async () => {
    const asked = miro.requests.length
    const guest = await guestOf(users, playwright, boardId)
    const client = await outsider(playwright)
    try {
      for (const path of [miroBoardsPath(users.devStudioId), miroImportPath(users.devStudioId)]) {
        const body = { token: FAKE_MIRO_TOKEN, boards: [{ miroBoardId: SPRINT_ID }] }
        const g = await guest.post(path, { data: body })
        expect(g.status(), path).toBe(403)
        expect(await codeOf(g), path).toBe('GUEST_ACCOUNT_REQUIRED')
        const c = await client.fetch('POST', path, body)
        expect(c.status(), path).toBe(403)
        expect(await codeOf(c), path).toBe('CREATOR_REQUIRED')
      }
      expect(miro.requests.length).toBe(asked)
    } finally {
      await guest.dispose()
      await client.dispose()
    }
  })

  expect(d.foreign).toEqual([])
  await d.context.close()
})

test('r-int backup: a board with an image is backed up from its menu, restored through Import ▸ Lobby backup, and opens with the image', async ({
  canvasSession,
  board,
  users,
  browser,
  playwright,
}) => {
  const a = await canvasSession('alice')
  const boardForeign = foreignRequests(a.page)
  const before = await allIds(a.page)
  await insertFiles(a.page, [`${FIXTURES_DIR}/image.png`])
  const [image] = await newItems(a.page, imageItems, before, 1)
  await expectLoadedImage(a.page, (image as { id: string }).id, board)
  const count = (await items(a.page)).length

  const file = await test.step('Board menu ▸ Export ▸ Download backup (.lobby)', async () => {
    await a.page.getByTestId('main-menu.button').click()
    await a.page.getByTestId('main-menu-sub.export-button').click()
    const line = a.page.getByTestId('main-menu.backup')
    const got = await downloadFrom(a.page, () => line.click())
    expect(got.name).toMatch(/\.lobby$/)
    expect(got.bytes.subarray(0, 2).toString('latin1')).toBe('PK')
    return { name: got.name, bytes: got.bytes }
  })

  const d = await aliceDashboard(browser, users)
  let restored = ''
  await test.step('Import ▸ Lobby backup (.lobby)… restores it as a new board and offers to open it', async () => {
    await importEntry(d.page, 'Lobby backup (.lobby)…')
    const dialog = d.page.getByTestId('import-backup-dialog')
    await expect(dialog).toBeVisible()
    await dialog
      .getByTestId('import-backup-file')
      .setInputFiles({ name: file.name, mimeType: 'application/vnd.lobby.board+zip', buffer: file.bytes })
    await dialog.getByTestId('import-backup-title').fill('Restored by r-int')
    await dialog.getByTestId('import-backup-submit').click()
    const open = dialog.getByTestId('import-backup-open')
    await expect(open).toBeVisible({ timeout: 120_000 })
    restored = ((await open.getAttribute('href')) ?? '').split('/').pop() as string
    expect(restored).not.toBe(board)
    expect(restored).toMatch(/^[a-z0-9][a-z0-9_-]{2,63}$/)
  })

  await test.step('the new board opens with the same items and the image from its own files', async () => {
    const alice = await users.get('alice')
    const b = await openCanvasSession(browser, restored, alice)
    try {
      const restoredForeign = foreignRequests(b.page)
      await expect.poll(async () => (await items(b.page)).length).toBe(count)
      const [copy] = await imageItems(b.page)
      expect(copy?.fileId).not.toBe((image as { fileId: string }).fileId)
      await expectLoadedImage(b.page, (copy as { id: string }).id, restored)
      const detail = await (await users.api('alice')).getBoard(restored)
      expect(detail.board).toMatchObject({ visibility: 'private', title: 'Restored by r-int' })
      expect(restoredForeign).toEqual([])
    } finally {
      await b.context.close()
    }
  })

  await test.step('a name-only guest and a non-creator are refused the restore (and a guest the download)', async () => {
    const guest = await guestOf(users, playwright, board)
    const client = await outsider(playwright)
    try {
      const path = `/api/workspaces/${users.devStudioId}/backups`
      const g = await guest.post(path, {
        headers: { 'content-type': 'application/vnd.lobby.board+zip' },
        data: file.bytes,
      })
      expect(g.status()).toBe(403)
      expect(await codeOf(g)).toBe('GUEST_ACCOUNT_REQUIRED')
      const ticket = await guest.post(`/api/boards/${board}/backup/ticket`)
      expect(ticket.status()).toBe(403)
      expect(await codeOf(ticket)).toBe('GUEST_ACCOUNT_REQUIRED')
      const c = await client.fetch('POST', path, file.bytes)
      expect(c.status()).toBe(403)
      expect(await codeOf(c)).toBe('CREATOR_REQUIRED')
    } finally {
      await guest.dispose()
      await client.dispose()
    }
  })

  expect(boardForeign).toEqual([])
  expect(d.foreign).toEqual([])
  await d.context.close()
})

const upload = (fixture: string, mimeType: string): FilePayload => ({
  name: fixture,
  mimeType,
  buffer: readFileSync(join(FIXTURES_DIR, fixture)),
})

test('r-int previews: a PSD and a TIFF upload get flattened previews; a commenting guest and someone without the board cannot upload', async ({
  canvasSession,
  board,
  playwright,
  users,
}) => {
  test.setTimeout(180_000)
  const a = await canvasSession('alice')
  const foreign = foreignRequests(a.page)
  const files = [
    { file: upload('design.psd', 'image/vnd.adobe.photoshop'), kind: 'psd', label: 'PSD' },
    { file: upload('scan-lzw.tif', 'image/tiff'), kind: 'tiff', label: 'TIFF' },
  ] as const
  await insertFiles(
    a.page,
    files.map((f) => f.file),
  )
  for (const f of files) {
    const card = fileCard(a.page, f.file.name)
    await expect(card).toHaveAttribute('data-status', 'ready', { timeout: 90_000 })
    await expect(card).toHaveAttribute('data-design', f.kind)
    await expect(card.getByTestId('file-card-design-badge')).toHaveText(`Flattened preview · ${f.label}`)
    await expect(card.getByTestId('file-card-preview')).toBeVisible()
    await expect(card).not.toContainText(/editable/i)
  }

  const guest = await guestOf(users, playwright, board)
  const client = await outsider(playwright)
  try {
    const psd = files[0].file
    const headers = { 'content-type': psd.mimeType, 'x-file-name': psd.name }
    const g = await guest.post(`/api/boards/${board}/assets`, { headers, data: psd.buffer })
    expect(g.status(), await g.text()).toBe(403)
    // not shared with them: the board is not there for them at all
    const c = await client.request.post(`${WEB_URL}/api/boards/${board}/assets`, {
      headers: { ...headers, origin: WEB_URL },
      data: psd.buffer,
    })
    expect(c.status(), await c.text()).toBe(404)
  } finally {
    await guest.dispose()
    await client.dispose()
  }
  expect(foreign).toEqual([])
})

test('r-int chat: a Slack channel added from the workspace menu gets the mention made on a board; a guest and a non-creator are refused', async ({
  browser,
  board,
  users,
  receiver,
  playwright,
}) => {
  await users.grant(board, 'bob', 'editor')
  const alice = await signedInContext(browser, 'alice')
  const bob = await signedInContext(browser, 'bob')
  const foreign = foreignRequests(alice.page)
  const bobForeign = foreignRequests(bob.page)
  let hookId = ''
  try {
    await test.step('workspace menu ▸ Chat notifications… ▸ Channels: alice adds a Slack channel', async () => {
      await openDashboard(alice.page, users.devStudioId, 'all')
      await alice.page.getByTestId('workspace-switcher').click()
      const entry = alice.page.getByTestId('workspace-menu-chat').getByTestId('chat-notifications-open')
      await entry.click()
      await expect(alice.page.getByTestId('chat-notifications-dialog')).toBeVisible()
      if (await alice.page.getByTestId('chat-tab-channels').count())
        await alice.page.getByTestId('chat-tab-channels').click()
      await alice.page.getByTestId('chat-hook-add-name').fill('#r-int')
      await alice.page.getByTestId('chat-hook-add-url').fill(slackHookUrl(receiver.origin))
      await alice.page.getByTestId('chat-hook-add-submit').click()
      const row = alice.page.getByTestId('chat-hook-row').filter({ hasText: '#r-int' })
      await expect(row).toHaveCount(1)
      hookId = ((await row.getAttribute('data-hook-id')) ?? '') as string
      expect(await alice.page.content()).not.toContain(SLACK_SECRET_PART)
      await closeChatDialog(alice.page)
    })

    await test.step('bob opts in to mentions in the channel (the bell’s entry)', async () => {
      await openDashboard(bob.page, users.devStudioId, 'all')
      await bob.page.getByTestId('dashboard-bell').click()
      await bob.page.getByTestId('chat-notifications-open').click()
      const hook = bob.page.locator('[data-testid="chat-prefs-hook"]').filter({ hasText: '#r-int' })
      await expect(hook).toHaveCount(1)
      const id = (await hook.getAttribute('data-hook-id')) as string
      if (!hookId) hookId = id
      await bob.page.getByTestId(`chat-pref-${id}-mention`).check()
      await bob.page.getByTestId('chat-prefs-save').click()
      await expect(bob.page.getByTestId('chat-prefs-saved')).toHaveText('Saved.')
      await closeChatDialog(bob.page)
    })

    await test.step('alice mentions bob on the board: the fake Slack gets one message', async () => {
      const bobUser = await users.get('bob')
      await commentsApi(await users.api('alice')).createThread(
        board,
        { kind: 'point', x: 10, y: 10 },
        `Have a look ${mentionToken('Bob Chen', bobUser.id)}`,
      )
      await expect.poll(() => receiver.posts.length, { timeout: 20_000 }).toBe(1)
      const post = receiver.posts[0]
      expect(post?.path).toBe(`/services/T0000000A/B0000000B/${SLACK_SECRET_PART}`)
      expect(String(post?.body?.text ?? '')).toBe('Alice Park mentioned Bob Chen on a private board')
      expect(post?.raw).not.toContain('Have a look')
    })

    await test.step('a name-only guest and a non-creator are refused', async () => {
      const guest = await guestOf(users, playwright, board)
      const client = await outsider(playwright)
      try {
        const hooks = `/api/workspaces/${users.devStudioId}/chat-hooks`
        const body = { name: '#nope', provider: 'slack', url: slackHookUrl(receiver.origin, 'zzzz9999') }
        for (const [method, path] of [
          ['GET', '/api/me/chat-prefs'],
          ['POST', hooks],
        ] as const) {
          const g = method === 'GET' ? await guest.get(path) : await guest.post(path, { data: body })
          expect(g.status(), path).toBe(403)
          expect(await codeOf(g), path).toBe('GUEST_ACCOUNT_REQUIRED')
        }
        const c = await client.fetch('POST', hooks, body)
        // not a member of Dev Studio and not a creator: refused before the workspace is looked at
        expect(c.status()).toBe(403)
        expect(await codeOf(c)).toBe('CREATOR_REQUIRED')
        expect(receiver.posts).toHaveLength(1)
      } finally {
        await guest.dispose()
        await client.dispose()
      }
    })
    expect(foreign).toEqual([])
    expect(bobForeign).toEqual([])
  } finally {
    // the channel goes again: the r3 specs on the same stack count Dev Studio's channels
    if (hookId)
      await (await users.api('alice')).fetch(
        'DELETE',
        `/api/workspaces/${users.devStudioId}/chat-hooks/${hookId}`,
      )
    await alice.context.close()
    await bob.context.close()
  }
})
