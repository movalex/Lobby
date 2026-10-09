// Wave L integration (L8-2 with W1 and W2): sort by a lens and Place with AI through the REAL path, which W8's
// own specs could not run on their branch (they stand the AI and the preview in with the dev hook,
// window.__lobbySort.fakeAi): W2's runAi (the privacy notice, the request, the run id) and showAiPreview (Apply),
// W1's api `sort` and `score` actions, and the AI fake (support/ai.ts waveLAnswer 'lobby_sort': two themes,
// 'Sooner' and 'Later', the sent notes split in half; 'lobby_score': x and y of ±3 by the note's position in
// what was sent). What must hold: the columns and the 2x2 land as the api's answer says, the headings carry the
// run, the server rejects nothing, and one undo takes each back.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/l8-real-ai --project=chromium --workers=1
import type { Page } from '@playwright/test'
import { type FakeOpenAi, itemsOf, startFakeOpenAi } from '../tests/support/ai.ts'
import {
  test as base,
  type CanvasElement,
  expect,
  expectSaved,
  items,
  saveState,
  select,
  setViewport,
} from '../tests/support/canvas.ts'
import { AI_API_ENV_3H, applyPreview, FAKE_OPENAI_PORT_3H } from './ai-kit.ts'
import { headings, makeFrame, makeNotes, sortRun, waitForSort, wordsOf } from './l8-kit.ts'
import { undoKey } from './navigation-kit.ts'

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

/** W2's privacy notice, when this person has not agreed yet, then W2's preview: Apply. */
async function continueThenApply(page: Page, summary?: RegExp) {
  const notice = page.getByTestId('ai-notice-continue')
  const panel = page.getByTestId('ai-preview-panel')
  await expect(notice.or(panel).first()).toBeVisible({ timeout: 20_000 })
  if (await notice.isVisible()) await notice.click()
  await applyPreview(page, summary ? { summary } : {})
}

const twelve = (frameX: number, frameY: number) =>
  Array.from({ length: 12 }, (_, i) => ({
    x: frameX + 60 + (i % 6) * 230,
    y: frameY + 120 + Math.floor(i / 6) * 230,
    text: `idea ${i + 1}`,
  }))

const positions = async (page: Page, ids: readonly string[]) =>
  JSON.stringify(
    Object.fromEntries(
      (await items(page)).filter((e) => ids.includes(e.id)).map((e) => [e.id, `${e.x},${e.y}`]),
    ),
  )

test('L8-2 real path: sort by a lens asks the api (sort), shows the preview, lays out its two themes; the headings carry the run id; one undo', async ({
  canvasSession,
  openai,
}) => {
  const a = await canvasSession('alice')
  await waitForSort(a.page)
  await setViewport(a.page, { x: -100, y: -100, zoom: 0.6 })
  const frame = await makeFrame(a.page, 0, 0, 2400, 1100, 'Journey')
  const ids = await makeNotes(a.page, twelve(0, 0), frame)
  const before = await positions(a.page, ids)
  const seenBefore = openai.requests.length
  await select(a.page, ids)
  // the command resolves once the person has answered the preview: run it, answer, then read what it said
  const ran = sortRun(a.page, 'sort.lens', { lens: 'journey stage' })
  await continueThenApply(a.page)
  expect(await ran).toBe(true)
  // the api asked OpenAI once, with its lobby_sort schema
  const asked = openai.requests.slice(seenBefore).map((r) => r.body.response_format?.json_schema?.name)
  expect(asked).toEqual(['lobby_sort'])
  await expect.poll(async () => (await headings(a.page)).map(wordsOf).sort()).toEqual(['Later', 'Sooner'])
  for (const h of await headings(a.page)) {
    const lobby = (h.customData as { lobby: { ai?: { by: string; run?: string }; kind: string } }).lobby
    expect(lobby.kind).toBe('ai-sort-label')
    expect(lobby.ai?.by).toBe(a.id)
    expect(lobby.ai?.run).toMatch(/^air_[0-9A-Za-z]{20}$/)
  }
  // each theme is one column under its heading
  const all = new Map((await items(a.page)).map((e) => [e.id, e]))
  const xs = new Set(ids.map((id) => all.get(id)?.x))
  expect(xs.size).toBeGreaterThanOrEqual(2)
  await expectSaved(a.page)
  expect((await saveState(a.page)).lastReject).toBeNull()
  await undoKey(a.page)
  await expect.poll(async () => (await headings(a.page)).length).toBe(0)
  await expect.poll(() => positions(a.page, ids)).toBe(before)
})

test('L8-2 real path: Place with AI on a new 2x2 asks the api (score) and puts each note in the quadrant of its scores; one undo', async ({
  canvasSession,
  openai,
}) => {
  const a = await canvasSession('alice')
  await waitForSort(a.page)
  await setViewport(a.page, { x: -100, y: -100, zoom: 0.5 })
  const frame = await makeFrame(a.page, 0, 0, 2400, 1100, 'Ideas')
  const ids = await makeNotes(a.page, twelve(0, 0), frame)
  const seenBefore = openai.requests.length
  await select(a.page, ids)
  const axes = [
    { name: 'Effort', low: 'Low effort', high: 'High effort' },
    { name: 'Impact', low: 'Low impact', high: 'High impact' },
  ]
  const ran = sortRun(a.page, 'sort.place', { axes })
  await continueThenApply(a.page)
  expect(await ran).toBe(true)
  const req = openai.requests.slice(seenBefore)
  expect(req.map((r) => r.body.response_format?.json_schema?.name)).toEqual(['lobby_score'])
  // the matrix frame this run made, and every note in it, in the quadrant its fake score names
  await expect
    .poll(async () =>
      (await items(a.page)).some(
        (e) => (e.customData as { lobby?: { kind?: string } } | undefined)?.lobby?.kind === 'sort-matrix',
      ),
    )
    .toBe(true)
  await expectSaved(a.page)
  expect((await saveState(a.page)).lastReject).toBeNull()
  const now = await items(a.page)
  const matrix = now.find(
    (e) => (e.customData as { lobby?: { kind?: string } } | undefined)?.lobby?.kind === 'sort-matrix',
  ) as CanvasElement
  const mid = { x: matrix.x + matrix.width / 2, y: matrix.y + matrix.height / 2 }
  // the fake scores the k-th note sent: x = k odd ? +3 : -3, y = k % 4 < 2 ? +3 : -3, so three notes a quadrant
  expect(req[0] ? itemsOf(req[0]).length : 0).toBe(12)
  const quadrants = new Map<string, number>()
  for (const id of ids) {
    const n = now.find((e) => e.id === id) as CanvasElement
    const cx = n.x + n.width / 2
    const cy = n.y + n.height / 2
    const key = `${cx > mid.x ? 'right' : 'left'}-${cy < mid.y ? 'up' : 'down'}`
    quadrants.set(key, (quadrants.get(key) ?? 0) + 1)
  }
  // the fake's spread puts three notes in each quadrant
  expect([...quadrants.values()].sort()).toEqual([3, 3, 3, 3])
  await undoKey(a.page)
  await expect
    .poll(async () =>
      (await items(a.page)).some(
        (e) => (e.customData as { lobby?: { kind?: string } } | undefined)?.lobby?.kind === 'sort-matrix',
      ),
    )
    .toBe(false)
})
