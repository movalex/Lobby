// Port of e2e/tests/network-interruption.spec.ts to the Excalidraw engine (the tldraw version stays in
// e2e/tests on the default build). A loses its network (its board socket cut with reconnects held, and
// its context offline, so a ticket refresh fails too) while B keeps editing. A edits a different element
// offline: the change stays on A's device ("Offline — 1 change on this device"). Back online, both
// converge with the server, and A's stale copy of B's element does not overwrite B's newer edit (the
// client re-sends only the field groups it changed, never a snapshot).
import type { Page } from '@playwright/test'
import {
  createItem,
  expect,
  expectConverged,
  expectSaved,
  item,
  pushedOps,
  saveState,
  test,
  updateItem,
  waitForItem,
} from '../tests/support/canvas.ts'
import {
  expectSaveState,
  expectServerConverged,
  goOffline,
  goOnline,
  openRelayedCanvasSession,
  relayStats,
  storedElement,
} from '../tests/support/excalidraw.ts'

const X = 'edited-by-bob'
const Y = 'edited-by-alice-offline'
const Z = 'created-by-bob'

const facts = async (page: Page, id: string) => {
  const s = await item(page, id)
  return s && !s.isDeleted
    ? { x: Math.round(s.x), y: Math.round(s.y), color: (s as { strokeColor?: string }).strokeColor }
    : null
}

test('offline A + online B: both converge and B’s edits survive A’s reconnect', async ({
  browser,
  board,
  users,
  canvasSession,
  stack,
}) => {
  const a = await openRelayedCanvasSession(browser, board, await users.get('alice'))
  try {
    const b = await canvasSession('bob')
    await createItem(b.page, 'rectangle', {
      id: X,
      x: 100,
      y: 120,
      width: 160,
      height: 110,
      strokeColor: '#1e1e1e',
    })
    await createItem(b.page, 'rectangle', {
      id: Y,
      x: 420,
      y: 120,
      width: 160,
      height: 110,
      strokeColor: '#1e1e1e',
    })
    await waitForItem(a.page, Y)
    await expectConverged(b.page, [a.page])

    await goOffline(a)
    await expectSaveState(a.page, 'offline')
    await expect(a.page.getByTestId('save-state')).toHaveText(/^Offline/)

    // B edits X (move + recolour) and adds Z while A is cut off.
    await updateItem(b.page, X, { x: 140, y: 300, strokeColor: '#e03131' })
    await createItem(b.page, 'note', { id: Z, x: 700, y: 120 })
    await expectSaved(b.page)
    // The server has B's edit, and A really has not received it.
    expect(await storedElement(stack, board, X)).toMatchObject({ x: 140, y: 300, strokeColor: '#e03131' })
    expect(await facts(a.page, X)).toEqual({ x: 100, y: 120, color: '#1e1e1e' })
    expect(await item(a.page, Z)).toBeNull()
    await expectSaveState(a.page, 'offline')

    // A edits a different element while offline; the change stays on A's device for now.
    const pushesBefore = (await pushedOps(a.page)).length
    await updateItem(a.page, Y, { x: 460, y: 320, strokeColor: '#1971c2' })
    await expect.poll(async () => (await saveState(a.page)).offlineChanges).toBe(1)
    await expect(a.page.getByTestId('save-state')).toHaveText('Offline — 1 change on this device')
    expect(await facts(b.page, Y)).toEqual({ x: 420, y: 120, color: '#1e1e1e' })
    // the held reconnects carried nothing to the server
    expect((await storedElement(stack, board, Y))?.x).toBe(420)
    expect(relayStats(a.page).framesWhileCut.filter((f) => f.type === 'push')).toEqual([])

    await goOnline(a)
    await expectSaved(a.page)
    expect((await pushedOps(a.page)).length).toBeGreaterThan(pushesBefore)

    // A's offline edit reaches B; B's edits (made while A was away) reach A and are NOT replaced.
    await expect.poll(() => facts(b.page, Y)).toEqual({ x: 460, y: 320, color: '#1971c2' })
    await expect.poll(() => facts(a.page, X)).toEqual({ x: 140, y: 300, color: '#e03131' })
    await expect.poll(() => item(a.page, Z).then((s) => s?.type ?? null)).toBe('stickynote')
    // A's replay wrote only Y's groups: nothing of X in any push A sent after the cut
    const replayed = (await pushedOps(a.page)).slice(pushesBefore).flatMap((p) => [...p.ops])
    expect(replayed.map((o) => (o.k === 'c' ? o.el.id : o.id))).not.toContain(X)
    await expectServerConverged(stack, board, [a.page, b.page])
    const fresh = await canvasSession('dave')
    await expectServerConverged(stack, board, [a.page, b.page, fresh.page])
    expect(await facts(fresh.page, X)).toEqual({ x: 140, y: 300, color: '#e03131' })
    expect(await facts(fresh.page, Y)).toEqual({ x: 460, y: 320, color: '#1971c2' })
  } finally {
    await a.context.close()
  }
})
