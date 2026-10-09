// Wave L (W2, L2-4): the session coach in three browsers, against the real api and sync server (OpenAI is the local
// fake; the wave L 'recap' goes through the e2e AI fake of ai-kit). The facilitator (alice) follows the chips from
// the colleagues' notes to themes, a vote (both colleagues cast), a reveal, vote-weighted action items and Wrap up;
// the colleagues' tabs push nothing whenever a chip is shown, and the chip sits by the Facilitate control.
// Steps that ride on other workstreams say so in an annotation when this build lacks them: W5's
// 'workshops.vote.setup' (else the vote starts through the api with the chip's theme notes), and W1's
// vote-weighted 'actions' (else the items come back without `votes`).
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/l2-coach.spec.ts --project=chromium --workers=1
import type { Page } from '@playwright/test'
import { type FakeOpenAi, startFakeOpenAi } from '../tests/support/ai.ts'
import { expectSaved, items, saveState } from '../tests/support/canvas.ts'
import { pushCount } from '../tests/support/excalidraw.ts'
import {
  AI_API_ENV_3H,
  aiMenu,
  aiObjects,
  applyPreview,
  FAKE_OPENAI_PORT_3H,
  fakeAiRuns,
  foreignRequests,
} from './ai-kit.ts'
import { expect, post, seed, showAll, type WorkshopCanvasSession, test as wk } from './workshops-kit.ts'

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

/** Continues past the OpenAI notice when it shows, until `then` is visible. */
async function continueNotice(page: Page, then: ReturnType<Page['getByTestId']>) {
  const cont = aiMenu(page).getByTestId('ai-notice-continue')
  await expect(cont.or(then).first()).toBeVisible({ timeout: 20_000 })
  if (await cont.isVisible()) await cont.click()
}

test('the facilitator follows the chips: themes, a vote, a reveal, action items by votes, Wrap up; the colleagues push nothing', async ({
  join,
  board,
}) => {
  test.setTimeout(240_000)
  const a = await join('alice')
  const b = await join('bob', 'editor')
  const c = await join('carol', 'editor')
  const foreign = [a, b, c].flatMap((s) => foreignRequests(s.page))
  await seed(a.page, { frames: [{ id: 'l2c-f', x: 0, y: 0, w: 1400, h: 900, name: 'Brainstorm' }] })
  await expect.poll(async () => (await items(b.page)).some((e) => e.id === 'l2c-f')).toBe(true)
  const ideas = (who: string, x0: number) =>
    ['Beach screenings', 'Solstice drop', 'Creator reactions', 'Ski lodge premiere'].map((t, i) => ({
      id: `l2c-${who}-${i}`,
      x: x0 + i * 230,
      y: who === 'b' ? 80 : 400,
      text: `${t} (${who})`,
      frameId: 'l2c-f',
    }))
  await seed(b.page, { notes: ideas('b', 60) })
  await seed(c.page, { notes: ideas('c', 60) })
  await expect.poll(async () => (await items(a.page)).filter((e) => e.type === 'stickynote').length).toBe(8)
  for (const s of [a, b, c]) await showAll(s.page)
  const pushes = { b: await pushCount(b.page), c: await pushCount(c.page) }
  const colleaguesQuiet = async () => {
    expect(await pushCount(b.page), 'bob pushed nothing').toBe(pushes.b)
    expect(await pushCount(c.page), 'carol pushed nothing').toBe(pushes.c)
  }

  await test.step('1: “Group these 8 notes into themes”, next to the Facilitate control; the preview, Apply', async () => {
    await expect(chip(a.page)).toHaveAttribute('data-step', 'themes', { timeout: 20_000 })
    await expect(chip(a.page)).toContainText('Group these 8 notes into themes')
    const f = await a.page.getByTestId('facilitate-button').boundingBox()
    const ch = await chip(a.page).boundingBox()
    // under the Facilitate control, right edges together (clear of the style panel at the canvas's top right)
    expect(
      f &&
        ch &&
        Math.abs(ch.x + ch.width - (f.x + f.width)) < 4 &&
        ch.y > f.y &&
        ch.y - (f.y + f.height) < 80,
    ).toBe(true)
    await colleaguesQuiet()
    await a.page.getByTestId('coach-run').click()
    await continueNotice(a.page, a.page.getByTestId('ai-preview-panel'))
    await applyPreview(a.page, { summary: 'Moves 8 notes into' })
    await expect(a.page.getByTestId('ai-done')).toContainText('Grouped 8 notes')
    await expectSaved(a.page)
  })

  let sid = ''
  await test.step('2: “Start a 3-dot vote on the themes”; both colleagues cast; alice reveals', async () => {
    await expect(chip(a.page)).toHaveAttribute('data-step', 'vote')
    await expect(chip(a.page)).toContainText('Start a 3-dot vote on the themes')
    await colleaguesQuiet()
    await a.page.getByTestId('coach-run').click()
    const hint = a.page.getByTestId('coach-vote-hint')
    const dialog = a.page.getByTestId('vote-setup-submit')
    await expect(hint.or(dialog).first()).toBeVisible()
    if (await dialog.isVisible()) {
      await a.page.getByTestId('vote-per-person').fill('3')
      await dialog.click()
    } else {
      test.info().annotations.push({
        type: 'vote',
        description:
          'started through the api with the chip’s theme notes (W5 workshops.vote.setup not on this branch)',
      })
      const refs = (await items(a.page))
        .filter((e) => e.type === 'stickynote' && e.frameId === 'l2c-f')
        .map((e) => `shape:${e.id}`)
      const r = await post(a, `/api/boards/${board}/votes`, {
        votesPerPerson: 3,
        onePerObject: false,
        scope: 'selection',
        selection: refs,
      })
      expect(r.status(), await r.text()).toBe(201)
    }
    const state = (await (await a.api.fetch('GET', `/api/boards/${board}/workshop`)).json()) as {
      vote: { session: { id: string; status: string } }
    }
    sid = state.vote.session.id
    expect(state.vote.session.status).toBe('open')
    // people are voting: no chip
    await expect(chip(a.page)).toHaveCount(0)
    const cast = async (s: WorkshopCanvasSession, id: string) =>
      expect((await post(s, `/api/votes/${sid}/cast`, { shapeId: `shape:${id}`, delta: 1 })).status()).toBe(
        200,
      )
    for (const id of ['l2c-b-1', 'l2c-b-1', 'l2c-c-2']) await cast(b, id)
    for (const id of ['l2c-b-1', 'l2c-c-2', 'l2c-b-3']) await cast(c, id)
    expect((await post(a, `/api/votes/${sid}/reveal`)).status()).toBe(200)
  })

  await test.step('3: “Turn the top 5 into action items”: the vote’s top items, the vote id; ordered by votes', async () => {
    await expect(chip(a.page)).toHaveAttribute('data-step', 'actions', { timeout: 20_000 })
    await colleaguesQuiet()
    const fake = await fakeAiRuns(a.page)
    await a.page.getByTestId('coach-run').click()
    await continueNotice(a.page, a.page.getByTestId('ai-done'))
    await expect(a.page.getByTestId('ai-done')).toContainText('action item')
    const call = fake.of('actions')[0]
    expect(call?.body.voteSessionId).toBe(sid)
    expect([...((call?.body.shapeIds as string[]) ?? [])].sort()).toEqual([
      'shape:l2c-b-1',
      'shape:l2c-b-3',
      'shape:l2c-c-2',
    ])
    const result = call?.result as { items?: { votes?: number }[] } | null
    const votes = (result?.items ?? []).map((i) => i.votes)
    if (votes.every((v) => v === undefined))
      test.info().annotations.push({
        type: 'actions',
        description: 'this api does not weight action items by votes yet (W1 L1-7): no `votes` in the items',
      })
    else expect([...votes].sort((p, q) => (q ?? 0) - (p ?? 0))).toEqual(votes)
    await expectSaved(a.page)
    await fake.dispose()
  })

  await test.step('4: “Wrap up”: the recap; Add as Recap frame ends the coaching', async () => {
    await expect(chip(a.page)).toHaveAttribute('data-step', 'wrapup')
    await expect(chip(a.page)).toHaveText(/Wrap up/)
    await colleaguesQuiet()
    const fake = await fakeAiRuns(a.page)
    await a.page.getByTestId('coach-run').click()
    const panel = a.page.locator('[data-testid="recap-panel"][data-status="done"]')
    await continueNotice(a.page, panel)
    await expect(panel).toBeVisible({ timeout: 20_000 })
    expect(fake.of('recap')).toHaveLength(1)
    await expect(panel.getByTestId('recap-top-voted')).toContainText('Solstice drop (b)')
    await panel.getByTestId('recap-add').click()
    await expectSaved(a.page)
    expect((await saveState(a.page)).lastReject).toBeNull()
    await expect(chip(a.page)).toHaveCount(0)
    await colleaguesQuiet()
  })

  await test.step('the colleagues saw the result as everyone does; nothing left Lobby’s origins', async () => {
    await expect.poll(async () => (await aiObjects(b.page)).some((o) => o.kind === 'recap')).toBe(true)
    expect(foreign).toEqual([])
  })
})

test('a dismissed chip stays dismissed on that board (a reload too); a viewer never gets one', async ({
  join,
}) => {
  const a = await join('alice')
  const v = await join('vera', 'viewer')
  await seed(a.page, {
    frames: [{ id: 'l2d-f', x: 0, y: 0, w: 1400, h: 700, name: 'Ideas' }],
  })
  await seed(a.page, {
    notes: Array.from({ length: 8 }, (_, i) => ({
      id: `l2d-${i}`,
      x: 60 + (i % 4) * 230,
      y: 80 + Math.floor(i / 4) * 260,
      text: `Idea ${i}`,
      frameId: 'l2d-f',
    })),
  })
  await expect(chip(a.page)).toHaveAttribute('data-step', 'themes', { timeout: 20_000 })
  await a.page.getByTestId('coach-dismiss').click()
  await expect(chip(a.page)).toHaveCount(0)
  await a.page.reload()
  await expect(a.page.getByTestId('facilitate-button')).toBeAttached()
  await a.page.waitForTimeout(1_500)
  await expect(chip(a.page)).toHaveCount(0)
  await expect.poll(async () => (await items(v.page)).filter((e) => e.type === 'stickynote').length).toBe(8)
  await v.page.waitForTimeout(1_000)
  await expect(chip(v.page)).toHaveCount(0)
})
