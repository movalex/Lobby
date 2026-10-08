// K3-2 (wave K): facilitation tools got tried but never finished: a vote with no close, a private brainstorm
// with no notes, no reveal and no cancel. The facilitator now sees "x of y voted" (from the counts the api
// sends and who is on the board) and a clear end, on the board and in the Voting panel; a brainstorm asks
// everyone to write and shows its starter how many notes came in, with Reveal. The components' rules are
// unit-tested (features/workshops/ported/voting-panel.test.ts).
import type { Page } from '@playwright/test'
import {
  clickElement,
  dot,
  expect,
  expectItemsEverywhere,
  post,
  seed,
  showAll,
  test,
} from './workshops-kit.ts'

const NOTES = [
  { id: 'k3f-a', x: 0, y: 0, text: 'Weekly demo' },
  { id: 'k3f-b', x: 260, y: 0, text: 'Shorter standups' },
]

async function openVotingPanel(page: Page) {
  const panel = page.getByTestId('voting-panel')
  if (!(await panel.isVisible())) await page.getByTestId('dock-tab-voting').click()
  await expect(panel).toBeVisible()
  return panel
}

test('K3-2: the facilitator sees "0 of 1 voted" become "1 of 1 voted" when the colleague casts, and ends the vote from the board', async ({
  join,
  board,
}, testInfo) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  await seed(a.page, { notes: NOTES })
  await expectItemsEverywhere(
    [b],
    NOTES.map((n) => n.id),
  )
  await showAll(b.page)
  const r = await post(a, `/api/boards/${board}/votes`, {
    title: 'Pick one',
    votesPerPerson: 1,
    onePerObject: false,
    scope: 'board',
  })
  expect(r.status(), await r.text()).toBe(201)

  const bar = a.page.getByTestId('vote-facilitator-bar')
  await test.step('before anyone votes: 0 of 1 (bob is here; alice runs it and need not vote)', async () => {
    await expect(bar.getByTestId('vote-bar-voted')).toHaveText('0 of 1 voted')
    const panel = await openVotingPanel(a.page)
    await expect(panel.getByTestId('vote-voted')).toHaveText('0 of 1 voted')
    await expect(panel.getByTestId('vote-reveal')).toHaveText('End and show results')
    await expect(panel.getByTestId('vote-close')).toBeVisible()
    await a.page.getByTestId('dock-panel-close').click()
  })

  await test.step('bob joins and casts: 1 of 1 voted, on the board and in the panel', async () => {
    await b.page.getByTestId('vote-join-prompt').getByTestId('vote-join').click()
    await clickElement(b.page, 'k3f-a')
    await expect(dot(b.page, 'k3f-a')).toHaveAttribute('data-count', '1')
    await expect(bar.getByTestId('vote-bar-voted')).toHaveText('1 of 1 voted', { timeout: 10_000 })
    await a.page.screenshot({ path: testInfo.outputPath('k3-vote-1-of-1.png') })
    const panel = await openVotingPanel(a.page)
    await expect(panel.getByTestId('vote-voted')).toHaveText('1 of 1 voted')
    await a.page.getByTestId('dock-panel-close').click()
  })

  await test.step('"Show results" on the board ends it: a final state for alice, the results for bob', async () => {
    await bar.getByTestId('vote-bar-reveal').click()
    await expect(bar).toHaveCount(0)
    const panel = await openVotingPanel(a.page)
    await expect(panel.getByTestId('vote-final')).toHaveText(
      'Voting is over: 1 vote from 1 person. Everyone sees the results.',
    )
    await expect(panel.getByTestId('vote-current')).toHaveAttribute('data-status', 'revealed')
    await expect(b.page.getByTestId('vote-results-card')).toBeVisible()
    await expect(b.page.getByTestId('vote-bar')).toHaveCount(0)
  })
})

test('K3-2: a private brainstorm asks bob to write, counts his note for alice, and alice reveals it from the board', async ({
  join,
  board,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  await seed(a.page, { frames: [{ id: 'k3f-frame', x: 0, y: 0, w: 900, h: 600, name: 'Ideas' }] })
  await expectItemsEverywhere([b], ['k3f-frame'])
  const started = await post(a, `/api/boards/${board}/private-brainstorm`, {
    prompt: 'What slowed us down?',
    anonymous: false,
    target: { frameId: 'shape:k3f-frame', pageId: 'page:page', x: 0, y: 0, w: 900, h: 600 },
  })
  expect(started.status(), await started.text()).toBe(201)

  const bar = a.page.getByTestId('pn-facilitator-bar')
  await test.step('alice: the count of notes so far (none yet) and Reveal; bob: the prompt to write', async () => {
    await expect(bar.getByTestId('pn-bar-counts')).toHaveText('No notes yet')
    await expect(bar.getByTestId('pn-bar-reveal')).toHaveText('Reveal')
    const prompt = b.page.getByTestId('pn-start-prompt')
    await expect(prompt).toBeVisible()
    await expect(prompt.getByTestId('pn-start-prompt-text')).toHaveText('What slowed us down?')
    await expect(b.page.getByTestId('pn-facilitator-bar')).toHaveCount(0)
  })

  await test.step('bob writes one note: alice sees "1 note from 1 person", never its words', async () => {
    await b.page.getByTestId('pn-start-prompt').getByTestId('pn-start-prompt-write').click()
    await b.page.getByTestId('pn-compose-text').fill('Too many meetings')
    await b.page.getByTestId('pn-add').click()
    await expect(b.page.getByTestId('pn-note-text')).toHaveText('Too many meetings')
    await expect(bar.getByTestId('pn-bar-counts')).toHaveText('1 note from 1 person')
    await expect(bar.getByTestId('pn-bar-reveal')).toHaveText('Reveal 1 note')
    const seen = a.net.responses.map((r) => r.body).join('\n')
    expect(seen).not.toContain('Too many meetings')
  })

  await test.step('alice reveals from the board: the note is on the board for both, and the bar is gone', async () => {
    await bar.getByTestId('pn-bar-reveal').click()
    await expect(a.page.getByTestId('pn-toast')).toContainText('1 note from the private brainstorm', {
      timeout: 15_000,
    })
    await expect(b.page.getByTestId('pn-toast')).toContainText('1 note from the private brainstorm')
    await expect(bar).toHaveCount(0)
  })
})
