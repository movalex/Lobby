// The test facade's `select` commits before it returns (DANA-01's root cause, tested without the race).
//
// `lobbyCanvas.select` is `port.select` -> `updateScene`, called from `page.evaluate`, outside any event: React
// would commit it as a default-lane update in a later task, not before the evaluate returns. A key pressed
// right after (Playwright's next call) could then reach Excalidraw first: Delete found an empty selection,
// deleted nothing and wrote its stale appState back over the new selection (history-checkpoints.spec.ts,
// docs commit 99ac6c52). The facade wraps the select in `flushSync` (apps/web/src/canvas/test-facade.ts), so
// the selection is in Excalidraw's state when the verb returns.
//
// Here the key follows the select in the SAME task, with no gap for the scheduler to run in, so the old
// facade fails these deterministically and not one run in seven.
import {
  canvasCall,
  createNote,
  expect,
  item,
  selection,
  test,
  waitForItem,
} from '../tests/support/canvas.ts'
import { focusBoard } from './board-kit.ts'

const alive = async (page: Parameters<typeof item>[0], id: string) => {
  const el = (await item(page, id)) as { isDeleted?: boolean } | null
  return !!el && !el.isDeleted
}

test('the facade select is committed when it returns: read in the same task, and in a microtask', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const id = await createNote(a.page, { x: 120, y: 120, text: 'Selected at once' })
  await waitForItem(a.page, id)
  await focusBoard(a.page)

  const seen = await a.page.evaluate(async (id) => {
    const f = (window as unknown as { lobbyCanvas: { select(ids: string[]): void; selection(): string[] } })
      .lobbyCanvas
    f.select([id])
    const now = f.selection()
    await Promise.resolve()
    return { now, microtask: f.selection() }
  }, id)
  expect(seen).toEqual({ now: [id], microtask: [id] })

  // and the same for clearing it
  const cleared = await a.page.evaluate(() => {
    const f = (window as unknown as { lobbyCanvas: { select(ids: string[]): void; selection(): string[] } })
      .lobbyCanvas
    f.select([])
    return f.selection()
  })
  expect(cleared).toEqual([])
})

test('a key that follows the select in the same task acts on it: Delete removes the selected note, Ctrl+Z restores it', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const id = await createNote(a.page, { x: 120, y: 120, text: 'Delete me' })
  await waitForItem(a.page, id)
  await focusBoard(a.page)

  // the select and the key in one task: nothing in between for React's scheduler
  const handled = await a.page.evaluate((id) => {
    const f = (window as unknown as { lobbyCanvas: { select(ids: string[]): void } }).lobbyCanvas
    f.select([id])
    const target = document.activeElement ?? document.body
    return target.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Delete', code: 'Delete', bubbles: true, cancelable: true }),
    )
  }, id)
  // Excalidraw took the key (preventDefault), and deleted the selection it was given
  expect(handled).toBe(false)
  await expect.poll(() => alive(a.page, id)).toBe(false)

  await canvasCall(a.page, 'select', [])
  await a.page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => alive(a.page, id)).toBe(true)
  expect(await selection(a.page)).toEqual([id]) // undo re-selects what its step was made with (F11)
})
