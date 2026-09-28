// Automatic checkpoints, preview and deletion (docs/WAVE4-CONTRACTS.md checkpoints-2; REV-10). Driven
// through the real UI of several browsers against the real api + sync server: the last editor leaving
// makes an automatic checkpoint that every open History panel lists under "Automatic"; the preview
// shows that version read-only and never touches the live board, which gets the keyboard back when it
// closes (DANA-01); restoring from it first saves the board as it is, and so does a private-notes
// reveal (R10); owners delete checkpoints, editors cannot (UI and server); name-only guests get no
// History at all (DANA-05); an empty text box tldraw removes by itself is no "deletion" (R17).
// The hourly rhythm and retention are covered by the api tests (a test clock), not here.
import type { Browser, Page } from '@playwright/test'
import { edit, read, shapeCenterOnScreen, waitForBoard } from './support/board.ts'
import { richText } from './support/editor.ts'
import { expect, test } from './support/fixtures.ts'
import {
  clickEmptyCanvas,
  expectServerHasTab,
  historyPanel,
  openHistory,
  serverShapes,
} from './support/history.ts'
import { WEB_URL } from './support/ports.ts'

const NOTE = 'shape:cp-launch-plan'

const manualRow = (page: Page, name?: string) =>
  name ? page.getByTestId('checkpoint-row').filter({ hasText: name }) : page.getByTestId('checkpoint-row')
const autoRows = (page: Page) => page.getByTestId('checkpoint-auto-row')
const preview = (page: Page) => page.getByTestId('checkpoint-preview-dialog')

/** Opens the "Automatic" disclosure of the History panel (it starts closed in a fresh browser). */
async function openAutomatic(page: Page) {
  const details = page.getByTestId('checkpoint-auto')
  await expect(details).toBeVisible()
  if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open)))
    await page.getByTestId('checkpoint-auto-toggle').click()
  await expect(details).toHaveAttribute('open', '')
}

async function putNote(page: Page, text: string) {
  await edit(
    page,
    (editor, arg) => {
      const props = { richText: arg.rt }
      if (editor.getShape(arg.id)) editor.updateShape({ id: arg.id, type: 'note', props })
      else editor.createShape({ id: arg.id, type: 'note', x: 120, y: 120, props })
    },
    { id: NOTE, rt: richText(text) },
  )
}

const noteTextOnServer = async (api: Parameters<typeof serverShapes>[0], board: string) => {
  const shape = (await serverShapes(api, board))[NOTE] as { props?: { richText?: unknown } } | undefined
  return JSON.stringify(shape?.props?.richText ?? null)
}

/** A fresh, signed-out browser that joins `link` as a name-only guest and lands on the board. */
async function joinAsGuest(browser: Browser, link: string, name: string) {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(link)
  await page.getByTestId('invite-guest-name').fill(name)
  await page.getByTestId('invite-guest-join').click()
  await expect(page).toHaveURL(/\/b\/[a-z0-9-]+$/, { timeout: 30_000 })
  await waitForBoard(page)
  return { context, page }
}

test('the last editor leaving saves an automatic checkpoint; its read-only preview never touches the live board; restoring from the preview saves the board first', async ({
  session,
  board,
  users,
}) => {
  const [aliceApi, bobApi] = await Promise.all([users.api('alice'), users.api('bob')])
  const bob = await session('bob', { role: 'viewer' }) // a Dev Studio member who views the board
  await openHistory(bob.page)
  await expect(bob.page.getByTestId('checkpoint-auto-toggle')).toHaveText('Automatic (0)')

  await test.step('alice edits, then leaves: every open panel lists "After an editing session"', async () => {
    const alice = await session('alice')
    await putNote(alice.page, 'Launch plan v1')
    await expectServerHasTab(aliceApi, board, alice.page)
    await alice.context.close()
    await expect(bob.page.getByTestId('checkpoint-auto-toggle')).toHaveText('Automatic (1)', {
      timeout: 20_000,
    })
    await openAutomatic(bob.page)
    const row = autoRows(bob.page).first()
    await expect(row).toHaveAttribute('data-reason', 'session_end')
    await expect(row).toContainText('After an editing session')
    await expect(row).toContainText('saved by Lobby')
    // Named checkpoints are separate; there are none.
    await expect(manualRow(bob.page)).toHaveCount(0)
    await expect(historyPanel(bob.page)).toContainText('No named checkpoints yet.')
  })

  const alice = await session('alice')
  await putNote(alice.page, 'Launch plan v2')
  await expectServerHasTab(aliceApi, board, alice.page)
  const autoId = (await autoRows(bob.page).first().getAttribute('data-snapshot-id')) ?? ''
  expect(autoId).toMatch(/^snp_/)

  await test.step('alice previews it: that version, read-only; keys pressed in it never reach her board', async () => {
    await edit(alice.page, (editor, id) => editor.select(id), NOTE)
    await openHistory(alice.page)
    await openAutomatic(alice.page)
    await autoRows(alice.page).first().getByTestId('checkpoint-preview').click()
    const dialog = preview(alice.page)
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveAttribute('data-snapshot-id', autoId)
    await expect(dialog).toHaveAttribute('data-shape-count', '1')
    await expect(dialog.getByRole('heading')).toContainText('After an editing session')
    await expect(dialog.getByTestId('checkpoint-preview-canvas')).toContainText('Launch plan v1')
    await expect(dialog).not.toContainText('Launch plan v2')
    await dialog.getByTestId('checkpoint-preview-canvas').click()
    for (const key of ['Control+a', 'Delete', 'Backspace', 'Control+x']) await alice.page.keyboard.press(key)
    await expect(dialog.getByTestId('checkpoint-preview-canvas')).toContainText('Launch plan v1') // read-only
    expect(await read(alice.page, (editor, id) => editor.getShape(id) !== undefined, NOTE)).toBe(true)
    expect(await noteTextOnServer(aliceApi, board)).toContain('Launch plan v2')
    await alice.page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(autoRows(alice.page).first().getByTestId('checkpoint-preview')).toBeFocused()
  })

  await test.step('bob (a viewer) restores it from the preview: a private board with v1; the live board is saved first', async () => {
    await autoRows(bob.page).first().getByTestId('checkpoint-preview').click()
    await expect(preview(bob.page).getByTestId('checkpoint-preview-canvas')).toContainText('Launch plan v1')
    await preview(bob.page).getByTestId('checkpoint-preview-restore').click()
    await expect(preview(bob.page)).toHaveCount(0)
    const title = await bob.page.getByTestId('board-title').innerText()
    await expect(bob.page.getByTestId('history-status').locator('p')).toHaveText(
      `Restored as “${title} (After an editing session)”, a new board only you can see.`,
    )
    const href = (await bob.page.getByTestId('history-open-board').getAttribute('href')) ?? ''
    const copy = href.replace('/b/', '')
    expect(await noteTextOnServer(bobApi, copy)).toContain('Launch plan v1')
    // The board as it was (v2) got its own automatic checkpoint before the restore.
    await expect(bob.page.getByTestId('checkpoint-auto-toggle')).toHaveText('Automatic (2)')
    const first = autoRows(bob.page).first()
    await expect(first).toHaveAttribute('data-reason', 'before_restore')
    await expect(first).toContainText('Before restoring “After an editing session”')
    await first.getByTestId('checkpoint-preview').click()
    await expect(preview(bob.page).getByTestId('checkpoint-preview-canvas')).toContainText('Launch plan v2')
    await preview(bob.page).getByTestId('checkpoint-preview-close').click()
    await expect(preview(bob.page)).toHaveCount(0)
  })
})

test('after a preview closes, the board has the keyboard again: Delete, Ctrl+Z and N work (DANA-01)', async ({
  session,
  board,
  users,
}) => {
  const aliceApi = await users.api('alice')
  const alice = await session('alice')
  const page = alice.page
  await putNote(page, 'Keep the keyboard')
  await expectServerHasTab(aliceApi, board, page)
  await openHistory(page)
  await page.getByTestId('checkpoint-name').fill('Before clean-up')
  await page.getByTestId('checkpoint-save').click()
  const row = manualRow(page, 'Before clean-up')
  await expect(row).toHaveCount(1)
  const noteOnBoard = () => read(page, (editor, id) => editor.getShape(id) !== undefined, NOTE)
  const boardFocused = () =>
    page.evaluate(() => (window.editor as unknown as { getIsFocused(): boolean }).getIsFocused())

  for (const how of ['close button', 'Escape'] as const) {
    await test.step(`closed with the ${how}: a clicked note goes with Delete and comes back with Ctrl+Z`, async () => {
      // (Ctrl+Z brings the selection back too, and a click on a selected note starts editing its text.)
      await edit(page, (editor) => editor.selectNone())
      await row.getByTestId('checkpoint-preview').click()
      const dialog = preview(page)
      await expect(dialog.getByTestId('checkpoint-preview-canvas')).toContainText('Keep the keyboard')
      expect(await boardFocused()).toBe(false) // keys pressed in the preview never reach the board
      if (how === 'Escape') await page.keyboard.press('Escape')
      else await dialog.getByTestId('checkpoint-preview-close').click()
      await expect(dialog).toHaveCount(0)
      await expect(row.getByTestId('checkpoint-preview')).toBeFocused() // back where it was opened
      expect(await boardFocused()).toBe(true)
      const at = await shapeCenterOnScreen(page, NOTE)
      await page.mouse.click(at.x, at.y)
      await page.keyboard.press('Delete')
      await expect.poll(noteOnBoard).toBe(false)
      await page.keyboard.press('ControlOrMeta+z')
      await expect.poll(noteOnBoard).toBe(true)
    })
  }

  await test.step('N picks the sticky-note tool', async () => {
    // Nothing selected (with one note selected, typing a letter writes into it: canvas-ux).
    await clickEmptyCanvas(page)
    await page.keyboard.press('n')
    await expect.poll(() => read(page, (editor) => editor.getCurrentToolId())).toBe('note')
  })
})

test('a private-notes reveal saves the board just before: History lists "Before revealing private notes" (R10)', async ({
  session,
  board,
  users,
}) => {
  const aliceApi = await users.api('alice')
  const alice = await session('alice')
  const page = alice.page
  await openHistory(page)
  await openAutomatic(page)
  await expect(page.getByTestId('checkpoint-auto')).toContainText(
    'None yet. Lobby saves one when everyone leaves, or after an hour of changes.',
  )
  const frame = { id: 'shape:cp-ideas', x: 100, y: 100, w: 800, h: 500 }
  await edit(
    page,
    (editor, f) =>
      editor.createShape({
        id: f.id,
        type: 'frame',
        x: f.x,
        y: f.y,
        props: { w: f.w, h: f.h, name: 'Ideas' },
      }),
    frame,
  )
  await expectServerHasTab(aliceApi, board, page)
  const pageId = await page.evaluate(() =>
    (window.editor as unknown as { getCurrentPageId(): string }).getCurrentPageId(),
  )
  const started = await aliceApi.fetch('POST', `/api/boards/${board}/private-brainstorm`, {
    prompt: 'What slowed us down?',
    anonymous: false,
    target: { frameId: frame.id, pageId, x: frame.x, y: frame.y, w: frame.w, h: frame.h },
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
  await expect(row).toContainText('saved by Lobby')
  // It holds the board without the revealed notes, which are on the live board now.
  await row.getByTestId('checkpoint-preview').click()
  const dialog = preview(page)
  await expect(dialog).toHaveAttribute('data-shape-count', '1')
  await expect(dialog.getByTestId('checkpoint-preview-canvas')).toContainText('Ideas')
  await expect(dialog.getByTestId('checkpoint-preview-canvas')).not.toContainText('CI queue was slow')
  await dialog.getByTestId('checkpoint-preview-close').click()
  await expect(dialog).toHaveCount(0)
  const revealedOnBoard = () =>
    read(page, (editor) =>
      editor.getCurrentPageShapes().some((s) => JSON.stringify(s.props).includes('CI queue was slow')),
    )
  await expect.poll(revealedOnBoard).toBe(true)
})

test('Recently deleted: an empty text box that tldraw removes by itself is not listed as someone’s deletion (R17)', async ({
  session,
  board,
  users,
}) => {
  const aliceApi = await users.api('alice')
  const alice = await session('alice')
  const bob = await session('bob', { role: 'editor' })
  await openHistory(alice.page)
  await expect(historyPanel(alice.page)).toContainText('Nothing deleted recently.')
  // Bob clicks the canvas with the Text tool, types nothing, and presses Escape.
  await bob.page.getByTestId('tools.text').click()
  const spot = await bob.page.evaluate(() => {
    const vb = (
      window.editor as unknown as {
        getViewportScreenBounds(): { x: number; y: number; w: number; h: number }
      }
    ).getViewportScreenBounds()
    return { x: Math.round(vb.x + vb.w * 0.6), y: Math.round(vb.y + vb.h * 0.5) }
  })
  await bob.page.mouse.click(spot.x, spot.y)
  await expect.poll(() => read(bob.page, (editor) => editor.getEditingShapeId())).not.toBeNull()
  const textId = (await read(bob.page, (editor) => editor.getEditingShapeId())) ?? ''
  // It reached everyone (so the server saw it go too)...
  await expect
    .poll(() => read(alice.page, (editor, id) => editor.getShape(id) !== undefined, textId))
    .toBe(true)
  await bob.page.keyboard.press('Escape')
  await expect
    .poll(() => read(alice.page, (editor, id) => editor.getShape(id) !== undefined, textId))
    .toBe(false)
  // ...and a real deletion right after is listed, while the empty text box never is.
  await putNote(bob.page, 'Parking lot')
  await expectServerHasTab(aliceApi, board, bob.page)
  await edit(bob.page, (editor, id) => editor.deleteShapes([id]), NOTE)
  await expect(alice.page.getByTestId('deleted-row')).toHaveCount(1)
  await expect(alice.page.getByTestId('deleted-row')).toHaveAttribute('data-shape-id', NOTE)
  await expect(alice.page.getByTestId('deleted-row')).toContainText('deleted by Bob')
  const listed = (await (await aliceApi.fetch('GET', `/api/boards/${board}/deleted`)).json()) as {
    entries: { shapeId: string }[]
  }
  expect(listed.entries.map((e) => e.shapeId)).toEqual([NOTE])
})

test('owners delete checkpoints (confirmed, live for everyone); editors and name-only guests cannot, in the UI or on the server', async ({
  browser,
  session,
  board,
  users,
}) => {
  const [aliceApi, carolApi] = await Promise.all([users.api('alice'), users.api('carol')])
  const alice = await session('alice')
  const carol = await session('carol', { role: 'editor' })
  await putNote(alice.page, 'Kickoff agenda')
  await expectServerHasTab(aliceApi, board, alice.page)
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
      await expect(guest.page.getByTestId('feature-dock')).toBeVisible()
      await expect(guest.page.getByTestId('dock-tab-comments')).toBeVisible()
      await expect(guest.page.getByTestId('dock-tab-history')).toHaveCount(0)
      await expect(guest.page.getByTestId('history-panel')).toHaveCount(0)
      await guest.page.reload()
      await waitForBoard(guest.page)
      await expect(guest.page.getByTestId('dock-tab-comments')).toBeVisible()
      await expect(guest.page.getByTestId('dock-tab-history')).toHaveCount(0)
      await expect(manualRow(guest.page)).toHaveCount(0)
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
      await expect(row.getByTestId('checkpoint-delete')).toBeVisible()
      // Keyboard users keep their place: focus goes back to the delete button; Escape cancels too.
      await expect(row.getByTestId('checkpoint-delete')).toBeFocused()
      await alice.page.keyboard.press('Enter')
      await expect(row.getByTestId('checkpoint-delete-cancel')).toBeFocused()
      await alice.page.keyboard.press('Escape')
      await expect(row.getByTestId('checkpoint-delete-confirm')).toHaveCount(0)
      await expect(row.getByTestId('checkpoint-delete')).toBeFocused()
      await expect(manualRow(alice.page, 'Kickoff')).toHaveCount(1)
      await row.getByTestId('checkpoint-delete').click()
      await row.getByTestId('checkpoint-delete-confirm').click()
      await expect(alice.page.getByTestId('history-status')).toHaveText('Deleted “Kickoff”.')
      for (const page of [alice.page, carol.page]) await expect(manualRow(page)).toHaveCount(0)
      const list = await aliceApi.fetch('GET', `/api/boards/${board}/snapshots`)
      expect(
        ((await list.json()) as { snapshots: { id: string }[] }).snapshots.map((s) => s.id),
      ).not.toContain(sid)
    })
  } finally {
    await guest.context.close()
  }
})
