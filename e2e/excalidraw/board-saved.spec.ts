// WRK-03 on the Excalidraw board page (ported from the tldraw suite's saving.spec.ts): the indicator
// shows "Saved" only once the engine core says so (nothing dirty, in flight or queued, every push
// acknowledged after COMMIT, docs/EXCALIDRAW-MIGRATION.md §2.5.7); offline changes are counted and kept
// on this device; presence never moves it.
import type { Page } from '@playwright/test'
import {
  createItem,
  createNote,
  dragItem,
  expect,
  item,
  items,
  select,
  startTextEditing,
  stopTextEditing,
  test,
  typeText,
  waitForItem,
} from '../tests/support/canvas.ts'
import {
  expectSaveState,
  markSaveLog,
  recordSaveStates,
  saveLog,
  saveStatus,
} from '../tests/support/collab-quality.ts'
import { connPill, emptyCanvasPoint, pushCount } from './board-kit.ts'

/** Only "Saving…" and "Saved" were shown, starting and ending on "Saved", with "Saving…" in between. */
function expectSavingThenSaved(log: string[]) {
  expect(log[0]).toBe('saved')
  expect(log.at(-1)).toBe('saved')
  expect(log).toContain('saving')
  expect(new Set(log)).toEqual(new Set(['saved', 'saving']))
}

/** A note's words (its bound label's text). */
async function noteText(page: Page, id: string): Promise<string | null> {
  const note = await item(page, id)
  const labelId = (
    (note as { boundElements?: { id: string; type: string }[] } | null)?.boundElements ?? []
  ).find((e) => e.type === 'text')?.id
  const label = (await items(page)).find((e) => e.id === labelId) as { originalText?: string } | undefined
  return label?.originalText ?? null
}

test('WRK-03: each edit shows Saving… then Saved, and what Saved promised is on the server', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await expectSaveState(a.page, 'saved')
  await expectSaveState(b.page, 'saved')
  await expect(connPill(a.page)).toHaveText('Live')
  await recordSaveStates(a.page)
  await recordSaveStates(b.page)

  // a single change through the facade (one transact, pushed by the engine)
  const box = await createItem(a.page, 'rectangle', {
    x: 120,
    y: 140,
    width: 160,
    height: 110,
    backgroundColor: '#a5d8ff',
    fillStyle: 'solid',
  })
  await expect.poll(() => saveLog(a.page)).toEqual(['saved', 'saving', 'saved'])

  // a real mouse drag: Saving… while it lasts, Saved once it is stored
  await select(a.page, [box])
  await markSaveLog(a.page)
  const x0 = (await item(a.page, box))?.x ?? Number.NaN
  await dragItem(a.page, box, { x: 260, y: 90 }, 25)
  await expect.poll(async () => ((await item(a.page, box))?.x ?? x0) - x0).toBeGreaterThan(200)
  await expectSaveState(a.page, 'saved')
  expectSavingThenSaved(await saveLog(a.page))
  const moved = (await item(a.page, box))?.x
  await expect.poll(async () => (await item(b.page, box))?.x).toBe(moved)

  // real typing into a note, through the lease
  const note = await createNote(a.page, { x: 520, y: 140 })
  await expectSaveState(a.page, 'saved')
  await markSaveLog(a.page)
  await startTextEditing(a.page, note)
  await typeText(a.page, 'Typed and saved')
  await stopTextEditing(a.page)
  await expectSaveState(a.page, 'saved')
  expectSavingThenSaved(await saveLog(a.page))

  // bob changed nothing: other people's edits never move his indicator
  expect(await saveLog(b.page)).toEqual(['saved'])

  // "Saved" meant stored: a session that loads the board from the server has all of it
  const fresh = await canvasSession('carol')
  await expect.poll(() => noteText(fresh.page, note)).toBe('Typed and saved')
  expect((await item(fresh.page, box))?.x).toBe(moved)
})

test('WRK-03: with the sync server killed, Offline, then "Offline — 10 changes on this device", then Saved, and all 10 reach a fresh session', async ({
  canvasSession,
  stack,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await expectSaveState(a.page, 'saved')
  await recordSaveStates(a.page)

  await stack.sync.kill()
  await expect(connPill(a.page)).toHaveAttribute('data-state', 'offline', { timeout: 30_000 })
  // nothing was waiting: offline, but nothing on this device
  await expectSaveState(a.page, 'offline')
  await expectSaveState(b.page, 'offline')
  await expect(saveStatus(a.page)).toHaveText('Offline')
  await expect(a.page.getByTestId('offline-banner')).toContainText('kept on this device')

  const ids: string[] = []
  for (let i = 0; i < 10; i++)
    ids.push(
      await createItem(a.page, 'rectangle', {
        x: 80 + (i % 5) * 150,
        y: 100 + Math.floor(i / 5) * 150,
        width: 120,
        height: 100,
      }),
    )
  await expectSaveState(a.page, 'offline-pending')
  await expect(saveStatus(a.page)).toHaveText('Offline — 10 changes on this device')
  await expect(saveStatus(a.page)).toHaveAttribute('title', /kept on this device/)
  // bob made no edits: his tab has nothing waiting
  await expectSaveState(b.page, 'offline')

  await stack.sync.start()
  await expect(connPill(a.page)).toHaveAttribute('data-state', 'online', { timeout: 30_000 })
  await expectSaveState(a.page, 'saved', 30_000)
  // never "Saved" while the server was down
  const log = await saveLog(a.page)
  expect(log[0]).toBe('saved')
  expect(log.at(-1)).toBe('saved')
  const down = log.indexOf('offline')
  expect(down).toBeGreaterThan(0)
  expect(log.slice(down, -1)).not.toContain('saved')
  expect(log).toContain('offline-pending')
  await expectSaveState(b.page, 'saved')

  const onBoard = async (p: Page) =>
    (await items(p))
      .filter((e) => ids.includes(e.id))
      .map((e) => e.id)
      .sort()
  await expect.poll(() => onBoard(b.page)).toEqual([...ids].sort())
  const fresh = await canvasSession('carol')
  await expect.poll(() => onBoard(fresh.page)).toEqual([...ids].sort())
})

test('WRK-03: presence-only activity (cursors, selection) never moves either indicator and is never a push', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const note = await createNote(a.page, { x: 200, y: 160, text: 'Look, no pushes' })
  await waitForItem(b.page, note)
  await expectSaveState(a.page, 'saved')
  await expectSaveState(b.page, 'saved')
  await recordSaveStates(a.page)
  await recordSaveStates(b.page)
  const pushes = await pushCount(b.page)

  const p = await emptyCanvasPoint(b.page)
  await b.page.mouse.move(p.x, p.y)
  await b.page.mouse.move(p.x - 200, p.y - 150, { steps: 10 })
  await select(b.page, [note])
  await b.page.mouse.click(p.x, p.y)
  const q = await emptyCanvasPoint(a.page)
  await a.page.mouse.move(q.x, q.y, { steps: 5 })
  await a.page.waitForTimeout(1_500)

  expect(await saveLog(a.page)).toEqual(['saved'])
  expect(await saveLog(b.page)).toEqual(['saved'])
  expect(await pushCount(b.page)).toBe(pushes)
})
