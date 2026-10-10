// M2-2 (wave M, W2): the session coach says the right count and speaks only to the person running the session.
//  - "Turn the top 5 into action items" with 3 results was wrong (FTU-7): the chip counts what is there ("the top 3",
//    "the winner");
//  - in a ten-person meeting every editor got the facilitator's prompts: now the chip is the vote starter's, else the
//    live presenter's, else the board owner's while nobody presents. A plain editor sees none.
// OpenAI is the local fake (as l2-coach.spec.ts); no model call is made by anything here.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/m2-coach-facilitator.spec.ts --project=chromium --workers=1
import type { Page } from '@playwright/test'
import { type FakeOpenAi, startFakeOpenAi } from '../tests/support/ai.ts'
import { items } from '../tests/support/canvas.ts'
import { AI_API_ENV_3H, FAKE_OPENAI_PORT_3H } from './ai-kit.ts'
import { expect, post, seed, showAll, test as wk } from './workshops-kit.ts'

const test = wk.extend<object, { openai: FakeOpenAi }>({
  openai: [
    async ({ stack: _ }, use) => {
      const fake = await startFakeOpenAi(FAKE_OPENAI_PORT_3H)
      await use(fake)
      await fake.close()
    },
    { scope: 'worker' },
  ],
})

test.use({ viewport: { width: 1440, height: 900 }, apiEnv: AI_API_ENV_3H })
test.beforeEach(({ openai }) => openai.reset())

const chip = (page: Page) => page.getByTestId('coach-chip')

test('nobody runs it but the owner: eight notes bring "Group these notes" to the owner and to nobody else', async ({
  join,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  const c = await join('carol', 'editor')
  await seed(a.page, { frames: [{ id: 'm2c-f', x: 0, y: 0, w: 1400, h: 900, name: 'Brainstorm' }] })
  await seed(a.page, {
    notes: Array.from({ length: 8 }, (_, i) => ({
      id: `m2c-${i}`,
      x: 60 + (i % 4) * 230,
      y: 80 + Math.floor(i / 4) * 260,
      text: `Idea ${i}`,
      frameId: 'm2c-f',
    })),
  })
  for (const s of [b, c])
    await expect.poll(async () => (await items(s.page)).filter((e) => e.type === 'stickynote').length).toBe(8)
  for (const s of [a, b, c]) await showAll(s.page)
  // the owner's chip, the editors' none
  await expect(chip(a.page)).toHaveAttribute('data-step', 'themes', { timeout: 20_000 })
  await expect(chip(a.page)).toContainText('Group these 8 notes into themes')
  // the editors' tabs have all the notes (the chip would be computed there) and are given time to show one
  await b.page.waitForTimeout(1_500)
  await expect(chip(b.page)).toHaveCount(0)
  await expect(chip(c.page)).toHaveCount(0)
})

test('the vote’s starter gets "Turn the top 3 into action items" (3 results), then "the winner" (1 result); the owner and a third editor get nothing', async ({
  join,
  board,
}) => {
  test.setTimeout(180_000)
  const a = await join('alice') // the owner
  const b = await join('bob', 'editor') // starts the votes
  const c = await join('carol', 'editor')
  await seed(a.page, {
    notes: ['Beach screenings', 'Solstice drop', 'Creator reactions'].map((t, i) => ({
      id: `m2v-${i}`,
      x: 60 + i * 230,
      y: 120,
      text: t,
    })),
  })
  for (const s of [b, c])
    await expect.poll(async () => (await items(s.page)).filter((e) => e.type === 'stickynote').length).toBe(3)
  for (const s of [a, b, c]) await showAll(s.page)
  const refs = [0, 1, 2].map((i) => `shape:m2v-${i}`)

  type Workshop = { vote: { session: { id: string; status: string; createdBy: string } } | null }
  const readVote = async () =>
    ((await (await b.api.fetch('GET', `/api/boards/${board}/workshop`)).json()) as Workshop).vote
  const round = async (casts: [typeof a, string][]) => {
    const started = await post(b, `/api/boards/${board}/votes`, {
      votesPerPerson: 3,
      onePerObject: false,
      scope: 'selection',
      selection: refs,
    })
    expect(started.status(), await started.text()).toBe(201)
    await expect.poll(async () => (await readVote())?.session.status ?? null).toBe('open')
    const sid = (await readVote())?.session.id ?? ''
    for (const [who, ref] of casts)
      expect((await post(who, `/api/votes/${sid}/cast`, { shapeId: ref, delta: 1 })).status()).toBe(200)
    expect((await post(b, `/api/votes/${sid}/reveal`)).status()).toBe(200)
    return sid
  }

  // three results
  const first = await round([
    [c, refs[0] as string],
    [c, refs[1] as string],
    [a, refs[2] as string],
  ])
  await expect(chip(b.page)).toHaveAttribute('data-step', 'actions', { timeout: 20_000 })
  await expect(chip(b.page)).toContainText('Turn the top 3 into action items')
  // everyone saw the reveal (the results card), so a chip would have shown by now; the owner and carol have none
  for (const s of [a, c]) await expect(s.page.getByTestId('vote-results-card')).toBeVisible()
  await a.page.waitForTimeout(1_500)
  await expect(chip(a.page)).toHaveCount(0)
  await expect(chip(c.page)).toHaveCount(0)
  expect(first).toMatch(/^vot_/)

  // one result: only the first note got a vote
  await round([[c, refs[0] as string]])
  await expect(chip(b.page)).toContainText('Turn the winner into an action item', { timeout: 20_000 })
  await a.page.waitForTimeout(1_000)
  await expect(chip(a.page)).toHaveCount(0)
  await expect(chip(c.page)).toHaveCount(0)
})
