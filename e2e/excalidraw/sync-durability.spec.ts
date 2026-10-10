// Durability on the Excalidraw engine: the browser half of §6.2 `durability` and of B4, and the port of the
// durability parts of e2e/tests/saving.spec.ts and collab-lifecycle.spec.ts step 3 (the tldraw versions
// stay in e2e/tests on the default build). "Saved" (§2.5.7) means stored: every check reads the server's
// test snapshot (the sync server runs with test hooks on these stacks).
//
//  - each edit shows Saving… then Saved, and what Saved promised is on the server and in a fresh session;
//  - with the sync server SIGKILLed, 10 edits are kept on the device ("Offline — 10 changes on this
//    device"), Saved never shows while it is down, a reload while it is down keeps them (the offline queue
//    lives in IndexedDB, not in the tab), and after the restart all 10 are stored exactly once;
//  - a SIGKILL in the middle of a burst of 60 creates loses none: every create is stored exactly once;
//  - an injected COMMIT failure (fail-commit hook): the push is refused UNAVAILABLE, the room reopens, the
//    tab reconnects and retries, and Saved shows only once the element is stored;
//  - a change the server refuses (LOCKED, replayed after a reconnect) shows "Change not saved", never
//    Saved, and never reaches the server.
import type { Page } from '@playwright/test'
import {
  createItem,
  expect,
  expectSaved,
  item,
  items,
  pushedOps,
  saveState,
  test,
  updateItem,
  waitForCanvas,
  waitForItem,
} from '../tests/support/canvas.ts'
import {
  expectSaveState,
  expectServerConverged,
  failNextCommits,
  goOffline,
  goOnline,
  openRelayedCanvasSession,
  saveIndicator,
  serverSnapshot,
  storedElement,
} from '../tests/support/excalidraw.ts'

/** Records every state the Saved indicator shows (its data-state), in order, from now on. */
async function recordSaveStates(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __saveLog?: string[] }
    // the board page's indicator (save-status) or the spike page's (save-state); re-read on every
    // mutation so a re-rendered indicator is still followed
    const read = () =>
      document
        .querySelector('[data-testid="save-status"], [data-testid="save-state"]')
        ?.getAttribute('data-state') ?? null
    const first = read()
    if (first === null) throw new Error('no Saved indicator on the page')
    w.__saveLog = [first]
    new MutationObserver(() => {
      const s = read() ?? ''
      if (w.__saveLog?.at(-1) !== s) w.__saveLog?.push(s)
    }).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-state'],
    })
  })
}
const saveLog = (page: Page) =>
  page.evaluate(() => [...((window as unknown as { __saveLog?: string[] }).__saveLog ?? [])])

/**
 * The indicator itself shows Saved. The board page's indicator follows the engine's Saved state with the
 * tldraw page's hold and settle rules (sync-quality/useEngineSaveStatus.ts): after a change it keeps
 * "Saving…" on screen for a moment after the engine (`expectSaved`) is already saved.
 */
const expectIndicatorSaved = (page: Page) =>
  expect(saveIndicator(page)).toHaveAttribute('data-state', 'saved', { timeout: 30_000 })

/**
 * The element ids in this tab's offline queue in IndexedDB (canvas/sync/adapter/offline-idb.ts: one record
 * per board, user and tab). The engine writes the queue 100 ms after a change (sync/core/engine.ts
 * schedulePersist), while the indicator already counts the change: a reload inside that window loses it
 * (docs/research/excalidraw/WAVE-2.md, open problems).
 */
const offlineQueueIds = (page: Page, board: string): Promise<string[]> =>
  page.evaluate(
    (boardId) =>
      new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open('lobby-offline')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const db = open.result
          if (!db.objectStoreNames.contains('queues')) return resolve([])
          const req = db.transaction('queues', 'readonly').objectStore('queues').getAll()
          req.onerror = () => reject(req.error)
          req.onsuccess = () => {
            const recs = req.result as { boardId: string; entries: { element: { id: string } }[] }[]
            resolve(
              recs
                // this web's form (`q2:<board>`, offline-idb.ts queueBoard) or the rev-11 web's
                .filter((r) => r.boardId === boardId || r.boardId === `q2:${boardId}`)
                .flatMap((r) => r.entries.map((e) => e.element.id)),
            )
          }
        }
      }),
    board,
  )

/** Live element ids of `ids` stored on the server. */
async function storedLive(
  stack: Parameters<typeof serverSnapshot>[0],
  board: string,
  ids: readonly string[],
) {
  const snap = await serverSnapshot(stack, board)
  return snap.elements
    .filter((e) => ids.includes(e.id) && !e.isDeleted)
    .map((e) => e.id)
    .sort()
}

test('each edit shows Saving… then Saved, and what Saved promised is on the server', async ({
  canvasSession,
  stack,
  board,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await expectSaved(a.page)
  await expectSaved(b.page)
  await expect(saveIndicator(a.page)).toHaveText('Saved')
  await recordSaveStates(a.page)
  await recordSaveStates(b.page)

  await createItem(a.page, 'rectangle', { id: 'saved-box', x: 120, y: 140, width: 160, height: 110 })
  await expectSaved(a.page)
  // Saved means stored: the server has it now
  expect((await storedElement(stack, board, 'saved-box'))?.type).toBe('rectangle')
  await expect.poll(() => saveLog(a.page)).toEqual(['saved', 'saving', 'saved'])

  await updateItem(a.page, 'saved-box', { x: 400, strokeColor: '#e03131' })
  await expectSaved(a.page)
  await expectIndicatorSaved(a.page)
  expect(await storedElement(stack, board, 'saved-box')).toMatchObject({ x: 400, strokeColor: '#e03131' })
  const log = await saveLog(a.page)
  expect(new Set(log)).toEqual(new Set(['saved', 'saving']))
  expect(log.at(-1)).toBe('saved')

  // bob changed nothing: other people's edits never move his indicator
  await waitForItem(b.page, 'saved-box', (el) => Math.round(el.x) === 400)
  expect(await saveLog(b.page)).toEqual(['saved'])

  const fresh = await canvasSession('carol')
  await expectServerConverged(stack, board, [a.page, b.page, fresh.page])
  expect(Math.round((await item(fresh.page, 'saved-box'))?.x ?? 0)).toBe(400)
})

test('with the sync server killed, 10 edits stay on the device, survive a reload, and are all stored after the restart', async ({
  canvasSession,
  stack,
  board,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await expectSaved(a.page)
  await recordSaveStates(a.page)
  const ids = Array.from({ length: 10 }, (_, i) => `offline-${i}`)

  await stack.sync.kill()
  await expectSaveState(a.page, 'offline')
  await expectSaveState(b.page, 'offline')
  // nothing was waiting: offline, with nothing on the device
  expect((await saveState(a.page)).offlineChanges).toBe(0)

  for (const [i, id] of ids.entries())
    await createItem(a.page, 'rectangle', {
      id,
      x: 80 + (i % 5) * 150,
      y: 100 + Math.floor(i / 5) * 150,
      width: 120,
      height: 100,
      strokeColor: '#1971c2',
    })
  await expect.poll(async () => (await saveState(a.page)).offlineChanges).toBe(10)
  await expect(saveIndicator(a.page)).toHaveText('Offline — 10 changes on this device')
  // bob made no edits: his tab has nothing on the device
  expect((await saveState(b.page)).offlineChanges).toBe(0)
  expect((await saveLog(a.page)).slice(1)).not.toContain('saved')

  // a reload while the server is down: the edits live in the device's offline queue, not in the tab
  // (once it holds them: the queue is written a moment after each change)
  await expect
    .poll(
      async () => {
        const queued = new Set(await offlineQueueIds(a.page, board))
        return ids.filter((id) => !queued.has(id))
      },
      { message: 'every offline edit is in the device queue' },
    )
    .toEqual([])
  await a.page.reload()
  await stack.sync.start()
  await waitForCanvas(a.page)
  await expectSaved(a.page, 30_000)
  await expectSaved(b.page)
  expect(await storedLive(stack, board, ids)).toEqual([...ids].sort())
  // each exactly once, and on every tab
  const snap = await expectServerConverged(stack, board, [a.page, b.page])
  expect(snap.elements.filter((e) => ids.includes(e.id))).toHaveLength(10)
  const fresh = await canvasSession('carol')
  await expect.poll(async () => (await items(fresh.page)).filter((e) => ids.includes(e.id)).length).toBe(10)
})

test('a SIGKILL in the middle of a burst of 60 creates loses none of them', async ({
  canvasSession,
  stack,
  board,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await expectSaved(a.page)
  const ids = Array.from({ length: 60 }, (_, i) => `burst-${i}`)
  const create = (i: number) =>
    createItem(a.page, 'rectangle', {
      id: ids[i] as string,
      x: (i % 10) * 110,
      y: 600 + Math.floor(i / 10) * 110,
      width: 100,
      height: 100,
    })
  for (let i = 0; i < 30; i++) await create(i)
  await stack.sync.kill() // some of the first 30 are acked, some in flight, some not sent yet
  for (let i = 30; i < 60; i++) await create(i)
  await expectSaveState(a.page, 'offline')
  expect((await saveState(a.page)).offlineChanges).toBeGreaterThan(0)
  await stack.sync.start()
  await expectSaved(a.page, 30_000)
  expect(await storedLive(stack, board, ids)).toEqual([...ids].sort())
  const snap = await expectServerConverged(stack, board, [a.page, b.page])
  expect(snap.elements.filter((e) => ids.includes(e.id))).toHaveLength(60)
})

test('an injected COMMIT failure: the tab reconnects and pushes the create again, and Saved comes only once it is stored', async ({
  canvasSession,
  stack,
  board,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await createItem(a.page, 'rectangle', { id: 'before-failure', x: 100, y: 100, width: 100, height: 100 })
  await expectSaved(a.page)
  await expectIndicatorSaved(a.page)
  await recordSaveStates(a.page)
  await failNextCommits(stack, board, 1)
  await createItem(a.page, 'rectangle', { id: 'across-failure', x: 300, y: 100, width: 100, height: 100 })
  // the moment the indicator says Saved, the element is stored
  await expectSaved(a.page, 30_000)
  expect((await storedElement(stack, board, 'across-failure'))?.type).toBe('rectangle')
  await expectIndicatorSaved(a.page)
  const log = await saveLog(a.page)
  expect(log[0]).toBe('saved')
  expect(log.slice(1, -1)).not.toContain('saved')
  expect(log.at(-1)).toBe('saved')
  // the failed COMMIT cost the first push: the create went out again after the room reopened
  const pushes = (await pushedOps(a.page)).filter((p) =>
    p.ops.some((o) => (o.k === 'c' ? o.el.id : o.id) === 'across-failure'),
  )
  expect(pushes.length).toBeGreaterThanOrEqual(2)
  await waitForItem(b.page, 'across-failure')
  await expectServerConverged(stack, board, [a.page, b.page])
  expect(stack.sync.logs()).not.toMatch(/room open failed|ERR_INVALID_STATE/)
})

test('a change the server refuses (LOCKED after a reconnect) shows "Change not saved", never Saved, and is not stored', async ({
  browser,
  canvasSession,
  users,
  stack,
  board,
}) => {
  const a = await canvasSession('alice')
  const b = await openRelayedCanvasSession(browser, board, await users.grant(board, 'bob', 'editor'))
  try {
    await createItem(a.page, 'rectangle', {
      id: 'to-lock',
      x: 100,
      y: 100,
      width: 120,
      height: 100,
      strokeColor: '#1e1e1e',
    })
    await waitForItem(b.page, 'to-lock')
    await expectSaved(b.page)
    await recordSaveStates(b.page)

    await goOffline(b)
    await updateItem(a.page, 'to-lock', { locked: true })
    await expectSaved(a.page)
    await updateItem(b.page, 'to-lock', { strokeColor: '#e03131' })
    await expect.poll(async () => (await saveState(b.page)).offlineChanges).toBe(1)
    await goOnline(b)

    await expectSaveState(b.page, 'not-saved', 30_000)
    expect((await saveState(b.page)).lastReject).toMatchObject({ id: 'to-lock', code: 'LOCKED' })
    await expect(saveIndicator(b.page)).toContainText('Change not saved')
    expect((await saveLog(b.page)).slice(1)).not.toContain('saved')
    // rolled back on bob's tab; the owner's copy and the server kept the lock and the colour
    await expect
      .poll(() => item(b.page, 'to-lock').then((s) => (s as { strokeColor?: string } | null)?.strokeColor))
      .toBe('#1e1e1e')
    expect(await storedElement(stack, board, 'to-lock')).toMatchObject({
      locked: true,
      strokeColor: '#1e1e1e',
    })
    await expectServerConverged(stack, board, [a.page, b.page])
  } finally {
    await b.context.close()
  }
})
