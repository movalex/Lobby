// M2-5 (wave M, W2, S6): "How did this go in Lobby? [Good] [Something got in the way]" at the end of a facilitated moment.
// The feedback box has had no messages in 50 hours of use; asking at a natural end, at most once a week, is the least
// naggy way to ask. No route, no api field: Good is a plain feedback text ("Good (after a vote reveal)") through
// POST /api/feedback, Something got in the way opens the existing Send feedback dialog with "After a vote reveal: ".
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/m2-feedback-prompt.spec.ts --project=chromium --workers=1
import type { Page } from '@playwright/test'
import { expectSaved, startTextEditingWithKeyboard, stopTextEditing } from '../tests/support/canvas.ts'
import {
  expect,
  expectItemsEverywhere,
  post,
  seed,
  test,
  type WorkshopCanvasSession,
} from './workshops-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

const prompt = (p: Page) => p.getByTestId('feedback-prompt')

/** Starts a vote of `starter`'s on the board's notes, two people cast, and `starter` reveals it. */
async function voteAndReveal(starter: WorkshopCanvasSession, others: WorkshopCanvasSession[], board: string) {
  const res = await post(starter, `/api/boards/${board}/votes`, {
    title: 'Pick one',
    votesPerPerson: 3,
    onePerObject: false,
    scope: 'board',
  })
  expect(res.status(), await res.text()).toBe(201)
  const sid = ((await res.json()) as { session: { id: string } }).session.id
  for (const who of others)
    expect((await post(who, `/api/votes/${sid}/cast`, { shapeId: 'shape:m2f-a', delta: 1 })).status()).toBe(
      200,
    )
  expect((await post(starter, `/api/votes/${sid}/reveal`)).status()).toBe(200)
}

test('a vote reveal asks its starter once: Something got in the way opens the dialog with the sentence; a second reveal the same day does not; the others are never asked', async ({
  join,
  board,
}) => {
  const a = await join('alice') // starts the votes
  const b = await join('bob', 'editor')
  await seed(a.page, {
    notes: ['a', 'b'].map((x, i) => ({ id: `m2f-${x}`, x: i * 320, y: 0, text: `Idea ${x}` })),
  })
  await expectItemsEverywhere([b], ['m2f-a', 'm2f-b'])

  await test.step('the reveal puts the question to alice only, in the top-centre stack', async () => {
    await voteAndReveal(a, [b], board)
    await expect(prompt(a.page)).toBeVisible({ timeout: 8_000 })
    await expect(prompt(a.page)).toContainText('How did this go in Lobby?')
    await expect(prompt(a.page)).toHaveAttribute('data-moment', 'vote-reveal')
    await expect(
      a.page.locator('[data-testid="top-centre-stack"] [data-testid="feedback-prompt"]'),
    ).toBeVisible()
    // bob saw the same reveal (his results card) and is not the one who ran it
    await expect(b.page.getByTestId('vote-results-card')).toBeVisible()
    await b.page.waitForTimeout(1_000)
    await expect(prompt(b.page)).toHaveCount(0)
  })

  await test.step('Something got in the way: the existing dialog opens with "After a vote reveal: " in What happened?', async () => {
    await a.page.getByTestId('feedback-prompt-issue').click()
    await expect(prompt(a.page)).toHaveCount(0)
    await expect(a.page.getByTestId('feedback-dialog')).toBeVisible()
    const text = a.page.getByTestId('feedback-text')
    await expect(text).toHaveValue('After a vote reveal: ')
    // the sentence alone is not a message; add to it and it is
    await expect(a.page.getByTestId('feedback-submit')).toBeDisabled()
    await text.pressSequentially('the countdown jumped')
    await expect(a.page.getByTestId('feedback-submit')).toBeEnabled()
    await a.page.getByRole('button', { name: 'Cancel' }).click()
    await expect(a.page.getByTestId('feedback-dialog')).toHaveCount(0)
  })

  await test.step('a second reveal the same day asks nothing', async () => {
    await voteAndReveal(a, [b], board)
    await expect(a.page.getByTestId('vote-results-card')).toBeVisible({ timeout: 8_000 })
    await a.page.waitForTimeout(1_500)
    await expect(prompt(a.page)).toHaveCount(0)
  })
})

test('Good sends "Good (after a vote reveal)" as a feedback text, with the usual context, and says thanks', async ({
  join,
  board,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  await seed(a.page, { notes: [{ id: 'm2f-a', x: 0, y: 0, text: 'Idea a' }] })
  await expectItemsEverywhere([b], ['m2f-a'])
  await voteAndReveal(a, [b], board)
  await expect(prompt(a.page)).toBeVisible({ timeout: 8_000 })

  const sent = a.page.waitForRequest(
    (r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/feedback',
  )
  await a.page.getByTestId('feedback-prompt-good').click()
  const body = (await sent).postDataJSON() as { text: string; context?: { boardId?: string; path?: string } }
  expect(body.text).toBe('Good (after a vote reveal)')
  expect(body.context?.boardId).toBe(board)
  expect(Object.keys(body).sort()).toEqual(['context', 'text']) // no kind, no moment, nothing the api would drop
  await expect(a.page.getByTestId('feedback-prompt-thanks')).toBeVisible()
  await expect(prompt(a.page)).toHaveCount(0, { timeout: 8_000 })
})

test('words in progress hold the question: it is asked once the editor closes', async ({ join, board }) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  await seed(a.page, {
    notes: [
      { id: 'm2f-a', x: 0, y: 0, text: 'Idea a' },
      { id: 'm2f-w', x: 320, y: 0, text: 'Typing here' },
    ],
  })
  await expectItemsEverywhere([b], ['m2f-a', 'm2f-w'])
  await expectSaved(a.page)
  // alice is in the middle of a note (an open editor holds its lease) when the vote she started is revealed
  await startTextEditingWithKeyboard(a.page, 'm2f-w')
  await voteAndReveal(a, [b], board)
  await expect(a.page.getByTestId('vote-results-card')).toBeVisible({ timeout: 8_000 })
  await a.page.waitForTimeout(1_500)
  await expect(prompt(a.page)).toHaveCount(0)
  await stopTextEditing(a.page)
  await expect(prompt(a.page)).toBeVisible({ timeout: 8_000 })
})
