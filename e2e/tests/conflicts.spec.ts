// Milestone-0 demonstration 5: what happens when two people change the same thing.
// Semantics: docs/research/SYNTHESIS.md §8; wire-level proofs: apps/sync/test/protocol/
// {text-lease,conflicts}.test.ts. These tests show the same behaviors through the real UI.
import type { Page } from '@playwright/test'
import {
  edit,
  expectConn,
  expectConverged,
  getShape,
  shapeText,
  startTextEditing,
  startTextEditingWithKeyboard,
  stopTextEditing,
  toScreen,
  typeText,
} from './support/board.ts'
import { expect, test } from './support/fixtures.ts'
import { capture } from './support/screenshots.ts'

// Short enough to watch the lease expire in the test, long enough for bob's denied attempt to land
// well inside it. The server default is 5000 ms.
const LEASE_MS = 3000
test.use({ syncEnv: { TEXT_LEASE_MS: String(LEASE_MS) } })

const noteText = (page: Page, id: string) => page.locator(`[data-shape-id="${id}"] .tl-rich-text`)
const editingBadge = (page: Page, userId: string) =>
  page.locator(`[data-testid="editing-badge"][data-user-id="${userId}"]`)

test('text lease: bob cannot type into the note alice is typing in, until her lease expires', async ({
  session,
}) => {
  const N = 'shape:leased-note'
  const a = await session('alice')
  const b = await session('bob')
  await edit(a.page, (ed, id) => ed.createShape({ id, type: 'note', x: 240, y: 140 }), N)
  await expect(b.page.locator(`[data-shape-id="${N}"]`)).toBeVisible()

  await startTextEditing(a.page, N)
  await typeText(a.page, 'alice typing')
  await expect.poll(() => shapeText(b.page, N)).toBe('alice typing')
  // B is told (by alice's presence hint) that she is editing this note.
  await expect(editingBadge(b.page, a.id)).toHaveText(`${a.name} is editing`)
  await expect(editingBadge(b.page, a.id)).toHaveAttribute('data-shape-id', N)

  // Bob tries to type into the same note while alice holds the lease.
  await startTextEditing(b.page, N)
  await typeText(b.page, ' and bob')
  await expect(b.page.getByTestId('lease-toast')).toHaveText(`${a.name} is editing this text`)
  // The server vetoed bob's change, so his copy is reverted to alice's text.
  await expect.poll(() => shapeText(b.page, N)).toBe('alice typing')
  await capture('lease-toast.png', b.page, test.info())
  await stopTextEditing(b.page)
  await expect(noteText(b.page, N)).toHaveText('alice typing')
  // Alice's text is intact on her side and on the server.
  expect(await shapeText(a.page, N)).toBe('alice typing')
  const probe = await session('carol')
  expect(await shapeText(probe.page, N)).toBe('alice typing')
  await probe.context.close()

  // Alice was never blocked.
  await typeText(a.page, '!')
  await expect.poll(() => shapeText(b.page, N)).toBe('alice typing!')
  await stopTextEditing(a.page)
  await expect(editingBadge(b.page, a.id)).toHaveCount(0)
  // Every renewal of alice's lease happened before bob saw her last character.
  const lastRenewalSeen = Date.now()

  // The expiry itself is under test here, so this is a real wait (plus a margin for clock skew).
  await b.page.waitForTimeout(Math.max(0, lastRenewalSeen + LEASE_MS + 750 - Date.now()))
  // Enter opens the note with all of its text selected, so bob's typing replaces it.
  await startTextEditingWithKeyboard(b.page, N)
  await typeText(b.page, 'bob took over')
  await stopTextEditing(b.page)
  await expect.poll(() => shapeText(a.page, N)).toBe('bob took over')
  await expect(noteText(a.page, N)).toHaveText('bob took over')
  await expectConverged(a.page, [b.page])
})

test('edit vs delete: the delete wins in either order', async ({ session }) => {
  const EDIT_FIRST = 'shape:edit-then-delete'
  const DELETE_FIRST = 'shape:delete-then-edit'
  const a = await session('alice')
  const b = await session('bob')
  await edit(
    a.page,
    (ed, ids) =>
      ed.createShapes([
        { id: ids.one, type: 'geo', x: 100, y: 120, props: { w: 160, h: 110 } },
        { id: ids.two, type: 'geo', x: 420, y: 120, props: { w: 160, h: 110 } },
      ]),
    { one: EDIT_FIRST, two: DELETE_FIRST },
  )
  await expectConverged(a.page, [b.page])
  const exists = (page: Page, id: string) => getShape(page, id).then((s) => s !== null)

  // 1. Alice's edit lands first, then bob deletes: gone everywhere.
  await edit(
    a.page,
    (ed, id) => ed.updateShape({ id, type: 'geo', x: 180, props: { color: 'green' } }),
    EDIT_FIRST,
  )
  await expect.poll(() => getShape(b.page, EDIT_FIRST).then((s) => s?.x)).toBe(180)
  await edit(b.page, (ed, id) => ed.deleteShapes([id]), EDIT_FIRST)
  await expect.poll(() => exists(a.page, EDIT_FIRST)).toBe(false)

  // 2. Bob deletes while alice's edit is still in flight (she is offline): the late edit does not
  //    bring the shape back.
  await a.context.setOffline(true)
  await expectConn(a.page, 'offline')
  await edit(
    a.page,
    (ed, id) => ed.updateShape({ id, type: 'geo', x: 500, props: { color: 'violet' } }),
    DELETE_FIRST,
  )
  await edit(b.page, (ed, id) => ed.deleteShapes([id]), DELETE_FIRST)
  expect(await exists(a.page, DELETE_FIRST)).toBe(true)
  await a.context.setOffline(false)
  await expectConn(a.page, 'online')
  await expect.poll(() => exists(a.page, DELETE_FIRST)).toBe(false)
  expect(await exists(b.page, DELETE_FIRST)).toBe(false)

  const fresh = await session('carol')
  expect(await exists(fresh.page, EDIT_FIRST)).toBe(false)
  expect(await exists(fresh.page, DELETE_FIRST)).toBe(false)
  await expectConverged(a.page, [b.page, fresh.page])
})

test('DOCUMENTED LIMITATION (SYNTHESIS §8): undo after a remote edit also reverts the other user’s prop on that shape', async ({
  session,
}) => {
  const X = 'shape:undo-after-remote'
  const a = await session('alice')
  const b = await session('bob')
  const facts = async (page: Page) => {
    const s = await getShape(page, X)
    return s ? { x: s.x, color: s.props.color } : null
  }
  await edit(
    a.page,
    (ed, id) => ed.createShape({ id, type: 'geo', x: 100, y: 160, props: { w: 160, h: 110 } }),
    X,
  )
  await expect.poll(() => facts(b.page)).toEqual({ x: 100, color: 'black' })

  // Alice moves the shape (her undo stack: this move). Bob then recolors it, a prop alice never touched.
  await edit(
    a.page,
    (ed, id) => {
      ed.markHistoryStoppingPoint('alice moves')
      ed.updateShape({ id, type: 'geo', x: 400 })
    },
    X,
  )
  await expect.poll(() => facts(b.page)).toEqual({ x: 400, color: 'black' })
  await edit(b.page, (ed, id) => ed.updateShape({ id, type: 'geo', props: { color: 'red' } }), X)
  await expect.poll(() => facts(a.page)).toEqual({ x: 400, color: 'red' })

  // Alice presses undo. tldraw's undo writes back her whole earlier record, so bob's recolor is
  // reverted too, for everyone. This is the documented M0 behavior, not the desired end state.
  const empty = await toScreen(a.page, { x: 900, y: 520 })
  await a.page.mouse.click(empty.x, empty.y) // focus the canvas (keyboard shortcuts)
  await a.page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => facts(a.page)).toEqual({ x: 100, color: 'black' })
  await expect.poll(() => facts(b.page)).toEqual({ x: 100, color: 'black' })
  const fresh = await session('carol')
  expect(await facts(fresh.page)).toEqual({ x: 100, color: 'black' })
})
