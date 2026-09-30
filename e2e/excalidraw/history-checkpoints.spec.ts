// OWNER: 3h. History on the Excalidraw board page: checkpoints (ported from e2e/tests/history.spec.ts and
// e2e/tests/checkpoints.spec.ts, which keep running on the default tldraw build). Named checkpoints saved
// from the panel and restored as a new private board, automatic checkpoints when the last editor leaves,
// the read-only bitmap preview (canvas/preview, CR-3H-1) that never touches the live board and gives the
// keyboard back when it closes, owners deleting checkpoints, viewers and commenters, duplicate, and a sync
// crash. Everything is driven through the real UI; what the SERVER stored is read through the api and the
// sync server's test snapshot, never from the acting tab alone.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw -- history-checkpoints
//
// Deviations from the tldraw specs (docs/research/excalidraw/wave3/3H.md): the preview is a bitmap, so
// its words are read from the preview's text layer (a visually hidden list); after it closes the focus
// goes back to the row's button and the board takes the keyboard on the next click (Excalidraw's keys
// follow DOM focus, so tldraw's "editor stays blurred" defect, DANA-01, cannot happen; the spec checks
// Delete, Ctrl+Z and N still work); the private-notes reveal (R10) is a server write on an open board and
// waits for CR 2F-2.
import type { Browser, Page } from '@playwright/test'
import type { Api } from '../tests/support/api.ts'
import {
  canvasCall,
  expect,
  expectSaved,
  items,
  openCanvasSession,
  pushedOps,
  selectNone,
  test,
  tool,
  waitForCanvas,
} from '../tests/support/canvas.ts'
import { checkpointRow, historyPanel, listSnapshots, openHistory } from '../tests/support/history.ts'
import { WEB_URL } from '../tests/support/ports.ts'
import { focusBoard } from './board-kit.ts'
import {
  boundEnds,
  deleteWithKeyboard,
  describeServerBoard,
  describeTab,
  drawFrameBoard,
  labelOf,
  onBoard,
  openBoardTarget,
  placement,
  putNote,
  replaceText,
  serverElements,
} from './history-kit.ts'

const manualRow = (page: Page, name?: string) =>
  name ? page.getByTestId('checkpoint-row').filter({ hasText: name }) : page.getByTestId('checkpoint-row')
const autoRows = (page: Page) => page.getByTestId('checkpoint-auto-row')
const preview = (page: Page) => page.getByTestId('checkpoint-preview-dialog')
/** The preview's words (its text layer): what the bitmap shows, readable. */
const previewText = (page: Page) => preview(page).getByTestId('checkpoint-preview-text')

/** Opens the "Automatic" disclosure of the History panel (it starts closed in a fresh browser). */
async function openAutomatic(page: Page) {
  const details = page.getByTestId('checkpoint-auto')
  await expect(details).toBeVisible()
  if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open)))
    await page.getByTestId('checkpoint-auto-toggle').click()
  await expect(details).toHaveAttribute('open', '')
}

/** The bitmap is drawn: the preview canvas holds dark (ink) pixels. */
async function expectBitmapDrawn(page: Page) {
  const bitmap = preview(page).getByTestId('checkpoint-preview-bitmap')
  await expect(bitmap).toHaveAttribute('data-ready', 'true', { timeout: 20_000 })
  await expect
    .poll(() =>
      bitmap.evaluate((c) => {
        const canvas = c as HTMLCanvasElement
        const d = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data
        if (!d) return 0
        let n = 0
        for (let i = 0; i < d.length; i += 16)
          if ((d[i] ?? 255) + (d[i + 1] ?? 255) + (d[i + 2] ?? 255) < 600) n++
        return n
      }),
    )
    .toBeGreaterThan(50)
}

const hasKeyboard = (page: Page) =>
  page.evaluate(() => {
    const b = (window as unknown as { __lobbyBoard?: { canvas: { hasKeyboard(): boolean } } }).__lobbyBoard
    return b?.canvas.hasKeyboard() ?? false
  })

/** Follows history-open-board and waits until the NEW board's canvas is live. */
async function followOpenBoard(page: Page, boardId: string, title: string) {
  await page.getByTestId('history-open-board').click()
  await expect(page).toHaveURL(new RegExp(`/b/${boardId}$`))
  await expect(page.getByTestId('board-title')).toHaveText(title)
  await waitForCanvas(page)
}

/** Grants-only people of a board as the server lists them, e.g. { 'usr_…': 'owner' }. */
async function grants(api: Api, boardId: string) {
  const members = await api.members(boardId)
  return Object.fromEntries(members.filter((m) => m.source === 'grant').map((m) => [m.user.id, m.role]))
}

/** A fresh, signed-out browser that joins `link` as a name-only guest and lands on the board. */
async function joinAsGuest(browser: Browser, link: string, name: string) {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(link)
  await page.getByTestId('invite-guest-name').fill(name)
  await page.getByTestId('invite-guest-join').click()
  await expect(page).toHaveURL(/\/b\/[a-z0-9-]+$/, { timeout: 30_000 })
  await waitForCanvas(page)
  return { context, page }
}

test('checkpoint round trip: bob sees the named checkpoint live; restoring it after a delete makes a private board with the frame, notes and connector; bob has no access; the original keeps the delete', async ({
  canvasSession,
  board,
  users,
  stack,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob') // editor on the original
  const [aliceApi, bobApi] = await Promise.all([users.api('alice'), users.api('bob')])
  const ids = await drawFrameBoard(a.page, 'cp')
  await expect.poll(() => describeTab(b.page)).toEqual(await describeTab(a.page))
  const atCheckpoint = await describeServerBoard(stack, board)
  const title = await a.page.getByTestId('board-title').innerText()

  await openHistory(a.page)
  await openHistory(b.page)
  await a.page.getByTestId('checkpoint-name').fill('Before the cleanup')
  await a.page.getByTestId('checkpoint-save').click()
  await expect(a.page.getByTestId('history-status')).toHaveText('Saved “Before the cleanup”.')
  await expect(checkpointRow(a.page)).toHaveCount(1)
  const snapshotId = (await checkpointRow(a.page).getAttribute('data-snapshot-id')) ?? ''
  expect(snapshotId).toMatch(/^snp_/)

  await test.step('bob’s open panel lists the checkpoint without a reload; the server stored it', async () => {
    const row = checkpointRow(b.page, snapshotId)
    await expect(row).toContainText('Before the cleanup')
    await expect(row).toContainText(`saved by ${a.name}`)
    expect(await listSnapshots(bobApi, board)).toEqual([
      expect.objectContaining({
        id: snapshotId,
        name: 'Before the cleanup',
        kind: 'manual',
        createdBy: { id: a.id, name: a.name },
      }),
    ])
  })

  await deleteWithKeyboard(a.page, [ids.note1])
  await expect.poll(() => onBoard(b.page, ids.note1)).toBe(false)
  await expectSaved(a.page)

  const restoredTitle = `${title} (Before the cleanup)`
  let copy = ''
  await test.step('restore as new board, then open it from the panel', async () => {
    await checkpointRow(a.page, snapshotId).getByTestId('checkpoint-restore').click()
    await expect(a.page.getByTestId('history-status').locator('p')).toHaveText(
      `Restored as “${restoredTitle}”, a new board only you can see.`,
    )
    copy = await openBoardTarget(a.page)
    expect(copy).not.toBe(board)
    await followOpenBoard(a.page, copy, restoredTitle)
  })

  await test.step('the new board holds the checkpoint: the note is back in its frame, the connector bound', async () => {
    await expect.poll(() => describeTab(a.page), { message: 'restored board differs' }).toEqual(atCheckpoint)
    expect(await placement(a.page, ids.note1)).toMatchObject({ frameId: ids.frame, x: 90, y: 120 })
    expect(await boundEnds(a.page, ids.arrow)).toEqual([`end->${ids.box}`, `start->${ids.note1}`])
    expect(await labelOf(a.page, ids.note1)).toBe('Ship the moodboard')
    // what the sync server stored for the copy, not only what this tab shows
    expect(await describeServerBoard(stack, copy)).toEqual(atCheckpoint)
  })

  await test.step('private to alice (PRF-08): owner, no other grants; bob gets no access', async () => {
    expect(await aliceApi.getBoard(copy)).toMatchObject({
      board: { id: copy, title: restoredTitle, visibility: 'private', status: 'active' },
      role: 'owner',
    })
    expect(await grants(aliceApi, copy)).toEqual({ [a.id]: 'owner' })
    expect((await bobApi.fetch('GET', `/api/boards/${copy}`)).status()).toBe(404)
    const probe = await b.context.newPage()
    await probe.goto(`/b/${copy}`)
    await expect(probe.getByTestId('no-access')).toBeVisible()
    await probe.close()
  })

  await test.step('the original is unchanged by the restore: the note stays deleted', async () => {
    const original = (await serverElements(stack, board)).map((e) => e.id)
    expect(original).not.toContain(ids.note1)
    expect(await onBoard(b.page, ids.note1)).toBe(false)
    expect((await aliceApi.getBoard(board)).board.title).toBe(title)
  })
})

test('the last editor leaving saves an automatic checkpoint; its read-only preview never touches the live board; restoring from the preview saves the board first', async ({
  canvasSession,
  board,
  users,
  stack,
}) => {
  const NOTE = 'cp-launch-plan'
  const bobApi = await users.api('bob')
  const bob = await canvasSession('bob', { role: 'viewer' })
  await openHistory(bob.page)
  await expect(bob.page.getByTestId('checkpoint-auto-toggle')).toHaveText('Automatic (0)')

  await test.step('alice edits, then leaves: every open panel lists "After an editing session"', async () => {
    const first = await canvasSession('alice')
    await putNote(first.page, NOTE, 'Launch plan v1')
    await first.context.close()
    await expect(bob.page.getByTestId('checkpoint-auto-toggle')).toHaveText('Automatic (1)', {
      timeout: 20_000,
    })
    await openAutomatic(bob.page)
    const row = autoRows(bob.page).first()
    await expect(row).toHaveAttribute('data-reason', 'session_end')
    await expect(row).toContainText('After an editing session')
    await expect(row).toContainText('saved by Lobby')
    await expect(manualRow(bob.page)).toHaveCount(0)
    await expect(historyPanel(bob.page)).toContainText('No named checkpoints yet.')
  })

  const alice = await canvasSession('alice')
  await expect.poll(() => labelOf(alice.page, NOTE)).toBe('Launch plan v1')
  const label = (await items(alice.page)).find(
    (e) => e.type === 'text' && (e as { containerId?: string }).containerId === NOTE,
  )?.id as string
  expect(await replaceText(alice.page, NOTE, 'Launch plan v2')).toBe(true)
  await expectSaved(alice.page)
  await expect.poll(() => labelOf(bob.page, NOTE)).toBe('Launch plan v2')
  const autoId = (await autoRows(bob.page).first().getAttribute('data-snapshot-id')) ?? ''
  expect(autoId).toMatch(/^snp_/)

  await test.step('alice previews it: that version, read-only; keys pressed in it never reach her board', async () => {
    await canvasCall(alice.page, 'select', [NOTE])
    await openHistory(alice.page)
    await openAutomatic(alice.page)
    const pushesBefore = (await pushedOps(alice.page)).length
    await autoRows(alice.page).first().getByTestId('checkpoint-preview').click()
    const dialog = preview(alice.page)
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveAttribute('data-snapshot-id', autoId)
    await expect(dialog).toHaveAttribute('data-shape-count', '1')
    await expect(dialog.getByRole('heading')).toContainText('After an editing session')
    await expect(previewText(alice.page)).toContainText('Launch plan v1')
    await expect(dialog).not.toContainText('Launch plan v2')
    await expectBitmapDrawn(alice.page)
    expect(await hasKeyboard(alice.page)).toBe(false)
    await dialog.getByTestId('checkpoint-preview-bitmap').click()
    for (const key of ['Control+a', 'Delete', 'Backspace', 'Control+x']) await alice.page.keyboard.press(key)
    await expect(previewText(alice.page)).toContainText('Launch plan v1') // read-only
    expect(await onBoard(alice.page, NOTE)).toBe(true)
    expect((await pushedOps(alice.page)).length).toBe(pushesBefore)
    const stored = (await serverElements(stack, board)).find((e) => e.id === label) as {
      originalText?: string
    }
    expect(stored?.originalText).toBe('Launch plan v2')
    await alice.page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(autoRows(alice.page).first().getByTestId('checkpoint-preview')).toBeFocused()
  })

  await test.step('bob (a viewer) restores it from the preview: a private board with v1; the live board is saved first', async () => {
    await autoRows(bob.page).first().getByTestId('checkpoint-preview').click()
    await expect(previewText(bob.page)).toContainText('Launch plan v1')
    await preview(bob.page).getByTestId('checkpoint-preview-restore').click()
    await expect(preview(bob.page)).toHaveCount(0)
    const title = await bob.page.getByTestId('board-title').innerText()
    await expect(bob.page.getByTestId('history-status').locator('p')).toHaveText(
      `Restored as “${title} (After an editing session)”, a new board only you can see.`,
    )
    const copy = await openBoardTarget(bob.page)
    expect(await bobApi.getBoard(copy)).toMatchObject({ board: { visibility: 'private' }, role: 'owner' })
    expect(await describeServerBoard(stack, copy)).toEqual([
      expect.stringMatching(new RegExp(`^${NOTE}\\|stickynote\\|.*\\|Launch plan v1$`)),
    ])
    // the board as it was (v2) got its own automatic checkpoint before the restore
    await expect(bob.page.getByTestId('checkpoint-auto-toggle')).toHaveText('Automatic (2)')
    const first = autoRows(bob.page).first()
    await expect(first).toHaveAttribute('data-reason', 'before_restore')
    await expect(first).toContainText('Before restoring “After an editing session”')
    await first.getByTestId('checkpoint-preview').click()
    await expect(previewText(bob.page)).toContainText('Launch plan v2')
    await preview(bob.page).getByTestId('checkpoint-preview-close').click()
    await expect(preview(bob.page)).toHaveCount(0)
  })
})

test('after a preview closes, the board takes the keyboard again: Delete, Ctrl+Z and N work (DANA-01)', async ({
  canvasSession,
}) => {
  const NOTE = 'cp-keyboard'
  const alice = await canvasSession('alice')
  const page = alice.page
  await putNote(page, NOTE, 'Keep the keyboard')
  await openHistory(page)
  await page.getByTestId('checkpoint-name').fill('Before clean-up')
  await page.getByTestId('checkpoint-save').click()
  const row = manualRow(page, 'Before clean-up')
  await expect(row).toHaveCount(1)

  for (const how of ['close button', 'Escape'] as const) {
    await test.step(`closed with the ${how}: a clicked note goes with Delete and comes back with Ctrl+Z`, async () => {
      await selectNone(page)
      await row.getByTestId('checkpoint-preview').click()
      const dialog = preview(page)
      await expect(previewText(page)).toContainText('Keep the keyboard')
      expect(await hasKeyboard(page)).toBe(false) // keys pressed in the preview never reach the board
      if (how === 'Escape') await page.keyboard.press('Escape')
      else await dialog.getByTestId('checkpoint-preview-close').click()
      await expect(dialog).toHaveCount(0)
      await expect(row.getByTestId('checkpoint-preview')).toBeFocused() // back where it was opened
      await focusBoard(page)
      expect(await hasKeyboard(page)).toBe(true)
      await canvasCall(page, 'select', [NOTE])
      await page.keyboard.press('Delete')
      await expect.poll(() => onBoard(page, NOTE)).toBe(false)
      await page.keyboard.press('ControlOrMeta+z')
      await expect.poll(() => onBoard(page, NOTE)).toBe(true)
    })
  }

  await test.step('N picks the sticky-note tool', async () => {
    await selectNone(page)
    await focusBoard(page)
    await page.keyboard.press('n')
    await expect.poll(() => tool(page)).toBe('note')
  })
})

test('a private-notes reveal saves the board just before: History lists "Before revealing private notes" (R10; CR 2F-2)', async ({
  canvasSession,
  board,
  users,
}) => {
  // The reveal is the api's server write on an OPEN board (place-notes), which answers 503 until the
  // room implements serverWrite (CR 2F-2, O1). Expected to fail until then.
  const aliceApi = await users.api('alice')
  const alice = await canvasSession('alice')
  const page = alice.page
  await openHistory(page)
  await openAutomatic(page)
  await expect(page.getByTestId('checkpoint-auto')).toContainText(
    'None yet. Lobby saves one when everyone leaves, or after an hour of changes.',
  )
  const frame = { id: 'cp-ideas', x: 100, y: 100, w: 800, h: 500 }
  await canvasCall(page, 'create', 'frame', {
    id: frame.id,
    x: frame.x,
    y: frame.y,
    width: frame.w,
    height: frame.h,
    name: 'Ideas',
  })
  await expectSaved(page)
  const started = await aliceApi.fetch('POST', `/api/boards/${board}/private-brainstorm`, {
    prompt: 'What slowed us down?',
    anonymous: false,
    target: {
      frameId: `shape:${frame.id}`,
      pageId: 'page:page',
      x: frame.x,
      y: frame.y,
      w: frame.w,
      h: frame.h,
    },
  })
  expect(started.status()).toBe(201)
  const sid = ((await started.json()) as { session: { id: string } }).session.id
  for (const text of ['CI queue was slow', 'Scope changed after planning'])
    expect(
      (
        await aliceApi.fetch('POST', `/api/private-brainstorms/${sid}/notes`, { text, color: 'yellow' })
      ).status(),
    ).toBe(201)
  expect((await aliceApi.fetch('POST', `/api/private-brainstorms/${sid}/reveal`)).status()).toBe(200)
  await expect(page.getByTestId('checkpoint-auto-toggle')).toHaveText('Automatic (1)')
  const row = autoRows(page).first()
  await expect(row).toHaveAttribute('data-reason', 'before_reveal')
  await expect(row).toContainText('Before revealing private notes')
  await row.getByTestId('checkpoint-preview').click()
  await expect(preview(page)).toHaveAttribute('data-shape-count', '1')
  await expect(previewText(page)).toContainText('Ideas')
  await expect(previewText(page)).not.toContainText('CI queue was slow')
  await preview(page).getByTestId('checkpoint-preview-close').click()
  await expect
    .poll(async () =>
      (await items(page)).some((e) => (e as { originalText?: string }).originalText === 'CI queue was slow'),
    )
    .toBe(true)
})

test('owners delete checkpoints (confirmed, live for everyone); editors and name-only guests cannot, in the UI or on the server', async ({
  browser,
  canvasSession,
  board,
  users,
}) => {
  const [aliceApi, carolApi] = await Promise.all([users.api('alice'), users.api('carol')])
  const alice = await canvasSession('alice')
  const carol = await canvasSession('carol', { role: 'editor' })
  await putNote(alice.page, 'cp-kickoff', 'Kickoff agenda')
  await openHistory(alice.page)
  await alice.page.getByTestId('checkpoint-name').fill('Kickoff')
  await alice.page.getByTestId('checkpoint-save').click()
  await expect(manualRow(alice.page, 'Kickoff')).toHaveCount(1)
  const sid = (await manualRow(alice.page, 'Kickoff').getAttribute('data-snapshot-id')) ?? ''

  await test.step('carol (editor): can preview and restore, cannot delete; the server refuses her too', async () => {
    await openHistory(carol.page)
    const row = manualRow(carol.page, 'Kickoff')
    await expect(row.getByTestId('checkpoint-preview')).toBeVisible()
    await expect(row.getByTestId('checkpoint-restore')).toBeVisible()
    await expect(carol.page.getByTestId('checkpoint-delete')).toHaveCount(0)
    await expect(carol.page.getByTestId('checkpoint-guest-hint')).toHaveCount(0)
    const res = await carolApi.fetch('DELETE', `/api/snapshots/${sid}`)
    expect(res.status()).toBe(403)
  })

  const link = await aliceApi.fetch('POST', `/api/boards/${board}/review-links`, {
    role: 'viewer',
    allowGuests: true,
  })
  expect(link.status()).toBe(201)
  const guest = await joinAsGuest(browser, ((await link.json()) as { url: string }).url, 'Sam')
  try {
    await test.step('a name-only guest gets no History at all (DANA-05): no rail entry, even after a reload; the server says 403 to the list, the preview and delete', async () => {
      // (the dock shows only when a panel is offered: on this branch nothing else a guest may open is
      // ported yet, so the rail itself may be absent; the History tab never shows either way)
      await expect(guest.page.getByTestId('board-title')).toBeVisible()
      await expect(guest.page.getByTestId('dock-tab-history')).toHaveCount(0)
      await expect(guest.page.getByTestId('history-panel')).toHaveCount(0)
      await guest.page.reload()
      await waitForCanvas(guest.page)
      await expect(guest.page.getByTestId('board-title')).toBeVisible()
      await expect(guest.page.getByTestId('dock-tab-history')).toHaveCount(0)
      const list = await guest.page.request.get(`${WEB_URL}/api/boards/${board}/snapshots`)
      expect(list.status()).toBe(403)
      expect(((await list.json()) as { error: { code: string } }).error.code).toBe('GUEST_ACCOUNT_REQUIRED')
      const content = await guest.page.request.get(`${WEB_URL}/api/snapshots/${sid}/content`)
      expect(content.status()).toBe(403)
      const del = await guest.page.request.delete(`${WEB_URL}/api/snapshots/${sid}`, {
        headers: { origin: WEB_URL },
      })
      expect(del.status()).toBe(403)
    })

    await test.step('alice deletes it after confirming (Cancel keeps it); it disappears from every open panel', async () => {
      const row = manualRow(alice.page, 'Kickoff')
      await row.getByTestId('checkpoint-delete').click()
      await expect(row.getByTestId('checkpoint-delete-cancel')).toBeFocused()
      await expect(row).toContainText('Delete this checkpoint for everyone? This can’t be undone.')
      await row.getByTestId('checkpoint-delete-cancel').click()
      await expect(row.getByTestId('checkpoint-delete')).toBeFocused()
      await alice.page.keyboard.press('Enter')
      await expect(row.getByTestId('checkpoint-delete-cancel')).toBeFocused()
      await alice.page.keyboard.press('Escape')
      await expect(row.getByTestId('checkpoint-delete-confirm')).toHaveCount(0)
      await expect(row.getByTestId('checkpoint-delete')).toBeFocused()
      await row.getByTestId('checkpoint-delete').click()
      await row.getByTestId('checkpoint-delete-confirm').click()
      await expect(alice.page.getByTestId('history-status')).toHaveText('Deleted “Kickoff”.')
      for (const page of [alice.page, carol.page]) await expect(manualRow(page)).toHaveCount(0)
      expect((await listSnapshots(aliceApi, board)).map((s) => s.id)).not.toContain(sid)
    })
  } finally {
    await guest.context.close()
  }
})

test('viewer and commenter: checkpoints are listed without save controls, "Recently deleted" is not shown (authz-001), forged restore or checkpoint POSTs get 403, the viewer exports .json, the commenter restores a private copy', async ({
  canvasSession,
  board,
  users,
  stack,
}) => {
  const NOTE = 'vc-note'
  const KEEP = 'vc-keep'
  const a = await canvasSession('alice')
  await putNote(a.page, NOTE, 'Pitch deck outline')
  await putNote(a.page, KEEP, 'Keep this one', 380, 120)
  const aliceApi = await users.api('alice')
  await deleteWithKeyboard(a.page, [NOTE])
  await expect
    .poll(async () =>
      (await aliceApi.fetch('GET', `/api/boards/${board}/deleted`).then((r) => r.json())).entries.map(
        (e: { shapeId: string }) => e.shapeId,
      ),
    )
    .toEqual([`shape:${NOTE}`])
  const saved = await aliceApi.fetch('POST', `/api/boards/${board}/snapshots`, { name: 'Review baseline' })
  expect(saved.status()).toBe(201)
  const snapshotId = ((await saved.json()) as { id: string }).id
  const title = await a.page.getByTestId('board-title').innerText()

  const viewer = await canvasSession('bob', { role: 'viewer' })
  const commenter = await canvasSession('carol', { role: 'commenter' })
  for (const s of [viewer, commenter]) {
    await test.step(`${s.user}: sees the checkpoints, not what was deleted, and no editing controls`, async () => {
      await openHistory(s.page)
      await expect(historyPanel(s.page).getByRole('heading', { name: 'Recently deleted' })).toHaveCount(0)
      await expect(historyPanel(s.page)).not.toContainText('Pitch deck outline')
      await expect(checkpointRow(s.page, snapshotId)).toContainText('Review baseline')
      for (const id of [
        'deleted-restore',
        'deleted-select',
        'deleted-restore-selected',
        'checkpoint-save',
        'checkpoint-name',
        'history-keep-sharing',
      ]) {
        await expect(s.page.getByTestId(id), id).toHaveCount(0)
      }
      await expect(checkpointRow(s.page, snapshotId).getByTestId('checkpoint-restore')).toBeVisible()
      await expect(s.page.getByTestId('history-duplicate')).toBeVisible()
      await expect(s.page.getByTestId('export-json')).toBeVisible()
    })
    await test.step(`${s.user}: forged requests are refused by the server`, async () => {
      const api = await users.api(s.user)
      const restore = await api.fetch('POST', `/api/boards/${board}/deleted/restore`, {
        ids: [`shape:${NOTE}`],
      })
      expect(restore.status()).toBe(403)
      const snap = await api.fetch('POST', `/api/boards/${board}/snapshots`, { name: 'Forged' })
      expect(snap.status()).toBe(403)
    })
  }

  await test.step('the viewer can download the .json export', async () => {
    const download = viewer.page.waitForEvent('download')
    await viewer.page.getByTestId('export-json').click()
    expect((await download).suggestedFilename()).toBe(`${title}.lobby.json`)
  })

  await test.step('the commenter can restore the checkpoint as a private board of her own', async () => {
    const carolApi = await users.api('carol')
    await checkpointRow(commenter.page, snapshotId).getByTestId('checkpoint-restore').click()
    await expect(commenter.page.getByTestId('history-status').locator('p')).toHaveText(
      `Restored as “${title} (Review baseline)”, a new board only you can see.`,
    )
    const copy = await openBoardTarget(commenter.page)
    expect(await carolApi.getBoard(copy)).toMatchObject({ board: { visibility: 'private' }, role: 'owner' })
    expect(await grants(carolApi, copy)).toEqual({ [commenter.id]: 'owner' })
    // the checkpoint was taken after the delete: only the kept note is on the copy
    expect((await describeServerBoard(stack, copy)).map((d) => d.split('|')[0])).toEqual([KEEP])
    expect((await (await users.api('bob')).fetch('GET', `/api/boards/${copy}`)).status()).toBe(404)
  })

  // nothing changed on the original: the note is still deleted, one checkpoint
  expect((await serverElements(stack, board)).map((e) => e.id)).not.toContain(NOTE)
  expect((await listSnapshots(aliceApi, board)).map((s) => s.name)).toEqual(['Review baseline'])
})

test('duplicate from the history panel: a viewer gets a private copy they own; the owner’s keep-sharing copy has visibility and grants but no invitations or review links', async ({
  canvasSession,
  board,
  users,
  browser,
  stack,
}) => {
  const a = await canvasSession('alice')
  const ids = await drawFrameBoard(a.page, 'dup')
  const [aliceApi, bobApi, carolApi] = await Promise.all([
    users.api('alice'),
    users.api('bob'),
    users.api('carol'),
  ])
  const title = await a.page.getByTestId('board-title').innerText()
  const v = await canvasSession('bob', { role: 'viewer' })
  const source = await describeServerBoard(stack, board)

  let viewerCopy = ''
  await test.step('viewer: “a private copy only you can see”, owned by bob', async () => {
    await openHistory(v.page)
    await expect(v.page.getByTestId('history-keep-sharing')).toHaveCount(0)
    await v.page.getByTestId('history-duplicate').click()
    await expect(v.page.getByTestId('history-status').locator('p')).toHaveText(
      `Made “Copy of ${title}”, a private copy only you can see.`,
    )
    viewerCopy = await openBoardTarget(v.page)
    expect(await bobApi.getBoard(viewerCopy)).toMatchObject({
      board: { title: `Copy of ${title}`, visibility: 'private' },
      role: 'owner',
    })
    expect(await grants(bobApi, viewerCopy)).toEqual({ [v.id]: 'owner' })
    expect((await carolApi.fetch('GET', `/api/boards/${viewerCopy}`)).status()).toBe(404)
  })

  await test.step('bob opens his copy: same content, editable', async () => {
    await followOpenBoard(v.page, viewerCopy, `Copy of ${title}`)
    await expect(v.page.getByTestId('readonly-pill')).toHaveCount(0)
    await expect.poll(() => describeTab(v.page)).toEqual(source)
    expect(await boundEnds(v.page, ids.arrow)).toEqual([`end->${ids.box}`, `start->${ids.note1}`])
  })

  await test.step('owner with keep sharing: visibility and people grants, never invitations or links', async () => {
    const carol = await users.grant(board, 'carol', 'commenter')
    await aliceApi.patchBoard(board, { visibility: 'workspace_view' })
    const invite = await aliceApi.fetch('POST', `/api/boards/${board}/invitations`, {
      role: 'commenter',
      email: 'reviewer@client.example.test',
    })
    expect(invite.status()).toBe(201)
    const link = await aliceApi.fetch('POST', `/api/boards/${board}/review-links`, {})
    expect(link.status()).toBe(201)

    await openHistory(a.page)
    await a.page.getByTestId('history-keep-sharing').check()
    await a.page.getByTestId('history-duplicate').click()
    await expect(a.page.getByTestId('history-status').locator('p')).toHaveText(`Made “Copy of ${title}”.`)
    const shared = await openBoardTarget(a.page)
    expect(shared).not.toBe(viewerCopy)
    expect(await aliceApi.getBoard(shared)).toMatchObject({
      board: { visibility: 'workspace_view' },
      role: 'owner',
    })
    expect(await grants(aliceApi, shared)).toEqual({
      [a.id]: 'owner',
      [v.id]: 'viewer',
      [carol.id]: 'commenter',
    })
    const copied = await aliceApi.fetch('GET', `/api/boards/${shared}/invitations`)
    expect(copied.status()).toBe(200)
    expect(((await copied.json()) as { invitations: unknown[] }).invitations).toEqual([])
    expect(await carolApi.getBoard(shared)).toMatchObject({ role: 'commenter' })
    expect(await describeServerBoard(stack, shared)).toEqual(source)
    // carol opens the copy on the canvas through her copied grant
    const who = await users.get('carol')
    const c = await openCanvasSession(browser, shared, who)
    await expect.poll(() => describeTab(c.page)).toEqual(source)
    await c.context.close()
  })
})

test('sync SIGKILL and restart: a checkpoint saved during the outage fails with a message and works after; recently deleted rows survive', async ({
  canvasSession,
  board,
  users,
  stack,
}) => {
  const NOTE = 'crash-note'
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const aliceApi = await users.api('alice')
  await putNote(a.page, NOTE, 'Survives a crash', 160, 140)
  await expect.poll(() => labelOf(b.page, NOTE)).toBe('Survives a crash')
  await deleteWithKeyboard(a.page, [NOTE])
  await expect
    .poll(async () =>
      (
        (await (await aliceApi.fetch('GET', `/api/boards/${board}/deleted`)).json()) as {
          entries: { shapeId: string }[]
        }
      ).entries.map((e) => e.shapeId),
    )
    .toEqual([`shape:${NOTE}`])

  await openHistory(a.page)
  await stack.sync.kill()
  await Promise.all([
    expect(a.page.getByTestId('conn-status')).toHaveAttribute('data-state', /offline|connecting|error/, {
      timeout: 30_000,
    }),
    expect(b.page.getByTestId('conn-status')).toHaveAttribute('data-state', /offline|connecting|error/, {
      timeout: 30_000,
    }),
  ])
  await test.step('while the board server is down, saving a checkpoint says so and stores nothing', async () => {
    await a.page.getByTestId('checkpoint-name').fill('During the outage')
    await a.page.getByTestId('checkpoint-save').click()
    await expect(a.page.getByTestId('history-error')).toHaveText(
      'The board server is not reachable right now. Try again in a moment.',
    )
    await expect(a.page.getByTestId('checkpoint-name')).toHaveValue('During the outage')
    expect(await listSnapshots(aliceApi, board)).toEqual([])
  })
  await stack.sync.start()
  await Promise.all([
    expect(a.page.getByTestId('conn-status')).toHaveAttribute('data-state', 'online', { timeout: 30_000 }),
    expect(b.page.getByTestId('conn-status')).toHaveAttribute('data-state', 'online', { timeout: 30_000 }),
  ])
  await a.page.getByTestId('checkpoint-save').click()
  await expect(a.page.getByTestId('history-status')).toHaveText('Saved “During the outage”.')
  expect((await listSnapshots(aliceApi, board)).map((s) => s.name)).toEqual(['During the outage'])

  const listed = (await (await aliceApi.fetch('GET', `/api/boards/${board}/deleted`)).json()) as {
    entries: { shapeId: string; type: string; label: string }[]
  }
  expect(listed.entries).toEqual([
    expect.objectContaining({ shapeId: `shape:${NOTE}`, type: 'note', label: 'Survives a crash' }),
  ])
  await b.page.reload()
  await waitForCanvas(b.page)
  await openHistory(b.page)
  await expect(b.page.locator(`[data-testid="deleted-row"][data-shape-id="shape:${NOTE}"]`)).toContainText(
    'Survives a crash',
  )
})
