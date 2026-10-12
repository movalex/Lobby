// Wave N1 (web follow-up of wave M, W2): the AI "working" pill sat at a fixed 58 px from the canvas's top, under whatever the
// top-centre stack (the invitation, the spotlight bar, the follow pills, the coach's chip, the prompt) held at the time:
// in a meeting, with a spotlight bar and a follow pill up, the pill was drawn behind them. It now goes under the stack, one
// gap below its last item, and back to its own place when the stack is empty.
//
// The stack's contents are an item the spec adds to the stack's own box (what a real item is: a box with a slot and a height);
// the pill is the real one, from a real AI run held open by the local fake OpenAI.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/n1w-ai-busy.spec.ts --project=chromium --workers=1
import type { Page } from '@playwright/test'
import { type FakeOpenAi, startFakeOpenAi } from '../tests/support/ai.ts'
import { test as base, createNote, expect, expectSaved } from '../tests/support/canvas.ts'
import {
  AI_API_ENV_3H,
  aiMenu,
  continueIfAsked,
  FAKE_OPENAI_PORT_3H,
  foreignRequests,
  openAiMenu,
  selectIds,
  showBounds,
} from './ai-kit.ts'

const test = base.extend<object, { openai: FakeOpenAi }>({
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

interface Box {
  y: number
  bottom: number
}

/** The stack's last item's bottom and the busy pill's top, in client pixels. */
const rects = (page: Page) =>
  page.evaluate(() => {
    const stack = document.querySelector('[data-testid="top-centre-stack"]')
    const items = stack ? [...stack.children].filter((c) => c.getBoundingClientRect().height > 0) : []
    const busy = document.querySelector('[data-testid="ai-busy"]')?.getBoundingClientRect()
    const last = items.map((c) => c.getBoundingClientRect().bottom).sort((a, b) => b - a)[0] ?? null
    return {
      stackBottom: last,
      busy: busy ? ({ y: busy.top, bottom: busy.bottom } satisfies Box) : null,
      canvasTop: document.querySelector('[data-lobby-board-canvas]')?.getBoundingClientRect().top ?? 0,
    }
  })

test('N1 (W2): the AI busy pill is drawn under the top-centre stack, and at its own place when the stack is empty', async ({
  canvasSession,
  openai,
}) => {
  const a = await canvasSession('alice')
  const foreign = foreignRequests(a.page)
  const ids: string[] = []
  for (const [i, text] of ['Book the venue', 'Draft the brief', 'Call the studio'].entries()) {
    ids.push(await createNote(a.page, { x: i * 260, y: 0, text }))
    await expectSaved(a.page)
  }
  await showBounds(a.page, { x: -40, y: -40, w: 860, h: 300 })

  // a stack with something tall in it (a spotlight bar and a follow pill together are about this)
  await a.page.evaluate(() => {
    const stack = document.querySelector('[data-testid="top-centre-stack"]')
    if (!stack) throw new Error('no top-centre stack')
    const item = document.createElement('div')
    item.className = 'lobby-top-centre__item'
    item.dataset.slot = 'coach'
    item.dataset.testid = 'n1w-stack-item'
    item.style.height = '120px'
    item.style.minWidth = '320px'
    item.style.background = 'rgb(255 240 200)'
    item.textContent = 'A box in the stack'
    stack.append(item)
  })

  openai.next({ kind: 'stall', ms: 5_000 })
  await selectIds(a.page, ids)
  await openAiMenu(a.page)
  await aiMenu(a.page).getByTestId('ai-actions').click()
  await continueIfAsked(a.page)
  await expect(a.page.getByTestId('ai-busy')).toBeVisible()

  await test.step('with the stack up, the pill starts below its last item (a gap of 8 px)', async () => {
    await expect
      .poll(async () => {
        const r = await rects(a.page)
        return r.busy && r.stackBottom !== null ? r.busy.y - r.stackBottom : null
      })
      .toBeGreaterThanOrEqual(7)
    const r = await rects(a.page)
    // and not far below it either (it follows the stack, it is not parked low)
    expect((r.busy?.y ?? 0) - (r.stackBottom ?? 0)).toBeLessThan(30)
  })

  await test.step('the stack emptied: the pill goes back to its own place', async () => {
    await a.page.evaluate(() => document.querySelector('[data-testid="n1w-stack-item"]')?.remove())
    await expect
      .poll(async () => {
        const r = await rects(a.page)
        return r.busy ? Math.round(r.busy.y - r.canvasTop) : null
      })
      .toBe(58)
  })

  await expect(a.page.getByTestId('ai-busy')).toHaveCount(0, { timeout: 30_000 })
  expect(foreign).toEqual([])
})
