// Presence on the Excalidraw board page (ported from the tldraw suite's collab-lifecycle step 1 and the
// plan's presence-roles check, docs/EXCALIDRAW-MIGRATION.md §2.7, §6.3): the people list, named cursors
// where the other person's pointer is (every role, no tool selected), "X is typing" while someone holds
// a note's lease, what the other person has selected (W5-28), and leaving.
import type { Page } from '@playwright/test'
import {
  type CanvasSession,
  createNote,
  expect,
  itemBounds,
  itemCenterOnScreen,
  sceneToScreen,
  screenToScene,
  select,
  selectNone,
  startTextEditing,
  stopTextEditing,
  test,
  updateItem,
  viewport,
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

const selectionOf = (s: CanvasSession, of: CanvasSession) =>
  s.page.locator(`[data-testid="remote-selection"][data-uid="${of.id}"]`)

/** Where `page` draws element `id` (client px): its scene bounds through the camera. */
async function screenBox(page: Page, id: string) {
  const b = await itemBounds(page, id)
  if (!b) throw new Error(`no bounds for ${id}`)
  const tl = await sceneToScreen(page, { x: b.x, y: b.y })
  const br = await sceneToScreen(page, { x: b.x + b.width, y: b.y + b.height })
  return { x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y }
}

/** The outline sits 4 px outside the element on every side (chrome.tsx OUTLINE_PAD), within 3 px. */
async function expectAround(page: Page, outline: ReturnType<typeof selectionOf>, id: string) {
  await expect
    .poll(async () => {
      const [box, want] = await Promise.all([outline.boundingBox(), screenBox(page, id)])
      if (!box) return Number.POSITIVE_INFINITY
      return Math.max(
        Math.abs(box.x - (want.x - 4)),
        Math.abs(box.y - (want.y - 4)),
        Math.abs(box.width - (want.width + 8)),
        Math.abs(box.height - (want.height + 8)),
      )
    })
    .toBeLessThan(3)
}

type BoardWindow = {
  __lobbyBoard?: {
    session: { presenceHub: { dragOffsetOf(id: string): { x: number; y: number } | null } | null }
    canvas: {
      presence: { peers(): { sid: string }[] }
      settings: { set(p: { focusMode: boolean }): void }
    }
    registries: { cursorVisible: { provide(fn: (sid: string) => boolean): () => void } }
  }
  __unhide?: () => void
}

test("W5-28: what alice has selected is outlined in her colour on bob's canvas, with her name; it follows the note and hides with her cursor", async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const note = await createNote(a.page, { x: 140, y: 120, text: 'Mine' })
  const other = await createNote(a.page, { x: 520, y: 120, text: 'Other' })
  await waitForItem(b.page, note)
  await waitForItem(b.page, other)
  await selectNone(a.page)
  const outline = selectionOf(b, a)
  await expect(outline).toHaveCount(0)

  await test.step('alice selects a note: bob sees it outlined, her name on it; her own canvas has none', async () => {
    await select(a.page, [note])
    await expect(outline).toHaveCount(1)
    await expect(outline).toHaveAttribute('data-ids', note)
    await expect(outline).toContainText(a.name)
    await expectAround(b.page, outline, note)
    const colour = await outline.evaluate((el) => getComputedStyle(el).borderTopColor)
    expect(colour).not.toBe('rgba(0, 0, 0, 0)')
    await expect(a.page.getByTestId('remote-selection')).toHaveCount(0)
  })

  await test.step('two notes: one outline each, her name on the first; the outline follows a move', async () => {
    await select(a.page, [note, other])
    await expect(outline).toHaveCount(2)
    await expect(outline.filter({ hasText: a.name })).toHaveCount(1)
    await select(a.page, [note])
    await expect(outline).toHaveCount(1)
    const before = await itemBounds(a.page, note)
    if (!before) throw new Error('no bounds')
    await updateItem(a.page, note, { x: before.x + 240, y: before.y + 60 })
    await expect
      .poll(async () => Math.round((await itemBounds(b.page, note))?.x ?? 0))
      .toBe(Math.round(before.x + 240))
    await expectAround(b.page, outline, note)
  })

  await test.step('"hide cursors" (a cursor filter) and focus mode hide it; it comes back with them', async () => {
    const sid = await b.page.evaluate(
      () => (window as unknown as BoardWindow).__lobbyBoard?.canvas.presence.peers()[0]?.sid ?? null,
    )
    expect(sid).not.toBeNull()
    await b.page.evaluate((hidden) => {
      const w = window as unknown as BoardWindow
      w.__unhide = w.__lobbyBoard?.registries.cursorVisible.provide((s) => s !== hidden)
    }, sid)
    await expect(outline).toHaveCount(0)
    await b.page.evaluate(() => (window as unknown as BoardWindow).__unhide?.())
    await expect(outline).toHaveCount(1)
    const focus = (on: boolean) =>
      b.page.evaluate((v) => {
        ;(window as unknown as BoardWindow).__lobbyBoard?.canvas.settings.set({ focusMode: v })
      }, on)
    await focus(true)
    await expect(outline).toHaveCount(0)
    await focus(false)
    await expect(outline).toHaveCount(1)
  })

  await test.step('alice drags the note: the outline moves with the live preview, then sits on the result', async () => {
    const start = await outline.boundingBox()
    if (!start) throw new Error('no outline')
    const zb = (await viewport(b.page)).zoom
    const from = await itemBounds(a.page, note)
    if (!from) throw new Error('no bounds')
    const c = await itemCenterOnScreen(a.page, note)
    await a.page.mouse.move(c.x, c.y)
    await a.page.mouse.down()
    await a.page.mouse.move(c.x + 160, c.y + 40, { steps: 8 })
    // still dragging: bob's outline is where his canvas previews the note (the relayed drag offset, through
    // his zoom), and it has moved right (the preview lags the first pointer step: the relay's offset starts
    // from where the note was at the drag's first frame)
    const offset = () =>
      b.page.evaluate(
        (id) =>
          (window as unknown as BoardWindow).__lobbyBoard?.session.presenceHub?.dragOffsetOf(id) ?? null,
        note,
      )
    await expect.poll(async () => (await offset())?.x ?? 0).toBeGreaterThan(100)
    await expect
      .poll(async () => {
        const [box, off] = await Promise.all([outline.boundingBox(), offset()])
        if (!box || !off) return Number.POSITIVE_INFINITY
        return Math.max(Math.abs(box.x - start.x - off.x * zb), Math.abs(box.y - start.y - off.y * zb))
      })
      .toBeLessThan(3)
    expect(from.x).toBeLessThan((await itemBounds(a.page, note))?.x ?? 0)
    await a.page.mouse.up()
    await expect
      .poll(async () => Math.round((await itemBounds(b.page, note))?.x ?? 0))
      .toBe(Math.round((await itemBounds(a.page, note))?.x ?? Number.NaN))
    await expectAround(b.page, outline, note)
  })

  await test.step('alice clears her selection: the outline goes', async () => {
    await selectNone(a.page)
    await expect(outline).toHaveCount(0)
  })
})
