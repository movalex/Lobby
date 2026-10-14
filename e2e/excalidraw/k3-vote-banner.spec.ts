// K3-1 (wave K): the one real vote with three people connected got no ballots: participants had to find
// "Join the vote" first. Now everyone who may vote gets a "Vote started" banner when a vote starts (once per
// vote), with who started it and how many dots they have; one click joins, and they can vote at once. A
// click on a note before joining joins and casts at once (P-001: a vote ended with 0 votes because people
// clicked notes and nothing happened until they found "Join").
// The store's rules are unit-tested (features/workshops/store.test.ts "the Vote started banner").
import type { Page } from '@playwright/test'
import { itemBounds, setTool } from '../tests/support/canvas.ts'
import { workshopState } from '../tests/support/workshops.ts'
import {
  clickElement,
  dot,
  expect,
  expectItemsEverywhere,
  post,
  reachableCenter,
  seed,
  showAll,
  test,
} from './workshops-kit.ts'

const banner = (page: Page) => page.getByTestId('vote-join-prompt')
const remaining = (page: Page) => page.getByTestId('vote-remaining')

const NOTES = [
  { id: 'k3v-a', x: 0, y: 0, text: 'Weekly demo' },
  { id: 'k3v-b', x: 260, y: 0, text: 'Shorter standups' },
  { id: 'k3v-c', x: 520, y: 0, text: 'Pair on reviews' },
]

async function startVote(s: Parameters<typeof post>[0], board: string) {
  const r = await post(s, `/api/boards/${board}/votes`, {
    title: 'Pick our next experiment',
    votesPerPerson: 3,
    onePerObject: false,
    scope: 'board',
  })
  expect(r.status(), await r.text()).toBe(201)
  return ((await r.json()) as { session: { id: string } }).session.id
}

const casts = (s: { net: { responses: { path: string }[] } }) =>
  s.net.responses.filter((r) => r.path.endsWith('/cast'))

test('K3-1: a vote starts: the colleague gets the banner at once, joins with one click and votes straight away', async ({
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

  const startedAt = Date.now()
  await startVote(a, board)
  await test.step('bob: "Alice started a vote", with his dots, within the event stream’s latency', async () => {
    await expect(banner(b.page)).toBeVisible({ timeout: 5_000 })
    const after = Date.now() - startedAt
    testInfo.annotations.push({ type: 'banner latency', description: `${after} ms` })
    expect(after).toBeLessThan(5_000)
    await expect(b.page.getByTestId('vote-banner-by')).toHaveText(`${a.name.split(' ')[0]} started a vote`)
    await expect(banner(b.page)).toContainText('Pick our next experiment')
    await expect(b.page.getByTestId('vote-click-hint')).toContainText('3 votes left')
    await expect(banner(b.page).getByTestId('vote-join')).toHaveText('Join and vote')
    // wave K integration (the K3 review): the board's polite live region says it (the banner takes no focus)
    await expect(b.page.getByTestId('canvas-announcer-tool')).toHaveText(
      `${a.name.split(' ')[0]} started a vote: Pick our next experiment. Join and vote is on the board.`,
    )
    await b.page.screenshot({ path: testInfo.outputPath('k3-vote-banner.png') })
  })

  await test.step('alice, who started it, is in already: no banner, her voting bar', async () => {
    await expect(a.page.getByTestId('vote-bar')).toBeVisible()
    await expect(banner(a.page)).toHaveCount(0)
  })

  await test.step('one click: bob is in, with "3 of 3 left", and his first click on a note is a dot', async () => {
    await banner(b.page).getByTestId('vote-join').click()
    await expect(banner(b.page)).toHaveCount(0)
    await expect(remaining(b.page)).toHaveText('3 of 3 left')
    await clickElement(b.page, 'k3v-a')
    await expect(dot(b.page, 'k3v-a')).toHaveAttribute('data-count', '1')
    await expect(remaining(b.page)).toHaveText('2 of 3 left')
  })

  await test.step('the count update that follows does not bring the banner back', async () => {
    await b.page.reload()
    await expect(b.page.getByTestId('vote-bar')).toBeVisible()
    await expect(banner(b.page)).toHaveCount(0)
  })
})

test('P-001: a click on a note before joining joins and casts at once; the prompt says voting is on', async ({
  join,
  board,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  const c = await join('carol', 'viewer')
  await seed(a.page, { notes: NOTES })
  await expectItemsEverywhere(
    [b, c],
    NOTES.map((n) => n.id),
  )
  await showAll(b.page)
  await startVote(a, board)
  await expect(banner(b.page)).toBeVisible()

  await test.step('the prompt says voting is on, what to click and how many votes are left', async () => {
    await expect(b.page.getByTestId('vote-click-hint')).toContainText(
      'Voting is on: click objects to vote, 3 votes left.',
    )
  })

  await test.step('bob clicks a note first: his dot is on it at once, he is in, no Join needed', async () => {
    const before = b.net.responses.length
    await clickElement(b.page, 'k3v-b')
    await expect(dot(b.page, 'k3v-b')).toHaveAttribute('data-count', '1')
    await expect(banner(b.page)).toHaveCount(0)
    await expect(remaining(b.page)).toHaveText('2 of 3 left')
    await expect.poll(() => casts(b).length).toBe(1)
    const after = b.net.responses.slice(before).map((r) => r.path)
    const join = after.findIndex((p) => p.endsWith('/workshop'))
    const cast = after.findIndex((p) => p.endsWith('/cast'))
    expect(join, after.join(', ')).toBeGreaterThanOrEqual(0)
    expect(cast).toBeGreaterThan(join) // the join confirms the vote with the server first (G1)
  })

  await test.step('the next click on another note is an ordinary vote', async () => {
    await clickElement(b.page, 'k3v-c')
    await expect(dot(b.page, 'k3v-c')).toHaveAttribute('data-count', '1')
    await expect(remaining(b.page)).toHaveText('1 of 3 left')
  })

  await test.step('a viewer may vote too: her banner; "Not now" puts it away for good', async () => {
    await expect(banner(c.page)).toBeVisible()
    await banner(c.page).getByTestId('vote-skip').click()
    await expect(banner(c.page)).toHaveCount(0)
    await expect(c.page.getByTestId('vote-toast')).toContainText('You can join later')
    await c.page.reload()
    await expect(c.page.getByTestId('facilitate-pill-vote')).toBeVisible()
    await expect(banner(c.page)).toHaveCount(0)
    expect(casts(c)).toEqual([])
  })

  await test.step('the vote ends: no banner anywhere', async () => {
    const d = await join('dave', 'editor')
    await expect(banner(d.page)).toBeVisible()
    const panel = a.page.getByTestId('voting-panel')
    if (!(await panel.isVisible())) await a.page.getByTestId('dock-tab-voting').click()
    await panel.getByTestId('vote-close').click()
    await expect(banner(d.page)).toHaveCount(0)
  })
})

// P-015: a vote nobody cast a dot in used to end with confetti, "0 votes from 0 people" and a survey question.
test('P-015: ending a vote nobody voted in is calm: no confetti, "No votes were cast", no survey', async ({
  join,
  board,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  await seed(a.page, { notes: NOTES })
  await expectItemsEverywhere(
    [b],
    NOTES.map((n) => n.id),
  )
  const sid = await startVote(a, board)
  await expect(banner(b.page)).toBeVisible()
  expect((await post(a, `/api/votes/${sid}/reveal`)).status()).toBe(200)

  await test.step('bob: the card says nothing was cast; there is no confetti and no list', async () => {
    const card = b.page.getByTestId('vote-results-card')
    await expect(card).toBeVisible()
    await expect(card).toContainText('No votes were cast')
    await expect(card.getByTestId('vote-results-card-row')).toHaveCount(0)
    await b.page.waitForTimeout(600)
    await expect(b.page.getByTestId('vote-confetti')).toHaveCount(0)
  })

  await test.step('alice, who ran it: no confetti and no "How did this go?" question', async () => {
    await expect(a.page.getByTestId('vote-results-card')).toBeVisible()
    await a.page.waitForTimeout(1_500)
    await expect(a.page.getByTestId('vote-confetti')).toHaveCount(0)
    await expect(a.page.getByTestId('feedback-prompt')).toHaveCount(0)
    await a.page.getByTestId('dock-tab-voting').click()
    await expect(a.page.getByTestId('vote-final')).toHaveText(
      'Voting is over. No votes were cast. Everyone sees the results.',
    )
  })
})

// Wave P review (P-001): with the banner up, every press on a note was the vote's, so someone who had not joined could
// not move a note, and the hand tool's click joined and voted too. Now, before joining, a press goes to the board (a
// drag moves the note, nothing is cast) and only a click without a drag joins and votes; the hand tool never votes.
test('P-001 review: before joining, a drag moves a note and casts nothing, and the hand tool never votes', async ({
  join,
  board,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  await seed(a.page, { notes: NOTES })
  await expectItemsEverywhere(
    [b],
    NOTES.map((n) => n.id),
  )
  await showAll(b.page)
  await startVote(a, board)
  await expect(banner(b.page)).toBeVisible()

  await test.step('a drag on a note moves it; nothing is cast and the banner stays', async () => {
    const before = await itemBounds(b.page, 'k3v-a')
    if (!before) throw new Error('no bounds')
    const at = await reachableCenter(b.page, 'k3v-a')
    await b.page.mouse.move(at.x, at.y)
    await b.page.mouse.down()
    await b.page.mouse.move(at.x + 60, at.y + 90, { steps: 6 })
    await b.page.mouse.move(at.x + 120, at.y + 180, { steps: 6 })
    await b.page.mouse.up()
    await expect.poll(async () => (await itemBounds(b.page, 'k3v-a'))?.y ?? 0).toBeGreaterThan(before.y + 60)
    await b.page.waitForTimeout(500)
    expect(casts(b)).toEqual([])
    await expect(dot(b.page, 'k3v-a')).toHaveCount(0)
    await expect(banner(b.page)).toBeVisible()
  })

  await test.step('the hand tool: a click on a note casts nothing', async () => {
    expect(await setTool(b.page, 'hand')).toBe(true)
    await clickElement(b.page, 'k3v-b')
    await b.page.waitForTimeout(1_000)
    expect(casts(b)).toEqual([])
    await expect(dot(b.page, 'k3v-b')).toHaveCount(0)
    await expect(banner(b.page)).toBeVisible()
    expect(await setTool(b.page, 'select')).toBe(true)
  })

  await test.step('with the select tool, a click without a drag joins and votes', async () => {
    await clickElement(b.page, 'k3v-c')
    await expect(dot(b.page, 'k3v-c')).toHaveAttribute('data-count', '1')
    await expect(banner(b.page)).toHaveCount(0)
    await expect.poll(() => casts(b).length).toBe(1)
  })
})

// Wave P review (P-001): the click that joins marked this person in at once, while the join was still being
// confirmed with the server, so a second click cast its dot before the join's own: two votes racing the join. Now a
// vote click while the join is being confirmed waits for it, and each click is one dot, cast after the join.
test('P-001 review: a second click while the join is being confirmed waits for it: one dot per click, both after the join', async ({
  join,
  board,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  await seed(a.page, { notes: NOTES })
  await expectItemsEverywhere(
    [b],
    NOTES.map((n) => n.id),
  )
  await showAll(b.page)
  await startVote(a, board)
  await expect(banner(b.page)).toBeVisible()
  const first = await reachableCenter(b.page, 'k3v-a')
  const second = await reachableCenter(b.page, 'k3v-b')
  // the join's confirmation takes a while
  await b.page.route('**/workshop', async (route) => {
    await new Promise((r) => setTimeout(r, 1_500))
    await route.continue()
  })
  const before = b.net.responses.length
  await b.page.mouse.click(first.x, first.y)
  await b.page.waitForTimeout(300)
  await b.page.mouse.click(second.x, second.y)
  await expect(dot(b.page, 'k3v-a')).toHaveAttribute('data-count', '1')
  await expect(dot(b.page, 'k3v-b')).toHaveAttribute('data-count', '1')
  await expect(remaining(b.page)).toHaveText('1 of 3 left')
  await expect.poll(() => casts(b).length).toBe(2)
  const after = b.net.responses.slice(before).map((r) => r.path)
  const joined = after.findIndex((p) => p.endsWith('/workshop'))
  const firstCast = after.findIndex((p) => p.endsWith('/cast'))
  expect(joined, after.join(', ')).toBeGreaterThanOrEqual(0)
  expect(firstCast, after.join(', ')).toBeGreaterThan(joined)
  await b.page.unroute('**/workshop')
  expect((await workshopState(b.api, board)).vote?.myVotes).toEqual({ 'shape:k3v-a': 1, 'shape:k3v-b': 1 })
})
