// M2-4 (wave M, W2): small things that read as broken in a meeting (FTU-12, FTU-9).
//  - the "Results are in" card is gone for the facilitator once they opened the Voting panel and put the results on
//    the board: it used to come back each time the panel closed, until its 30 s ran out;
//  - the checkpoint name field says "Name (optional)" and the default name sits below it, whole (the placeholder was
//    the default and was cut off mid-time);
//  - the time-travel preview in dark mode: a frame's name is readable (>= 4.5:1 against the preview's page; it was
//    2.8:1 measured in the browser, grey on grey).
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/m2-history-results.spec.ts --project=chromium --workers=1
import type { Page } from '@playwright/test'
import { test as canvasTest, expect as pwExpect } from '../tests/support/canvas.ts'
import { openHistory } from '../tests/support/history.ts'
import { expect, expectItemsEverywhere, post, seed, test } from './workshops-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

test('the results card is gone for the facilitator after opening Voting and putting the results on the board; a second reveal makes a new one', async ({
  join,
  board,
}) => {
  const a = await join('alice') // the owner, who runs the vote
  const b = await join('bob', 'editor')
  const ids = ['m2h-a', 'm2h-b', 'm2h-c']
  await seed(a.page, {
    notes: ids.map((id, i) => ({ id, x: i * 320, y: 0, text: `Idea ${id.slice(-1).toUpperCase()}` })),
  })
  await expectItemsEverywhere([b], ids)

  const round = async (title: string) => {
    const res = await post(a, `/api/boards/${board}/votes`, {
      title,
      votesPerPerson: 3,
      onePerObject: false,
      scope: 'board',
    })
    expect(res.status(), await res.text()).toBe(201)
    const sid = ((await res.json()) as { session: { id: string } }).session.id
    for (const [who, id] of [
      [a, 'm2h-a'],
      [b, 'm2h-a'],
      [b, 'm2h-b'],
    ] as const)
      expect((await post(who, `/api/votes/${sid}/cast`, { shapeId: `shape:${id}`, delta: 1 })).status()).toBe(
        200,
      )
    expect((await post(a, `/api/votes/${sid}/reveal`)).status()).toBe(200)
  }
  const card = (p: Page) => p.getByTestId('vote-results-card')
  const panel = (p: Page) => p.getByTestId('dock-panel-voting')

  await test.step('the reveal puts the card in front of everyone on the board', async () => {
    await round('First')
    await expect(card(a.page)).toBeVisible({ timeout: 8_000 })
    await expect(card(b.page)).toBeVisible()
  })

  await test.step('alice opens Voting (the card has nothing to add), puts the results on the board, closes the panel: no card', async () => {
    await a.page.getByTestId('dock-tab-voting').click()
    await expect(panel(a.page)).toBeVisible()
    await expect(card(a.page)).toHaveCount(0)
    await a.page.getByTestId('vote-results-to-board').click()
    await expect(a.page.getByTestId('vote-chart-toast')).toBeVisible()
    await a.page.getByTestId('dock-tab-voting').click()
    await expect(panel(a.page)).toHaveCount(0)
    // it used to come back here, and stay until its 30 s ran out
    await a.page.waitForTimeout(1_500)
    await expect(card(a.page)).toHaveCount(0)
    // bob did none of that: his card is still there to see
    await expect(card(b.page)).toBeVisible()
  })

  await test.step('opening the panel alone ends it too, and a newer reveal makes a new card for alice', async () => {
    await b.page.getByTestId('dock-tab-voting').click()
    await expect(card(b.page)).toHaveCount(0)
    await b.page.getByTestId('dock-tab-voting').click()
    await a.page.waitForTimeout(300)
    await expect(card(b.page)).toHaveCount(0)
    await round('Second')
    await expect(card(a.page)).toBeVisible({ timeout: 8_000 })
    await expect(card(a.page)).toContainText('Second')
  })
})

canvasTest(
  'the checkpoint name field says what it is, and the default name sits below it, whole',
  async ({ canvasSession }) => {
    const a = await canvasSession('alice')
    const panel = await openHistory(a.page)
    const field = panel.getByTestId('checkpoint-name')
    await pwExpect(field).toHaveAttribute('placeholder', 'Name (optional)')
    const hint = panel.getByTestId('checkpoint-name-default')
    await pwExpect(hint).toBeVisible()
    const text = (await hint.textContent()) ?? ''
    // "Left empty, it is saved as “Checkpoint Oct 10, 3:46 AM”." : the whole default, with its time
    pwExpect(text).toMatch(/^Left empty, it is saved as “Checkpoint [A-Z][a-z]{2} \d{1,2}, .+”\.$/)
    // nothing of it is cut off (the placeholder was cut at "Checkpoint Oct 10, 1:")
    const cutOff = await hint.evaluate((el) => el.scrollWidth > el.clientWidth + 1)
    pwExpect(cutOff).toBe(false)
    // saving with it empty still saves under that default
    await panel.getByTestId('checkpoint-save').click()
    await pwExpect(panel.getByText(/Checkpoint [A-Z][a-z]{2} \d{1,2}, /).first()).toBeVisible()
  },
)

/** WCAG relative luminance and contrast of two [r, g, b] colours. */
const luminance = ([r, g, b]: number[]) => {
  const f = (v: number) => {
    const c = (v ?? 0) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r ?? 0) + 0.7152 * f(g ?? 0) + 0.0722 * f(b ?? 0)
}
const contrast = (p: number[], q: number[]) => {
  const [hi, lo] = [Math.max(luminance(p), luminance(q)), Math.min(luminance(p), luminance(q))]
  return (hi + 0.05) / (lo + 0.05)
}

canvasTest(
  'in dark mode the time-travel preview shows a frame’s name readably (>= 4.5:1)',
  async ({ canvasSession, board }, testInfo) => {
    canvasTest.setTimeout(120_000)
    const a = await canvasSession('alice')
    // one empty frame: the bitmap holds its outline, its name and the page, nothing else
    await seed(a.page, { frames: [{ id: 'm2h-f', x: 0, y: 0, w: 800, h: 450, name: 'Plan' }] })
    const saved = await a.page.evaluate(async (b) => {
      const r = await fetch(`/api/boards/${b}/snapshots`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Plan v1' }),
      })
      return r.status
    }, board)
    pwExpect(saved).toBe(201)
    await a.page.emulateMedia({ colorScheme: 'dark' })
    await pwExpect(a.page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await openHistory(a.page)
    await a.page.getByTestId('history-time-travel').click()
    const dialog = a.page.getByTestId('checkpoint-preview-dialog')
    await pwExpect(dialog).toBeVisible()
    await pwExpect(dialog).toHaveAttribute('data-drawn-id', /.+/, { timeout: 30_000 })
    await pwExpect(dialog.getByTestId('checkpoint-preview-bitmap')).toHaveAttribute('data-ready', 'true')
    // the camera settles on the frame (one draw after the bitmap is ready)
    await a.page.waitForTimeout(1_000)
    await testInfo.attach('dark-preview', { body: await dialog.screenshot(), contentType: 'image/png' })

    // where the name is: the preview fits the frame and its name (bounds x 0..800, y -23.5..450; Lobby's gap above the
    // frame, canvas/engine/theme.ts FRAME_NAME_OFFSET, a 14 px name) in the view, 24 px in, at most 100%
    const read = await dialog
      .getByTestId('checkpoint-preview-bitmap')
      .evaluate((canvas: HTMLCanvasElement) => {
        const rect = canvas.getBoundingClientRect()
        const dpr = canvas.width / rect.width
        const zoom = Math.min(1, (rect.width - 48) / 800, (rect.height - 48) / 473.5)
        const left = rect.width / 2 - 400 * zoom
        const top = rect.height / 2 - 213.25 * zoom
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('no 2d context')
        const px = (x: number, y: number) =>
          Array.from(ctx.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data.slice(0, 3))
        // the page's colour: inside the empty frame
        const page = px(rect.width / 2, rect.height / 2)
        // the name's window: right of the frame's left edge, between the top of the label and just above the outline
        const x0 = Math.max(0, left - 2)
        const x1 = left + 120 * zoom
        const y0 = Math.max(0, top - 30 * zoom)
        const y1 = top - 3
        const samples: number[][] = []
        for (let y = Math.floor(y0); y <= y1; y++)
          for (let x = Math.floor(x0); x <= x1; x++) samples.push(px(x, y))
        return { page, samples, window: { x0, x1, y0, y1 }, zoom }
      })
    const best = read.samples.reduce((m, s) => Math.max(m, contrast(s, read.page)), 1)
    console.log(`[M2-4] page ${read.page.join(',')}, best contrast of the name's pixels ${best.toFixed(2)}`)
    pwExpect(read.samples.length, 'a window with pixels in it').toBeGreaterThan(50)
    pwExpect(best, 'the frame name against the preview page').toBeGreaterThanOrEqual(4.5)
  },
)
