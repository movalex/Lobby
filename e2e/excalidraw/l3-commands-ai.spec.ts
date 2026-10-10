// W3 (wave L, L3-3): the AI fallback of the palette's plain-language commands, with the e2e AI fake.
// "select the notes about budget" is a matter of meaning (the grammar leaves "about …" to AI): the palette offers
// "Do with AI: …", which runs W2's runAi with action 'command' (W1's api); the fake answers with the items whose
// words are about the budget, and exactly those notes end up selected, nothing written.
//
// It needs W1's 'command' action on the api and W2's runAi and 'ai.ask' on the web (wave L): on a build without
// them (the wave L foundation alone) the test says so and is skipped, never passed.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/l3-commands-ai.spec.ts --project=chromium --workers=1
import { createServer, type Server } from 'node:http'
import type { Page } from '@playwright/test'
import { FAKE_KEY, itemsOf, type SeenRequest } from '../tests/support/ai.ts'
import { createNote, expect, expectSaved, pushedOps, selection, test } from '../tests/support/canvas.ts'
import { HOST, PORT_BASE, WEB_URL } from '../tests/support/ports.ts'
import { focusCanvas } from './navigation-kit.ts'

/** base + 11: this spec's own fake (the AI kit's sits on base + 10, the default suite's on base + 3). */
const FAKE_PORT = PORT_BASE === null ? 5901 : PORT_BASE + 11

test.use({
  viewport: { width: 1440, height: 900 },
  apiEnv: {
    OPENAI_API_KEY: FAKE_KEY,
    OPENAI_BASE_URL: `http://${HOST}:${FAKE_PORT}/v1`,
    OPENAI_MODEL: 'gpt-5.4-mini',
    DRAFTROOM_AI: 'on',
  },
})

/** The fake's answer for one request: a board command selects the items about the budget. */
function answer(req: SeenRequest): unknown {
  const items = itemsOf(req)
  if (req.body.response_format?.json_schema?.name === 'lobby_command') {
    const ids = items.filter((i) => /budget|cost|spend/i.test(i.text)).map((i) => i.id)
    return {
      ops: ids.length ? [{ op: 'select', ids }] : [],
      explain: `Selected ${ids.length} notes about the budget`,
    }
  }
  return {}
}

let server: Server | null = null
const seen: SeenRequest[] = []
test.beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: SeenRequest['body'] = {}
      try {
        body = JSON.parse(raw)
      } catch {
        // recorded as empty
      }
      const r: SeenRequest = { headers: req.headers, body, raw }
      seen.push(r)
      const content = JSON.stringify(answer(r))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'chatcmpl-l3',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'fake',
          choices: [
            { index: 0, message: { role: 'assistant', content, refusal: null }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        }),
      )
    })
  })
  await new Promise<void>((resolve, reject) => {
    server?.once('error', reject)
    server?.listen(FAKE_PORT, HOST, () => resolve())
  })
})
test.afterAll(async () => {
  await new Promise<void>((resolve) => {
    if (!server) return resolve()
    server.closeAllConnections()
    server.close(() => resolve())
  })
})

const option = (page: Page, id: string) =>
  page.locator(`[data-testid="command-palette-option"][data-entry-id="${id}"]`)

test('with the AI fake, "select the notes about budget" selects exactly those notes (Do with AI, one call, nothing written)', async ({
  canvasSession,
  board,
}) => {
  const a = await canvasSession('alice')
  const about = [
    await createNote(a.page, { x: 0, y: 0, text: 'Budget for the launch' }),
    await createNote(a.page, { x: 300, y: 0, text: 'Cut tooling costs' }),
  ]
  await expectSaved(a.page)
  const other = await createNote(a.page, { x: 600, y: 0, text: 'Hire a designer' })
  await expectSaved(a.page)

  // W1's 'command' action: a wave K or foundation-only api refuses it (400)
  const probe = await a.page.request.post(`${WEB_URL}/api/boards/${board}/ai/run`, {
    headers: { origin: WEB_URL },
    data: { action: 'command', instruction: 'probe', mode: 'find', shapeIds: [], acknowledged: true },
  })
  test.skip(probe.status() === 400, `the api has no 'command' action yet (W1, wave L): ${probe.status()}`)
  seen.length = 0

  await focusCanvas(a.page)
  await a.page.keyboard.press('ControlOrMeta+k')
  await a.page.keyboard.type('select the notes about budget')
  const line = option(a.page, 'do:ai')
  const offered = await line
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false)
  test.skip(!offered, "the web has no AI 'ask' command yet (W2, wave L): no Do with AI line")
  await expect(option(a.page, 'do:grammar')).toHaveCount(0)
  const pushes = (await pushedOps(a.page)).length
  await line.click()
  // W2's "Sends the selected text to OpenAI" notice, when this person has not agreed yet. The palette runs the
  // line on a later task (runChosen's setTimeout), so under load the notice opens after the click returns: wait
  // for the notice or the result, never a one-off look (the gate's run 2 lost the run that way).
  const notice = a.page.getByTestId('ai-notice-continue')
  const want = [...about].sort()
  const selected = async () => JSON.stringify([...(await selection(a.page))].sort()) === JSON.stringify(want)
  await expect
    .poll(async () => (await notice.isVisible()) || (await selected()), { timeout: 20_000 })
    .toBe(true)
  if (await notice.isVisible()) await notice.click()
  await expect.poll(async () => [...(await selection(a.page))].sort(), { timeout: 20_000 }).toEqual(want)
  expect(await selection(a.page)).not.toContain(other)
  expect(seen.filter((r) => r.body.response_format?.json_schema?.name === 'lobby_command')).toHaveLength(1)
  // a find writes nothing
  expect((await pushedOps(a.page)).length).toBe(pushes)
})
