// Reload and server-kill durability on the Excalidraw board page (ported from the tldraw suite's
// collab-lifecycle steps 2 and 3 and network-interruption): a reload shows exactly what the server has;
// a SIGKILLed and restarted sync server keeps everything acknowledged and the connection pill goes
// offline and back; an edit made while it is down reaches the others; and a member's offline edits
// survive a reload of the tab (the engine's per-tab IndexedDB queue, §2.5.6).
import type { Page } from '@playwright/test'
import {
  createItem,
  createNote,
  expect,
  expectConverged,
  hash,
  item,
  items,
  test,
  updateItem,
  waitForCanvas,
  waitForItem,
} from '../tests/support/canvas.ts'
import { expectSaveState, saveStatus } from '../tests/support/collab-quality.ts'
import { connPill, settled } from './board-kit.ts'

/** A note's words (its bound label's text). */
async function noteText(page: Page, id: string): Promise<string | null> {
  const note = await item(page, id)
  const labelId = (
    (note as { boundElements?: { id: string; type: string }[] } | null)?.boundElements ?? []
  ).find((e) => e.type === 'text')?.id
  const label = (await items(page)).find((e) => e.id === labelId) as { originalText?: string } | undefined
  return label?.originalText ?? null
}

/** A small board: a note with words, a shape in a frame, and an arrow bound from the shape to the note. */
async function seed(page: Page) {
  const frame = await settled(
    page,
    createItem(page, 'frame', { x: 40, y: 360, width: 420, height: 260, name: 'Sprint' }),
  )
  const box = await settled(
    page,
    createItem(page, 'rectangle', {
      x: 80,
      y: 420,
      width: 140,
      height: 90,
      backgroundColor: '#a5d8ff',
      fillStyle: 'solid',
      frameId: frame,
    }),
  )
  const note = await settled(page, createNote(page, { x: 480, y: 80, text: 'Hello from alice' }))
  const arrow = await settled(
    page,
    createItem(page, 'arrow', {
      x: 220,
      y: 440,
      points: [
        [0, 0],
        [260, -260],
      ],
    }),
  )
  // bound by an update of the arrow (the server keeps the targets' boundElements symmetric)
  await updateItem(page, arrow, {
    startBinding: { elementId: box, fixedPoint: [1, 0.5], mode: 'orbit' },
    endBinding: { elementId: note, fixedPoint: [0, 0.5], mode: 'orbit' },
  })
  return { frame, box, note, arrow }
}

async function expectSeed(page: Page, s: Awaited<ReturnType<typeof seed>>) {
  await expect.poll(() => noteText(page, s.note)).toBe('Hello from alice')
  expect((await item(page, s.box))?.frameId).toBe(s.frame)
  const a = (await item(page, s.arrow)) as {
    startBinding?: { elementId: string } | null
    endBinding?: { elementId: string } | null
  } | null
  expect([a?.startBinding?.elementId, a?.endBinding?.elementId]).toEqual([s.box, s.note])
}

test('a reload shows exactly what the server has, and the reloaded tab says Saved', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const s = await seed(a.page)
  await expectSaveState(a.page, 'saved')
  await waitForItem(b.page, s.arrow)
  await expectConverged(a.page, [b.page])
  const before = await hash(a.page)

  const dialogs: string[] = []
  a.page.on('dialog', (d) => {
    dialogs.push(d.type())
    void d.dismiss()
  })
  await a.page.reload()
  await waitForCanvas(a.page)
  // Saved: nothing to lose, so a reload never asks
  expect(dialogs).toEqual([])
  await expectSaveState(a.page, 'saved')
  await expectSeed(a.page, s)
  expect(await hash(a.page)).toBe(before)
  await expectConverged(a.page, [b.page])
})

test('a SIGKILLed sync server keeps everything acknowledged; the pill goes offline and back; an edit made while it is down reaches the others', async ({
  canvasSession,
  stack,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const s = await seed(a.page)
  await expectSaveState(a.page, 'saved')
  await waitForItem(b.page, s.arrow)

  await stack.sync.kill()
  await expect(connPill(a.page)).toHaveAttribute('data-state', 'offline', { timeout: 30_000 })
  await expect(connPill(b.page)).toHaveAttribute('data-state', 'offline', { timeout: 30_000 })
  const late = await createNote(a.page, { x: 700, y: 360, text: 'Made while the server was down' })
  await expectSaveState(a.page, 'offline-pending')

  await stack.sync.start()
  await expect(connPill(a.page)).toHaveAttribute('data-state', 'online', { timeout: 30_000 })
  await expect(connPill(b.page)).toHaveAttribute('data-state', 'online', { timeout: 30_000 })
  await expectSaveState(a.page, 'saved', 30_000)
  await expect.poll(() => noteText(b.page, late), { timeout: 20_000 }).toBe('Made while the server was down')
  await expectConverged(a.page, [b.page])

  // a fresh session loads it all from the restarted server
  const fresh = await canvasSession('carol')
  await expectSeed(fresh.page, s)
  await expect.poll(() => noteText(fresh.page, late)).toBe('Made while the server was down')
  await expectConverged(a.page, [fresh.page])
})

test("a member's offline edits survive a reload of the tab and sync when the server is back", async ({
  canvasSession,
  stack,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await expectSaveState(a.page, 'saved')
  await stack.sync.kill()
  await expect(connPill(a.page)).toHaveAttribute('data-state', 'offline', { timeout: 30_000 })
  const ids = [
    await createNote(a.page, { x: 100, y: 100, text: 'one' }),
    await createNote(a.page, { x: 340, y: 100, text: 'two' }),
    await createNote(a.page, { x: 580, y: 100, text: 'three' }),
  ]
  // the engine counts its queue per element (a note and its label are two, once both are queued)
  await expect(saveStatus(a.page)).toHaveText(/^Offline — \d+ changes on this device$/)
  // the queue is written a moment after the change
  await a.page.waitForTimeout(500)

  const dialogs: string[] = []
  a.page.on('dialog', (d) => {
    dialogs.push(d.type())
    void d.dismiss()
  })
  await a.page.reload()
  // the reloaded tab (same tab id) found its queue: still offline, the changes still counted
  await expect(a.page.getByTestId('lobby-board')).toBeVisible()
  // (the engine counts the queue per element: a note and its label are two)
  await expect(saveStatus(a.page)).toHaveText(/^Offline — \d+ changes on this device$/, { timeout: 20_000 })
  expect(dialogs).toEqual([])

  await stack.sync.start()
  await waitForCanvas(a.page, 60_000)
  await expectSaveState(a.page, 'saved', 30_000)
  for (const [i, id] of ids.entries())
    await expect.poll(() => noteText(b.page, id), { timeout: 30_000 }).toBe(['one', 'two', 'three'][i])
  await expectConverged(a.page, [b.page])
})
