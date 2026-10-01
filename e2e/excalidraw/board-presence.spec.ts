// Presence on the Excalidraw board page (ported from the tldraw suite's collab-lifecycle step 1 and the
// plan's presence-roles check, docs/EXCALIDRAW-MIGRATION.md §2.7, §6.3): the people list, named cursors
// where the other person's pointer is (every role, no tool selected), "X is typing" while someone holds
// a note's lease, and leaving.
import type { Page } from '@playwright/test'
import {
  type CanvasSession,
  createNote,
  expect,
  sceneToScreen,
  screenToScene,
  startTextEditing,
  stopTextEditing,
  test,
  waitForItem,
} from '../tests/support/canvas.ts'
import { emptyCanvasPoint } from './board-kit.ts'

const avatar = (s: CanvasSession, of: CanvasSession) =>
  s.page.locator(`[data-testid="presence-user"][data-user-id="${of.id}"]`)
const cursorOf = (s: CanvasSession, of: CanvasSession) =>
  s.page.locator(`[data-testid="cursor"][data-uid="${of.id}"]`)

/** Moves `s`'s real pointer over empty canvas and returns the scene point it ended on. */
async function hover(s: CanvasSession, dx = 0, dy = 0) {
  const p = await emptyCanvasPoint(s.page)
  await s.page.mouse.move(p.x + dx - 20, p.y + dy - 10)
  await s.page.mouse.move(p.x + dx, p.y + dy, { steps: 4 })
  return screenToScene(s.page, { x: p.x + dx, y: p.y + dy })
}

/** Where `page` draws a cursor for the scene point `at` (its tip), in client pixels. */
async function expectCursorAt(page: Page, cursor: ReturnType<typeof cursorOf>, at: { x: number; y: number }) {
  const want = await sceneToScreen(page, at)
  await expect
    .poll(async () => {
      const box = await cursor.boundingBox()
      return box
        ? Math.max(Math.abs(box.x + 2 - want.x), Math.abs(box.y + 2 - want.y))
        : Number.POSITIVE_INFINITY
    })
    .toBeLessThan(4)
}

test('two people see one another: the people list, a named cursor where the pointer is, and "X is typing" while one types', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await expect(avatar(a, b)).toBeVisible()
  await expect(avatar(b, a)).toBeVisible()
  await expect(avatar(a, b)).toHaveAttribute('title', b.name)
  // nobody lists themselves
  await expect(avatar(a, a)).toHaveCount(0)

  const at = await hover(b)
  const cursor = cursorOf(a, b)
  await expect(cursor).toBeVisible()
  await expect(cursor).toContainText(b.name)
  await expectCursorAt(a.page, cursor, at)
  // it follows the pointer
  const next = await hover(b, -180, -90)
  await expectCursorAt(a.page, cursor, next)
  // a feature's cursor filter (present mode, "hide cursors") hides it until it stops filtering
  await a.page.evaluate(
    (sid) => {
      const r = (
        window as unknown as {
          __lobbyBoard?: {
            registries: { cursorVisible: { provide(fn: (sid: string) => boolean): () => void } }
          }
        }
      ).__lobbyBoard?.registries
      ;(window as unknown as { __unhide?: () => void }).__unhide = r?.cursorVisible.provide((s) => s !== sid)
    },
    await cursor.getAttribute('data-sid'),
  )
  await hover(b, -170, -80)
  await expect(cursor).toHaveCount(0)
  await a.page.evaluate(() => (window as unknown as { __unhide?: () => void }).__unhide?.())
  await hover(b, -160, -70)
  await expect(cursor).toBeVisible()

  const note = await createNote(a.page, { x: 140, y: 120, text: 'Hi' })
  await waitForItem(b.page, note)
  await startTextEditing(a.page, note)
  const badge = b.page.locator(`[data-testid="typing-badge"][data-lease="${note}"]`)
  await expect(badge).toContainText(`${a.name} is typing`)
  // this tab never badges its own lease
  await expect(a.page.locator(`[data-testid="typing-badge"][data-lease="${note}"]`)).toHaveCount(0)
  await stopTextEditing(a.page)
  await expect(badge).toHaveCount(0)
})

test("a viewer's and a commenter's cursors reach an editor, with no tool selected", async ({
  canvasSession,
}) => {
  const editor = await canvasSession('alice')
  const viewer = await canvasSession('bob', { role: 'viewer' })
  const commenter = await canvasSession('carol', { role: 'commenter' })
  const v = await hover(viewer)
  const c = await hover(commenter, -250, -120)
  await expectCursorAt(editor.page, cursorOf(editor, viewer), v)
  await expectCursorAt(editor.page, cursorOf(editor, commenter), c)
  await expect(cursorOf(editor, viewer)).toContainText(viewer.name)
  await expect(avatar(editor, viewer)).toBeVisible()
  await expect(avatar(editor, commenter)).toBeVisible()
})

test('someone who closes the board leaves the people list, and their cursor goes', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await hover(b)
  await expect(cursorOf(a, b)).toBeVisible()
  await expect(avatar(a, b)).toBeVisible()
  await b.context.close()
  await expect(avatar(a, b)).toHaveCount(0, { timeout: 20_000 })
  await expect(cursorOf(a, b)).toHaveCount(0)
})
