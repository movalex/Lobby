// GAP PASS (browser-test gaps on the Excalidraw canvas): Recently deleted for FILES.
//
// history-deleted.spec.ts restores frames, notes and connectors; the tldraw suite's history.spec
// "recently deleted files: an image and a PDF card deleted by alice come back with their previews, restored
// by bob" was never ported, although a restore of a file element must bring back an element whose preview the
// canvas can load again (its stable file facts, `customData.lobby.file`, and the derivative the loader
// resolves through `files.urlOf`) and a card whose face (pages, status) is drawn again.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw gaps-history-files
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, expectConverged, expectSaved, item, test } from '../tests/support/canvas.ts'
import { deletedRow, listDeleted, openHistory } from '../tests/support/history.ts'
import { FIXTURES_DIR } from '../tests/support/stack.ts'
import { deleteWithKeyboard, ref, serverElements } from './history-kit.ts'
import {
  allIds,
  cardItems,
  expectLoadedImage,
  fileCard,
  imageItems,
  insertFiles,
  newItems,
} from './media-kit.ts'

const place = async (page: Page, id: string) => {
  const e = (await item(page, id)) as { x: number; y: number; isDeleted?: boolean } | null
  return e && !e.isDeleted ? { x: Math.round(e.x), y: Math.round(e.y) } : null
}

test('Recently deleted files: an image and a PDF card deleted by alice with the keyboard come back with their previews when bob restores them, on both screens and on the server', async ({
  canvasSession,
  board,
  users,
  stack,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const bobApi = await users.api('bob')

  const before = await allIds(a.page)
  await insertFiles(a.page, [join(FIXTURES_DIR, 'image.png'), join(FIXTURES_DIR, 'document.pdf')])
  const [image] = await newItems(a.page, imageItems, before, 1)
  const [card] = await newItems(a.page, cardItems, before, 1)
  const imageId = (image as NonNullable<typeof image>).id
  const cardId = (card as NonNullable<typeof card>).id
  const pdf = (page: Page) => fileCard(page, 'document.pdf')

  await test.step('both files are ready on both screens', async () => {
    await expect(pdf(a.page)).toHaveAttribute('data-status', 'ready', { timeout: 60_000 })
    await expect(pdf(b.page)).toHaveAttribute('data-status', 'ready', { timeout: 60_000 })
    await expectLoadedImage(a.page, imageId, board)
    await expectLoadedImage(b.page, imageId, board)
    await expectSaved(a.page)
    await expectConverged(a.page, [b.page])
  })
  const was = { image: await place(a.page, imageId), card: await place(a.page, cardId) }
  expect(was.image).not.toBeNull()
  expect(was.card).not.toBeNull()

  await test.step('alice deletes both with Delete; bob’s open panel lists them and his card is gone', async () => {
    await openHistory(b.page)
    await deleteWithKeyboard(a.page, [imageId, cardId])
    await expect(deletedRow(b.page, ref(imageId))).toBeVisible()
    await expect(deletedRow(b.page, ref(cardId))).toBeVisible()
    await expect(deletedRow(b.page, ref(cardId))).toContainText('document.pdf')
    await expect(pdf(b.page)).toHaveCount(0)
    await expect(pdf(a.page)).toHaveCount(0)
    await expect.poll(() => place(b.page, imageId)).toBeNull()
  })

  await test.step('bob restores both together', async () => {
    await deletedRow(b.page, ref(imageId)).getByTestId('deleted-select').check()
    await deletedRow(b.page, ref(cardId)).getByTestId('deleted-select').check()
    await b.page.getByTestId('deleted-restore-selected').click()
    await expect(b.page.getByTestId('history-status')).toHaveText('Restored 2 objects.')
  })

  for (const s of [a, b]) {
    await test.step(`${s.user}: both are back where they were, with their previews`, async () => {
      await expect.poll(() => place(s.page, imageId)).toEqual(was.image)
      await expect.poll(() => place(s.page, cardId)).toEqual(was.card)
      await expectLoadedImage(s.page, imageId, board)
      const c = pdf(s.page)
      await expect(c).toHaveAttribute('data-status', 'ready', { timeout: 60_000 })
      await expect(c.getByTestId('file-card-pages')).toHaveText('4 pages')
      const preview = c.getByTestId('file-card-preview')
      await expect
        .poll(() => preview.evaluate((el) => (el as HTMLImageElement).naturalWidth))
        .toBeGreaterThan(0)
    })
  }

  await test.step('the list is empty again and the server stores both live', async () => {
    await expect(deletedRow(b.page)).toHaveCount(0)
    expect((await listDeleted(bobApi, board)).entries).toEqual([])
    const stored = (await serverElements(stack, board)).map((e) => e.id)
    expect(stored).toEqual(expect.arrayContaining([imageId, cardId]))
    await expectConverged(a.page, [b.page])
  })
})
