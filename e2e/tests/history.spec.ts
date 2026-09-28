// History (docs/FEATURES-M2-CONTRACTS.md "history"; checklist REV-07, REV-08, DSH-02, DSH-03, PRS-11,
// PRF-08; scenarios tagged [history] in docs/E2E-PLAN.md): named checkpoints restored as a new private
// board, "Recently deleted" with restore, duplicate (history panel and dashboard), Trash restore,
// .json export/import, and the backup restore drill. Everything is driven through the real UI of two
// (or more) browsers; what the SERVER stored is read back through the API (the board export is the
// sync room's own snapshot), never from the acting tab alone.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { Api } from './support/api.ts'
import {
  type BoardDocument,
  boardDocument,
  documentDiff,
  edit,
  expectConn,
  expectConverged,
  fileCard,
  getShape,
  insertFiles,
  read,
  shapeText,
  startTextEditing,
  stopTextEditing,
  typeText,
  waitForBoard,
} from './support/board.ts'
import { richText, type ShapeLike } from './support/editor.ts'
import { expect, test } from './support/fixtures.ts'
import {
  boundEnds,
  checkpointRow,
  clickEmptyCanvas,
  deletedRow,
  deleteWithKeyboard,
  describeShape,
  drawFrameBoard,
  expectImageRendered,
  expectServerHasTab,
  type FileRef,
  fileStatus,
  fixture,
  type HistoryEditorLike,
  historyPanel,
  listDeleted,
  listSnapshots,
  openHistory,
  placement,
  runRestoreDrill,
  selectedIds,
  serverArchive,
  serverBindings,
  serverShapes,
  undoWithKeyboard,
  uploadImage,
} from './support/history.ts'
import { capture } from './support/screenshots.ts'

/** Shapes and bindings only (the uploading tab may still touch its asset record for previews). */
const content = (d: BoardDocument): BoardDocument => ({ shapes: d.shapes, bindings: d.bindings, assets: {} })

const boardCard = (page: Page, boardId: string) =>
  page.locator(`[data-testid="board-card"][data-board-id="${boardId}"]`)

async function cardMenu(page: Page, boardId: string, action: string) {
  await boardCard(page, boardId).getByTestId('board-card-menu').click()
  await boardCard(page, boardId).locator(`[role="menuitem"][data-action="${action}"]`).click()
}

/** The board id a history-open-board link points at. */
async function openBoardTarget(page: Page): Promise<string> {
  const href = (await page.getByTestId('history-open-board').getAttribute('href')) ?? ''
  const id = /^\/b\/(b-[0-9a-z]{10})$/.exec(href)?.[1]
  if (!id) throw new Error(`unexpected open-board href ${href}`)
  return id
}

/** Follows history-open-board and waits until the NEW board's editor is live. */
async function followOpenBoard(page: Page, boardId: string, title: string) {
  await page.getByTestId('history-open-board').click()
  await expect(page).toHaveURL(new RegExp(`/b/${boardId}$`))
  await expect(page.getByTestId('board-title')).toHaveText(title)
  await waitForBoard(page)
}

/** Grants-only people of a board as the server lists them, e.g. { 'usr_…': 'owner' }. */
async function grants(api: Api, boardId: string) {
  const members = await api.members(boardId)
  return Object.fromEntries(members.filter((m) => m.source === 'grant').map((m) => [m.user.id, m.role]))
}

/** The copy serves the file; a board that does not show it gets 404 for the very same asset. */
async function expectFileScopedTo(api: Api, file: FileRef, shownOn: string[], notShownOn: string) {
  for (const b of shownOn) expect(await fileStatus(api, file, b), `file on ${b}`).toBe(200)
  expect(await fileStatus(api, file, notShownOn), `file on unrelated ${notShownOn}`).toBe(404)
}

// ---- P0 -----------------------------------------------------------------------------------------

test('checkpoint round trip: bob sees the named checkpoint live; restoring it after a delete makes a private board with the note and its image, bob has no access, the original keeps the delete', async ({
  session,
  board,
  users,
}) => {
  const a = await session('alice')
  const b = await session('bob') // editor on the original
  const [aliceApi, bobApi] = await Promise.all([users.api('alice'), users.api('bob')])
  const ids = await drawFrameBoard(a.page, 'cp')
  const image = await uploadImage(a.page, board)
  await expectConverged(a.page, [b.page])
  const atCheckpoint = content(await boardDocument(a.page))
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
  await expect.poll(() => getShape(b.page, ids.note1)).toBeNull()

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

  await test.step('the new board holds the checkpoint: the note is back in its frame, bound, image rendered', async () => {
    await expect
      .poll(async () => documentDiff(atCheckpoint, content(await boardDocument(a.page))), {
        message: 'restored board differs from the checkpoint',
      })
      .toEqual([])
    expect(await placement(a.page, ids.note1)).toMatchObject({ parentId: ids.frame, x: 30, y: 60 })
    expect(await boundEnds(a.page, ids.arrow)).toEqual([`end->${ids.box}`, `start->${ids.note1}`])
    await expect(a.page.locator(`[data-shape-id="${ids.note1}"] .tl-rich-text`)).toHaveText(
      'Ship the moodboard',
    )
    await expectImageRendered(a.page, image.shapeId, copy)
    // What the sync server stored for the copy, not only what this tab shows.
    const stored = await serverShapes(aliceApi, copy)
    expect(Object.keys(stored).sort()).toEqual(Object.keys(atCheckpoint.shapes).sort())
    await capture('history-restored-checkpoint.png', a.page, test.info())
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
    const original = await serverShapes(aliceApi, board)
    expect(original[ids.note1]).toBeUndefined()
    expect(Object.keys(original).sort()).toEqual(
      Object.keys(atCheckpoint.shapes)
        .filter((id) => id !== ids.note1)
        .sort(),
    )
    expect(await getShape(b.page, ids.note1)).toBeNull()
    expect((await aliceApi.getBoard(board)).board.title).toBe(title)
  })

  await test.step('files follow the copy: served for the copy, 404 for an unrelated board', async () => {
    const unrelated = await users.createBoard('Unrelated board')
    await expectFileScopedTo(aliceApi, image.file, [board, copy], unrelated)
  })
})

test('recently deleted frame: its 2 notes come back in place inside it, the connector is re-bound, the frame is selected, and bob sees it all', async ({
  session,
  board,
  users,
}) => {
  const a = await session('alice')
  const b = await session('bob')
  const bobApi = await users.api('bob')
  const ids = await drawFrameBoard(a.page, 'rd')
  await expectConverged(a.page, [b.page])
  const before = {
    frame: await placement(a.page, ids.frame),
    note1: await placement(a.page, ids.note1),
    note2: await placement(a.page, ids.note2),
  }
  expect(before.note1?.parentId).toBe(ids.frame)
  const bound = [`end->${ids.box}`, `start->${ids.note1}`]
  expect(await boundEnds(b.page, ids.arrow)).toEqual(bound)

  await openHistory(a.page)
  await openHistory(b.page)
  await expect(historyPanel(b.page)).toContainText('Nothing deleted recently.')

  await deleteWithKeyboard(a.page, [ids.frame])
  await test.step('the frame and its notes are gone for both; the connector lost its note end', async () => {
    for (const s of [a, b]) {
      await expect
        .poll(() =>
          read(s.page, (ed, list) => list.filter((id) => ed.getShape(id)).length, [
            ids.frame,
            ids.note1,
            ids.note2,
          ]),
        )
        .toBe(0)
      await expect.poll(() => boundEnds(s.page, ids.arrow)).toEqual([`end->${ids.box}`])
    }
  })

  await test.step('bob’s panel lists one row: the frame, “2 objects inside”, deleted by alice', async () => {
    const row = deletedRow(b.page, ids.frame)
    await expect(row).toContainText('Sprint ideas')
    await expect(row).toContainText('Frame · 2 objects inside')
    await expect(row).toContainText(`deleted by ${a.name}`)
    await expect(deletedRow(b.page)).toHaveCount(1)
    expect((await listDeleted(bobApi, board)).entries).toEqual([
      expect.objectContaining({
        shapeId: ids.frame,
        type: 'frame',
        label: 'Sprint ideas',
        childCount: 2,
        deletedBy: { id: a.id, name: a.name },
      }),
    ])
  })

  await deletedRow(a.page, ids.frame).getByTestId('deleted-restore').click()
  await expect(a.page.getByTestId('history-status')).toHaveText(
    'Restored 3 objects, reconnected 1 connection.',
  )

  await test.step('back at the same x/y inside the frame, re-bound, on both clients and on the server', async () => {
    for (const s of [a, b]) {
      await expect.poll(() => placement(s.page, ids.frame)).toEqual(before.frame)
      await expect.poll(() => placement(s.page, ids.note1)).toEqual(before.note1)
      await expect.poll(() => placement(s.page, ids.note2)).toEqual(before.note2)
      await expect.poll(() => boundEnds(s.page, ids.arrow)).toEqual(bound)
      await expect(deletedRow(s.page)).toHaveCount(0)
    }
    await expect(b.page.locator('.tl-frame-heading').filter({ hasText: 'Sprint ideas' })).toBeVisible()
    const stored = await serverShapes(bobApi, board)
    expect(stored[ids.note1]).toMatchObject({ parentId: ids.frame, x: before.note1?.x, y: before.note1?.y })
    expect(stored[ids.note2]).toMatchObject({ parentId: ids.frame })
    expect(
      (await serverBindings(bobApi, board))
        .filter((x) => x.fromId === ids.arrow)
        .map((x) => `${x.props.terminal}->${x.toId}`)
        .sort(),
    ).toEqual(bound)
    expect((await listDeleted(bobApi, board)).entries).toEqual([])
  })

  await test.step('the restored frame is what is selected, and dragging it carries its notes along', async () => {
    await expect.poll(() => selectedIds(a.page)).toEqual([ids.frame])
    // The restore brings the frame into view with a short camera animation: let it finish first.
    let last = ''
    await expect
      .poll(
        async () => {
          const cam = JSON.stringify(
            await read(a.page, (ed) =>
              (
                ed as unknown as HistoryEditorLike & {
                  getCamera(): unknown
                }
              ).getCamera(),
            ),
          )
          const settled = cam === last
          last = cam
          return settled
        },
        { intervals: [200] },
      )
      .toBe(true)
    const zoom = await read(a.page, (ed) => (ed as unknown as { getZoomLevel(): number }).getZoomLevel())
    const heading = a.page.locator(`[data-shape-id="${ids.frame}"] .tl-frame-heading`)
    const box = await heading.boundingBox()
    if (!box) throw new Error('frame heading not rendered')
    const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    await a.page.mouse.move(from.x, from.y)
    await a.page.mouse.down()
    await a.page.mouse.move(from.x + 90, from.y + 45, { steps: 12 })
    await a.page.mouse.up()
    const dx = 90 / zoom
    const dy = 45 / zoom
    for (const s of [a, b]) {
      await expect
        .poll(async () => {
          const f = await placement(s.page, ids.frame)
          return f
            ? [Math.round(f.x - (before.frame?.x ?? 0)), Math.round(f.y - (before.frame?.y ?? 0))]
            : null
        })
        .toEqual([Math.round(dx), Math.round(dy)])
      // The notes moved WITH the frame: their place inside it is unchanged.
      expect(await placement(s.page, ids.note1)).toEqual(before.note1)
      expect(await placement(s.page, ids.note2)).toEqual(before.note2)
    }
  })
})

test('recently deleted note and connector: deleted together by alice, restored together by bob (multi-select) into the frame and re-bound for both', async ({
  session,
  board,
  users,
}) => {
  const a = await session('alice')
  const b = await session('bob')
  const bobApi = await users.api('bob')
  const ids = await drawFrameBoard(a.page, 'nc')
  await expectConverged(a.page, [b.page])
  const before = { note1: await placement(a.page, ids.note1), arrow: await placement(a.page, ids.arrow) }
  const bound = [`end->${ids.box}`, `start->${ids.note1}`]

  await openHistory(a.page)
  await openHistory(b.page)
  await deleteWithKeyboard(a.page, [ids.note1, ids.arrow])
  await expect.poll(() => getShape(b.page, ids.arrow)).toBeNull()

  await test.step('bob sees both rows: the note by its text, the connector by its kind', async () => {
    await expect(deletedRow(b.page, ids.note1)).toContainText('Ship the moodboard')
    await expect(deletedRow(b.page, ids.note1)).toContainText('Sticky note')
    await expect(deletedRow(b.page, ids.arrow)).toContainText('Connector')
    await expect(deletedRow(b.page)).toHaveCount(2)
    expect(
      (await listDeleted(bobApi, board)).entries.map((e) => [e.shapeId, e.type, e.deletedBy.id]).sort(),
    ).toEqual(
      [
        [ids.arrow, 'arrow', a.id],
        [ids.note1, 'note', a.id],
      ].sort(),
    )
  })

  await test.step('bob ticks both rows and restores the selection', async () => {
    await expect(b.page.getByTestId('deleted-restore-selected')).toHaveCount(0)
    await deletedRow(b.page, ids.note1).getByTestId('deleted-select').check()
    await expect(b.page.getByTestId('deleted-restore-selected')).toHaveText('Restore 1 selected object')
    await deletedRow(b.page, ids.arrow).getByTestId('deleted-select').check()
    await expect(b.page.getByTestId('deleted-restore-selected')).toHaveText('Restore 2 selected objects')
    await b.page.getByTestId('deleted-restore-selected').click()
    await expect(b.page.getByTestId('history-status')).toHaveText(
      'Restored 2 objects, reconnected 2 connections.',
    )
  })

  await test.step('both are back in place (the note inside its frame), the connector bound at both ends', async () => {
    for (const s of [a, b]) {
      await expect.poll(() => placement(s.page, ids.note1)).toEqual(before.note1)
      await expect.poll(() => placement(s.page, ids.arrow)).toEqual(before.arrow)
      await expect.poll(() => boundEnds(s.page, ids.arrow)).toEqual(bound)
      await expect(deletedRow(s.page)).toHaveCount(0)
    }
    expect(before.note1?.parentId).toBe(ids.frame)
    await expect.poll(() => selectedIds(b.page)).toEqual([ids.arrow, ids.note1].sort())
    const stored = await serverShapes(bobApi, board)
    expect(stored[ids.note1]).toMatchObject({ parentId: ids.frame })
    expect(stored[ids.arrow]).toBeDefined()
    expect((await listDeleted(bobApi, board)).entries).toEqual([])
    await expectConverged(a.page, [b.page])
  })
})

test('recently deleted note whose frame is gone: restoring it puts it on the page where it was and reconnects its connector; the frame comes back without it', async ({
  session,
  board,
  users,
}) => {
  const a = await session('alice')
  const b = await session('bob')
  const bobApi = await users.api('bob')
  const ids = await drawFrameBoard(a.page, 'rp')
  await expectConverged(a.page, [b.page])
  const pageId = await read(a.page, (ed) =>
    (ed as unknown as { getCurrentPageId(): string }).getCurrentPageId(),
  )
  const onPage = await read(
    a.page,
    (ed, id) => {
      const p = (ed as HistoryEditorLike).getShapePageTransform(id).point()
      return { x: p.x, y: p.y }
    },
    ids.note1,
  )
  const note2 = await placement(a.page, ids.note2)

  await openHistory(a.page)
  await openHistory(b.page)
  await deleteWithKeyboard(a.page, [ids.note1])
  await expect(deletedRow(b.page, ids.note1)).toBeVisible()
  await deleteWithKeyboard(a.page, [ids.frame])
  await expect(deletedRow(b.page, ids.frame)).toContainText('Frame · 1 object inside')
  await expect(deletedRow(b.page)).toHaveCount(2)

  await test.step('bob restores only the note: it lands on the page at the same place', async () => {
    await deletedRow(b.page, ids.note1).getByTestId('deleted-restore').click()
    await expect(b.page.getByTestId('history-status')).toHaveText(
      'Restored 1 object, reconnected 1 connection, 1 object placed on the board (the frame is gone).',
    )
    for (const s of [a, b]) {
      await expect.poll(() => placement(s.page, ids.note1)).toEqual({ parentId: pageId, ...onPage })
      await expect
        .poll(() => boundEnds(s.page, ids.arrow))
        .toEqual([`end->${ids.box}`, `start->${ids.note1}`])
      expect(await getShape(s.page, ids.frame)).toBeNull()
      await expect(deletedRow(s.page, ids.note1)).toHaveCount(0)
      await expect(deletedRow(s.page, ids.frame)).toBeVisible()
    }
    expect((await serverShapes(bobApi, board))[ids.note1]).toMatchObject({ parentId: pageId, ...onPage })
  })

  await test.step('then the frame comes back with the note that was deleted with it', async () => {
    await deletedRow(a.page, ids.frame).getByTestId('deleted-restore').click()
    await expect(a.page.getByTestId('history-status')).toHaveText('Restored 2 objects.')
    for (const s of [a, b]) {
      await expect.poll(() => placement(s.page, ids.note2)).toEqual(note2)
      expect(await placement(s.page, ids.note1)).toEqual({ parentId: pageId, ...onPage })
      await expect(deletedRow(s.page)).toHaveCount(0)
    }
    expect((await listDeleted(bobApi, board)).entries).toEqual([])
    await expectConverged(a.page, [b.page])
  })
})

test('recently deleted files: an image and a PDF card deleted by alice come back with their previews, restored by bob', async ({
  session,
  board,
  users,
}) => {
  const a = await session('alice')
  const b = await session('bob')
  const bobApi = await users.api('bob')
  const image = await uploadImage(a.page, board)
  await insertFiles(a.page, [fixture('document.pdf')])
  const pdfCard = (page: Page) => fileCard(page, 'document.pdf')
  await expect(pdfCard(b.page)).toHaveAttribute('data-status', 'ready', { timeout: 30_000 })
  const cardId = (await pdfCard(a.page)
    .locator('xpath=ancestor::*[@data-shape-id][1]')
    .getAttribute('data-shape-id')) as string
  expect(cardId).toMatch(/^shape:/)
  await expectConverged(a.page, [b.page])
  const before = content(await boardDocument(a.page))

  await openHistory(b.page)
  await deleteWithKeyboard(a.page, [image.shapeId, cardId])
  await expect(deletedRow(b.page, image.shapeId)).toContainText('Image')
  await expect(deletedRow(b.page, cardId)).toContainText('document.pdf')
  await expect(deletedRow(b.page, cardId)).toContainText('File')
  await expect(pdfCard(b.page)).toHaveCount(0)

  await deletedRow(b.page, image.shapeId).getByTestId('deleted-select').check()
  await deletedRow(b.page, cardId).getByTestId('deleted-select').check()
  await b.page.getByTestId('deleted-restore-selected').click()
  await expect(b.page.getByTestId('history-status')).toHaveText('Restored 2 objects.')

  for (const s of [a, b]) {
    await expect.poll(async () => documentDiff(before, content(await boardDocument(s.page)))).toEqual([])
    await expectImageRendered(s.page, image.shapeId, board)
    const card = pdfCard(s.page)
    await expect(card).toHaveAttribute('data-status', 'ready')
    await expect(card.getByTestId('file-card-pages')).toHaveText('4 pages')
    const preview = card.getByTestId('file-card-preview')
    await expect(preview).toHaveAttribute('src', new RegExp(`/d/drv_\\w{20}\\?board=${board}$`))
    await expect
      .poll(() => preview.evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0)
  }
  expect((await listDeleted(bobApi, board)).entries).toEqual([])
})

test('viewer and commenter: history rows are listed without restore, save or select controls, and forged restore or checkpoint POSTs get 403', async ({
  session,
  board,
  users,
}) => {
  const NOTE = 'shape:vc-note'
  const KEEP = 'shape:vc-keep'
  const a = await session('alice')
  await edit(
    a.page,
    (ed, x) =>
      ed.createShapes([
        { id: x.note, type: 'note', x: 120, y: 120, props: { richText: x.t1 } },
        { id: x.keep, type: 'note', x: 380, y: 120, props: { richText: x.t2, color: 'green' } },
      ]),
    { note: NOTE, keep: KEEP, t1: richText('Pitch deck outline'), t2: richText('Keep this one') },
  )
  const aliceApi = await users.api('alice')
  // A create and a delete sent in the same push never reach the server as a delete: let it land.
  await expectServerHasTab(aliceApi, board, a.page)
  await deleteWithKeyboard(a.page, [NOTE])
  await expect
    .poll(async () => (await listDeleted(aliceApi, board)).entries.map((e) => e.shapeId))
    .toEqual([NOTE])
  const saved = await aliceApi.fetch('POST', `/api/boards/${board}/snapshots`, { name: 'Review baseline' })
  expect(saved.status()).toBe(201)
  const snapshotId = ((await saved.json()) as { id: string }).id
  const title = await a.page.getByTestId('board-title').innerText()

  const viewer = await session('bob', { role: 'viewer' })
  const commenter = await session('carol', { role: 'commenter' })
  for (const s of [viewer, commenter]) {
    await test.step(`${s.user}: sees the rows, gets no editing controls`, async () => {
      await openHistory(s.page)
      await expect(deletedRow(s.page, NOTE)).toContainText('Pitch deck outline')
      await expect(deletedRow(s.page, NOTE)).toContainText(`deleted by ${a.name}`)
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
      // What they may do: a private copy of their own, and the export.
      await expect(checkpointRow(s.page, snapshotId).getByTestId('checkpoint-restore')).toBeVisible()
      await expect(s.page.getByTestId('history-duplicate')).toBeVisible()
      await expect(s.page.getByTestId('export-json')).toBeVisible()
    })
    await test.step(`${s.user}: forged requests are refused by the server`, async () => {
      const api = await users.api(s.user)
      const restore = await api.fetch('POST', `/api/boards/${board}/deleted/restore`, { ids: [NOTE] })
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
    // The checkpoint was taken after the delete: only the kept note is on the copy.
    expect(Object.keys(await serverShapes(carolApi, copy))).toEqual([KEEP])
    expect((await (await users.api('bob')).fetch('GET', `/api/boards/${copy}`)).status()).toBe(404)
  })

  // Nothing changed on the original: the note is still deleted and listed, one checkpoint.
  expect((await listDeleted(aliceApi, board)).entries.map((e) => e.shapeId)).toEqual([NOTE])
  expect((await serverShapes(aliceApi, board))[NOTE]).toBeUndefined()
  expect((await listSnapshots(aliceApi, board)).map((s) => s.name)).toEqual(['Review baseline'])
  expect(await getShape(a.page, NOTE)).toBeNull()
})

test('live list: bob’s delete appears in alice’s open panel within about 2 s and his undo removes it; a delete vetoed by the text lease is never listed', async ({
  session,
  board,
  users,
}) => {
  const GONE = 'shape:live-gone'
  const LEASED = 'shape:live-leased'
  const a = await session('alice')
  const b = await session('bob')
  const aliceApi = await users.api('alice')
  await edit(
    a.page,
    (ed, x) =>
      ed.createShapes([
        { id: x.gone, type: 'note', x: 100, y: 120, props: { richText: x.t1 } },
        { id: x.leased, type: 'note', x: 380, y: 120, props: { richText: x.t2 } },
      ]),
    { gone: GONE, leased: LEASED, t1: richText('Bob removes this'), t2: richText('') },
  )
  await expectConverged(a.page, [b.page])
  await openHistory(a.page)
  await expect(historyPanel(a.page)).toContainText('Nothing deleted recently.')

  await test.step('bob deletes a note: alice’s panel gains the row within about 2 s', async () => {
    await deleteWithKeyboard(b.page, [GONE])
    const t0 = Date.now()
    await expect(deletedRow(a.page, GONE)).toBeVisible({ timeout: 2_500 })
    test.info().annotations.push({ type: 'row appeared after (ms)', description: String(Date.now() - t0) })
    await expect(deletedRow(a.page, GONE)).toContainText(`deleted by ${b.name}`)
  })

  await test.step('bob’s Ctrl+Z brings it back, and the row leaves alice’s panel', async () => {
    await undoWithKeyboard(b.page)
    await expect.poll(() => getShape(a.page, GONE).then((s) => s !== null)).toBe(true)
    const t0 = Date.now()
    await expect(deletedRow(a.page, GONE)).toHaveCount(0, { timeout: 2_500 })
    test.info().annotations.push({ type: 'row left after (ms)', description: String(Date.now() - t0) })
    expect((await listDeleted(aliceApi, board)).entries).toEqual([])
  })

  await test.step('a delete the text lease vetoes (lease-toast) is not listed', async () => {
    await startTextEditing(a.page, LEASED)
    await typeText(a.page, 'Alice is typing')
    await expect.poll(() => shapeText(b.page, LEASED)).toBe('Alice is typing')
    await clickEmptyCanvas(b.page)
    await edit(b.page, (ed, id) => ed.select(id), LEASED)
    await b.page.keyboard.press('Delete')
    await expect(b.page.getByTestId('lease-toast')).toHaveText(`${a.name} is editing this text`)
    // The server refused the delete: bob's copy gets the note back, alice never lost it.
    await expect.poll(() => shapeText(b.page, LEASED)).toBe('Alice is typing')
    expect(await shapeText(a.page, LEASED)).toBe('Alice is typing')
    expect((await listDeleted(aliceApi, board)).entries).toEqual([])
    // bob's own panel (his tab saw the note leave and come back) does not list it either.
    await openHistory(b.page)
    await expect(historyPanel(b.page)).toContainText('Nothing deleted recently.')
    await expect(deletedRow(a.page)).toHaveCount(0)
    await stopTextEditing(a.page)
  })
})

test('duplicate from the history panel: a viewer gets a private copy they own with working files; the owner’s keep-sharing copy has visibility and grants but no invitations or review links', async ({
  session,
  board,
  users,
}) => {
  const a = await session('alice')
  const ids = await drawFrameBoard(a.page, 'dup')
  const image = await uploadImage(a.page, board)
  // A PDF card too: file cards reference their upload by props (images by an asset record).
  await insertFiles(a.page, [fixture('document.pdf')])
  await expect(fileCard(a.page, 'document.pdf')).toHaveAttribute('data-status', 'ready', { timeout: 30_000 })
  const [aliceApi, bobApi, carolApi] = await Promise.all([
    users.api('alice'),
    users.api('bob'),
    users.api('carol'),
  ])
  const title = await a.page.getByTestId('board-title').innerText()
  const v = await session('bob', { role: 'viewer' })
  await expectConverged(a.page, [v.page])
  const source = content(await boardDocument(a.page))

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

  await test.step('bob opens his copy: same content, the image renders for the copy', async () => {
    await followOpenBoard(v.page, viewerCopy, `Copy of ${title}`)
    // bob owns this one: an editable board, not the read-only source.
    await expect(v.page.getByTestId('readonly-pill')).toHaveCount(0)
    await expect.poll(async () => documentDiff(source, content(await boardDocument(v.page)))).toEqual([])
    expect(await boundEnds(v.page, ids.arrow)).toEqual([`end->${ids.box}`, `start->${ids.note1}`])
    await expectImageRendered(v.page, image.shapeId, viewerCopy)
    const card = fileCard(v.page, 'document.pdf')
    await expect(card).toHaveAttribute('data-status', 'ready')
    const preview = card.getByTestId('file-card-preview')
    await expect(preview).toHaveAttribute('src', new RegExp(`/d/drv_\\w{20}\\?board=${viewerCopy}$`))
    await expect
      .poll(() => preview.evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0)
    const download = (await card.getByTestId('file-card-download').getAttribute('href')) ?? ''
    expect(download).toMatch(new RegExp(`\\?board=${viewerCopy}$`))
    expect((await v.page.request.get(download)).status()).toBe(200)
    const unrelated = await users.createBoard('Unrelated to the copy')
    await users.grant(unrelated, 'bob', 'viewer')
    await expectFileScopedTo(bobApi, image.file, [viewerCopy], unrelated)
  })

  await test.step('owner with keep sharing: visibility and people grants, never invitations or links', async () => {
    const carol = await users.grant(board, 'carol', 'commenter')
    await aliceApi.patchBoard(board, { visibility: 'workspace_view' })
    const invite = await aliceApi.fetch('POST', `/api/boards/${board}/invitations`, { role: 'commenter' })
    expect(invite.status()).toBe(201)
    const link = await aliceApi.fetch('POST', `/api/boards/${board}/review-links`, {})
    expect(link.status()).toBe(201)
    const sourceInvitations = await aliceApi.fetch('GET', `/api/boards/${board}/invitations`)
    expect(((await sourceInvitations.json()) as { invitations: unknown[] }).invitations).toHaveLength(2)

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
    // carol can open it through her copied grant; the source's links still exist.
    expect(await carolApi.getBoard(shared)).toMatchObject({ role: 'commenter' })
    const after = await aliceApi.fetch('GET', `/api/boards/${board}/invitations`)
    expect(((await after.json()) as { invitations: unknown[] }).invitations).toHaveLength(2)
    expect(Object.keys(await serverShapes(aliceApi, shared)).sort()).toEqual(
      Object.keys(source.shapes).sort(),
    )
  })
})

test('duplicate from the dashboard card menu: duplicate-dialog prefilled “<title> (copy)” makes a private copy with the same content and a working image', async ({
  session,
  board,
  users,
}) => {
  const a = await session('alice')
  const ids = await drawFrameBoard(a.page, 'dd')
  const image = await uploadImage(a.page, board)
  const aliceApi = await users.api('alice')
  const title = await a.page.getByTestId('board-title').innerText()
  // The server has every shape before the copy is taken.
  await expectServerHasTab(aliceApi, board, a.page)
  const source = content(await boardDocument(a.page))

  await a.page.goto(`/w/${users.devStudioId}`)
  await a.page.getByTestId('nav-all').click()
  await cardMenu(a.page, board, 'duplicate')
  const dialog = a.page.getByTestId('duplicate-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId('duplicate-title')).toHaveValue(`${title} (copy)`)
  await expect(dialog.getByTestId('duplicate-keep-sharing')).not.toBeChecked()
  const created = a.page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith(`/api/boards/${board}/duplicate`),
  )
  await dialog.getByTestId('duplicate-submit').click()
  const res = await created
  expect(res.status()).toBe(201)
  const copy = ((await res.json()) as { board: { id: string } }).board.id
  await expect(dialog).toHaveCount(0)
  await expect(a.page.getByTestId('dashboard-toast')).toContainText(`Duplicated as “${title} (copy)”`)
  await expect(boardCard(a.page, copy)).toHaveAttribute('data-role', 'owner')

  expect(await aliceApi.getBoard(copy)).toMatchObject({
    board: { title: `${title} (copy)`, visibility: 'private' },
    role: 'owner',
  })
  expect(await grants(aliceApi, copy)).toEqual({ [a.id]: 'owner' })

  await boardCard(a.page, copy).getByRole('link').first().click()
  await expect(a.page).toHaveURL(new RegExp(`/b/${copy}$`))
  await waitForBoard(a.page)
  await expect(a.page.getByTestId('board-title')).toHaveText(`${title} (copy)`)
  await expect.poll(async () => documentDiff(source, content(await boardDocument(a.page)))).toEqual([])
  expect(await boundEnds(a.page, ids.arrow)).toEqual([`end->${ids.box}`, `start->${ids.note1}`])
  await expectImageRendered(a.page, image.shapeId, copy)
  await expectFileScopedTo(aliceApi, image.file, [copy], await users.createBoard('Not the copy'))
})

test('trash restore keeps content and files: a board trashed from the dashboard and restored from Trash opens with the same shapes and its image', async ({
  session,
  board,
  users,
}) => {
  const a = await session('alice')
  const ids = await drawFrameBoard(a.page, 'tr')
  const image = await uploadImage(a.page, board)
  const aliceApi = await users.api('alice')
  const wid = users.devStudioId
  await expectServerHasTab(aliceApi, board, a.page)
  const before = content(await boardDocument(a.page))

  await a.page.goto(`/w/${wid}`)
  await a.page.getByTestId('nav-all').click()
  await cardMenu(a.page, board, 'trash')
  await expect(boardCard(a.page, board)).toHaveCount(0)
  await expect
    .poll(async () => (await aliceApi.listBoards(wid, 'trashed')).some((x) => x.id === board))
    .toBe(true)
  expect((await aliceApi.fetch('GET', `/api/boards/${board}/export`)).status()).toBe(404)

  await a.page.goto(`/w/${wid}/trash`)
  await expect(a.page.getByTestId('trash-note')).toBeVisible()
  await expect(boardCard(a.page, board)).toHaveAttribute('data-status', 'trashed')
  await cardMenu(a.page, board, 'restore')
  await expect(boardCard(a.page, board)).toHaveCount(0)
  await expect.poll(async () => (await aliceApi.getBoard(board)).board.status).toBe('active')

  await a.page.goto(`/w/${wid}`)
  await a.page.getByTestId('nav-all').click()
  await boardCard(a.page, board).getByRole('link').first().click()
  await expect(a.page).toHaveURL(new RegExp(`/b/${board}$`))
  await waitForBoard(a.page)
  await expect.poll(async () => documentDiff(before, content(await boardDocument(a.page)))).toEqual([])
  expect(await boundEnds(a.page, ids.arrow)).toEqual([`end->${ids.box}`, `start->${ids.note1}`])
  await expectImageRendered(a.page, image.shapeId, board)
  expect(await fileStatus(aliceApi, image.file, board)).toBe(200)
  expect(Object.keys(await serverShapes(aliceApi, board)).sort()).toEqual(Object.keys(before.shapes).sort())
})

// ---- P1 -----------------------------------------------------------------------------------------

test('export .json and import it on the dashboard: same shapes, frame, connector, image and PDF card under fresh ids; broken files are refused without a new board', async ({
  session,
  board,
  users,
}, testInfo) => {
  const a = await session('alice')
  const ids = await drawFrameBoard(a.page, 'ex')
  const image = await uploadImage(a.page, board)
  await insertFiles(a.page, [fixture('document.pdf')])
  await expect(fileCard(a.page, 'document.pdf')).toHaveAttribute('data-status', 'ready', { timeout: 30_000 })
  const aliceApi = await users.api('alice')
  const wid = users.devStudioId
  const title = await a.page.getByTestId('board-title').innerText()
  await expectServerHasTab(aliceApi, board, a.page)
  const source = Object.values(await serverShapes(aliceApi, board))
  const pdf = source.find((s) => s.type === 'dr-file-card')?.props as FileRef | undefined
  if (!pdf) throw new Error('no file card on the source board')

  let file = ''
  await test.step('export-json downloads “<title>.lobby.json” in the draftroom-board format', async () => {
    await openHistory(a.page)
    const download = a.page.waitForEvent('download')
    await a.page.getByTestId('export-json').click()
    const d = await download
    expect(d.suggestedFilename()).toBe(`${title}.lobby.json`)
    file = testInfo.outputPath(d.suggestedFilename())
    await d.saveAs(file)
    await expect(a.page.getByTestId('history-status')).toContainText('Board exported as a .json file')
    const archive = JSON.parse(readFileSync(file, 'utf8')) as {
      format: string
      version: number
      records: { typeName: string }[]
      assets: { assetId: string; versionId: string; name: string; mimeType: string }[]
    }
    expect(archive).toMatchObject({ format: 'draftroom-board', version: 1 })
    expect(archive.records.filter((r) => r.typeName === 'shape')).toHaveLength(7)
    expect(archive.records.filter((r) => r.typeName === 'binding')).toHaveLength(2)
    // Files travel by reference (the manifest), not as bytes.
    expect(archive.assets.map((x) => `${x.assetId}/${x.versionId} ${x.name} ${x.mimeType}`).sort()).toEqual(
      [
        `${image.file.assetId}/${image.file.versionId} image.png image/png`,
        `${pdf.assetId}/${pdf.versionId} document.pdf application/pdf`,
      ].sort(),
    )
  })

  let imported = ''
  await test.step('import-board-file on the dashboard makes a new private board', async () => {
    await a.page.goto(`/w/${wid}`)
    await a.page.getByTestId('nav-all').click()
    const response = a.page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().includes(`/api/workspaces/${wid}/boards/import`),
    )
    await a.page.getByTestId('import-board-file').setInputFiles(file)
    const res = await response
    expect(res.status()).toBe(201)
    const body = (await res.json()) as { board: { id: string; title: string }; droppedFiles: number }
    imported = body.board.id
    expect(body.droppedFiles).toBe(0)
    // "<title>.lobby.json" imports as "<title>" (the export suffix is not part of the name).
    expect(body.board.title).toBe(title)
    await expect(a.page.getByTestId('dashboard-toast')).toHaveText(`Imported “${body.board.title}”.`)
    await expect(boardCard(a.page, imported)).toHaveAttribute('data-role', 'owner')
    expect(await aliceApi.getBoard(imported)).toMatchObject({
      board: { visibility: 'private' },
      role: 'owner',
    })
    expect(await grants(aliceApi, imported)).toEqual({ [a.id]: 'owner' })
  })

  await test.step('the imported board reproduces the content under fresh ids', async () => {
    const stored = Object.values(await serverShapes(aliceApi, imported))
    expect(stored.map(describeShape).sort()).toEqual(source.map(describeShape).sort())
    const sourceIds = new Set(source.map((s) => s.id))
    expect(stored.filter((s) => sourceIds.has(s.id))).toEqual([])
    const byText = (list: ShapeLike[], text: string) => list.find((s) => describeShape(s).endsWith(text))
    const frame = stored.find((s) => s.type === 'frame')
    const note1 = byText(stored, 'Ship the moodboard')
    const note2 = byText(stored, 'Record the voiceover')
    const box = stored.find((s) => s.type === 'geo')
    const arrow = stored.find((s) => s.type === 'arrow')
    expect(note1?.parentId).toBe(frame?.id)
    expect(note2?.parentId).toBe(frame?.id)
    const bindings = (await serverBindings(aliceApi, imported)).map(
      (x) => `${x.fromId}|${x.props.terminal}->${x.toId}`,
    )
    expect(bindings.sort()).toEqual(
      [`${arrow?.id}|end->${box?.id}`, `${arrow?.id}|start->${note1?.id}`].sort(),
    )
    // And in the browser: open it from its card; the image renders for the imported board.
    await boardCard(a.page, imported).getByRole('link').first().click()
    await waitForBoard(a.page)
    await expect(a.page).toHaveURL(new RegExp(`/b/${imported}$`))
    const image2 = stored.find((s) => s.type === 'image')
    if (!image2) throw new Error('no image on the imported board')
    await expectImageRendered(a.page, image2.id, imported)
    const card = fileCard(a.page, 'document.pdf')
    await expect(card).toHaveAttribute('data-status', 'ready')
    await expect(card.getByTestId('file-card-preview')).toHaveAttribute(
      'src',
      new RegExp(`/d/drv_\\w{20}\\?board=${imported}$`),
    )
    expect(await boundEnds(a.page, arrow?.id ?? '')).toEqual([`end->${box?.id}`, `start->${note1?.id}`])
    expect(ids.frame).not.toBe(frame?.id)
    expect(await fileStatus(aliceApi, pdf, imported)).toBe(200)
  })

  await test.step('a corrupt .json and a foreign JSON are refused and make no board', async () => {
    await a.page.goto(`/w/${wid}`)
    await a.page.getByTestId('nav-all').click()
    const count = async () => (await aliceApi.listBoards(wid)).length
    const boardsBefore = await count()
    await a.page.getByTestId('import-board-file').setInputFiles({
      name: 'broken.lobby.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{"format":"draftroom-board","records":['),
    })
    await expect(
      a.page.locator('.dr-notice').filter({ hasText: 'That file is not a Lobby board export (.json).' }),
    ).toBeVisible()
    const refused = a.page.waitForResponse((r) => r.url().includes(`/api/workspaces/${wid}/boards/import`))
    await a.page.getByTestId('import-board-file').setInputFiles({
      name: 'other-app.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ format: 'tldraw-file', records: [] })),
    })
    expect((await refused).status()).toBe(400)
    await expect(
      a.page
        .locator('.dr-notice')
        .filter({ hasText: 'can’t be imported' })
        .or(a.page.locator('.dr-notice').filter({ hasText: "can't be imported" })),
    ).toBeVisible()
    expect(await count()).toBe(boardsBefore)
  })
})

test('sync SIGKILL and restart: recently deleted rows survive and can still be restored; a checkpoint saved during the outage fails with a message and works after', async ({
  session,
  board,
  users,
  stack,
}) => {
  const NOTE = 'shape:crash-note'
  const a = await session('alice')
  const b = await session('bob')
  const aliceApi = await users.api('alice')
  await edit(
    a.page,
    (ed, x) => ed.createShape({ id: x.id, type: 'note', x: 160, y: 140, props: { richText: x.text } }),
    { id: NOTE, text: richText('Survives a crash') },
  )
  await expectConverged(a.page, [b.page])
  const before = await placement(a.page, NOTE)
  await deleteWithKeyboard(a.page, [NOTE])
  await expect
    .poll(async () => (await listDeleted(aliceApi, board)).entries.map((e) => e.shapeId))
    .toEqual([NOTE])

  await openHistory(a.page)
  await stack.sync.kill()
  await Promise.all([expectConn(a.page, 'offline'), expectConn(b.page, 'offline')])
  await test.step('while the board server is down, saving a checkpoint says so and stores nothing', async () => {
    await a.page.getByTestId('checkpoint-name').fill('During the outage')
    await a.page.getByTestId('checkpoint-save').click()
    await expect(a.page.getByTestId('history-error')).toHaveText(
      'The board server is not reachable right now. Try again in a moment.',
    )
    // The typed name is kept for the retry.
    await expect(a.page.getByTestId('checkpoint-name')).toHaveValue('During the outage')
    expect(await listSnapshots(aliceApi, board)).toEqual([])
  })
  await stack.sync.start()
  await Promise.all([expectConn(a.page, 'online'), expectConn(b.page, 'online')])
  await a.page.getByTestId('checkpoint-save').click()
  await expect(a.page.getByTestId('history-status')).toHaveText('Saved “During the outage”.')
  expect((await listSnapshots(aliceApi, board)).map((s) => s.name)).toEqual(['During the outage'])

  expect((await listDeleted(aliceApi, board)).entries).toEqual([
    expect.objectContaining({ shapeId: NOTE, type: 'note', label: 'Survives a crash' }),
  ])
  await b.page.reload()
  await waitForBoard(b.page)
  await openHistory(b.page)
  await deletedRow(b.page, NOTE).getByTestId('deleted-restore').click()
  await expect(b.page.getByTestId('history-status')).toHaveText('Restored 1 object.')
  await expect.poll(() => placement(a.page, NOTE)).toEqual(before)
  expect((await serverShapes(aliceApi, board))[NOTE]).toMatchObject({ x: before?.x, y: before?.y })
  expect((await listDeleted(aliceApi, board)).entries).toEqual([])
})

test('backup restore drill: `pnpm --filter @draftroom/sync backup:restore-drill` passes for a live board of this stack', async ({
  session,
  board,
  users,
  stack,
}) => {
  const a = await session('alice')
  await drawFrameBoard(a.page, 'bk')
  await uploadImage(a.page, board)
  const aliceApi = await users.api('alice')
  // Every edit has landed (the drill compares the backup with the live board afterwards).
  await expectServerHasTab(aliceApi, board, a.page)
  const archive = await serverArchive(aliceApi, board)

  const run = runRestoreDrill(stack.dataDir, [board])
  test.info().annotations.push({ type: 'drill output', description: run.output })
  expect(run.status, run.output).toBe(0)
  expect(run.output).toContain(`backed up ${board}`)
  expect(run.output).toContain(`PASS ${board}`)
  expect(run.output).toContain('file sha256 matches the manifest')
  expect(run.output).toContain('opened through the sync room registry; every record identical')
  expect(run.output).toContain('identical to the live board (unchanged since the backup)')
  expect(run.output).not.toContain('FAIL')
  expect(run.output).toContain('restore drill passed')

  const manifestPath = join(stack.dataDir, 'backups', board, 'manifest.json')
  expect(existsSync(manifestPath)).toBe(true)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    boardId: string
    backups: { file: string; recordCount: number; documentClock: number }[]
  }
  expect(manifest.boardId).toBe(board)
  const latest = manifest.backups.at(-1)
  // The drill checked exactly what the manifest lists: every page, asset, shape and binding the
  // export has, plus the document record and the editors' user records (not exported).
  expect(run.output).toContain(
    `${latest?.recordCount} records, clock ${latest?.documentClock}, digest matches`,
  )
  expect(latest?.recordCount).toBeGreaterThanOrEqual(archive.records.length + 1)
  expect(latest?.documentClock).toBeGreaterThan(0)
  expect(existsSync(join(stack.dataDir, 'backups', board, latest?.file ?? 'missing'))).toBe(true)
  // The live board kept working next to the backup.
  await edit(a.page, (ed) =>
    ed.createShape({ id: 'shape:bk-after', type: 'geo', x: 900, y: 80, props: { w: 80, h: 80 } }),
  )
  await expect.poll(async () => (await serverShapes(aliceApi, board))['shape:bk-after']).toBeDefined()
})
