// OWNER: 3f (workshops; wave N, WS3; N3-2). The kill switch: with DRAFTROOM_REACTIONS=off the sync refuses every react
// write UNAVAILABLE (a retryable code: the engine would retry for ever). The room still says 13, so the page offers
// reacting; the person is told "Reactions are switched off right now", the key goes back to the server's value (the
// chip is gone), the retries stop (the page returns to Saved) and nothing is stored. Another tab never sees it.
//
//   cd e2e && E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/n3-reactions-off.spec.ts --project=chromium --workers=1
import { expectSaved } from '../tests/support/canvas.ts'
import { storedElement } from '../tests/support/excalidraw.ts'
import {
  expect,
  expectItemsEverywhere,
  reactionChip,
  reactionRow,
  reactionsOfElement,
  reactWithMouse,
  seed,
  showAll,
  test,
} from './workshops-kit.ts'

test.use({ syncEnv: { DRAFTROOM_REACTIONS: 'off' } })

const N = 'n3off-note'

test('with DRAFTROOM_REACTIONS=off the toast shows, the key goes back and nothing is stored', async ({
  join,
  board,
  stack,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  await seed(a.page, { notes: [{ id: N, x: 40, y: 60, text: 'Warm-up game' }] })
  await expectItemsEverywhere([b], [N])
  for (const s of [a, b]) await showAll(s.page)

  await reactWithMouse(b.page, N, 'up')
  // the engine retries UNAVAILABLE; the second answer is read as the switch: the person is told
  await expect(b.page.getByTestId('reaction-toast')).toContainText('Reactions are switched off right now', {
    timeout: 20_000,
  })
  // the key is the server's value again (it never had it): no chip, and the page settles (no retry loop left)
  await expect(reactionRow(b.page, N)).toHaveCount(0)
  await expectSaved(b.page)
  expect(reactionsOfElement(await storedElement(stack, board, N))).toEqual({})
  // the other tab saw nothing at any point
  await expect(reactionRow(a.page, N)).toHaveCount(0)

  // asking again is told again, and still nothing is stored
  await b.page.getByTestId('reaction-toast').waitFor({ state: 'detached', timeout: 20_000 })
  await reactWithMouse(b.page, N, 'heart')
  await expect(b.page.getByTestId('reaction-toast')).toContainText('Reactions are switched off right now', {
    timeout: 20_000,
  })
  await expect(reactionChip(b.page, N, 'heart')).toHaveCount(0)
  await expectSaved(b.page)
  expect(reactionsOfElement(await storedElement(stack, board, N))).toEqual({})
})
