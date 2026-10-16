// Wave S, WS2 (docs/WAVE-S-CONTRACTS.md §3): versions of a deliverable on the Excalidraw board, with the versions
// switch on (s2-kit.ts). "Upload new version" uploads with X-Lobby-Supersedes and makes the same write as Replace
// media: the element and its asset id stay, its version moves on (v2, v3); the "v3" chip and the version list show the
// chain; a second tab sees the new version and its chip; "Make current" shows an older version without a new one; a
// viewer sees the chain but cannot add to it, and the api refuses a viewer, an older version and a version of another
// board.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e exec playwright test -c excalidraw/playwright.config.ts s2-versions
import { expect, select, selectNone, test } from '../tests/support/canvas.ts'
import { makeImages } from '../tests/support/files.ts'
import { expectLoadedImage, imageItems, insertFiles, newItems, settleCamera } from './media-kit.ts'
import { chipOf, fileOf, listVersions, rawSupersede, uploadNewVersion, withVersions } from './s2-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

test('S2 Upload new version: v2 and v3 keep the element and its asset id; chip and list; bob sees it; Make current', async ({
  canvasSession,
  board,
}) => {
  test.setTimeout(240_000)
  const a = await withVersions(await canvasSession('alice'))
  const b = await withVersions(await canvasSession('bob'))
  const [v1File, v2File, v3File] = await makeImages(a.page, [
    { name: 'key-art-v1.png', w: 1600, h: 900, type: 'image/png' },
    { name: 'key-art-v2.png', w: 1600, h: 900, type: 'image/png' },
    { name: 'key-art-v3.png', w: 900, h: 1600, type: 'image/png' },
  ])
  if (!v1File || !v2File || !v3File) throw new Error('no images')
  const before = new Set((await imageItems(a.page)).map((f) => f.id))
  await insertFiles(a.page, [v1File])
  const [img] = await newItems(a.page, imageItems, before, 1)
  if (!img) throw new Error('no image')
  await expectLoadedImage(a.page, img.id, board)
  await settleCamera(a.page)
  // one version: no chip
  await expect(chipOf(a.page, img.id)).toHaveCount(0)
  await select(a.page, [img.id])
  // the switch on: the entry reads "Upload new version" (Replace media is the same command)
  await expect(a.page.getByTestId('media-new-version')).toBeVisible()
  await expect(a.page.getByTestId('media-replace')).toHaveCount(0)

  const v2 = await uploadNewVersion(a.page, img.id, v2File)
  expect(v2.facts.assetId).toBe(img.facts.assetId)
  expect(v2.facts.versionId).not.toBe(img.facts.versionId)
  await expect(chipOf(a.page, img.id)).toHaveText('v2')
  // bob's tab: the element shows v2 (sync) and its chip says so (the board event refreshed the list)
  await fileOf(b.page, img.id, (f) => f.facts.versionId === v2.facts.versionId)
  await expect(chipOf(b.page, img.id)).toHaveText('v2', { timeout: 20_000 })

  // v3 from the version list
  await selectNone(a.page)
  await chipOf(a.page, img.id).click()
  const list = a.page.getByTestId('version-list')
  await expect(list).toBeVisible()
  await expect(list.getByTestId('version-row')).toHaveCount(2)
  const chooser = a.page.waitForEvent('filechooser')
  await list.getByTestId('version-list-upload').click()
  await (await chooser).setFiles(v3File)
  const v3 = await fileOf(a.page, img.id, (f) => f.facts.name === 'key-art-v3.png')
  expect(v3.facts.assetId).toBe(img.facts.assetId)
  await expect(chipOf(a.page, img.id)).toHaveText('v3')
  await expect(chipOf(b.page, img.id)).toHaveText('v3', { timeout: 20_000 })
  // the new proportions (portrait), as Replace media does
  await expect.poll(async () => (await fileOf(a.page, img.id, () => true)).height).toBeGreaterThan(v3.width)

  // the api's list: oldest first, the chain linear
  const listed = await listVersions(b.page, board, img.facts.assetId)
  expect(listed.status).toBe(200)
  expect(listed.body?.versions.map((v) => [v.n, v.versionId, v.name])).toEqual([
    [1, img.facts.versionId, 'key-art-v1.png'],
    [2, v2.facts.versionId, 'key-art-v2.png'],
    [3, v3.facts.versionId, 'key-art-v3.png'],
  ])
  expect(listed.body?.latestVersionId).toBe(v3.facts.versionId)

  // Make current v1 (bob): no upload, the same element shows v1 again, the chip says v1 on both tabs
  await chipOf(b.page, img.id).click()
  const bList = b.page.getByTestId('version-list')
  await expect(bList.getByTestId('version-row')).toHaveCount(3)
  await bList.locator(`[data-version="${img.facts.versionId}"]`).getByTestId('version-make-current').click()
  await fileOf(a.page, img.id, (f) => f.facts.versionId === img.facts.versionId)
  await expect(chipOf(a.page, img.id)).toHaveText('v1')
  await expect(chipOf(b.page, img.id)).toHaveText('v1')
  expect((await listVersions(a.page, board, img.facts.assetId)).body?.versions).toHaveLength(3)
  // "Upload new version" now goes on top of the newest version (v3), not v1
  const v4 = await uploadNewVersion(a.page, img.id, { ...v2File, name: 'key-art-v4.png' })
  expect(v4.facts.assetId).toBe(img.facts.assetId)
  await expect(chipOf(a.page, img.id)).toHaveText('v4')
  await expectLoadedImage(b.page, img.id, board)
})

test('S2 permissions: a viewer sees the chain but cannot add to it; the api refuses a viewer, an older version, another board', async ({
  canvasSession,
  board,
  users,
}) => {
  test.setTimeout(180_000)
  const a = await withVersions(await canvasSession('alice'))
  const v = await withVersions(await canvasSession('vic', { role: 'viewer' }))
  const [v1File, v2File] = await makeImages(a.page, [
    { name: 'poster-v1.png', w: 800, h: 1200, type: 'image/png' },
    { name: 'poster-v2.png', w: 800, h: 1200, type: 'image/png' },
  ])
  if (!v1File || !v2File) throw new Error('no images')
  const before = new Set((await imageItems(a.page)).map((f) => f.id))
  await insertFiles(a.page, [v1File])
  const [img] = await newItems(a.page, imageItems, before, 1)
  if (!img) throw new Error('no image')
  await expectLoadedImage(a.page, img.id, board)
  const v2 = await uploadNewVersion(a.page, img.id, v2File)

  // the viewer: the chip and the list, no upload, no Make current, no selection-bar entry
  await expect(chipOf(v.page, img.id)).toHaveText('v2', { timeout: 20_000 })
  await chipOf(v.page, img.id).click()
  const list = v.page.getByTestId('version-list')
  await expect(list.getByTestId('version-row')).toHaveCount(2)
  await expect(list.getByTestId('version-compare')).toHaveCount(1)
  await expect(list.getByTestId('version-make-current')).toHaveCount(0)
  await expect(list.getByTestId('version-list-upload')).toHaveCount(0)
  await v.page.keyboard.press('Escape')
  await expect(list).toHaveCount(0)
  await select(v.page, [img.id])
  await expect(v.page.getByTestId('media-new-version')).toHaveCount(0)

  // the api: a viewer 403; an older version 409 naming the newest; another board's version 404 (no probing)
  expect((await rawSupersede(v.page, board, v2.facts.versionId)).status).toBe(403)
  const old = await rawSupersede(a.page, board, img.facts.versionId)
  expect(old.status).toBe(409)
  expect(old.body).toMatchObject({
    error: { code: 'VERSION_NOT_LATEST' },
    latestVersionId: v2.facts.versionId,
  })
  const other = await users.createBoard('S2 elsewhere')
  expect((await rawSupersede(a.page, other, v2.facts.versionId)).status).toBe(404)
  expect((await rawSupersede(a.page, board, 'not-a-version')).status).toBe(400)
  // nothing of that was stored
  expect((await listVersions(a.page, board, img.facts.assetId)).body?.versions).toHaveLength(2)
  // a Dev Studio member without access to the board reads no list (the same 404 as a missing one)
  const dora = await users.api('dora')
  expect((await dora.fetch('GET', `/api/boards/${board}/asset-versions/${img.facts.assetId}`)).status()).toBe(
    404,
  )
})
