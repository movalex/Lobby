// Wave S, WS2: the file collector over a REAL chain on the running stack (docs/WAVE-S-CONTRACTS.md §3.4). v1 to v3 of a
// deliverable are uploaded through "Upload new version" (the versions switch on, s2-kit.ts), a comment thread is pinned
// to v1 (an `asset` anchor), the card shows v3; then the owner's storage check runs a report pass through the real
// sync server (it reads the board's canvas). The pass is complete and reports none of the chain, the chain's three
// originals stay servable, and the version list still has all three. Nothing uploaded in a run is a week old (the
// in-flight rule), so this proves the pass runs over chains end to end; the grace-period rules themselves (a superseded
// version that only a comment or an old checkpoint names survives delete mode, with its chain) are proven against the
// real upload in apps/api/test/files/versions-gc.test.ts and with real locks in versions.pg.test.ts.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e exec playwright test -c excalidraw/playwright.config.ts s2-gc
import { expect, test } from '../tests/support/canvas.ts'
import { makeImages } from '../tests/support/files.ts'
import { expectLoadedImage, imageItems, insertFiles, newItems } from './media-kit.ts'
import { chipOf, listVersions, uploadNewVersion, withVersions } from './s2-kit.ts'

test('S2 the collector keeps the whole chain and the comment-pinned v1', async ({
  canvasSession,
  board,
  users,
}) => {
  test.setTimeout(180_000)
  const a = await withVersions(await canvasSession('alice'))
  const files = await makeImages(a.page, [
    { name: 'deliverable-v1.png', w: 1200, h: 800, type: 'image/png' },
    { name: 'deliverable-v2.png', w: 1200, h: 800, type: 'image/png' },
    { name: 'deliverable-v3.png', w: 1200, h: 800, type: 'image/png' },
  ])
  const [f1, f2, f3] = files
  if (!f1 || !f2 || !f3) throw new Error('no images')
  const before = new Set((await imageItems(a.page)).map((f) => f.id))
  await insertFiles(a.page, [f1])
  const [img] = await newItems(a.page, imageItems, before, 1)
  if (!img) throw new Error('no image')
  await expectLoadedImage(a.page, img.id, board)
  const v2 = await uploadNewVersion(a.page, img.id, f2)
  const v3 = await uploadNewVersion(a.page, img.id, f3)
  await expect(chipOf(a.page, img.id)).toHaveText('v3')
  const chain = [img.facts.versionId, v2.facts.versionId, v3.facts.versionId]

  // a comment on v1 (the version the client looked at)
  const alice = await users.api('alice')
  const thread = await alice.fetch('POST', `/api/boards/${board}/threads`, {
    anchor: {
      kind: 'asset',
      shapeId: `shape:${img.id}`,
      assetId: img.facts.assetId,
      versionId: img.facts.versionId,
    },
    body: 'Logo bigger, as on v1',
  })
  expect(thread.status(), await thread.text()).toBe(201)

  const scan = await alice.fetch('POST', `/api/workspaces/${users.devStudioId}/storage/scan`)
  expect(scan.status(), await scan.text()).toBe(200)
  const report = (await scan.json()) as {
    summary: { lastRun: { mode: string; complete: boolean; boardsFailed: number } | null }
    versions: { versionId: string }[]
  }
  expect(report.summary.lastRun).toMatchObject({ mode: 'report', complete: true, boardsFailed: 0 })
  expect(report.versions.map((v) => v.versionId).filter((id) => chain.includes(id))).toEqual([])
  const again = await alice.fetch('GET', `/api/workspaces/${users.devStudioId}/storage/gc-report`)
  expect(
    ((await again.json()) as { versions: { versionId: string }[] }).versions.filter((v) =>
      chain.includes(v.versionId),
    ),
  ).toEqual([])

  // every version is still there and servable
  for (const ver of chain) {
    const res = await alice.fetch('GET', `/files/${img.facts.assetId}/${ver}/original?board=${board}`)
    expect(res.status(), ver).toBe(200)
  }
  expect(
    (await listVersions(a.page, board, img.facts.assetId)).body?.versions.map((v) => v.versionId),
  ).toEqual(chain)
})
