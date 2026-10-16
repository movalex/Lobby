// Wave T (CONTRACTS_REV 14, WS1's stale pair (b); docs/WAVE-T-CONTRACTS.md §3.5-§3.6): this tree's web and api against
// the DEPLOYED sync (ba1704c, CONTRACTS_REV 13, which knows no planning key), as the deploy order api, sync, web leaves
// them until the new sync is live. The run's sync is that build's (E2E_SYNC_ENTRY: the 6769e07 tree's
// apps/sync/src/server.ts, whose sync is ba1704c's), so the room says 13 although this stack sets DRAFTROOM_PLANNING=on
// (only an older sync does that: the proof the run is against it). With every planning switch of the page forced on
// (the dev-auth override of features/planning/flags.ts), this tree's web:
//  - reads the room as 13: no planning write is offered (planningOffered needs 14);
//  - and a planning key written anyway (the facade's update, as a feature would) never reaches the room: its push
//    carries none (the keys a room cannot know are stripped, as for any older sync), nothing is refused, the element
//    is stored without it, and the other tab ends on the server's board.
// Run:
//   cd e2e && E2E_SYNC_ENTRY=<the 6769e07 tree>/apps/sync/src/server.ts E2E_PORT_BASE=<base> \
//     pnpm exec playwright test excalidraw/t-compat-old-sync.spec.ts --project=chromium --workers=1
// Without E2E_SYNC_ENTRY it is skipped, saying so.
import type { Page } from '@playwright/test'
import { isPlanningKey } from '../../packages/canvas-schema/src/planning-keys.ts'
import {
  createItem,
  createNote,
  expect,
  expectSaved,
  hash,
  item,
  pushedOps,
  saveState,
  test,
  updateItem,
  waitForCanvas,
} from '../tests/support/canvas.ts'
import { serverSnapshot, storedElement } from '../tests/support/excalidraw.ts'
import { withCanvas } from './canvas-ux-kit.ts'

const OLD_SYNC = process.env.E2E_SYNC_ENTRY ?? null
/** apps/web/src/features/planning/flags.ts PLANNING_FLAG_KEYS (not imported: that module reads import.meta.env) */
const PLANNING_FLAG_KEYS = [
  'lobby.planStoryboard',
  'lobby.planStoryboardAi',
  'lobby.planAnimatic',
  'lobby.planStoryboardExports',
  'lobby.planCards',
  'lobby.planKanban',
  'lobby.planTable',
  'lobby.planTimeline',
]

const roomRev = (page: Page) => withCanvas(page, (c) => c.room.contractsRev(), null)

test('t-compat (b): this web against the deployed sync: the room says 13, no planning offered, no planning key pushed', async ({
  board,
  canvasSession,
  stack,
}) => {
  test.skip(
    !OLD_SYNC,
    'needs E2E_SYNC_ENTRY: the deployed sync’s server.ts (a 6769e07 or ba1704c tree with its install)',
  )
  test.setTimeout(180_000)
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  // every planning switch on for both pages (the dev-auth override), then a reload so the pages read it
  for (const s of [a, b]) {
    await s.page.evaluate((keys) => {
      for (const k of keys) localStorage.setItem(k, '1')
    }, PLANNING_FLAG_KEYS)
    await s.page.reload()
    await waitForCanvas(s.page)
  }
  test.info().annotations.push({ type: 'sync', description: String(OLD_SYNC) })

  await test.step('the room says 13 (the stack sets DRAFTROOM_PLANNING=on: only the older sync ignores it)', async () => {
    await expect.poll(() => roomRev(a.page)).toBe(13)
    await expect.poll(() => roomRev(b.page)).toBe(13)
  })

  await test.step('a planning key written on this page never reaches the room: no push names one, nothing is refused', async () => {
    const n = await createNote(a.page, { x: 100, y: 100, text: 'not a card here' })
    const f = await createItem(a.page, 'frame', { x: 400, y: 100, width: 320, height: 180, name: 'Panel' })
    await expectSaved(a.page)
    const before = (await pushedOps(a.page)).length
    await updateItem(a.page, n, {
      customData: { lobby: { 'card:status': 'todo', 'card:due': '2026-10-30' } },
    })
    await updateItem(a.page, f, { customData: { lobby: { kanban: { wip: { doing: 2 } } } } })
    await updateItem(a.page, n, { x: 140 })
    await expectSaved(a.page)
    expect((await saveState(a.page)).lastReject).toBeNull()
    const pushed = (await pushedOps(a.page)).slice(before).flatMap((p) => p.ops)
    const named = pushed.filter((op) => {
      const lobby =
        op.k === 'c'
          ? ((op.el as { customData?: { lobby?: object } }).customData?.lobby ?? {})
          : ((op as { c?: object }).c ?? {})
      return Object.keys(lobby).some(isPlanningKey)
    })
    expect(named, 'ops naming a planning key pushed to a rev-13 room').toEqual([])
    await expect.poll(async () => (await storedElement(stack, board, n))?.x).toBe(140)
    for (const id of [n, f]) {
      const lobby = ((await storedElement(stack, board, id))?.customData?.lobby ?? {}) as object
      expect(Object.keys(lobby).filter(isPlanningKey), id).toEqual([])
    }
    await expect.poll(async () => (await item(b.page, n))?.x).toBe(140)
  })

  await test.step('both tabs hold the server’s board', async () => {
    const server = await serverSnapshot(stack, board)
    await expect.poll(() => hash(a.page)).toBe(server.hash)
    await expect.poll(() => hash(b.page)).toBe(server.hash)
  })
})
