// L5-3 (wave L) Vote results that move the meeting: after the reveal, the ranking is a bar chart; "Results to
// board" makes a native chart frame (one undo step, no refused op), "Gather the winners" copies the top three
// into a "Top ideas" frame in rank order, and "Run-off vote" opens the setup prefilled with exactly those three.
// Two browsers: alice (owner, the facilitator) and bob (editor). The api is the second witness for the run-off.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw -- l5-results
import type { Page } from '@playwright/test'
import { type CanvasElement, items, itemText } from '../tests/support/canvas.ts'
import { focusBoard } from './board-kit.ts'
import {
  expect,
  expectItemsEverywhere,
  post,
  seed,
  test,
  type WorkshopCanvasSession,
} from './workshops-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

/** @draftroom/contracts client-rev.ts (the suites do not depend on it): the web build's revision header. */
const CLIENT_HEADER = 'x-lobby-client'
const CLIENT_REV = 2

const NOTES = ['l5r-a', 'l5r-b', 'l5r-c', 'l5r-d']
const ref = (id: string) => `shape:${id}`

/** Ops the server refused in the acks this tab received (a refused op is `ok: false` in `ack.r`). */
function refusedOps(s: WorkshopCanvasSession): number {
  let n = 0
  for (const f of s.net.wsFrames) {
    if (!f.startsWith('{"type":"ack"')) continue
    try {
      const m = JSON.parse(f) as { r?: { ok: boolean }[] }
      n += (m.r ?? []).filter((x) => x.ok === false).length
    } catch {
      // not an ack
    }
  }
  return n
}

const byKind = async (page: Page, kind: string): Promise<CanvasElement[]> =>
  (await items(page)).filter((e) => e.customData?.lobby?.kind === kind)
const frameNamed = async (page: Page, name: string) =>
  (await items(page)).find((e) => e.type === 'frame' && (e as { name?: string }).name === name)

interface VoteView {
  session: { id: string; scope: string; onePerObject: boolean; selection: string[] | null; title: string }
}
async function currentVote(s: WorkshopCanvasSession, board: string): Promise<VoteView['session'] | null> {
  // as the web asks: the api answers a selection vote as such only to a build that says it knows them
  const body = await s.page.evaluate(
    async (a) => (await fetch(a.path, { headers: { [a.header]: String(a.rev) } })).json(),
    { path: `/api/boards/${board}/workshop`, header: CLIENT_HEADER, rev: CLIENT_REV },
  )
  return (body as { vote: VoteView | null }).vote?.session ?? null
}

test('L5-3: both cast and alice reveals: the results are a chart; Results to board is one undo step with no refused op; Gather copies the top three in order; the run-off is a vote on exactly those three', async ({
  join,
  board,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  const c = await join('carol', 'viewer')
  await b.page.emulateMedia({ reducedMotion: 'reduce' })
  await seed(a.page, {
    notes: NOTES.map((id, i) => ({ id, x: i * 320, y: 0, text: `Idea ${id.slice(-1).toUpperCase()}` })),
  })
  await expectItemsEverywhere([b, c], NOTES)

  let sid = ''
  await test.step('alice starts a vote (3 votes each) and both cast: A 3, B 2, C 1, D none', async () => {
    const res = await post(a, `/api/boards/${board}/votes`, {
      title: 'Pick one',
      votesPerPerson: 3,
      onePerObject: false,
      scope: 'board',
    })
    expect(res.status(), await res.text()).toBe(201)
    sid = ((await res.json()) as { session: { id: string } }).session.id
    const cast = async (s: WorkshopCanvasSession, id: string) => {
      const r = await post(s, `/api/votes/${sid}/cast`, { shapeId: ref(id), delta: 1 })
      expect(r.status(), `${s.user} ${id}: ${await r.text()}`).toBe(200)
    }
    for (const id of ['l5r-a', 'l5r-a', 'l5r-b']) await cast(a, id)
    for (const id of ['l5r-a', 'l5r-c', 'l5r-b']) await cast(b, id)
  })

  await test.step('alice reveals from the Voting panel; the ranking is a bar chart for both, no animation with reduced motion', async () => {
    await a.page.getByTestId('dock-tab-voting').click()
    await expect(a.page.getByTestId('vote-reveal')).toBeVisible()
    await a.page.getByTestId('vote-reveal').click()
    await b.page.getByTestId('dock-tab-voting').click()
    await c.page.getByTestId('dock-tab-voting').click()
    for (const s of [a, b, c]) {
      await expect(s.page.getByTestId('vote-chart')).toBeVisible({ timeout: 8_000 })
      await expect(s.page.getByTestId('vote-result-bar')).toHaveCount(3)
    }
    const shares = await a.page
      .getByTestId('vote-result-bar')
      .evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-share'))))
    expect(shares).toEqual([100, 66.7, 33.3])
    // the widths on screen follow the counts (layout width: the bars are still growing in)
    const widths = await a.page
      .getByTestId('vote-result-bar')
      .evaluateAll((els) => els.map((e) => (e as HTMLElement).offsetWidth))
    expect(widths[1] ?? 0).toBeCloseTo((widths[0] ?? 0) * (2 / 3), -1)
    expect(widths[2] ?? 0).toBeCloseTo((widths[0] ?? 0) * (1 / 3), -1)
    // motion: a plays the bars in, b (reduced motion) just shows them
    const animation = (p: Page) =>
      p
        .getByTestId('vote-result-bar')
        .first()
        .evaluate((e) => getComputedStyle(e).animationName)
    expect(await animation(a.page)).toBe('dr-wk-bar-grow')
    expect(await animation(b.page)).toBe('none')
    // the facilitators (editors with an account) have the actions; carol, a viewer, sees the chart alone
    for (const s of [a, b]) await expect(s.page.getByTestId('vote-after')).toBeVisible()
    await expect(c.page.getByTestId('vote-after')).toHaveCount(0)
  })

  await test.step('Results to board: a frame with 3 bars and their words, 0 refused ops, bob has it too, one Ctrl+Z removes all of it', async () => {
    await a.page.getByTestId('vote-results-to-board').click()
    await expect(a.page.getByTestId('vote-chart-toast')).toBeVisible()
    await expect
      .poll(async () => (await byKind(a.page, 'vote-chart')).length, { timeout: 8_000 })
      .toBeGreaterThan(4)
    const chart = await byKind(a.page, 'vote-chart')
    const frame = chart.find((e) => e.type === 'frame') as (CanvasElement & { name?: string }) | undefined
    expect(frame?.name).toBe('Results: Pick one')
    const bars = chart.filter((e) => e.type === 'rectangle')
    expect(bars).toHaveLength(3)
    expect(bars.every((r) => (r as { frameId?: string | null }).frameId === frame?.id)).toBe(true)
    const heights = bars.map((r) => r.height).sort((x, y) => y - x)
    expect(heights[1] ?? 0).toBeCloseTo((heights[0] ?? 0) * (2 / 3), 0)
    expect(heights[2] ?? 0).toBeCloseTo((heights[0] ?? 0) * (1 / 3), 0)
    // the words: the date and how many people voted, a count over every bar, the ideas' words under them
    const words = chart
      .filter((e) => e.type === 'text')
      .map((e) => (e as { originalText?: string }).originalText ?? '')
    expect(words.some((w) => /2 people voted/.test(w))).toBe(true)
    expect(words.filter((w) => /^[123]$/.test(w)).sort()).toEqual(['1', '2', '3'])
    expect(words.some((w) => w.startsWith('#1 Idea A'))).toBe(true)
    // clear of the notes it is about, and nothing was refused by the sync server
    const f = frame as CanvasElement
    for (const id of NOTES) {
      const n = (await items(a.page)).find((e) => e.id === id) as CanvasElement
      const overlap =
        f.x < n.x + n.width && n.x < f.x + f.width && f.y < n.y + n.height && n.y < f.y + f.height
      expect(overlap, id).toBe(false)
    }
    expect(refusedOps(a)).toBe(0)
    // bob receives it
    await expect
      .poll(async () => (await byKind(b.page, 'vote-chart')).length, { timeout: 8_000 })
      .toBe(chart.length)
    expect(refusedOps(b)).toBe(0)
    // one undo step takes the whole chart back, for both
    await focusBoard(a.page)
    await a.page.keyboard.press('ControlOrMeta+z')
    await expect.poll(async () => (await byKind(a.page, 'vote-chart')).length, { timeout: 8_000 }).toBe(0)
    await expect.poll(async () => (await byKind(b.page, 'vote-chart')).length, { timeout: 8_000 }).toBe(0)
  })

  await test.step('Gather the winners: a Top ideas frame with copies of A, B, C in rank order, each under its rank; one undo takes it back', async () => {
    await a.page.getByTestId('vote-gather').click()
    await expect(a.page.getByTestId('vote-gather-toast')).toBeVisible()
    await expect.poll(async () => !!(await frameNamed(a.page, 'Top ideas')), { timeout: 8_000 }).toBe(true)
    const frame = (await frameNamed(a.page, 'Top ideas')) as CanvasElement
    const all = await items(a.page)
    const copies = all.filter(
      (e) =>
        e.type === 'stickynote' &&
        !NOTES.includes(e.id) &&
        (e as { frameId?: string | null }).frameId === frame.id,
    )
    expect(copies).toHaveLength(3)
    const ranks = all
      .filter((e) => e.type === 'text' && e.customData?.lobby?.kind === 'vote-rank')
      .sort((x, y) => x.x - y.x)
      .map((e) => (e as { originalText?: string }).originalText)
    expect(ranks).toEqual(['#1 · 3 votes', '#2 · 2 votes', '#3 · 1 vote'])
    // left to right: the copy of Idea A first, then B, then C
    const order = [...copies].sort((x, y) => x.x - y.x)
    expect(await Promise.all(order.map((c) => itemText(a.page, c.id)))).toEqual([
      'Idea A',
      'Idea B',
      'Idea C',
    ])
    // the originals are untouched, and nothing was refused
    for (const id of NOTES)
      expect((all.find((e) => e.id === id) as CanvasElement).x).toBe(NOTES.indexOf(id) * 320)
    expect(refusedOps(a)).toBe(0)
    await focusBoard(a.page)
    await a.page.keyboard.press('ControlOrMeta+z')
    await expect.poll(async () => !!(await frameNamed(a.page, 'Top ideas')), { timeout: 8_000 }).toBe(false)
  })

  await test.step('Run-off: the setup opens prefilled with the top three, one vote per object; starting it makes a selection vote of exactly those; bob casts on them, not on the fourth', async () => {
    await a.page.getByTestId('vote-runoff').click()
    const dialog = a.page.getByTestId('vote-setup-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('vote-title')).toHaveValue('Run-off: Pick one')
    await expect(dialog.getByTestId('vote-one-per-object')).toBeChecked()
    await expect(dialog.getByTestId('vote-scope')).toHaveValue('selection')
    await dialog.getByTestId('vote-setup-submit').click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(async () => (await currentVote(a, board))?.scope, { timeout: 8_000 }).toBe('selection')
    const vote = await currentVote(a, board)
    expect([...(vote?.selection ?? [])].sort()).toEqual(['l5r-a', 'l5r-b', 'l5r-c'].map(ref))
    expect(vote?.onePerObject).toBe(true)
    // K3-1's banner announces it to bob
    await expect(b.page.getByTestId('vote-join-prompt')).toBeVisible({ timeout: 8_000 })
    const ok = await post(b, `/api/votes/${vote?.id}/cast`, { shapeId: ref('l5r-a'), delta: 1 })
    expect(ok.status(), await ok.text()).toBe(200)
    const no = await post(b, `/api/votes/${vote?.id}/cast`, { shapeId: ref('l5r-d'), delta: 1 })
    expect(no.status()).toBe(400)
    expect(((await no.json()) as { error: { code: string } }).error.code).toBe('NOT_ELIGIBLE')
  })
})
