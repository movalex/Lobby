// L1 (wave L, W1): the AI engine on the api, against the real api and sync server (OpenAI is the local fake
// of support/ai.ts on this run's own port). These are api-level specs: the web's wave L AI UI is W2's, so
// they call POST /api/boards/:bid/ai/run as a signed-in person would, on a board whose elements the real
// sync stored and stamped. What must hold:
// - the six new actions run on a real board: a recap window by the sync's own server stamps, citations,
//   commands, diagrams, sort and score (with their checkpoint), every id one of the board's elements;
// - a colleague's open board page receives ai.working and ai.done for each run, with no board content, and
//   that receive-only tab pushes nothing; its requests stay on Lobby's origin;
// - who may: a viewer may ask and find, never draw, sort or change the board; a name-only guest and an
//   export-limited viewer get nothing; a vote that is not revealed cannot weight action items (409).
// The budget refusals are l1-ai-budget.spec.ts (a stack with a lower hourly cap).
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/l1-ai-engine --project=chromium --workers=1
import type { APIResponse, Page } from '@playwright/test'
import { type FakeOpenAi, itemsOf, startFakeOpenAi } from '../tests/support/ai.ts'
import { test as base, expect, items } from '../tests/support/canvas.ts'
import { pushCount } from '../tests/support/excalidraw.ts'
import { WEB_URL } from '../tests/support/ports.ts'
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

test.use({ viewport: { width: 1280, height: 820 }, apiEnv: AI_API_ENV_3H })
test.beforeEach(({ openai }) => openai.reset())

const BRAINSTORM = '2 · Brainstorm'
type Json = Record<string, unknown>

/** Opens the board's own event stream in `page` (same origin, the session cookie) and keeps its ai.* events. */
async function recordAiEvents(page: Page, board: string) {
  await page.evaluate((b) => {
    const w = window as unknown as { __l1Events: Json[]; __l1Open: boolean }
    w.__l1Events = []
    w.__l1Open = false
    const es = new EventSource(`/api/boards/${b}/events`)
    es.onopen = () => {
      w.__l1Open = true
    }
    es.onmessage = (m) => {
      try {
        const e = JSON.parse(m.data) as Json
        if (typeof e.type === 'string' && e.type.startsWith('ai.') && e.type !== 'ai.settings')
          w.__l1Events.push(e)
      } catch {
        // not JSON: ignored, as the web's own listener does
      }
    }
  }, board)
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __l1Open: boolean }).__l1Open))
    .toBe(true)
  return () => page.evaluate(() => (window as unknown as { __l1Events: Json[] }).__l1Events)
}

const body = async (res: APIResponse) => (await res.json()) as Json
async function ok(res: APIResponse): Promise<Json> {
  expect(res.status(), await res.text()).toBe(200)
  return body(res)
}
async function refused(res: APIResponse, status: number, code: string) {
  expect(res.status(), await res.text()).toBe(status)
  expect(((await body(res)).error as { code: string }).code).toBe(code)
}

test('the six wave L actions on a real board: real ids, the sync’s own stamps; a colleague’s page sees ai.working and ai.done and pushes nothing', async ({
  canvasSession,
  board,
  users,
  openai,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const offOrigin: string[] = []
  b.page.on('request', (r) => {
    const u = new URL(r.url())
    if (u.protocol.startsWith('http') && u.origin !== new URL(WEB_URL).origin) offOrigin.push(u.origin)
  })
  const since = Date.now() - 5_000
  await placeTemplate(a.page, board, 'lobby-tour')
  await expect.poll(async () => (await frameNotes(a.page, BRAINSTORM)).length).toBe(8)
  const notes = await frameNotes(a.page, BRAINSTORM)
  const noteRefs = notes.map((n) => `shape:${n.id}`)
  const onBoard = new Set((await items(a.page)).map((e) => `shape:${e.id}`))
  const events = await recordAiEvents(b.page, board)
  const pushedBefore = await pushCount(b.page)
  const alice = await users.api('alice')
  const runAi = (data: Json) =>
    alice.fetch('POST', `/api/boards/${board}/ai/run`, { acknowledged: true, ...data })
  const runIds: string[] = []
  const idsIn = (v: unknown): string[] => JSON.stringify(v).match(/shape:[^"]+/g) ?? []

  await test.step('recap: the window is the sync’s server stamps of the tour it just stored', async () => {
    const r = await ok(await runAi({ action: 'recap', scope: { kind: 'since', since }, mode: 'panel' }))
    expect(r.windowFrom).toBe(since)
    const sent = itemsOf(openai.requests.at(-1) as never)
    expect(sent.length).toBeGreaterThanOrEqual(8)
    for (const n of notes) expect(sent.map((i) => i.text)).toContain(n.text)
    for (const id of idsIn(r)) expect(onBoard.has(id), id).toBe(true)
    // a window that starts after the tour was placed holds nothing
    await refused(
      await runAi({ action: 'recap', scope: { kind: 'since', since: Date.now() + 60_000 }, mode: 'panel' }),
      400,
      'AI_NOTHING_TO_SEND',
    )
    runIds.push(r.runId as string)
  })

  await test.step('ask the whole board: cited ids are elements of this board', async () => {
    const r = await ok(
      await runAi({ action: 'ask', question: 'What is the hook of the trailer?', shapeIds: [] }),
    )
    expect(r.found).toBe('yes')
    const cited = (r.citations as { ids: string[] }[]).flatMap((c) => c.ids)
    expect(cited.length).toBeGreaterThan(0)
    for (const id of cited) expect(onBoard.has(id), id).toBe(true)
    runIds.push(r.runId as string)
  })

  await test.step("a 'find' command: only select and zoomTo, on the board's own ids", async () => {
    const r = await ok(
      await runAi({
        action: 'command',
        instruction: 'select the notes about players',
        mode: 'find',
        shapeIds: [],
      }),
    )
    for (const op of r.ops as { op: string; ids: string[] }[]) {
      expect(['select', 'zoomTo']).toContain(op.op)
      for (const id of op.ids) expect(onBoard.has(id), id).toBe(true)
    }
    runIds.push(r.runId as string)
  })

  await test.step('a diagram from a description: a graph of our own node ids', async () => {
    const r = await ok(
      await runAi({ action: 'diagram', shapeIds: [], prompt: 'From brief to launch', direction: 'down' }),
    )
    const nodes = r.nodes as { id: string }[]
    expect(nodes.length).toBeGreaterThanOrEqual(2)
    for (const n of nodes) expect(n.id).toMatch(/^n\d+$/)
    expect(openai.requests.at(-1)?.body).toMatchObject({
      reasoning_effort: 'low',
      max_completion_tokens: 1500,
    })
    runIds.push(r.runId as string)
  })

  await test.step('sort and score the Brainstorm notes: every note once, scores in range, a checkpoint first', async () => {
    const sorted = await ok(await runAi({ action: 'sort', shapeIds: noteRefs, lens: 'how soon' }))
    expect((sorted.themes as { noteIds: string[] }[]).flatMap((t) => t.noteIds).sort()).toEqual(
      [...noteRefs].sort(),
    )
    const scored = await ok(
      await runAi({
        action: 'score',
        shapeIds: noteRefs,
        axes: [
          { name: 'Impact', low: 'Low', high: 'High' },
          { name: 'Effort', low: 'Easy', high: 'Hard' },
        ],
      }),
    )
    const scores = scored.scores as { id: string; x: number; y: number }[]
    expect(scores.map((s) => s.id).sort()).toEqual([...noteRefs].sort())
    for (const s of scores) {
      expect(Math.abs(s.x)).toBeLessThanOrEqual(5)
      expect(Math.abs(s.y)).toBeLessThanOrEqual(5)
    }
    const listed = await body(await alice.fetch('GET', `/api/boards/${board}/snapshots`))
    expect((listed.snapshots as { reason: string | null }[]).map((s) => s.reason)).toContain(
      'before_ai_themes',
    )
    runIds.push(sorted.runId as string, scored.runId as string)
  })

  await test.step('bob’s board page got ai.working and ai.done for every run (none for the refused recap), with no content', async () => {
    await expect.poll(async () => (await events()).length).toBe(runIds.length * 2)
    const got = await events()
    const pairs = runIds.flatMap((id) => [
      ['ai.working', id],
      ['ai.done', id],
    ])
    expect(got.map((e) => [e.type, (e.data as { runId: string }).runId])).toEqual(pairs)
    for (const e of got.filter((e) => e.type === 'ai.working'))
      expect(Object.keys(e.data as Json).sort()).toEqual(['action', 'name', 'rect', 'runId'])
    const wire = JSON.stringify(got)
    for (const n of notes) expect(wire).not.toContain(n.text)
    expect(wire).not.toContain('trailer')
  })

  await test.step('bob’s receive-only tab pushed nothing; its requests stayed on Lobby’s origin', async () => {
    expect(await pushCount(b.page)).toBe(pushedBefore)
    expect(offOrigin).toEqual([])
  })
})

test('who may: a viewer asks and finds but never draws, sorts or changes the board; guests and export-limited viewers get nothing; an unrevealed vote is a 409', async ({
  canvasSession,
  board,
  users,
  openai,
  playwright,
}) => {
  const a = await canvasSession('alice')
  await placeTemplate(a.page, board, 'lobby-tour')
  await expect.poll(async () => (await frameNotes(a.page, BRAINSTORM)).length).toBe(8)
  const noteRefs = (await frameNotes(a.page, BRAINSTORM)).map((n) => `shape:${n.id}`)
  await users.grant(board, 'dave', 'viewer')
  const dave = await users.api('dave')
  const alice = await users.api('alice')
  const as = (who: typeof dave, data: Json) =>
    who.fetch('POST', `/api/boards/${board}/ai/run`, { acknowledged: true, ...data })

  await test.step('a viewer: ask, find and a recap panel 200; command do, diagram, sort, score and recap insert 403', async () => {
    await ok(await as(dave, { action: 'ask', question: 'Who is the villain?', shapeIds: [] }))
    await ok(
      await as(dave, { action: 'command', instruction: 'find the villain', mode: 'find', shapeIds: [] }),
    )
    await ok(
      await as(dave, { action: 'recap', scope: { kind: 'shapes', shapeIds: noteRefs }, mode: 'panel' }),
    )
    const calls = openai.requests.length
    for (const data of [
      { action: 'command', instruction: 'make them red', mode: 'do', shapeIds: [] },
      { action: 'diagram', shapeIds: [], prompt: 'a flow', direction: 'right' },
      { action: 'sort', shapeIds: noteRefs, lens: 'urgency' },
      {
        action: 'score',
        shapeIds: noteRefs,
        axes: [
          { name: 'A', low: 'l', high: 'h' },
          { name: 'B', low: 'l', high: 'h' },
        ],
      },
      { action: 'recap', scope: { kind: 'shapes', shapeIds: noteRefs }, mode: 'insert' },
    ])
      await refused(await as(dave, data), 403, 'FORBIDDEN')
    expect(openai.requests.length).toBe(calls)
  })

  await test.step('an action-items run weighted by a vote: 409 before the reveal, then ordered by the tallies', async () => {
    const started = await alice.fetch('POST', `/api/boards/${board}/votes`, {
      votesPerPerson: 5,
      onePerObject: false,
      scope: 'board',
    })
    expect(started.status(), await started.text()).toBe(201)
    const vote = ((await body(started)).session as { id: string }).id
    const castOn = async (ref: string, n: number) => {
      for (let i = 0; i < n; i++)
        expect(
          (await alice.fetch('POST', `/api/votes/${vote}/cast`, { shapeId: ref, delta: 1 })).status(),
        ).toBe(200)
    }
    await castOn(noteRefs[0] as string, 1)
    await castOn(noteRefs[1] as string, 3)
    const calls = openai.requests.length
    await refused(
      await as(alice, { action: 'actions', shapeIds: noteRefs, voteSessionId: vote }),
      409,
      'AI_VOTE_NOT_REVEALED',
    )
    expect(openai.requests.length).toBe(calls)
    expect((await alice.fetch('POST', `/api/votes/${vote}/reveal`)).status()).toBe(200)
    const r = await ok(await as(alice, { action: 'actions', shapeIds: noteRefs, voteSessionId: vote }))
    expect((r.items as { votes: number }[]).map((i) => i.votes)).toEqual([3, 1])
    expect(itemsOf(openai.requests.at(-1) as never)).toHaveLength(2)
  })

  await test.step('a name-only guest (a workshop link, editor) gets 403 GUEST_ACCOUNT_REQUIRED', async () => {
    const made = await alice.fetch('POST', `/api/boards/${board}/review-links`, {
      role: 'editor',
      allowGuests: true,
      expiresInHours: 3,
    })
    expect(made.status()).toBe(201)
    const url = ((await body(made)) as { url: string }).url
    const guest = await playwright.request.newContext({ baseURL: WEB_URL })
    try {
      const joined = await guest.post(`/api/invitations/${url.slice(url.lastIndexOf('/') + 1)}/guest`, {
        headers: { origin: WEB_URL },
        data: { name: 'Sam' },
      })
      expect(joined.status(), await joined.text()).toBe(201)
      const calls = openai.requests.length
      await refused(
        await guest.post(`/api/boards/${board}/ai/run`, {
          headers: { origin: WEB_URL },
          data: { action: 'ask', question: 'Anything?', shapeIds: [], acknowledged: true },
        }),
        403,
        'GUEST_ACCOUNT_REQUIRED',
      )
      expect(openai.requests.length).toBe(calls)
    } finally {
      await guest.dispose()
    }
  })

  await test.step('export policy "editors": the viewer gets 403 AI_EXPORT_DISABLED', async () => {
    const res = await alice.fetch('PUT', `/api/boards/${board}/export-policy`, { exportPolicy: 'editors' })
    expect(res.status(), await res.text()).toBe(200)
    await refused(
      await as(dave, { action: 'ask', question: 'Who is the villain?', shapeIds: [] }),
      403,
      'AI_EXPORT_DISABLED',
    )
  })
})
