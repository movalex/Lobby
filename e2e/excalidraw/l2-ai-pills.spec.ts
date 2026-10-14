// Wave P (P-047): other people's AI runs whose area is off screen are pills in the board's top-centre stack
// (features/ai working.tsx), one under the other and under what is above them, where they used to sit at one
// fixed spot on top of the since and coach chips and of one another. Moved out of l2-trust.spec.ts.
//
// The two runs are handed to bob's stream (ai-kit `injectBoardEvent`: the cookie transport's EventSource).
// Under E2E_DIRECT_EVENTS=1 the stack's api serves the stream on its own origin and the page reads it with a
// fetch, which nothing can be handed to, so this file pins the same-origin stream (an empty
// DRAFTROOM_EVENTS_ORIGIN is unset; a worker option, so a file of its own). What it checks, the pills' place
// in the stack, is the same on either transport.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/l2-ai-pills.spec.ts --project=chromium --workers=1
import { expect, test, waitForCanvas } from '../tests/support/canvas.ts'
import {
  AI_API_ENV_3H,
  captureEventStreams,
  fakeRunId,
  hasShell,
  injectBoardEvent,
  openEventStreams,
} from './ai-kit.ts'

test.use({
  viewport: { width: 1440, height: 900 },
  apiEnv: { ...AI_API_ENV_3H, DRAFTROOM_EVENTS_ORIGIN: '' },
})

test('P-047: two people’s AI runs off screen are pills in the top-centre stack, one under the other, clear of the chip above them', async ({
  canvasSession,
}) => {
  const b = await canvasSession('bob')
  await captureEventStreams(b.page)
  await b.page.reload()
  await waitForCanvas(b.page)
  await expect.poll(() => hasShell(b.page, 'contextMenu')).toBe(true)
  // a chip in the stack's coach place (what the coach's chip or the since chip is: a box with a slot and a height)
  await b.page.evaluate(() => {
    const stack = document.querySelector('[data-testid="top-centre-stack"]')
    if (!stack) throw new Error('no top-centre stack')
    const item = document.createElement('div')
    item.className = 'lobby-top-centre__item'
    item.dataset.slot = 'coach'
    item.dataset.testid = 'p047-chip'
    item.style.order = '4'
    item.style.height = '36px'
    item.style.minWidth = '320px'
    item.textContent = 'A chip'
    stack.append(item)
  })
  // two runs far from the view: no area to shimmer over, so each is a pill; bob's stream is open first
  // (the reload reopened it)
  await expect.poll(() => openEventStreams(b.page)).toBeGreaterThan(0)
  const far = { x: 90_000, y: 90_000, w: 200, h: 120 }
  for (const name of ['Dana', 'Eli']) {
    const event = { runId: fakeRunId(), name, action: 'actions', rect: far }
    expect(await injectBoardEvent(b.page, 'ai.working', event)).toBeGreaterThan(0)
  }
  const pills = b.page.getByTestId('ai-working')
  await expect(pills).toHaveCount(2)
  const boxes = await b.page.evaluate(() => {
    const r = (el: Element) => {
      const b = el.getBoundingClientRect()
      return { top: b.top, bottom: b.bottom, left: b.left, right: b.right }
    }
    const stack = document.querySelector('[data-testid="top-centre-stack"]')
    const pills = [...document.querySelectorAll('[data-testid="ai-working"]')]
    return {
      inStack: pills.every((p) => !!stack?.contains(p)),
      chip: r(document.querySelector('[data-testid="p047-chip"]') as Element),
      pills: pills.map(r).sort((a, b) => a.top - b.top),
    }
  })
  expect(boxes.inStack).toBe(true)
  const [first, second] = boxes.pills
  // under the chip, then one under the other, each a gap apart: no overlap
  expect((first?.top ?? 0) - boxes.chip.bottom).toBeGreaterThanOrEqual(7)
  expect((second?.top ?? 0) - (first?.bottom ?? 0)).toBeGreaterThanOrEqual(7)
})
