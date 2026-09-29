// The wave-1 check of the ported-spec helpers (tests/support/canvas.ts) on the Excalidraw board page:
// each helper against the real page, and the facade's writes against real pointer input (§6.3 "each
// facade verb is checked once against real pointer and keyboard input").
import {
  clickItem,
  createNote,
  expect,
  expectConverged,
  expectSaved,
  item,
  itemBounds,
  itemCenterOnScreen,
  items,
  selection,
  setViewport,
  startTextEditing,
  stopTextEditing,
  test,
  typeText,
  updateItem,
  viewport,
  waitForItem,
} from '../tests/support/canvas.ts'

test('helpers: a facade note converges on two tabs, is selected by a real click and edited through the lease', async ({
  canvasSession,
}) => {
  const alice = await canvasSession('alice')
  const bob = await canvasSession('bob')

  const id = await createNote(alice.page, { x: 100, y: 120, text: 'Hello' })
  await waitForItem(bob.page, id)
  await expectConverged(alice.page, [bob.page])
  await expectSaved(alice.page)

  // bounds and screen coordinates agree with where the note is drawn: a real click selects it
  const b = await itemBounds(alice.page, id)
  expect(b).not.toBeNull()
  const c = await itemCenterOnScreen(alice.page, id)
  const vp = alice.page.viewportSize()
  expect(c.x).toBeGreaterThan(0)
  expect(c.x).toBeLessThan(vp?.width ?? 0)
  await clickItem(alice.page, id)
  await expect.poll(() => selection(alice.page)).toEqual([id])

  // a facade update reaches the other tab
  await updateItem(bob.page, id, { backgroundColor: '#a3d9a5' })
  await waitForItem(
    alice.page,
    id,
    (el) => (el as { backgroundColor?: string }).backgroundColor === '#a3d9a5',
  )
  await expectConverged(alice.page, [bob.page])

  // the editor opens only under the lease, then typing lands in the note's label
  await startTextEditing(alice.page, id)
  await alice.page.keyboard.press('End')
  await typeText(alice.page, ' there')
  await stopTextEditing(alice.page)
  const labelText = async () => {
    const note = await item(alice.page, id)
    const labelId = (
      (note as { boundElements?: { id: string; type: string }[] } | null)?.boundElements ?? []
    ).find((e) => e.type === 'text')?.id
    const label = (await items(alice.page)).find((e) => e.id === labelId) as
      | { originalText?: string }
      | undefined
    return label?.originalText ?? null
  }
  await expect.poll(labelText).toBe('Hello there')
  await expectSaved(alice.page)
  await expectConverged(alice.page, [bob.page])

  // viewport helpers (the harness fallback until 2E lands the wave-1 facade verbs)
  await setViewport(alice.page, { x: 0, y: 0, zoom: 1 })
  await expect.poll(async () => Math.round((await viewport(alice.page)).zoom * 100)).toBe(100)
})
