// W5-02 (wave 5, owner 2A, the security blocker of the early wave-5 review): no role receives a deleted
// element's content over the canvas socket. Through the real stack and the Excalidraw board page: alice
// writes and deletes a note and a text; a viewer, a commenter and an editor who open the board afterwards
// hold the tombstones in their scene (Excalidraw's map, deleted elements included) without the words or
// the author, and so does what their sockets received (a forged socket with each page's own ticket reads
// the raw welcome and snapshot). alice's undo of her delete and the api's "Recently deleted" still bring
// the full note back to everyone. The protocol half (a name-only guest too, catch-ups, refused ops) is
// apps/sync/test/element-room/wave5-2a.test.ts.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw -- sync-room-tombstones
import type { Page } from '@playwright/test'
import {
  createItem,
  createNote,
  deleteItem,
  expect,
  expectConverged,
  expectSaved,
  item,
  itemText,
  test,
  undo,
  waitForItem,
} from '../tests/support/canvas.ts'
import { forgeSession, serverSnapshot } from '../tests/support/excalidraw.ts'
import { WEB_URL } from '../tests/support/ports.ts'

const WORDS = 'internal margin note for the team only'
const FREE = 'confidential plan before the client sees it'

/** Every element of the page's Excalidraw scene, deleted ones included, as JSON. */
const sceneJson = (page: Page) =>
  page.evaluate(() => {
    const b = (
      window as unknown as { __lobbyBoard?: { api: { getSceneElementsIncludingDeleted(): unknown[] } } }
    ).__lobbyBoard
    if (!b) throw new Error('no __lobbyBoard (not a dev-auth Excalidraw build?)')
    return JSON.stringify(b.api.getSceneElementsIncludingDeleted())
  })

test('a viewer, a commenter and an editor who open the board never get a deleted note’s words or author; undo and Recently deleted bring it back', async ({
  canvasSession,
  stack,
  board,
}) => {
  test.setTimeout(240_000)
  const a = await canvasSession('alice')
  const note = await createNote(a.page, { x: 100, y: 100, text: WORDS })
  await createItem(a.page, 'text', { id: 'free-words', x: 500, y: 100, text: FREE })
  await expectSaved(a.page)
  await deleteItem(a.page, note)
  await deleteItem(a.page, 'free-words')
  await expectSaved(a.page)
  // the server keeps the full rows ("Recently deleted", restores)
  expect(JSON.stringify((await serverSnapshot(stack, board)).elements)).toContain(WORDS)

  for (const [user, role] of [
    ['victor', 'viewer'],
    ['carol', 'commenter'],
    ['bob', 'editor'],
  ] as const) {
    const s = await canvasSession(user, { role })
    const scene = await sceneJson(s.page)
    expect(scene, `${user}'s scene`).not.toContain(WORDS)
    expect(scene, `${user}'s scene`).not.toContain(FREE)
    expect(scene, `${user}'s scene: no author on a tombstone`).not.toContain(a.id)
    expect(
      JSON.parse(scene).filter((e: { isDeleted: boolean }) => e.isDeleted).length,
    ).toBeGreaterThanOrEqual(3)
    // what the socket gets: the raw welcome and the reset snapshot
    const { socket, welcome } = await forgeSession(s.page, board)
    try {
      expect(welcome.reset).toBe(true)
      // the binary snapshot frame follows the welcome
      await expect.poll(async () => (await socket.snapshots()).length).toBeGreaterThan(0)
      const snaps = await socket.snapshots()
      const raw = JSON.stringify([welcome, snaps])
      expect(raw).not.toContain(WORDS)
      expect(raw).not.toContain(FREE)
      const dead = snaps.flatMap((f) => f.elements).filter((e) => e.isDeleted)
      expect(dead.length).toBeGreaterThanOrEqual(3)
      for (const e of dead) expect(e.customData, `${e.id} carries no customData`).toBeUndefined()
    } finally {
      await socket.close()
    }
    await expectConverged(a.page, [s.page])
    await s.context.close()
  }

  // alice's undo of her own delete restores the free text whole, for everyone
  const v = await canvasSession('victor', { role: 'viewer' })
  await undo(a.page)
  await expectSaved(a.page)
  await waitForItem(v.page, 'free-words')
  await expect.poll(() => itemText(v.page, 'free-words')).toBe(FREE)
  // the api's "Recently deleted" restores the note through the open room
  const res = await a.page.request.post(`/api/boards/${board}/deleted/restore`, {
    data: { ids: [`shape:${note}`] },
    headers: { origin: WEB_URL },
  })
  expect(res.status(), await res.text()).toBe(200)
  await waitForItem(v.page, note)
  await expect.poll(() => itemText(v.page, note)).toBe(WORDS)
  expect((await item(v.page, note))?.isDeleted ?? false).toBe(false)
  await expectConverged(a.page, [v.page])
})
