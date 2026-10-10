// Wave M (M8-2, owner W8): Ask across boards in the browser, against the REAL api route (POST
// /api/workspaces/:wid/ai/ask), the real search index and sync server, and the e2e OpenAI fake (support/ai.ts):
//  - the board page offers it on its own (no forcing): a workspace member, the workspace's AI on, the board's AI
//    status read by the AI feature; the palette command 'ai.askWorkspace' is there;
//  - an ask through the page's real client reaches the model with both boards' words and none of a board the asker
//    cannot open; the canned answer's citations name the right boards and elements, and each opens its board with
//    ?el= selecting the cited note;
//  - a viewer of one board gets only that board; nothing leaves Lobby's origins (the e2e network assertion).
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/m8-ask-boards.spec.ts --project=chromium --workers=1
import type { Page } from '@playwright/test'
import { elementsLink } from '../../apps/web/src/lib/deep-link.ts'
import { type FakeOpenAi, itemsOf, startFakeOpenAi } from '../tests/support/ai.ts'
import {
  test as base,
  createNote,
  expect,
  expectSaved,
  openCanvasSession,
  selection,
  waitForCanvas,
} from '../tests/support/canvas.ts'
import {
  AI_API_ENV_3H,
  aiMenu,
  askWorkspaceInPage,
  FAKE_OPENAI_PORT_3H,
  foreignRequests,
  workspaceAskAvailable,
} from './ai-kit.ts'
import { navRun } from './navigation-kit.ts'

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

/** A word no other board of this run holds (the search index is the stack's, shared by the specs). */
const word = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 8)}`

/** `board`'s note with `text`, made as alice in a page of her own (closed after). */
async function noteOn(
  browser: Parameters<typeof openCanvasSession>[0],
  board: string,
  alice: Parameters<typeof openCanvasSession>[2],
  text: string,
) {
  const s = await openCanvasSession(browser, board, alice)
  const id = await createNote(s.page, { x: 100, y: 100, text })
  await expectSaved(s.page)
  await s.context.close()
  return id
}

/** Offered by the board page itself (once the AI feature has read the board's AI status). */
async function offered(page: Page) {
  await expect.poll(() => workspaceAskAvailable(page), { timeout: 30_000 }).toBe(true)
}

test('All boards: the real route answers from both boards, cites them, and each citation opens its board with ?el=', async ({
  board,
  canvasSession,
  users,
  browser,
  openai,
}) => {
  test.setTimeout(180_000)
  const key = word('pricing')
  const alice = await users.get('alice')
  const other = await users.createBoard('M8 launch plan')
  const there = await noteOn(browser, other, alice, `Launch ${key}: twenty percent off`)
  const a = await canvasSession('alice')
  const foreign = foreignRequests(a.page)
  const here = await createNote(a.page, { x: 0, y: 0, text: `Decided ${key}: the annual plan wins` })
  await expectSaved(a.page)
  // the board page offers it by itself: alice is the workspace owner, AI is on (nothing forced)
  await offered(a.page)
  // the palette command runs the board's Ask (its All boards side is the Ask panel's, W4)
  expect(await navRun(a.page, 'ai.askWorkspace')).toBe(true)
  await expect(aiMenu(a.page)).toBeVisible()
  await a.page.keyboard.press('Escape')
  await expect(aiMenu(a.page)).toHaveCount(0)
  // the canned answer cites the first item of each board sent (b1, b2: the rank decides which is which)
  openai.next({
    kind: 'content',
    content: {
      answer: 'The annual plan wins [1], and the launch is twenty percent off [2].',
      found: 'yes',
      citations: [{ ids: ['b1.n1'] }, { ids: ['b2.n1'] }],
    },
  })
  const out = await askWorkspaceInPage(a.page, `What did we decide about ${key}?`, true)
  expect(out.ok, JSON.stringify(out)).toBe(true)
  const answer = (
    out as {
      ok: true
      answer: {
        answer: string
        citations: { boardId: string; boardTitle: string; elementIds: string[] }[]
        exportAllowed: boolean
      }
    }
  ).answer
  // what the model was sent: both notes, as aliases only
  const sent = itemsOf(openai.requests.at(-1) as never)
  expect(sent.map((i) => i.text).sort()).toEqual(
    [`Decided ${key}: the annual plan wins`, `Launch ${key}: twenty percent off`].sort(),
  )
  for (const i of sent) expect(i.id).toMatch(/^b[12]\.n1$/)
  const raw = openai.requests.at(-1)?.raw ?? ''
  for (const id of [here, there, other]) expect(raw).not.toContain(id)
  // the citations name the boards and the elements
  const byBoard = Object.fromEntries(answer.citations.map((c) => [c.boardId, c]))
  expect(Object.keys(byBoard).sort()).toEqual([board, other].sort())
  expect(byBoard[board]).toMatchObject({ elementIds: [here] })
  expect(byBoard[other]).toMatchObject({ boardTitle: 'M8 launch plan', elementIds: [there] })
  expect(answer.exportAllowed).toBe(true)
  expect(answer.answer).toMatch(/\[1\].*\[2\]/)

  // each citation opens its board at the cited note (the deep link's ?el=)
  for (const c of answer.citations) {
    const link = elementsLink(`/b/${c.boardId}`, c.elementIds)
    expect(link).toContain('?el=')
    await a.page.goto(link)
    await waitForCanvas(a.page)
    await expect.poll(() => selection(a.page), { timeout: 20_000 }).toEqual(c.elementIds)
  }
  expect(foreign).toEqual([])
})

test('a viewer of one board asks across boards: only that board reaches the model, only it is cited', async ({
  canvasSession,
  users,
  browser,
  openai,
}) => {
  test.setTimeout(180_000)
  const key = word('budget')
  const alice = await users.get('alice')
  const hidden = await users.createBoard('M8 hidden plan')
  await noteOn(browser, hidden, alice, `Secret ${key}: forty thousand`)
  const owner = await canvasSession('alice')
  const visibleNote = await createNote(owner.page, { x: 0, y: 0, text: `Shared ${key}: ten thousand` })
  await expectSaved(owner.page)
  const viewer = await canvasSession('bob', { role: 'viewer' })
  await offered(viewer.page)
  openai.next({
    kind: 'content',
    content: {
      answer: 'Ten thousand [1]. Forty [2].',
      found: 'yes',
      citations: [{ ids: ['b1.n1'] }, { ids: ['b2.n1'] }],
    },
  })
  const out = await askWorkspaceInPage(viewer.page, `What is the ${key}?`, true)
  expect(out.ok, JSON.stringify(out)).toBe(true)
  const answer = (out as { ok: true; answer: { citations: { boardId: string; elementIds: string[] }[] } })
    .answer
  const raw = openai.requests.at(-1)?.raw ?? ''
  expect(raw).toContain(`Shared ${key}`)
  expect(raw).not.toContain('forty thousand')
  expect(raw).not.toContain('M8 hidden plan')
  expect(answer.citations.map((c) => c.elementIds)).toEqual([[visibleNote]])
  expect(JSON.stringify(answer)).not.toContain(hidden)
})
