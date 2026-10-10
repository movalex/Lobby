// OWNER: W4 (wave M; written by the wave M foundation, W4 owns ai-kit.ts and may fold this into its m4 specs). The
// Ask-across-boards e2e kit in a real browser, before W8's route or W4's switch exist:
//   - the board page sets no context, so askWorkspaceAvailable() is false and an ask sends nothing;
//   - forceWorkspaceAsk(page, true) (the dev-auth hook) makes it available, and an ask goes through the page's real
//     client to fakeWorkspaceAsk, whose canned answer comes back parsed;
//   - a 404 (the fake's `unavailable`, and the foundation api's own pending route) turns it off for the tab.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/m-foundation-ask-kit.spec.ts --project=chromium --workers=1
import { expect, test, waitForCanvas } from '../tests/support/canvas.ts'
import {
  askWorkspaceInPage,
  cannedWorkspaceAsk,
  fakeWorkspaceAsk,
  forceWorkspaceAsk,
  workspaceAskAvailable,
} from './ai-kit.ts'

const UNAVAILABLE = { ok: false, code: 'unavailable', message: 'unavailable' }

test('the workspace-ask kit: hidden by default, forced on it asks through the real client, a 404 turns it off', async ({
  canvasSession,
  users,
}) => {
  const a = await canvasSession('alice')
  const problems: string[] = []
  a.page.on('pageerror', (e) => problems.push(e.message))
  const board = await users.createBoard('M ask kit')
  await a.page.goto(`/b/${board}`)
  await waitForCanvas(a.page)

  const canned = cannedWorkspaceAsk([{ boardId: board, boardTitle: 'M ask kit', elementIds: ['note-1'] }])
  const fake = await fakeWorkspaceAsk(a.page, { answer: canned })
  await forceWorkspaceAsk(a.page, null)
  // the foundation sets no context: not available, and nothing is sent
  expect(await workspaceAskAvailable(a.page)).toBe(false)
  expect(await askWorkspaceInPage(a.page, 'What did we decide?')).toEqual(UNAVAILABLE)
  expect(fake.calls).toEqual([])

  // forced on: the real client posts to the board's workspace and the canned answer comes back parsed
  await forceWorkspaceAsk(a.page, true)
  expect(await workspaceAskAvailable(a.page)).toBe(true)
  expect(await askWorkspaceInPage(a.page, '  What did we decide?  ', true)).toEqual({
    ok: true,
    answer: canned,
  })
  expect(fake.calls).toHaveLength(1)
  expect(fake.calls[0]).toMatchObject({
    body: { question: '  What did we decide?  ', acknowledged: true },
    status: 200,
  })
  const workspaceId = fake.calls[0]?.workspaceId ?? ''
  expect(workspaceId).toMatch(/^wsp_/)

  // the api without the route (the fake's 404): unavailable, and off for the tab
  await fake.dispose()
  const gone = await fakeWorkspaceAsk(a.page, { unavailable: true })
  expect(await askWorkspaceInPage(a.page, 'Again?')).toEqual(UNAVAILABLE)
  expect(gone.calls.map((c) => [c.workspaceId, c.status])).toEqual([[workspaceId, 404]])
  expect(await workspaceAskAvailable(a.page)).toBe(false)
  expect(await askWorkspaceInPage(a.page, 'And again?')).toEqual(UNAVAILABLE)
  expect(gone.calls).toHaveLength(1)
  await gone.dispose()

  // and the foundation api itself (the route is pending, so it answers 404 like any unknown path)
  await a.page.reload()
  await waitForCanvas(a.page)
  await forceWorkspaceAsk(a.page, true)
  const seen: number[] = []
  a.page.on('response', (r) => {
    if (r.url().endsWith(`/api/workspaces/${workspaceId}/ai/ask`)) seen.push(r.status())
  })
  expect(await askWorkspaceInPage(a.page, 'From the api?')).toEqual(UNAVAILABLE)
  expect(seen).toEqual([404])
  expect(await workspaceAskAvailable(a.page)).toBe(false)
  expect(problems).toEqual([])
})
