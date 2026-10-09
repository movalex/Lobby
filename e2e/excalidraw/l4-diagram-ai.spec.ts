// L4-2 (wave L, W4): Diagram from words on the Excalidraw board page, the api running with the AI fake
// (support/ai.ts). A viewer has no "Diagram from words…" entry (an editor has). With the fake, a 40-node answer
// becomes 40 native shapes with bound elbow connectors, after W2's shared preview (over 20 elements), every element
// stamped with its provenance, all accepted by the server (no rejection), every connector the room's re-snap.
//
// The AI test is NOT runnable in the W4 branch alone (test.fixme below, with the reason): it needs W1's api
// `diagram` action live (LIVE_AI_ACTIONS, prompt.ts lobby_diagram) and W2's runAi and showAiPreview
// (features/ai/ported/public.ts; the foundation stub of runAi resolves null and sends nothing). The wave L
// integration enables it (and checks the name of W2's preview Apply button). The parts that do not need W1 or W2
// are unit-tested in apps/web/src/features/ai/diagram/prompt.test.ts (runAi, showAiPreview and findSpot mocked).
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/l4-diagram-ai --project=chromium --workers=1
import { type ElementsById, resnapArrow } from '../../packages/canvas-schema/src/engine/index.ts'
import { type FakeOpenAi, startFakeOpenAi } from '../tests/support/ai.ts'
import {
  test as base,
  type CanvasElement,
  canvasCall,
  createNote,
  expect,
  expectSaved,
  itemCenterOnScreen,
  items,
  saveState,
  setViewport,
} from '../tests/support/canvas.ts'
import { AI_API_ENV_3H, continueIfAsked, FAKE_OPENAI_PORT_3H } from './ai-kit.ts'
import { focusBoard } from './board-kit.ts'

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

type Arrow = CanvasElement & {
  startBinding?: { elementId: string } | null
  endBinding?: { elementId: string } | null
}

test('L4-2: a viewer has no "Diagram from words…" entry; an editor has', async ({ canvasSession }) => {
  const a = await canvasSession('alice')
  const v = await canvasSession('victor', { role: 'viewer' })
  for (const s of [a, v]) {
    await setViewport(s.page, { x: 0, y: 0, zoom: 1 })
    await focusBoard(s.page)
    const box = await s.page.locator('[data-lobby-board-canvas]').boundingBox()
    if (!box) throw new Error('no canvas')
    await s.page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.6, { button: 'right' })
    await expect(s.page.getByTestId('context-menu-root')).toBeVisible()
  }
  await expect(a.page.getByRole('menuitem', { name: /Diagram from words/ })).toBeVisible()
  await expect(v.page.getByRole('menuitem', { name: /Diagram from words/ })).toHaveCount(0)
})

// fixme: needs W1 (the api diagram action) and W2 (runAi, showAiPreview); enable at the wave L integration (see the header)
test.fixme('L4-2: a 40-node AI diagram is accepted by the server with 0 rejections, with provenance on every element', async ({
  canvasSession,
  openai,
}) => {
  const a = await canvasSession('alice')
  const note = await createNote(a.page, { x: 0, y: 0, text: 'Brief, concept, review, ship' })
  await expectSaved(a.page)
  const nodes = Array.from({ length: 40 }, (_, i) => ({
    id: `s${i + 1}`,
    label: `Step ${i + 1}`,
    kind: (['process', 'decision', 'terminal', 'io'] as const)[i % 4],
  }))
  const edges = Array.from({ length: 39 }, (_, i) => ({
    from: `s${i + 1}`,
    to: `s${i + 2}`,
    label: i % 5 ? '' : 'next',
  }))
  openai.next({ kind: 'content', content: { nodes, edges } })
  await focusBoard(a.page)
  await canvasCall(a.page, 'select', [note])
  const at = await itemCenterOnScreen(a.page, note)
  await a.page.mouse.click(at.x, at.y, { button: 'right' })
  await a.page.getByRole('menuitem', { name: /Diagram from words/ }).click()
  await a.page.getByTestId('diagram-prompt-text').fill('Brief, concept, review, ship')
  await a.page.getByTestId('diagram-prompt-create').click()
  await continueIfAsked(a.page)
  // over 20 elements: W2's shared preview first (its Apply button)
  await a.page.getByRole('button', { name: /^apply/i }).click()
  const shapes = async () =>
    (await items(a.page)).filter((e) => ['rectangle', 'diamond', 'ellipse'].includes(e.type)).length
  await expect.poll(shapes).toBe(40)
  await expectSaved(a.page)
  expect((await saveState(a.page)).lastReject).toBeNull()
  const all = await items(a.page)
  const made = all.filter((e) => e.id !== note && e.containerId !== note)
  for (const e of made) expect(e.customData?.lobby?.ai, e.id).toMatchObject({ by: a.id })
  const map = new Map(all.map((e) => [e.id, e])) as unknown as ElementsById
  for (const arrow of made.filter((e) => e.type === 'arrow') as Arrow[]) {
    expect(arrow.startBinding?.elementId && arrow.endBinding?.elementId, arrow.id).toBeTruthy()
    expect(resnapArrow(arrow as never, map).changed, arrow.id).toBe(false)
  }
})
