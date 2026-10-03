// What a lock lets through on the Excalidraw board page (wave A, A1: CR-3F-2, CR-3b-4). A facilitator locks
// a template's prompt notes and slides; the sync server keeps their content and place (LOCKED) but lets two
// keys through (the registry's `lockExempt`, canvas-schema custom-data.ts):
//  - the writer's own `plusOne:<uid>`: participants, a workshop guest included, +1 a locked note;
//  - `present` on a frame, from an account: the facilitator reorders and skips locked slides in the Frames
//    panel. A name-only guest can neither lock nor unlock, so for a guest a locked frame keeps its place.
// The protocol side (another uid's +1, other keys, geometry, a guest's `present`) is
// apps/sync/test/negative/lock-exempt-keys.test.ts.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/locked-customdata.spec.ts   (from e2e/)
import type { Page } from '@playwright/test'
import {
  canvasCall,
  createItem,
  createNote,
  expect,
  expectSaved,
  item,
  test,
  updateItem,
  waitForCanvas,
  zoomToFit,
} from '../tests/support/canvas.ts'
import { storedElement } from '../tests/support/excalidraw.ts'
import { createGuestLink } from '../tests/support/tags.ts'
import { settled } from './board-kit.ts'
import { joinAsGuest } from './tags-kit.ts'
import { clickPlusOne, plusOne, plusOnesOfElement } from './workshops-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

const frameRow = (page: Page, id: string) => page.locator(`[data-testid="frame-row"][data-frame-id="${id}"]`)
const frameRowIds = (page: Page) =>
  page
    .locator('[data-testid="frame-row"]')
    .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-frame-id')))
const present = async (page: Page, id: string) =>
  ((await item(page, id))?.customData?.lobby?.present ?? null) as { index?: number; skip?: boolean } | null
const notSaved = (page: Page) => page.getByText('Change not saved')
const uidOf = async (page: Page) => ((await canvasCall(page, 'me')) as { uid: string }).uid

test('CR-3F-2: a locked template note takes +1s from an editor and a workshop guest (the server keeps them, a reload shows them); the note stays locked in place', async ({
  browser,
  canvasSession,
  stack,
  board,
}) => {
  const a = await canvasSession('alice')
  const note = await settled(a.page, createNote(a.page, { x: 100, y: 100, text: 'What went well?' }))
  await settled(a.page, updateItem(a.page, note, { locked: true }))
  expect((await item(a.page, note))?.locked).toBe(true)
  const b = await canvasSession('bob')
  const workshop = await createGuestLink(a.page, 'workshop')
  const guest = await joinAsGuest(browser, workshop, 'Wes Guest')
  try {
    const g = guest.page
    for (const p of [b.page, g]) {
      await expect.poll(async () => (await item(p, note))?.locked).toBe(true)
      await zoomToFit(p)
    }
    // bob, then the guest: the +1 control shows on the locked note and one click lands for everyone
    await clickPlusOne(b.page, note)
    await expect(plusOne(b.page, note)).toHaveAttribute('aria-pressed', 'true')
    await expect(plusOne(b.page, note)).toHaveAttribute('data-locked', 'true')
    await clickPlusOne(g, note)
    await expect(plusOne(g, note)).toHaveAttribute('data-count', '2')
    const want = [b.id, await uidOf(g)].sort()
    await expect.poll(async () => plusOnesOfElement(await storedElement(stack, board, note))).toEqual(want)
    for (const p of [a.page, b.page, g]) {
      await expectSaved(p)
      await expect(notSaved(p)).toHaveCount(0)
    }
    // the lock still holds: the note is where it was, still locked, its words unchanged
    const stored = await storedElement(stack, board, note)
    expect([stored?.locked, stored?.x, stored?.y]).toEqual([true, 100, 100])
    // a reload keeps the count (the server's copy)
    await a.page.reload()
    await waitForCanvas(a.page)
    await expect.poll(async () => (await item(a.page, note))?.locked, { timeout: 30_000 }).toBe(true)
    await zoomToFit(a.page)
    await expect(plusOne(a.page, note)).toHaveAttribute('data-count', '2')
  } finally {
    await guest.context.close()
  }
})

test('CR-3b-4: the facilitator reorders and skips a locked slide in the Frames panel (Saved, bob sees it, a reload keeps it); a workshop guest gets no controls on the locked row', async ({
  browser,
  canvasSession,
  stack,
  board,
}) => {
  const a = await canvasSession('alice')
  const F1 = await settled(
    a.page,
    createItem(a.page, 'frame', { x: 0, y: 0, width: 480, height: 320, name: 'Intro', locked: true }),
  )
  const F2 = await settled(
    a.page,
    createItem(a.page, 'frame', { x: 700, y: 0, width: 480, height: 320, name: 'Body' }),
  )
  expect((await item(a.page, F1))?.locked).toBe(true)
  const b = await canvasSession('bob')
  for (const s of [a, b]) {
    await s.page.getByTestId('dock-tab-frames').click()
    await expect.poll(() => frameRowIds(s.page)).toEqual([F1, F2])
  }
  // the locked row has the controls an unlocked one has
  await expect(frameRow(a.page, F1)).toHaveAttribute('data-locked', 'true')
  await expect(frameRow(a.page, F1)).toHaveAttribute('draggable', 'true')
  await frameRow(a.page, F1).getByRole('button', { name: 'Move Intro down' }).click()
  await expect.poll(() => frameRowIds(a.page)).toEqual([F2, F1])
  expect([await present(a.page, F1), await present(a.page, F2)]).toEqual([{ index: 1 }, { index: 0 }])
  await expect.poll(() => frameRowIds(b.page), { timeout: 5_000 }).toEqual([F2, F1])
  await frameRow(a.page, F1).getByTestId('frame-skip').click()
  await expect.poll(() => present(a.page, F1)).toEqual({ index: 1, skip: true })
  await expectSaved(a.page)
  await expect(notSaved(a.page)).toHaveCount(0)
  const stored = await storedElement(stack, board, F1)
  expect([stored?.locked, stored?.x, stored?.customData?.lobby?.present]).toEqual([
    true,
    0,
    { index: 1, skip: true },
  ])
  await expect(frameRow(b.page, F1)).toHaveAttribute('data-skipped', 'true')
  await a.page.reload()
  await waitForCanvas(a.page)
  await a.page.getByTestId('dock-tab-frames').click()
  await expect.poll(() => frameRowIds(a.page), { timeout: 30_000 }).toEqual([F2, F1])

  // a workshop guest: the unlocked row can be reordered, the locked one cannot (the room refuses it)
  const workshop = await createGuestLink(a.page, 'workshop')
  const guest = await joinAsGuest(browser, workshop, 'Wes Guest')
  try {
    const g = guest.page
    await g.getByTestId('dock-tab-frames').click()
    await expect.poll(() => frameRowIds(g)).toEqual([F2, F1])
    await expect(frameRow(g, F1)).toHaveAttribute('draggable', 'false')
    await expect(frameRow(g, F1).getByTestId('frame-skip')).toHaveCount(0)
    await expect(frameRow(g, F1).locator('.dr-cux-frame__handle')).toHaveCount(0)
    await expect(frameRow(g, F2)).toHaveAttribute('draggable', 'true')
    await expect(frameRow(g, F2).getByTestId('frame-skip')).toHaveCount(1)
  } finally {
    await guest.context.close()
  }
})
