// Wave K (K4-2): every template of the catalogue, inserted the way people insert one (`?template=` on an empty
// board: the page builds the scene with the browser's own measurements and the real sync server validates
// and stores every element). The six agency templates join the original seven, so this spec runs over
// TEMPLATE_INFOS and a template added later is covered the day it lands:
//   - the frames arrive (one per section) and the board is Saved;
//   - the server stores exactly what the tab holds (no op refused, no element dropped);
//   - nothing in the sync log says an op was refused, and the page raised no error.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw k4-templates
import { TEMPLATE_INFOS } from '../../packages/templates/src/plan.ts'
import { expect, expectSaved, items, test } from '../tests/support/canvas.ts'
import { expectServerConverged, serverSnapshot } from '../tests/support/excalidraw.ts'
import { countOf, waitForNavigation } from './navigation-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

test('every template inserts and is accepted by the server: its frames, one stored copy of every element, no refused op', async ({
  canvasSession,
  users,
  stack,
}) => {
  test.setTimeout(60_000 + TEMPLATE_INFOS.length * 40_000)
  const a = await canvasSession('alice')
  const problems: string[] = []
  a.page.on('pageerror', (e) => problems.push(e.message))
  for (const t of TEMPLATE_INFOS) {
    await test.step(t.id, async () => {
      const board = await users.createBoard(`K4 ${t.id}`)
      await a.page.goto(`/b/${board}?template=${t.id}`)
      await waitForNavigation(a.page)
      await expect
        .poll(() => countOf(a.page, 'frame'), { timeout: 30_000, message: `${t.id}: frames` })
        .toBe(t.sections.length)
      await expectSaved(a.page)
      await expect(a.page.getByText('Change not saved')).toHaveCount(0)

      const held = await items(a.page)
      const snapshot = await expectServerConverged(stack, board, [a.page])
      const stored = snapshot.elements.filter((e) => !e.isDeleted)
      // the server holds every element the tab holds, and nothing else
      expect(stored.length, `${t.id}: stored elements`).toBe(held.length)
      expect(
        stored
          .filter((e) => e.type === 'frame')
          .map((e) => (e as { name?: string }).name)
          .sort(),
      ).toEqual([...t.sections].sort())
      expect((await serverSnapshot(stack, board)).elements.some((e) => e.isDeleted)).toBe(false)
    })
  }
  // a refused op is answered to the client, never logged as a failure: what the room does log is a room that
  // failed to open or commit, or a server write it had to refuse (apps/sync element-room.ts)
  expect(stack.sync.logs()).not.toMatch(/room error|room open failed|server write refused|ERR_INVALID_STATE/)
  expect(problems).toEqual([])
})
