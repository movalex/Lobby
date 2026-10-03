// GAP PASS (browser-test gaps on the Excalidraw canvas): leaving a board right after an edit, and moving
// between two boards in one tab.
//
// WAVE-3.md §5 lists "Saved indicator, per-property undo, leave guard" as ported (wave 2) with `board-saved`
// and `sync-durability` as evidence, but no Excalidraw spec ever LEAVES the board right after a write. The
// tldraw suite's dashboard-share "leaving a board right away keeps its last changes" was never ported. The
// Lobby board page holds an in-app navigation while the save state is "saving" (LobbyBoardPage.tsx
// setLeaveGuard, LEAVE_WAIT_MS), persists its offline queue on pagehide and on unmount (session.ts), and
// DEMO 4:45 is "Back to the dashboard".
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw gaps-leave-guard
//
// Writes go through the facade (`window.lobbyCanvas.create`, as every ported spec's writes do); the
// navigation is the real "Back to <workspace>" link of the top bar, or the browser's Back (history.back()).
// The server's view is the sync test snapshot (tests/support/excalidraw.ts serverSnapshot).
import type { Page } from '@playwright/test'
import {
  collaborators,
  createNote,
  expect,
  expectSaved,
  item,
  items,
  test,
  waitForCanvas,
} from '../tests/support/canvas.ts'
import { mainCard } from '../tests/support/dashboard-share.ts'
import { serverSnapshot } from '../tests/support/excalidraw.ts'
import type { Stack } from '../tests/support/stack.ts'

type Facade = { create(kind: string, props: Record<string, unknown>): string }
const BACK_LINK = 'a[aria-label="Back to Dev Studio"]'

/** The element is stored live on the server (not a tombstone, not missing). */
async function liveOnServer(stack: Stack, board: string, id: string): Promise<boolean> {
  const snap = await serverSnapshot(stack, board)
  const el = snap.elements.find((e) => e.id === id) as { isDeleted?: boolean } | undefined
  return !!el && !el.isDeleted
}

const live = async (page: Page, id: string) => {
  const el = (await item(page, id)) as { isDeleted?: boolean } | null
  return !!el && !el.isDeleted
}

/** The dashboard is on screen (the board page has been left). */
const expectDashboard = (page: Page) => expect(page.getByTestId('dashboard')).toBeVisible({ timeout: 15_000 })

/** Opens `board` from its dashboard card in the same tab and waits for the canvas. */
async function openFromCard(page: Page, board: string) {
  await mainCard(page, board)
    .getByRole('link', { name: /^Open / })
    .click()
  await waitForCanvas(page)
}

test('leave guard: an edit, then "Back to Dev Studio" or the browser Back on the very next frame: the dashboard shows and the server holds the edit', async ({
  canvasSession,
  stack,
  board,
}) => {
  const a = await canvasSession('alice')
  const first = await createNote(a.page, { x: 200, y: 200, text: 'first' })
  await expectSaved(a.page)

  await test.step('a write, then the Back link one animation frame later (as fast as a hand can be)', async () => {
    await a.page.evaluate((sel) => {
      const f = (window as unknown as { lobbyCanvas: Facade }).lobbyCanvas
      f.create('note', { id: 'leave-back-link', x: 500, y: 200, text: 'back link' })
      requestAnimationFrame(() => {
        const link = document.querySelector<HTMLAnchorElement>(sel)
        if (!link) throw new Error('no "Back to Dev Studio" link on the board page')
        link.click()
      })
    }, BACK_LINK)
    await expectDashboard(a.page)
    await expect.poll(() => liveOnServer(stack, board, 'leave-back-link'), { timeout: 10_000 }).toBe(true)
  })

  await test.step('back on the board from its card: the note is there; a write, then history.back() a frame later', async () => {
    await openFromCard(a.page, board)
    expect(await live(a.page, 'leave-back-link')).toBe(true)
    await a.page.evaluate(() => {
      const f = (window as unknown as { lobbyCanvas: Facade }).lobbyCanvas
      f.create('note', { id: 'leave-browser-back', x: 800, y: 200, text: 'browser back' })
      requestAnimationFrame(() => history.back())
    })
    await expectDashboard(a.page)
    await expect.poll(() => liveOnServer(stack, board, 'leave-browser-back'), { timeout: 10_000 }).toBe(true)
  })

  await test.step('a second person opening the board gets all three notes', async () => {
    const b = await canvasSession('bob')
    for (const id of [first, 'leave-back-link', 'leave-browser-back'])
      await expect.poll(() => live(b.page, id), { message: id }).toBe(true)
  })
})

test('leave guard: an edit and "Back to Dev Studio" in the SAME task (before the engine has reported the write): the edit still reaches the server', async ({
  canvasSession,
  stack,
  board,
}) => {
  // The tldraw suite's case (dashboard-share "leaving a board right away"): the sync client sends on a
  // later animation frame at the earliest, so the note is certainly unsent when the link's handler runs.
  const a = await canvasSession('alice')
  await createNote(a.page, { x: 200, y: 200, text: 'baseline' })
  await expectSaved(a.page)
  await a.page.evaluate((sel) => {
    const f = (window as unknown as { lobbyCanvas: Facade }).lobbyCanvas
    f.create('note', { id: 'leave-same-task', x: 500, y: 200, text: 'same task' })
    const link = document.querySelector<HTMLAnchorElement>(sel)
    if (!link) throw new Error('no "Back to Dev Studio" link on the board page')
    link.click()
  }, BACK_LINK)
  await expectDashboard(a.page)
  await expect.poll(() => liveOnServer(stack, board, 'leave-same-task'), { timeout: 10_000 }).toBe(true)
  const b = await canvasSession('bob')
  await expect.poll(() => live(b.page, 'leave-same-task')).toBe(true)
})

test('two boards in one tab: board A → the dashboard → board B shows only B (its title, its elements, its people); back to A shows only A; the server agrees', async ({
  canvasSession,
  users,
  stack,
  board,
}) => {
  const A = board
  const B = await users.createBoard('Gaps second board')
  const aliceApi = await users.api('alice')
  const titleA = (await aliceApi.getBoard(A)).board.title
  const a = await canvasSession('alice')
  await createNote(a.page, { x: 240, y: 200, text: 'Only on A' })
  await expectSaved(a.page)
  const idsOnA = (await items(a.page)).map((e) => e.id)
  expect(idsOnA.length).toBeGreaterThan(0)

  await test.step('A → dashboard → B: B is empty, named B, with only alice on it', async () => {
    await a.page.locator(BACK_LINK).first().click()
    await expectDashboard(a.page)
    await openFromCard(a.page, B)
    await expect(a.page.getByTestId('board-title')).toHaveText('Gaps second board')
    expect(await items(a.page)).toEqual([])
    const people = await collaborators(a.page)
    expect(people.length).toBe(1)
    await createNote(a.page, { x: 240, y: 200, text: 'Only on B' })
    await expectSaved(a.page)
  })

  await test.step('B → dashboard → A: A has its note and nothing of B', async () => {
    await a.page.locator(BACK_LINK).first().click()
    await expectDashboard(a.page)
    await openFromCard(a.page, A)
    await expect(a.page.getByTestId('board-title')).toHaveText(titleA)
    const now = (await items(a.page)).map((e) => e.id).sort()
    expect(now).toEqual([...idsOnA].sort())
  })

  await test.step('the server holds A’s note on A and B’s note on B only', async () => {
    const onA = (await serverSnapshot(stack, A)).elements.filter(
      (e) => !(e as { isDeleted?: boolean }).isDeleted,
    )
    const onB = (await serverSnapshot(stack, B)).elements.filter(
      (e) => !(e as { isDeleted?: boolean }).isDeleted,
    )
    expect(onA.map((e) => e.id).sort()).toEqual([...idsOnA].sort())
    expect(onB.length).toBeGreaterThan(0)
    expect(onB.map((e) => e.id).some((id) => idsOnA.includes(id))).toBe(false)
  })
})
