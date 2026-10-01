// PORTED from e2e/tests/offsite-backups.spec.ts (32859b1; retired with the tldraw suite) to the Excalidraw
// stack, every assertion about the feature kept. What the board holds is drawn through the facade
// (history-kit `drawFrameBoard`, media-kit `insertFiles`) instead of `window.editor`; the two kinds of file
// reference are an image element and a PDF file card, both naming their uploaded version in
// `customData.lobby.file` (apps/sync/src/r0/lb-files.ts `lbAssetRefs`); "every edit landed" is the server's
// test snapshot agreeing with the tab (excalidraw.ts `expectServerConverged`). The drill's open check is the
// element room's own store (the backup is a `lobby-elements` file; apps/sync/src/backup/drill.ts
// `openElementBoard`) where the tldraw spec read "opened through the sync room registry".
//
// Offsite board backups (docs/WAVE3-CONTRACTS.md "offsite-backups"), end to end on the real stack with
// the fs driver: a board edited in the browser is backed up by the sync server, copied to the store
// under <DATA>/blobs/backups/sync/<board>/ with a manifest that lists the files the board references,
// and `pnpm --filter @draftroom/sync backup:restore-drill --from=store` restores it from there; a damaged
// offsite copy fails the drill. R2 itself is never contacted here.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createItem, expect, test } from '../tests/support/canvas.ts'
import { expectServerConverged, serverSnapshot } from '../tests/support/excalidraw.ts'
import { fixture } from '../tests/support/history.ts'
import {
  damaged,
  drillFromStore,
  localManifest,
  OFFSITE_SYNC_ENV,
  offsiteDir,
  offsiteIndex,
  settledOffsite,
} from './backups-kit.ts'
import { settled } from './board-kit.ts'
import { drawFrameBoard } from './history-kit.ts'
import {
  cardItems,
  expectLoadedImage,
  type FileItem,
  imageItems,
  insertFiles,
  newItems,
} from './media-kit.ts'

// The sync server of this file's stack copies its backups to the fs store, and backs changed boards
// up every 1.5 s instead of every 15 minutes.
test.use({ syncEnv: OFFSITE_SYNC_ENV })

const refOf = (f: FileItem) => ({ assetId: f.facts.assetId, versionId: f.facts.versionId })

test('an edited board is copied offsite with a manifest of its files, and the drill restores it from the store', async ({
  canvasSession,
  board,
  stack,
}) => {
  const a = await canvasSession('alice')
  await drawFrameBoard(a.page, 'ob')
  // Both kinds of file element: an image, and a PDF (a file card); each names its uploaded version.
  await insertFiles(a.page, [fixture('image.png')])
  const [image] = await newItems(a.page, imageItems, new Set(), 1)
  if (!image) throw new Error('no image element')
  await expectLoadedImage(a.page, image.id, board)
  await insertFiles(a.page, [fixture('document.pdf')])
  const [card] = await newItems(a.page, cardItems, new Set(), 1)
  if (!card) throw new Error('no file card')
  expect(card.facts).toMatchObject({ kind: 'pdf', name: 'document.pdf' })
  for (const f of [image, card]) {
    expect(f.facts.assetId).toMatch(/^ast_[0-9A-Za-z]{20}$/)
    expect(f.facts.versionId).toMatch(/^ver_[0-9A-Za-z]{20}$/)
  }
  await settled(
    a.page,
    createItem(a.page, 'rectangle', { id: 'ob-last', x: 900, y: 80, width: 80, height: 80 }),
  )
  // Every edit of the tab has landed (the server's snapshot, tombstones included, agrees with the tab).
  await expectServerConverged(stack, board, [a.page])
  // Nobody edits from here on: the backups catch up with the board and stop.
  await a.context.close()

  const manifest = await settledOffsite(stack.dataDir, board)
  const newest = manifest.backups.at(-1)
  const local = localManifest(stack.dataDir, board)?.backups.at(-1)
  expect(manifest).toMatchObject({ format: 'draftroom-offsite-board-backups', boardId: board })
  expect(newest).toMatchObject({
    file: local?.file,
    key: `backups/sync/${board}/${local?.file}`,
    documentClock: local?.documentClock,
    recordCount: local?.recordCount,
    sha256: local?.sha256,
    sizeBytes: local?.sizeBytes,
    // a board born on the new canvas: copied whole, described from its lb_* tables
    format: 'lobby-elements',
  })
  expect(newest?.schema).toMatchObject({ format: 'lobby-elements' })
  // the stored object is the local backup, byte for byte
  const object = readFileSync(join(offsiteDir(stack.dataDir, board), newest?.file ?? 'missing'))
  expect(createHash('sha256').update(object).digest('hex')).toBe(newest?.sha256)
  expect(object.byteLength).toBe(newest?.sizeBytes)
  // both kinds of file references: the image's version and the PDF card's
  expect(newest?.assets).toEqual(expect.arrayContaining([refOf(image), refOf(card)]))
  // every element the server stores, tombstones included, is a record of the backup
  const stored = await serverSnapshot(stack, board)
  const live = stored.elements.filter((e) => !(e as { isDeleted?: boolean }).isDeleted).length
  const dead = stored.elements.length - live
  expect(newest?.recordCount).toBe(stored.elements.length)
  expect(offsiteIndex(stack.dataDir)?.boards).toContainEqual(
    expect.objectContaining({ boardId: board, latestFile: newest?.file }),
  )

  const run = drillFromStore(stack.dataDir, board, stack.internalSecret)
  test.info().annotations.push({ type: 'drill output', description: run.output })
  expect(run.status, run.output).toBe(0)
  expect(run.output).toContain(`PASS ${board} ${newest?.file}`)
  expect(run.output).toContain(
    `downloaded backups/sync/${board}/${newest?.file} from the fs store (${newest?.sizeBytes} bytes)`,
  )
  expect(run.output).toContain('file sha256 matches the manifest')
  expect(run.output).toContain('restored into a clean data dir')
  expect(run.output).toContain(
    `${newest?.recordCount} records, clock ${newest?.documentClock}, digest matches`,
  )
  expect(run.output).toContain(
    `opened through the element room's store: ${live} live elements and ${dead} tombstones, every row readable, clock ${newest?.documentClock}`,
  )
  expect(run.output).toContain('identical to the live board (unchanged since the backup)')
  expect(run.output).toContain('restore drill passed')
  expect(run.output).not.toContain('FAIL')
})

test('a damaged offsite copy fails the drill from the store', async ({ canvasSession, board, stack }) => {
  const a = await canvasSession('alice')
  await drawFrameBoard(a.page, 'od')
  await a.context.close()
  const manifest = await settledOffsite(stack.dataDir, board)
  const file = join(offsiteDir(stack.dataDir, board), manifest.backups.at(-1)?.file ?? 'missing')
  const original = readFileSync(file)
  writeFileSync(file, damaged(original))
  try {
    const run = drillFromStore(stack.dataDir, board, stack.internalSecret)
    expect(run.status, run.output).toBe(1)
    expect(run.output).toContain(`FAIL ${board}`)
    expect(run.output).toContain('backup file checksum does not match its manifest')
    expect(run.output).toContain('restore drill FAILED')
  } finally {
    writeFileSync(file, original)
  }
  expect(drillFromStore(stack.dataDir, board, stack.internalSecret).status).toBe(0)
})
