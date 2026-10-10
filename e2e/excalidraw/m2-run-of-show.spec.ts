// M2-3 (wave M, W2): the run of show and the Voting panel say one thing once, in words.
//  - presenting a planned section shows ONE countdown: the agenda line's, not the line and a timer pill (FTU-10);
//  - the presenter's drift reads "Planned 3 min · on time" (it read "planned 3 · projected 3"), and the control that
//    starts each section's timer says "Times each section" (it said "Auto-time on");
//  - in the Voting panel each ranked row's bar has its own line under the words: nothing is drawn through a label
//    (its 2 px edge was), and the "Top" select is styled like the other fields.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/m2-run-of-show.spec.ts --project=chromium --workers=1
import type { Page } from '@playwright/test'
import { item } from '../tests/support/canvas.ts'
import { startPresenting } from './present-kit.ts'
import { expect, expectItemsEverywhere, post, seed, test } from './workshops-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

const row = (page: Page, id: string) => page.locator(`[data-testid="frame-row"][data-frame-id="${id}"]`)
const strip = (page: Page) => page.getByTestId('agenda-strip')

async function planMinutes(page: Page, id: string, target: number) {
  await row(page, id).getByTestId('frame-mins-add').click()
  for (let m = 5; m > target; m--) await row(page, id).getByTestId('frame-mins-down').click()
  await expect(row(page, id).getByTestId('frame-mins')).toContainText(`${target} min`)
}

test('presenting a planned section shows one countdown (the agenda line), the drift in words and "Times each section"', async ({
  join,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  await seed(a.page, {
    frames: [
      { id: 'm2r-one', x: 0, y: 0, w: 800, h: 450, name: 'Alpha' },
      { id: 'm2r-two', x: 1000, y: 0, w: 800, h: 450, name: 'Beta' },
    ],
  })
  await expectItemsEverywhere([b], ['m2r-one', 'm2r-two'])
  await a.page.getByTestId('dock-tab-frames').click()
  await expect(a.page.getByTestId('frame-outline')).toBeVisible()
  await planMinutes(a.page, 'm2r-one', 2)
  await planMinutes(a.page, 'm2r-two', 1)
  await expect
    .poll(
      async () =>
        ((await item(b.page, 'm2r-two'))?.customData?.lobby?.present as { mins?: number } | undefined)
          ?.mins ?? null,
    )
    .toBe(1)

  await startPresenting(a.page.getByTestId('present-button'))
  await expect(a.page.getByTestId('live-presenting')).toBeVisible()
  await expect(b.page.getByTestId('live-invite')).toBeVisible({ timeout: 5_000 })
  await b.page.getByTestId('live-join').click()
  await expect(b.page.getByTestId('live-following')).toBeVisible()

  for (const s of [a, b]) {
    // the line counts the section down...
    await expect(strip(s.page).getByTestId('agenda-line')).toContainText(/Alpha · \d+:\d\d left/, {
      timeout: 8_000,
    })
    // ...and the timer pill over the slides (the same time again) is not there, while the line is
    await expect(s.page.getByTestId('timer-floating'), `${s.name}: one countdown`).toHaveCount(0)
  }
  // the pill stays away across the next slide (still a counted section) and after a moment
  await a.page.keyboard.press('ArrowRight')
  for (const s of [a, b]) {
    await expect(strip(s.page).getByTestId('agenda-line')).toContainText(/Beta · \d+:\d\d left/, {
      timeout: 8_000,
    })
    await expect(s.page.getByTestId('timer-floating')).toHaveCount(0)
  }
  await a.page.waitForTimeout(1_500)
  await expect(a.page.getByTestId('timer-floating')).toHaveCount(0)

  // the words: the presenter's drift, and the switch
  await expect(a.page.getByTestId('agenda-drift')).toHaveText(
    /^Planned 3 min · (on time|\d+ min (over|ahead))$/,
  )
  await expect(a.page.getByTestId('agenda-drift')).not.toContainText('projected')
  await expect(b.page.getByTestId('agenda-drift')).toHaveCount(0)
  await expect(a.page.getByTestId('agenda-autotime')).toHaveText('Times each section')
  await expect(a.page.getByTestId('agenda-autotime')).toHaveAttribute('aria-pressed', 'true')
  await a.page.getByTestId('agenda-autotime').click()
  await expect(a.page.getByTestId('agenda-autotime')).toHaveText('Sections not timed')
  await expect(a.page.getByTestId('agenda-autotime')).toHaveAttribute('aria-pressed', 'false')

  await a.page.keyboard.press('Escape')
  await expect(b.page.getByTestId('present-overlay')).toHaveCount(0)
})

test('without a run of show a running timer still floats over the slides while presenting (nothing else counts it)', async ({
  join,
  board,
}) => {
  const a = await join('alice')
  await seed(a.page, { frames: [{ id: 'm2r-solo', x: 0, y: 0, w: 800, h: 450, name: 'Solo' }] })
  expect(
    (await post(a, `/api/boards/${board}/timer`, { action: 'start', durationMs: 300_000 })).status(),
  ).toBe(200)
  await startPresenting(a.page.getByTestId('present-button'), 'me')
  await expect(a.page.getByTestId('present-overlay')).toBeVisible()
  await expect(a.page.getByTestId('timer-floating')).toBeVisible()
  await expect(a.page.getByTestId('agenda-strip')).toHaveCount(0)
  await a.page.keyboard.press('Escape')
})

test('the Voting panel’s ranking: each bar has its own line under its row’s words, and the Top select is a styled field', async ({
  join,
  board,
}, testInfo) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  const ids = ['m2r-a', 'm2r-b', 'm2r-c', 'm2r-d']
  await seed(a.page, {
    notes: ids.map((id, i) => ({ id, x: i * 320, y: 0, text: `Idea ${id.slice(-1).toUpperCase()}` })),
  })
  await expectItemsEverywhere([b], ids)
  const res = await post(a, `/api/boards/${board}/votes`, {
    title: 'Pick one',
    votesPerPerson: 3,
    onePerObject: false,
    scope: 'board',
  })
  expect(res.status(), await res.text()).toBe(201)
  const sid = ((await res.json()) as { session: { id: string } }).session.id
  const cast = async (who: typeof a, id: string) =>
    expect((await post(who, `/api/votes/${sid}/cast`, { shapeId: `shape:${id}`, delta: 1 })).status()).toBe(
      200,
    )
  for (const id of ['m2r-a', 'm2r-a', 'm2r-b']) await cast(a, id)
  for (const id of ['m2r-a', 'm2r-c', 'm2r-b']) await cast(b, id)
  expect((await post(a, `/api/votes/${sid}/reveal`)).status()).toBe(200)

  await a.page.getByTestId('dock-tab-voting').click()
  const chart = a.page.getByTestId('vote-chart')
  await expect(chart).toBeVisible({ timeout: 8_000 })
  await expect(a.page.getByTestId('vote-result-bar')).toHaveCount(3)
  // reduced motion would hide a growing bar mid-animation; the geometry is the layout's, not the animation's
  await a.page.emulateMedia({ reducedMotion: 'reduce' })

  const geometry = await chart.locator('[data-testid="vote-result-row"]').evaluateAll((rows) =>
    rows.map((r) => {
      const box = (el: Element | null) => {
        const b = el?.getBoundingClientRect()
        return b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null
      }
      return {
        label: box(r.querySelector('.dr-wk-rank__label')),
        place: box(r.querySelector('.dr-wk-rank__place')),
        count: box(r.querySelector('.dr-wk-rank__count')),
        bar: box(r.querySelector('[data-testid="vote-result-bar"]')),
        track: box(r.querySelector('.dr-wk-rank__track')),
      }
    }),
  )
  expect(geometry).toHaveLength(3)
  const overlaps = (p: { x: number; y: number; w: number; h: number }, q: typeof p) =>
    p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h
  for (const [i, g] of geometry.entries()) {
    if (!g.label || !g.place || !g.count || !g.bar || !g.track) throw new Error(`row ${i} is missing a part`)
    // the bar is drawn on its own line: it touches no word (it ran behind them, its edge through the label)
    for (const word of [g.label, g.place, g.count])
      expect(overlaps(g.bar, word), `row ${i}: the bar is over ${JSON.stringify(word)}`).toBe(false)
    expect(g.bar.y, `row ${i}: the bar is under the words`).toBeGreaterThanOrEqual(
      g.label.y + g.label.h - 0.5,
    )
    // inside its track, as long as the count says (the widths follow 3 : 2 : 1 over the top result's)
    expect(g.bar.x).toBeGreaterThanOrEqual(g.track.x - 0.5)
    expect(g.bar.w).toBeLessThanOrEqual(g.track.w + 0.5)
  }
  const top = geometry[0]?.bar?.w ?? 0
  expect(geometry[1]?.bar?.w ?? 0).toBeCloseTo(top * (2 / 3), -1)
  expect(geometry[2]?.bar?.w ?? 0).toBeCloseTo(top * (1 / 3), -1)
  // no 2 px edge: the bar has no border of its own
  const border = await a.page
    .getByTestId('vote-result-bar')
    .first()
    .evaluate((el) => getComputedStyle(el).borderRightWidth)
  expect(border).toBe('0px')
  await testInfo.attach('ranking', { body: await chart.screenshot(), contentType: 'image/png' })

  // the Top select is a styled field, as the other inputs are (it was a bare browser select)
  const select = a.page.getByTestId('vote-top-n')
  await expect(select).toHaveClass(/dr-input/)
  const style = await select.evaluate((el) => {
    const cs = getComputedStyle(el)
    return { height: cs.height, radius: cs.borderTopLeftRadius, border: cs.borderTopWidth }
  })
  expect(style).toEqual({ height: '34px', radius: '8px', border: '1px' })
})
