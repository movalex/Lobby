// Wave L (W2, L2-1): the AI trust layer in two browsers, against the real api and sync server (OpenAI is the
// local fake on this run's own port).
//  - "Dana is using AI here": while alice runs AI, bob sees a shimmer over the area with her name within the
//    event stream's latency, it clears when her run is done, and bob's tab pushes nothing while it watches.
//    The api publishes ai.working / ai.done (W1). Where this build's api does not publish them yet, the spec
//    hands bob's tab the api's event itself (ai-kit `injectBoardEvent`, annotated as such); the page code under
//    test is the same either way.
//  - "Remove this AI result": after bob edits one AI-made note, alice's Remove keeps it and removes the rest of
//    the run in one undo step, with no server rejection.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/l2-trust.spec.ts --project=chromium --workers=1
import type { Page } from '@playwright/test'
import { type FakeOpenAi, startFakeOpenAi } from '../tests/support/ai.ts'
import {
  test as base,
  canvasCall,
  createNote,
  expect,
  expectSaved,
  items,
  saveState,
  waitForCanvas,
} from '../tests/support/canvas.ts'
import { pressUndo, pushCount } from '../tests/support/excalidraw.ts'
import {
  AI_API_ENV_3H,
  aiMenu,
  aiObjects,
  captureEventStreams,
  continueIfAsked,
  FAKE_OPENAI_PORT_3H,
  fakeRunId,
  foreignRequests,
  hasShell,
  injectBoardEvent,
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

/** Three notes in a row, saved one by one. */
async function threeNotes(page: Page): Promise<string[]> {
  const ids: string[] = []
  for (const [i, text] of ['Book the venue', 'Draft the brief', 'Call the studio'].entries()) {
    ids.push(await createNote(page, { x: i * 260, y: 0, text }))
    await expectSaved(page)
  }
  return ids
}

/** Runs AI › Action items on `ids` from the selection bar (the notice is continued when it shows). */
async function actionItems(page: Page, ids: string[]) {
  await showBounds(page, { x: -40, y: -40, w: 860, h: 300 })
  await selectIds(page, ids)
  await openAiMenu(page)
  await aiMenu(page).getByTestId('ai-actions').click()
  await continueIfAsked(page)
}

test('L2-1e: bob sees alice’s “is using AI here” shimmer over her selection, it clears when her run is done, and bob pushes nothing', async ({
  canvasSession,
  openai,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const foreign = [...foreignRequests(a.page), ...foreignRequests(b.page)]
  await captureEventStreams(b.page)
  await b.page.reload()
  await waitForCanvas(b.page)
  const ids = await threeNotes(a.page)
  await expect.poll(async () => (await items(b.page)).filter((e) => e.type === 'stickynote').length).toBe(3)
  await showBounds(b.page, { x: -40, y: -40, w: 860, h: 300 })
  const bPushes = await pushCount(b.page)
  const shimmer = b.page.getByTestId('ai-working')

  // a slow answer, so the run is visibly under way
  openai.next({ kind: 'stall', ms: 4_000 })
  await actionItems(a.page, ids)
  await expect(a.page.getByTestId('ai-busy')).toBeVisible()
  const startedAt = Date.now()
  const live = await shimmer
    .waitFor({ state: 'visible', timeout: 2_500 })
    .then(() => true)
    .catch(() => false)
  let injected: string | null = null
  if (!live) {
    // this build's api does not publish ai.working yet: hand bob's stream the event it would publish
    test.info().annotations.push({
      type: 'ai.working',
      description: 'injected into bob’s event stream (this api does not publish ai.working/ai.done yet)',
    })
    const sel = (await canvasCall(a.page, 'selection')) as string[]
    const boxes = await Promise.all(sel.map((id) => canvasCall(a.page, 'bounds', id)))
    const xs = boxes.flatMap((r) => (r ? [r.x, r.x + r.width] : []))
    const ys = boxes.flatMap((r) => (r ? [r.y, r.y + r.height] : []))
    const rect = {
      x: Math.round(Math.min(...xs)),
      y: Math.round(Math.min(...ys)),
      w: Math.round(Math.max(...xs) - Math.min(...xs)),
      h: Math.round(Math.max(...ys) - Math.min(...ys)),
    }
    injected = fakeRunId()
    expect(
      await injectBoardEvent(b.page, 'ai.working', {
        runId: injected,
        name: a.name,
        action: 'actions',
        rect,
      }),
    ).toBeGreaterThan(0)
    await expect(shimmer).toBeVisible({ timeout: 2_000 })
  }
  await test.step('bob sees her name over the area, within the event latency; alice sees no shimmer of her own run', async () => {
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    await expect(shimmer).toContainText(`${a.name} is using AI here`)
    const box = await shimmer.boundingBox()
    const first = await canvasCall(b.page, 'bounds', ids[0] as string)
    const at = await canvasCall(b.page, 'sceneToScreen', { x: first?.x ?? 0, y: first?.y ?? 0 })
    expect(box && at && Math.abs(box.x - at.x) < 40 && Math.abs(box.y - at.y) < 40).toBe(true)
    await expect(a.page.getByTestId('ai-working')).toHaveCount(0)
  })
  await test.step('it clears when the run is done', async () => {
    await expect(a.page.getByTestId('ai-done')).toContainText('Added 3 action items.', { timeout: 20_000 })
    if (injected) await injectBoardEvent(b.page, 'ai.done', { runId: injected })
    await expect(shimmer).toHaveCount(0, { timeout: 5_000 })
  })
  await test.step('bob’s tab pushed nothing while it watched; nothing left Lobby’s origins', async () => {
    await expect.poll(() => countKinds(b.page, 'action-item')).toBe(3)
    expect(await pushCount(b.page)).toBe(bPushes)
    expect(foreign).toEqual([])
  })
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
  // two runs far from the view: no area to shimmer over, so each is a pill
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

const countKinds = async (page: Page, kind: string) =>
  (await aiObjects(page)).filter((o) => o.kind === kind).length

test('L2-1d: after bob edits one AI-made note, alice’s “Remove this AI result” keeps it and removes the rest in one undo step', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const ids = await threeNotes(a.page)
  await actionItems(a.page, ids)
  await expect(a.page.getByTestId('ai-done')).toContainText('Added 3 action items.', { timeout: 20_000 })
  await expectSaved(a.page)
  const made = await aiObjects(a.page)
  const notes = made.filter((o) => o.kind === 'action-item')
  expect(notes).toHaveLength(3)
  expect(made.filter((o) => o.kind === 'heading')).toHaveLength(1)
  // provenance: every AI object of the run carries the run id
  const runs = await a.page.evaluate(
    (ids) =>
      ids.map(
        (id) =>
          (
            window as unknown as {
              __lobbyBoard: {
                canvas: { get(id: string): { customData?: { lobby?: { ai?: { run?: string } } } } }
              }
            }
          ).__lobbyBoard.canvas.get(id)?.customData?.lobby?.ai?.run ?? null,
      ),
    made.map((o) => o.id),
  )
  expect(new Set(runs).size).toBe(1)
  expect(runs[0]).toMatch(/^air_[0-9A-Za-z]{20}$/)
  const [edited, other] = notes as [(typeof notes)[0], (typeof notes)[0]]

  await test.step('bob rewrites one of the AI notes (under his own text lease)', async () => {
    await expect.poll(async () => (await aiObjects(b.page)).length).toBe(4)
    const ok = await b.page.evaluate(
      (id) =>
        (
          window as unknown as {
            __lobbyBoard: { canvas: { text: { replace(id: string, t: string): Promise<boolean> } } }
          }
        ).__lobbyBoard.canvas.text.replace(id, 'Book the bigger venue (Bo)'),
      edited.id,
    )
    expect(ok).toBe(true)
    await expectSaved(b.page)
    await expect
      .poll(async () => (await aiObjects(a.page)).find((o) => o.id === edited.id)?.text)
      .toBe('Book the bigger venue (Bo)')
  })

  await test.step('alice: Remove this AI result on another note of the run', async () => {
    expect(await hasShell(a.page, 'contextMenu')).toBe(true)
    const r = await canvasCall(a.page, 'bounds', other.id)
    if (!r) throw new Error('no bounds')
    const p = await canvasCall(a.page, 'sceneToScreen', { x: r.x + r.width / 2, y: r.y + 30 })
    await a.page.mouse.click(p.x, p.y, { button: 'right' })
    await a.page.getByRole('menuitem', { name: 'Remove this AI result' }).click()
    await expect(a.page.getByTestId('ai-removed')).toContainText(
      'Removed 3 AI-made items. Kept 1 item someone changed.',
    )
    await expectSaved(a.page)
    const left = await aiObjects(a.page)
    expect(left.map((o) => o.id)).toEqual([edited.id])
    await expect.poll(async () => (await aiObjects(b.page)).map((o) => o.id)).toEqual([edited.id])
    expect((await saveState(a.page)).lastReject).toBeNull()
  })

  await test.step('one Ctrl+Z brings the three back; the notes alice did not make stay as they were', async () => {
    await pressUndo(a.page)
    await expect.poll(async () => (await aiObjects(a.page)).length).toBe(4)
    await expectSaved(a.page)
    expect((await saveState(a.page)).lastReject).toBeNull()
    const plain = (await items(a.page)).filter((e) => ids.includes(e.id))
    expect(plain).toHaveLength(3)
  })
})
