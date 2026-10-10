// K7 (wave K): AI and mind maps that wow, on the Excalidraw board page against the real api and sync server,
// OpenAI the local fake of support/ai.ts. Expand with AI (K7-1), Mind map from a prompt (K7-3), the wait made
// deliberate (K7-4: shimmer where the result lands, a brief highlight, not under reduced motion) and the AI
// status read leaving the board-open burst (K7-4). The outline paste is k7-outline-paste.spec.ts.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/k7-ai-mindmap --project=chromium --workers=1
import type { Browser, Page } from '@playwright/test'
import { type FakeOpenAi, itemsOf, startFakeOpenAi } from '../tests/support/ai.ts'
import { signInContext } from '../tests/support/api.ts'
import {
  test as base,
  clickItem,
  createNote,
  expect,
  expectConverged,
  expectSaved,
  itemBounds,
  sceneToScreen,
  screenToScene,
  select,
  selection,
  viewport,
  waitForCanvas,
  waitForItem,
} from '../tests/support/canvas.ts'
import { pressRedo, pressUndo } from '../tests/support/excalidraw.ts'
import {
  AI_API_ENV_3H,
  aiMenu,
  aiObjects,
  continueIfAsked,
  FAKE_OPENAI_PORT_3H,
  openAiMenu,
} from './ai-kit.ts'
import {
  buildMap,
  byText,
  expectTidy,
  type MapSpec,
  mapProblems,
  mapView,
  selectOnly,
  structure,
} from './mindmap-kit.ts'
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

/** The sub-topics the fake model writes (tests/support/ai.ts, the 'lobby_ideas' pool, in order). */
const POOL = [
  'Countdown built from player deaths',
  'Trailer that plays backwards',
  'Hide the logo in the final boss arena',
  'Let the villain narrate',
  'Live co-op premiere with two creators',
  'A one-shot through every biome',
]

const MAP: MapSpec = ['Campaign', [['Channels', ['Social']], 'Audience', 'Budget']]

/** Opens `boardId` as `handle` in a new signed-in context (for people outside the `canvasSession` fixture). */
async function openAs(browser: Browser, handle: string, boardId: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await signInContext(context, handle)
  const page = await context.newPage()
  await page.goto(`/b/${boardId}`)
  await waitForCanvas(page)
  return page
}

const expandButton = (page: Page) => page.getByTestId('mindmap-expand-ai')

/** A sticky note in the view (the selection bar and the AI menu point at what is on screen). */
async function noteInView(page: Page, text: string, at = { fx: 0.3, fy: 0.3 }): Promise<string> {
  const v = await viewport(page)
  return createNote(page, { x: v.x + v.width * at.fx, y: v.y + v.height * at.fy, text })
}

test('Expand with AI: select a topic, Expand, and five sub-topics appear connected, tidy, seen by bob and a fresh tab; Ctrl+Z removes them in one step, Ctrl+Shift+Z brings them back', async ({
  canvasSession,
  openai,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const ids = await buildMap(a.page, MAP)
  await expectTidy(a.page)
  await expectSaved(a.page)
  await expect.poll(async () => (await mapView(b.page)).topics.length).toBe(5)
  const before = structure(await mapView(a.page))

  await test.step('the topic bar offers it once the AI status is known, and only on a topic with words', async () => {
    await clickItem(a.page, ids.Channels as string)
    await expect(expandButton(a.page)).toBeVisible()
    await expect(expandButton(a.page)).toBeEnabled()
    await expect(expandButton(a.page)).toHaveAccessibleName('Expand with AI')
  })

  await test.step('Expand: the first-use notice names the topic, then the sub-topics are drafted', async () => {
    await expandButton(a.page).click()
    const notice = a.page.getByTestId('ai-notice')
    await expect(notice).toBeVisible()
    await expect(notice).toContainText('expand the topic')
    await expect(notice).toContainText('the topic “Channels”')
    await continueIfAsked(a.page)
    await expect(a.page.getByTestId('ai-done')).toContainText('Added 5 sub-topics.')
  })

  const request = openai.requests.at(-1)
  await test.step('the api was asked the existing ideas action: the topic as the prompt, its path as the context', async () => {
    expect(request?.body.response_format?.json_schema?.name).toBe('lobby_ideas')
    const user = request?.body.messages?.find((m) => m.role === 'user')?.content ?? ''
    expect(user).toContain('"Channels"')
    expect(user).toContain('Write exactly 5 new, distinct ideas')
    // the path (Campaign > Channels) and its child (Social) are the items sent as context
    for (const word of ['Campaign', 'Channels', 'Social']) expect(user).toContain(`"text":"${word}"`)
    // nothing from the other branches
    expect(user).not.toContain('"text":"Budget"')
    expect(user).not.toContain('"text":"Audience"')
  })

  await test.step('five children, connected to the topic, tidy, with the server-derived line ends the same for everyone', async () => {
    await expect.poll(async () => (await mapView(a.page)).topics.length).toBe(10)
    const view = await mapView(a.page)
    const channels = byText(view, 'Channels')
    const kids = view.topics.filter((t) => t.parentId === channels.id)
    expect(kids.map((t) => t.text).sort()).toEqual([...POOL.slice(0, 5), 'Social'].sort())
    expect(kids.every((t) => t.side === channels.side)).toBe(true)
    // each has one line, from the topic to it (the line's bound ends are what the server derives)
    for (const k of kids) {
      const lines = view.edges.filter((e) => e.childId === k.id)
      expect(lines).toHaveLength(1)
      expect([lines[0]?.start, lines[0]?.end]).toEqual([channels.id, k.id])
    }
    await expectTidy(a.page)
    expect(mapProblems(view)).toEqual([])
    await expectSaved(a.page)
    await expectConverged(a.page, [b.page])
    expect(structure(await mapView(b.page))).toEqual(structure(view))
    // what the AI made says so, and who it was made for
    const stamp = await a.page.evaluate(
      (kidId) => {
        const c = (
          window as unknown as { lobbyCanvas: { get(id: string): { customData?: unknown } | undefined } }
        ).lobbyCanvas
        return (c.get(kidId)?.customData as { lobby?: Record<string, unknown> } | undefined)?.lobby
      },
      kids.find((k) => k.text === POOL[0])?.id as string,
    )
    expect(stamp?.ai).toBeDefined()
    expect(stamp?.kind).toBe('ai-topic')
  })

  await test.step('a tab that opens the board afterwards finds the same map: the server took every element', async () => {
    const carol = await canvasSession('carol')
    await expect.poll(async () => (await mapView(carol.page)).topics.length).toBe(10)
    expect(structure(await mapView(carol.page))).toEqual(structure(await mapView(a.page)))
    expect(mapProblems(await mapView(carol.page))).toEqual([])
  })

  await test.step('one undo removes all five, one redo brings them back', async () => {
    await pressUndo(a.page)
    await expect.poll(async () => (await mapView(a.page)).topics.length).toBe(5)
    expect(structure(await mapView(a.page))).toEqual(before)
    await expect.poll(async () => (await mapView(b.page)).topics.length).toBe(5)
    await expectTidy(a.page)
    await pressRedo(a.page)
    await expect.poll(async () => (await mapView(a.page)).topics.length).toBe(10)
    await expectTidy(a.page)
    await expectSaved(a.page)
    await expectConverged(a.page, [b.page])
  })
})

test('The toast’s Undo takes back the whole expansion in one step, and only that', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const ids = await buildMap(a.page, MAP)
  await expectTidy(a.page)
  const before = structure(await mapView(a.page))
  await clickItem(a.page, ids.Channels as string)
  await expandButton(a.page).click()
  await continueIfAsked(a.page)
  await expect(a.page.getByTestId('ai-done')).toContainText('Added 5 sub-topics.')
  await expect.poll(async () => (await mapView(a.page)).topics.length).toBe(10)
  await a.page.getByTestId('ai-undo').click()
  await expect.poll(async () => (await mapView(a.page)).topics.length).toBe(5)
  expect(structure(await mapView(a.page))).toEqual(before)
  await expectTidy(a.page)
  await expectSaved(a.page)
})

test('Expand with AI is hidden when AI is off for the board, and when the workspace’s budget is used up', async ({
  canvasSession,
  board,
  openai,
  users,
}) => {
  const a = await canvasSession('alice')
  const ids = await buildMap(a.page, MAP)
  await expectTidy(a.page)
  await clickItem(a.page, ids.Channels as string)
  await expect(expandButton(a.page)).toBeVisible()

  await test.step('the owner turns AI off for this board: the button goes at once, nothing is asked', async () => {
    const aliceApi = await users.api('alice')
    const res = await aliceApi.fetch('PUT', `/api/boards/${board}/ai/settings`, { enabled: false })
    expect(res.status()).toBe(200)
    await expect(expandButton(a.page)).toHaveCount(0)
    // the command is not offered either
    expect(await navRun(a.page, 'ai.expand')).toBe(false)
    const reply = await aliceApi.fetch('PUT', `/api/boards/${board}/ai/settings`, { enabled: null })
    expect(reply.status()).toBe(200)
    await expect(expandButton(a.page)).toBeVisible()
    expect(openai.requests).toHaveLength(0)
  })

  await test.step('a viewer sees no topic bar buttons for AI', async () => {
    const v = await canvasSession('bob', { role: 'viewer' })
    await expect.poll(async () => (await mapView(v.page)).topics.length).toBe(5)
    await selectOnly(v.page, ids.Channels as string)
    await v.page.waitForTimeout(600)
    await expect(expandButton(v.page)).toHaveCount(0)
  })
})

test('Expand with AI is hidden once the day’s budget is spent, and a rate limit shows the friendly words and adds nothing', async ({
  browser,
  users,
  openai,
}) => {
  // frank's own workspace, so the shared Dev Studio budget of the other tests is untouched
  const frank = await users.get('frank')
  const api = await users.api('frank')
  const own = await api.createBoard(frank.personalWorkspaceId, 'Frank’s map')
  const page = await openAs(browser, 'frank', own.id)
  try {
    const ids = await buildMap(page, MAP)
    await expectTidy(page)
    await clickItem(page, ids.Channels as string)
    await expect(expandButton(page)).toBeVisible()
    const before = structure(await mapView(page))

    await test.step('a rate limit (a 429 with the api’s words): the friendly message, no partial map', async () => {
      await page.route('**/api/boards/*/ai/run', (route) =>
        route.fulfill({
          status: 429,
          json: {
            error: {
              code: 'AI_RATE_LIMITED',
              message: 'You’ve used AI 20 times in the last hour. Try again a little later.',
            },
          },
        }),
      )
      await expandButton(page).click()
      await continueIfAsked(page).catch(() => undefined)
      await expect(page.getByTestId('ai-error')).toContainText(
        'You’ve used AI 20 times in the last hour. Try again a little later.',
      )
      expect(structure(await mapView(page))).toEqual(before)
      await page.unroute('**/api/boards/*/ai/run')
    })

    await test.step('one very expensive answer uses up the day: the owner sees 100% and Expand is gone', async () => {
      openai.next({
        kind: 'content',
        content: { ideas: ['Only one idea'] },
        usage: { prompt_tokens: 450_000, completion_tokens: 10, total_tokens: 450_010 },
      })
      await expandButton(page).click()
      await continueIfAsked(page).catch(() => undefined)
      await expect(page.getByTestId('ai-done')).toBeVisible()
      // the status is asked again after the answer (the budget moved)
      await selectOnly(page, ids.Channels as string)
      await expect(expandButton(page)).toHaveCount(0)
      expect(openai.requests.length).toBeGreaterThan(0)
    })
  } finally {
    await page.context().close()
  }
})

// ---- K7-3: Mind map from a prompt ---------------------------------------------------------------------------

/** Types the prompt of the "Mind map from a prompt" popover and drafts the map. */
async function draftMap(page: Page, prompt: string, branches?: number) {
  const form = page.getByTestId('ai-mindmap-form')
  await expect(form).toBeVisible()
  await page.getByTestId('ai-mindmap-prompt').fill(prompt)
  if (branches) await page.getByTestId('ai-mindmap-count').selectOption(String(branches))
  await page.getByTestId('ai-mindmap-go').click()
  await continueIfAsked(page)
}

test('Mind map from a prompt, from the AI menu: the prompt is the centre, the ideas its first ring, one undo step; only the prompt is sent', async ({
  canvasSession,
  openai,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const note = await noteInView(a.page, 'A note that stays on the board')
  await expectSaved(a.page)
  await select(a.page, [note])

  await test.step('the AI menu offers it beside the four actions; Draft it asks for the notice once', async () => {
    await openAiMenu(a.page)
    await expect(aiMenu(a.page).getByTestId('ai-mindmap')).toBeVisible()
    await aiMenu(a.page).getByTestId('ai-mindmap').click()
    await draftMap(a.page, 'Launch party', 4)
    await expect(a.page.getByTestId('ai-done')).toContainText('Drafted a mind map with 4 branches.')
  })

  await test.step('the map: the prompt in the centre, the four ideas around it, tidy, the same for bob', async () => {
    await expect.poll(async () => (await mapView(a.page)).topics.length).toBe(5)
    const view = await mapView(a.page)
    const root = view.topics.find((t) => t.parentId === null)
    expect(root?.text).toBe('Launch party')
    const ring = view.topics.filter((t) => t.parentId === root?.id)
    expect(ring.map((t) => t.text).sort()).toEqual([...POOL.slice(0, 4)].sort())
    // balanced either side of the centre
    expect(ring.filter((t) => t.side === 'right')).toHaveLength(2)
    expect(ring.filter((t) => t.side === 'left')).toHaveLength(2)
    expect(mapProblems(view)).toEqual([])
    await expectTidy(a.page)
    await expectSaved(a.page)
    await expectConverged(a.page, [b.page])
    // the existing note was not touched, and nothing of it was sent: the prompt is the only text
    const request = openai.requests.at(-1)
    expect(itemsOf(request as never)).toEqual([])
    expect(request?.raw).not.toContain('A note that stays on the board')
    expect(request?.body.messages?.find((m) => m.role === 'user')?.content).toContain('"Launch party"')
  })

  await test.step('one undo takes the whole map back (the note stays), one redo brings it back', async () => {
    await pressUndo(a.page)
    await expect.poll(async () => (await mapView(a.page)).topics.length).toBe(0)
    await expect.poll(async () => (await mapView(b.page)).topics.length).toBe(0)
    expect(
      await a.page.evaluate(
        (id) => !!(window as never as { lobbyCanvas: { get(i: string): unknown } }).lobbyCanvas.get(id),
        note,
      ),
    ).toBe(true)
    await pressRedo(a.page)
    await expect.poll(async () => (await mapView(a.page)).topics.length).toBe(5)
    await expectTidy(a.page)
    await expectConverged(a.page, [b.page])
  })
})

test('Mind map from a prompt, from the commands (the empty board’s "Ideas with AI"): a map near the centre of the view; the most branches the action allows; a 429 draws nothing', async ({
  canvasSession,
  openai,
}) => {
  const a = await canvasSession('alice')

  await test.step('the empty board’s "Ideas with AI" (the command the hint dispatches): the ideas prompt, a mind map as the result', async () => {
    // offered once the status is known (the first read waits for an idle moment)
    await expect.poll(() => navRun(a.page, 'ai.ideas')).toBe(true)
    await expect(a.page.getByTestId('ai-ideas-as-map')).toBeChecked()
    await expect(a.page.getByTestId('ai-ideas-as-notes')).not.toBeChecked()
    await a.page.getByTestId('ai-ideas-prompt').fill('Brand refresh')
    await a.page.getByTestId('ai-ideas-count').selectOption('4')
    await expect(a.page.getByTestId('ai-ideas-go')).toHaveText('Draft it')
    await a.page.getByTestId('ai-ideas-go').click()
    await continueIfAsked(a.page)
    await expect(a.page.getByTestId('ai-done')).toContainText('Drafted a mind map with 4 branches.')
    await expect.poll(async () => (await mapView(a.page)).topics.length).toBe(5)
    const view = await mapView(a.page)
    const root = view.topics.find((t) => t.parentId === null)
    expect(root?.text).toBe('Brand refresh')
    expect(
      view.topics
        .filter((t) => t.parentId === root?.id)
        .map((t) => t.text)
        .sort(),
    ).toEqual([...POOL.slice(0, 4)].sort())
    // the request carried the prompt and no board text
    expect(itemsOf(openai.requests.at(-1) as never)).toEqual([])
    await expectTidy(a.page)
  })

  await test.step('the mind map command: 12 branches, the cap of the existing ideas action, a second map clear of the first', async () => {
    expect(await navRun(a.page, 'ai.mindmap')).toBe(true)
    await expect(a.page.getByTestId('ai-mindmap-form')).toBeVisible()
    await draftMap(a.page, 'Brand refresh for the spring season', 12)
    await expect(a.page.getByTestId('ai-done')).toContainText('Drafted a mind map with 12 branches.')
    await expect.poll(async () => (await mapView(a.page)).topics.length).toBe(5 + 13)
    await expectTidy(a.page)
    await expectSaved(a.page)
    const body = openai.requests.at(-1)?.body.messages?.find((m) => m.role === 'user')?.content ?? ''
    expect(body).toContain('Write exactly 12 new, distinct ideas')
    const view = await mapView(a.page)
    const root = view.topics.find((t) => t.text === 'Brand refresh for the spring season')
    expect(view.topics.filter((t) => t.rootId === root?.id)).toHaveLength(13)
    expect(view.edges.filter((e) => e.parentId === root?.id)).toHaveLength(12)
  })

  await test.step('a 429 or budget answer shows the friendly words and draws no partial map', async () => {
    const before = structure(await mapView(a.page))
    await a.page.route('**/api/boards/*/ai/run', (route) =>
      route.fulfill({
        status: 429,
        json: {
          error: {
            code: 'AI_BUDGET_EXHAUSTED',
            message: 'AI budget for today is used up. It resets at midnight UTC.',
          },
        },
      }),
    )
    expect(await navRun(a.page, 'ai.mindmap')).toBe(true)
    await draftMap(a.page, 'Another map', 6)
    await expect(a.page.getByTestId('ai-error')).toContainText(
      'AI budget for today is used up. It resets at midnight UTC.',
    )
    await a.page.waitForTimeout(300)
    expect(structure(await mapView(a.page))).toEqual(before)
    expect((await mapView(a.page)).topics.some((t) => t.text === 'Another map')).toBe(false)
  })
})

// Wave K integration (K2-4 with K7-3): the empty board's card dispatches the registered 'ai.ideas' command.
test('The empty board’s card offers "Ideas with AI" once the AI status is known; it opens the ideas prompt set to a mind map', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForCanvas(a.page)
  await expect(a.page.getByTestId('empty-board-hint')).toBeVisible()
  // the first status read waits for an idle moment after the board is live (K7-4), then the button appears
  const ideas = a.page.getByTestId('empty-hint-ai')
  await expect(ideas).toBeVisible({ timeout: 15_000 })
  await expect(ideas).toHaveText(/Ideas with AI/)
  await ideas.click()
  await expect(a.page.getByTestId('ai-ideas-prompt')).toBeVisible()
  await expect(a.page.getByTestId('ai-ideas-as-map')).toBeChecked()
  await expect(a.page.getByTestId('ai-ideas-as-notes')).not.toBeChecked()
})

// ---- K7-4: the wait feels deliberate, and the status read leaves the open burst ----------------------------------

const aiButton = (page: Page) => page.getByTestId('selection-ai')

/** Opens the Generate ideas prompt for the selection and starts it. */
async function startIdeas(page: Page, prompt: string, count: number) {
  await openAiMenu(page)
  await aiMenu(page).getByTestId('ai-ideas').click()
  await page.getByTestId('ai-ideas-prompt').fill(prompt)
  await page.getByTestId('ai-ideas-count').selectOption(String(count))
  await page.getByTestId('ai-ideas-go').click()
  await continueIfAsked(page)
}

const clientRects = (page: Page, selector: string) =>
  page.locator(selector).evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height }
    }),
  )

const pushedCount = (page: Page) =>
  page.evaluate(
    () => (window as never as { lobbyCanvas: { pushedOps(): unknown[] } }).lobbyCanvas.pushedOps().length,
  )

test('The wait feels deliberate: a shimmer where the sticky notes will land while the request runs, then the new notes briefly highlighted (never stored)', async ({
  canvasSession,
  openai,
}) => {
  const a = await canvasSession('alice')
  const note = await noteInView(a.page, 'Launch trailer')
  await expectSaved(a.page)
  await select(a.page, [note])
  const pushedBefore = await pushedCount(a.page)

  openai.next({ kind: 'stall', ms: 2500 })
  await startIdeas(a.page, 'trailer hooks', 4)

  const shimmer = a.page.getByTestId('ai-shimmer')
  const landing =
    await test.step('while the request runs, blocks show where the heading and the four notes will land', async () => {
      await expect(a.page.getByTestId('ai-busy')).toBeVisible()
      await expect(shimmer).toBeVisible()
      await expect(shimmer).toHaveAttribute('data-action', 'ideas')
      await expect(shimmer).toHaveAttribute('data-motion', 'shimmer')
      await expect(shimmer.locator('.dr-ai-shimmer__tile')).toHaveCount(5)
      // decoration: it takes no clicks and is hidden from assistive technology
      await expect(shimmer).toHaveAttribute('aria-hidden', 'true')
      expect(await shimmer.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none')
      // in the scene (the camera may move to show the result, the blocks are where the notes will be)
      const rects = await clientRects(a.page, '[data-testid="ai-shimmer"] .dr-ai-shimmer__tile--note')
      const zoom = (await viewport(a.page)).zoom
      return Promise.all(
        rects.map(async (r) => ({
          ...(await screenToScene(a.page, { x: r.x, y: r.y })),
          w: r.w / zoom,
          h: r.h / zoom,
        })),
      )
    })
  expect(landing).toHaveLength(4)

  await test.step('the result lands exactly there; the placeholder goes and the new notes are highlighted', async () => {
    await expect(a.page.getByTestId('ai-done')).toContainText('Added 4 ideas.', { timeout: 20_000 })
    await expect(shimmer).toHaveCount(0)
    const flash = a.page.getByTestId('ai-flash')
    await expect(flash).toBeVisible()
    expect(await flash.locator('.dr-ai-flash__box').count()).toBeGreaterThanOrEqual(4)
    expect(await flash.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none')
    // each new note sits on one of the blocks the placeholder showed (in the scene: the camera may have
    // moved to bring the result into view)
    const notes = (await aiObjects(a.page)).filter((o) => o.kind === 'idea')
    expect(notes).toHaveLength(4)
    for (const n of notes) {
      const b = (await itemBounds(a.page, n.id)) as { x: number; y: number; width: number; height: number }
      const c = { x: b.x + b.width / 2, y: b.y + b.height / 2 }
      const hit = landing.some(
        (r) => c.x >= r.x - 6 && c.x <= r.x + r.w + 6 && c.y >= r.y - 6 && c.y <= r.y + r.h + 6,
      )
      expect(hit, JSON.stringify({ note: n.text, c, b, landing })).toBe(true)
    }
  })

  await test.step('the highlight goes by itself and wrote nothing: only the result’s own elements were pushed', async () => {
    await expect(a.page.getByTestId('ai-flash')).toHaveCount(0, { timeout: 6000 })
    await expectSaved(a.page)
    // the heading, four notes and their labels: creates only, no op for a placeholder or a highlight
    expect((await aiObjects(a.page)).length).toBe(5)
    expect((await pushedCount(a.page)) - pushedBefore).toBeLessThan(30)
  })
})

test('Under reduced motion the placeholder stands still and the highlight is not drawn', async ({
  canvasSession,
  openai,
}) => {
  const a = await canvasSession('alice')
  await a.page.emulateMedia({ reducedMotion: 'reduce' })
  const note = await noteInView(a.page, 'Launch trailer')
  await expectSaved(a.page)
  await select(a.page, [note])
  openai.next({ kind: 'stall', ms: 1500 })
  await startIdeas(a.page, 'trailer hooks', 3)
  const shimmer = a.page.getByTestId('ai-shimmer')
  await expect(shimmer).toBeVisible()
  await expect(shimmer).toHaveAttribute('data-motion', 'still')
  expect(
    await shimmer
      .locator('.dr-ai-shimmer__tile')
      .first()
      .evaluate((el) => getComputedStyle(el).animationName),
  ).toBe('none')
  await expect(a.page.getByTestId('ai-done')).toBeVisible({ timeout: 20_000 })
  await expect(shimmer).toHaveCount(0)
  // the highlight would be up for 1.6 s: it is never drawn
  for (let i = 0; i < 6; i++) {
    await expect(a.page.getByTestId('ai-flash')).toHaveCount(0)
    await a.page.waitForTimeout(250)
  }
})

test('Expand with AI shows pills where the sub-topics will go; a summary shows its panel as a placeholder', async ({
  canvasSession,
  openai,
}) => {
  const a = await canvasSession('alice')
  const ids = await buildMap(a.page, MAP)
  await expectTidy(a.page)
  await clickItem(a.page, ids.Audience as string)

  await test.step('Expand: five pills beside the topic', async () => {
    openai.next({ kind: 'stall', ms: 2000 })
    await expect(expandButton(a.page)).toBeVisible()
    await expandButton(a.page).click()
    await continueIfAsked(a.page)
    const shimmer = a.page.getByTestId('ai-shimmer')
    await expect(shimmer).toBeVisible()
    await expect(a.page.getByTestId('ai-busy')).toHaveText(/Expanding the topic/)
    await expect(shimmer.locator('.dr-ai-shimmer__tile--pill')).toHaveCount(5)
    const pills = await clientRects(a.page, '[data-testid="ai-shimmer"] .dr-ai-shimmer__tile--pill')
    const topic = (await itemBounds(a.page, ids.Audience as string)) as { x: number; width: number }
    const right = await sceneToScreen(a.page, { x: topic.x + topic.width, y: 0 })
    const left = await sceneToScreen(a.page, { x: topic.x, y: 0 })
    // all on one side of the topic, away from the centre of the map
    expect(pills.every((p) => p.x >= right.x - 2) || pills.every((p) => p.x + p.w <= left.x + 2)).toBe(true)
    await expect(a.page.getByTestId('ai-done')).toContainText('Added 5 sub-topics.', { timeout: 20_000 })
    await expect(shimmer).toHaveCount(0)
    await expect(a.page.getByTestId('ai-flash')).toBeVisible()
  })

  await test.step('Summarize: a panel-shaped placeholder, then the summary in its place', async () => {
    const note = await noteInView(a.page, 'Studio booked for Monday', { fx: 0.3, fy: 0.7 })
    await expectSaved(a.page)
    await select(a.page, [note])
    openai.next({ kind: 'stall', ms: 2000 })
    await openAiMenu(a.page)
    await aiMenu(a.page).getByTestId('ai-summarize').click()
    await continueIfAsked(a.page).catch(() => undefined)
    await expect(a.page.getByTestId('ai-summary-pending')).toBeVisible()
    await expect(a.page.getByTestId('ai-summary-panel')).toHaveCount(0)
    await expect(a.page.getByTestId('ai-summary-panel')).toBeVisible({ timeout: 20_000 })
    await expect(a.page.getByTestId('ai-summary-pending')).toHaveCount(0)
  })
})

test('The AI status is not read while the board opens: it waits for an idle moment after the board is live', async ({
  browser,
  board,
}) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await signInContext(context, 'alice')
  // a browser that is never idle until the test says so (requestIdleCallback holds its callbacks)
  await context.addInitScript(() => {
    const held: ((d: unknown) => void)[] = []
    const w = window as unknown as Record<string, unknown>
    w.requestIdleCallback = (cb: (d: unknown) => void) => held.push(cb)
    w.cancelIdleCallback = () => undefined
    w.__releaseIdle = () => {
      for (const cb of held.splice(0)) cb({ didTimeout: false, timeRemaining: () => 50 })
    }
  })
  const page = await context.newPage()
  const reads: string[] = []
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname
    if (r.method() === 'GET' && /^\/api\/boards\/[^/]+\/ai$/.test(path)) reads.push(path)
  })
  try {
    await page.goto(`/b/${board}`)
    await waitForCanvas(page)
    // well past the burst of the board opening, and the board is live: still no status read
    await page.waitForTimeout(3500)
    expect(reads).toEqual([])
    const note = await noteInView(page, 'A note')
    await select(page, [note])
    await page.waitForTimeout(500)
    await expect(aiButton(page)).toHaveCount(0)

    // the browser goes idle: one read, and the entry points appear
    await page.evaluate(() => (window as never as { __releaseIdle(): void }).__releaseIdle())
    await expect.poll(() => reads.length).toBe(1)
    await expect(aiButton(page)).toBeVisible()
    await page.waitForTimeout(500)
    expect(reads).toHaveLength(1)
  } finally {
    await context.close()
  }
})

test('With a normal browser the status is read once, soon after the board is live and never before', async ({
  browser,
  board,
}) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await signInContext(context, 'alice')
  const page = await context.newPage()
  const events: string[] = []
  page.on('websocket', (ws) =>
    ws.on('framereceived', (f) => {
      if (typeof f.payload === 'string' && f.payload.includes('"type":"welcome"')) events.push('welcome')
    }),
  )
  page.on('request', (r) => {
    if (r.method() === 'GET' && /^\/api\/boards\/[^/]+\/ai$/.test(new URL(r.url()).pathname))
      events.push('ai-status')
  })
  try {
    await page.goto(`/b/${board}`)
    await waitForCanvas(page)
    await expect.poll(() => events.includes('ai-status'), { timeout: 10_000 }).toBe(true)
    await page.waitForTimeout(1000)
    expect(events.filter((e) => e === 'ai-status')).toHaveLength(1)
    // never before the board was live (the welcome)
    expect(events.indexOf('welcome')).toBeGreaterThanOrEqual(0)
    expect(events.indexOf('ai-status')).toBeGreaterThan(events.indexOf('welcome'))
  } finally {
    await context.close()
  }
})

// Wave K.1 (K7 with K2, follow-up 9): the selection bar reads each item's `visible` inside its selector, so the AI
// button comes when the status does. Before, a read-only person who selected before the status read (it waits for
// an idle moment, K7-4) got a bar without it (for a viewer: no bar at all) until they selected again.
test('K.1: a viewer who selects a note before the AI status is known gets the AI button when it arrives, without selecting again', async ({
  browser,
  board,
  users,
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const note = await noteInView(a.page, 'Summarise me')
  await expectSaved(a.page)
  const carol = await users.grant(board, 'carol', 'viewer')
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await signInContext(context, carol.handle, carol.name)
  // never idle until the test says so: the status read waits (K7-4)
  await context.addInitScript(() => {
    const held: ((d: unknown) => void)[] = []
    const w = window as unknown as Record<string, unknown>
    w.requestIdleCallback = (cb: (d: unknown) => void) => held.push(cb)
    w.cancelIdleCallback = () => undefined
    w.__releaseIdle = () => {
      for (const cb of held.splice(0)) cb({ didTimeout: false, timeRemaining: () => 50 })
    }
  })
  const page = await context.newPage()
  try {
    await page.goto(`/b/${board}`)
    await waitForCanvas(page)
    await waitForItem(page, note)
    await select(page, [note])
    await page.waitForTimeout(300)
    await expect(aiButton(page)).toHaveCount(0)
    // the status arrives (enabled for a viewer: summaries); the selection is unchanged
    await page.evaluate(() => (window as never as { __releaseIdle(): void }).__releaseIdle())
    await expect(aiButton(page)).toBeVisible()
    expect(await selection(page)).toEqual([note])
  } finally {
    await context.close()
  }
})

// Wave K.1 (follow-up 8): the AI popover has a max-height and scrolls inside it; it never sits under the selection
// bar it opened from, nor runs off a short window.
for (const size of [
  { width: 1280, height: 520 },
  { width: 900, height: 440 },
])
  test(`K.1: on a ${size.width}×${size.height} window the AI popover stays inside the canvas and off the selection bar, scrolling inside`, async ({
    canvasSession,
  }) => {
    const a = await canvasSession('alice')
    await a.page.setViewportSize(size)
    // the canvas has the new size before the note is placed in it (else it lands low, from the old size)
    await expect.poll(async () => (await viewport(a.page)).height).toBeLessThan(size.height - 40)
    const note = await noteInView(a.page, 'Launch trailer', { fx: 0.45, fy: 0.35 })
    await expectSaved(a.page)
    await select(a.page, [note])
    await expect(aiButton(a.page)).toBeVisible({ timeout: 15_000 })
    const menu = await openAiMenu(a.page)
    await expect(menu).toHaveCSS('visibility', 'visible')
    const boxes = await a.page.evaluate(() => {
      const r = (sel: string) => {
        const b = document.querySelector(sel)?.getBoundingClientRect()
        return b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null
      }
      const pop = document.querySelector<HTMLElement>('[data-testid="ai-menu"]')
      return {
        pop: r('[data-testid="ai-menu"]'),
        bar: r('[data-testid="selection-bar"]'),
        canvas: r('[data-lobby-board-canvas]'),
        scrolls: pop ? pop.scrollHeight > pop.clientHeight + 1 : false,
        overflowY: pop ? getComputedStyle(pop).overflowY : null,
      }
    })
    const { pop, bar, canvas } = boxes
    if (!pop || !bar || !canvas) throw new Error(`missing box: ${JSON.stringify(boxes)}`)
    // inside the canvas, top and bottom
    expect(pop.y).toBeGreaterThanOrEqual(canvas.y)
    expect(pop.y + pop.h).toBeLessThanOrEqual(canvas.y + canvas.h + 0.5)
    // never over the selection bar
    const overlap =
      pop.y < bar.y + bar.h && bar.y < pop.y + pop.h && pop.x < bar.x + bar.w && bar.x < pop.x + pop.w
    expect(overlap, JSON.stringify(boxes)).toBe(false)
    // what does not fit scrolls inside it
    expect(boxes.overflowY).toBe('auto')
    // every action can still be reached: the last one scrolls into view and is clickable
    const items = menu.getByRole('menuitem')
    const last = items.last()
    await last.scrollIntoViewIfNeeded()
    await expect(last).toBeInViewport()
  })
