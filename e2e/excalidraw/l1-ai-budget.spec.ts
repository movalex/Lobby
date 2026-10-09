// L1 (wave L, W1): the AI cost limits hold for the new actions, against the real api and sync server (OpenAI is
// the local fake of support/ai.ts). This file's stack lowers the hourly cap to 3 calls per person, so its
// refusals come quickly. A refused call never reaches OpenAI and never tells the board anyone is using AI:
// a colleague's open board page gets ai.working and ai.done only for the calls that ran.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/l1-ai-budget --project=chromium --workers=1
import type { APIResponse, Page } from '@playwright/test'
import { type FakeOpenAi, startFakeOpenAi } from '../tests/support/ai.ts'
import { test as base, expect } from '../tests/support/canvas.ts'
import { pushCount } from '../tests/support/excalidraw.ts'
import { AI_API_ENV_3H, FAKE_OPENAI_PORT_3H, frameNotes, placeTemplate } from './ai-kit.ts'

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

test.use({
  viewport: { width: 1280, height: 820 },
  apiEnv: { ...AI_API_ENV_3H, DRAFTROOM_AI_CALLS_PER_HOUR: '3' },
})
test.beforeEach(({ openai }) => openai.reset())

const BRAINSTORM = '2 · Brainstorm'
type Json = Record<string, unknown>

async function aiEventsOf(page: Page, board: string) {
  await page.evaluate((b) => {
    const w = window as unknown as { __l1Events: string[]; __l1Open: boolean }
    w.__l1Events = []
    w.__l1Open = false
    const es = new EventSource(`/api/boards/${b}/events`)
    es.onopen = () => {
      w.__l1Open = true
    }
    es.onmessage = (m) => {
      try {
        const e = JSON.parse(m.data) as { type?: unknown }
        if (typeof e.type === 'string' && e.type.startsWith('ai.') && e.type !== 'ai.settings')
          w.__l1Events.push(e.type)
      } catch {
        // ignored
      }
    }
  }, board)
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __l1Open: boolean }).__l1Open))
    .toBe(true)
  return () => page.evaluate(() => (window as unknown as { __l1Events: string[] }).__l1Events)
}

async function codeOf(res: APIResponse): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code
}

test('3 calls an hour: the 4th new-action call is a 429 that reaches nobody; a spent daily allowance is a 429 too', async ({
  canvasSession,
  board,
  users,
  openai,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob', { role: 'viewer' })
  await placeTemplate(a.page, board, 'lobby-tour')
  await expect.poll(async () => (await frameNotes(a.page, BRAINSTORM)).length).toBe(8)
  const noteRefs = (await frameNotes(a.page, BRAINSTORM)).map((n) => `shape:${n.id}`)
  const events = await aiEventsOf(b.page, board)
  const pushedBefore = await pushCount(b.page)

  await test.step('frank (an editor): three new-action calls run, the fourth is AI_RATE_LIMITED with Retry-After', async () => {
    await users.grant(board, 'frank', 'editor')
    const frank = await users.api('frank')
    const calls: Json[] = [
      { action: 'ask', question: 'What is the hook?', shapeIds: [] },
      { action: 'diagram', shapeIds: [], prompt: 'From brief to launch', direction: 'down' },
      { action: 'sort', shapeIds: noteRefs, lens: 'how soon' },
    ]
    for (const data of calls) {
      const res = await frank.fetch('POST', `/api/boards/${board}/ai/run`, { acknowledged: true, ...data })
      expect(res.status(), await res.text()).toBe(200)
    }
    const fourth = await frank.fetch('POST', `/api/boards/${board}/ai/run`, {
      acknowledged: true,
      action: 'score',
      shapeIds: noteRefs,
      axes: [
        { name: 'Impact', low: 'Low', high: 'High' },
        { name: 'Effort', low: 'Easy', high: 'Hard' },
      ],
    })
    expect(fourth.status()).toBe(429)
    expect(await codeOf(fourth)).toBe('AI_RATE_LIMITED')
    expect(Number(fourth.headers()['retry-after'])).toBeGreaterThan(3000)
    expect(openai.requests).toHaveLength(3)
    await expect.poll(async () => (await events()).length).toBe(6)
  })

  await test.step('gina: one answer OpenAI bills at 200k tokens spends the 150k daily allowance; the next call is AI_USER_BUDGET', async () => {
    await users.grant(board, 'gina', 'editor')
    const gina = await users.api('gina')
    openai.next({
      kind: 'content',
      content: { answer: 'It is the boss fight [1].', found: 'yes', citations: [{ ids: ['n1'] }] },
      usage: { prompt_tokens: 199_990, completion_tokens: 10, total_tokens: 200_000 },
    })
    const first = await gina.fetch('POST', `/api/boards/${board}/ai/run`, {
      acknowledged: true,
      action: 'ask',
      question: 'What is the hook?',
      shapeIds: [],
    })
    expect(first.status(), await first.text()).toBe(200)
    const next = await gina.fetch('POST', `/api/boards/${board}/ai/run`, {
      acknowledged: true,
      action: 'command',
      instruction: 'find the villain',
      mode: 'find',
      shapeIds: [],
    })
    expect(next.status()).toBe(429)
    expect(await codeOf(next)).toBe('AI_USER_BUDGET')
    expect(openai.requests).toHaveLength(4)
  })

  await test.step('the board heard of the four calls that ran, never of the refused ones; the viewer tab pushed nothing', async () => {
    await expect.poll(async () => (await events()).length).toBe(8)
    expect(await events()).toEqual(Array.from({ length: 4 }, () => ['ai.working', 'ai.done']).flat())
    expect(await pushCount(b.page)).toBe(pushedBefore)
  })
})
