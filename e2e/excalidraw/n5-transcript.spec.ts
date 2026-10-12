// Wave N (WS5, N5-4, N5-5): a meeting transcript becomes a board, on the Excalidraw page against the real api and
// sync (the capture answered by ai-kit.ts fakeCapture's canned meeting: 3 themes, 2 decisions, 3 actions):
//  - a .vtt file is opened: cue numbers, timings and markup gone, speaker names kept; the first use's notice (a
//    Continue); the preview with its counts; Apply makes the frame "Meeting — <title>" whose columns and counts match
//    the canned answer, as one undo step;
//  - the transcript's words go only in the capture request's body: not in any other request, not in any push to the
//    board, not in the board's elements (beyond the notes applied), and nothing leaves Lobby's origins;
//  - the length meter, and past 60,000 characters "Only the first 60,000 characters will be used." (the text sent is
//    cut to that).
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/n5-transcript --project=chromium --workers=1
import type { Page } from '@playwright/test'
import { type FakeOpenAi, startFakeOpenAi } from '../tests/support/ai.ts'
import {
  test as base,
  canvasCall,
  createNote,
  expect,
  expectSaved,
  items,
  pushedOps,
  select,
  setViewport,
} from '../tests/support/canvas.ts'
import {
  AI_API_ENV_3H,
  aiButton,
  captureDialog,
  continueCaptureNotice,
  FAKE_OPENAI_PORT_3H,
  fakeCapture,
  foreignRequests,
  openCaptureFromMenu,
} from './ai-kit.ts'
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

/** Words found nowhere but in the transcript (the canned answer never says them). */
const SECRET = 'zebra-crossing-forty-two'
const VTT = `WEBVTT

NOTE exported from the meeting app

1
00:00:01.000 --> 00:00:04.000
<v Ana Lopez>We should move the shoot to the 14th, the ${SECRET} plan.</v>

2
00:00:04.000 --> 00:00:06.500
<v Bo>Agreed. I will send the revised budget.</v>
`

const aiMade = async (page: Page) =>
  (await items(page)).filter((e) => (e.customData as { lobby?: { ai?: unknown } } | undefined)?.lobby?.ai)

/** Every request body `page` sends (test data; read here, never logged). */
function requestBodies(page: Page): { url: string; body: string }[] {
  const out: { url: string; body: string }[] = []
  page.on('request', (r) => {
    const body = r.postData()
    if (body) out.push({ url: r.url(), body })
  })
  return out
}

test('N5-4: a .vtt file becomes the meeting frame; its words go only in the capture request', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const foreign = foreignRequests(a.page)
  const bodies = requestBodies(a.page)
  await setViewport(a.page, { x: -200, y: -200, zoom: 0.5 })
  const note = await createNote(a.page, { x: 0, y: 0, text: 'Agenda' })
  await expectSaved(a.page)
  await select(a.page, [note])
  await expect(aiButton(a.page)).toBeVisible({ timeout: 20_000 })
  await select(a.page, [])
  const fake = await fakeCapture(a.page, { keepBodies: true })
  const pushesBefore = (await pushedOps(a.page)).length

  await test.step('open the .vtt: cues and timings out, speakers in, the meter says its length', async () => {
    await focusBoard(a.page)
    await openCaptureFromMenu(a.page)
    const d = captureDialog(a.page)
    await d.getByTestId('capture-tab-transcript').click()
    await expect(d.getByTestId('capture-footer')).toHaveText(
      'Sends this transcript’s text to OpenAI. Lobby doesn’t keep the transcript; only the notes you apply are saved.',
    )
    await d.getByTestId('capture-transcript-file').setInputFiles({
      name: 'Launch sync.vtt',
      mimeType: 'text/vtt',
      buffer: Buffer.from(VTT),
    })
    const parsed = `Ana Lopez: We should move the shoot to the 14th, the ${SECRET} plan.\nBo: Agreed. I will send the revised budget.`
    await expect(d.getByTestId('capture-transcript-text')).toHaveValue(parsed)
    await expect(d.getByTestId('capture-transcript-title')).toHaveValue('Launch sync')
    await expect(d.getByTestId('capture-transcript-meter')).toHaveText(`${parsed.length} / 60,000 characters`)
    await expect(d.getByTestId('capture-transcript-truncated')).toHaveCount(0)
  })

  await test.step('the first use’s notice, then the preview with the counts, then Apply', async () => {
    await captureDialog(a.page).getByTestId('capture-transcript-go').click()
    await expect(a.page.getByTestId('capture-notice-text')).toHaveText(
      'Sends this transcript’s text to OpenAI. Lobby doesn’t keep the transcript; only the notes you apply are saved.',
    )
    await expect(a.page.getByTestId('capture-notice').getByRole('checkbox')).toHaveCount(0)
    expect(await continueCaptureNotice(a.page)).toBe(true)
    await expect(a.page.getByTestId('ai-preview-summary')).toHaveText(
      'Adds 3 themes (5 notes), 2 decisions and 3 actions',
      { timeout: 20_000 },
    )
    await expect(a.page.getByTestId('ai-preview-group')).toHaveText([
      'Schedule (2)',
      'Budget (2)',
      'Team (1)',
    ])
    await a.page.getByTestId('ai-preview-apply').click()
    await expect
      .poll(async () => (await aiMade(a.page)).filter((e) => e.type === 'stickynote').length)
      .toBe(10)
    await expectSaved(a.page)
    expect((await canvasCall(a.page, 'saveState')).lastReject).toBeNull()
  })

  await test.step('the frame’s columns and counts match the canned answer', async () => {
    const made = await aiMade(a.page)
    const frame = made.find((e) => e.type === 'frame')
    expect((frame as { name?: string } | undefined)?.name).toBe('Meeting — Launch sync')
    const inFrame = (await items(a.page)).filter((e) => e.frameId === frame?.id)
    const texts = await Promise.all(
      inFrame.filter((e) => e.type === 'text' && !e.containerId).map((e) => canvasCall(a.page, 'text', e.id)),
    )
    for (const heading of [
      'Meeting — Launch sync',
      'Themes',
      'Decisions',
      'Actions',
      'Schedule',
      'Budget',
      'Team',
    ])
      expect(texts, heading).toContain(heading)
    const notes = inFrame.filter((e) => e.type === 'stickynote')
    expect(notes).toHaveLength(10)
    const words = await Promise.all(notes.map((n) => canvasCall(a.page, 'text', n.id)))
    for (const w of [
      'Shoot moves to the 14th',
      'Sam joins as editor',
      'We shoot on the 14th',
      'One location only',
      'Ana: Book the studio for the 14th',
      'Bo: Send the revised budget',
      'Share the shot list',
    ])
      expect(words, w).toContain(w)
    // the decisions and the actions are each their own column (one x per column)
    const kindOf = (e: (typeof made)[number]) => (e.customData as { lobby: { kind: string } }).lobby.kind
    const xs = (kind: string) => new Set(made.filter((e) => kindOf(e) === kind).map((e) => Math.round(e.x)))
    expect(xs('ai-capture-decision').size).toBe(1)
    expect(xs('ai-capture-action').size).toBe(1)
    expect([...xs('ai-capture-decision')][0]).not.toBe([...xs('ai-capture-action')][0])
  })

  await test.step('the transcript’s words: only in the capture request body', async () => {
    const call = fake.calls.find((c) => c.kind === 'transcript')
    expect(call?.body?.toString('utf8')).toContain(SECRET)
    expect(JSON.parse(call?.body?.toString('utf8') ?? '{}')).toEqual({
      text: `Ana Lopez: We should move the shoot to the 14th, the ${SECRET} plan.\nBo: Agreed. I will send the revised budget.`,
      title: 'Launch sync',
    })
    const elsewhere = bodies.filter(
      (b) => b.body.includes(SECRET) && !b.url.includes('/ai/capture/transcript'),
    )
    expect(elsewhere.map((b) => b.url)).toEqual([])
    const pushes = (await pushedOps(a.page)).slice(pushesBefore)
    expect(JSON.stringify(pushes)).not.toContain(SECRET)
    expect(JSON.stringify(pushes)).not.toContain('We should move the shoot')
    expect(JSON.stringify(await items(a.page))).not.toContain(SECRET)
    expect(foreign).toEqual([])
  })

  await test.step('one Ctrl+Z takes the whole meeting frame back', async () => {
    await focusBoard(a.page)
    await a.page.keyboard.press('ControlOrMeta+z')
    await expect.poll(async () => (await aiMade(a.page)).length).toBe(0)
    await expectSaved(a.page)
  })
})

test('N5-4: past 60,000 characters the dialog says only the first 60,000 will be used, and sends just those', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const note = await createNote(a.page, { x: 0, y: 0, text: 'Agenda' })
  await expectSaved(a.page)
  await select(a.page, [note])
  await expect(aiButton(a.page)).toBeVisible({ timeout: 20_000 })
  await select(a.page, [])
  const fake = await fakeCapture(a.page, { keepBodies: true })
  await focusBoard(a.page)
  await openCaptureFromMenu(a.page)
  const d = captureDialog(a.page)
  await d.getByTestId('capture-tab-transcript').click()
  const long = `Ana: ${'we talked about the plan for the launch and the shoot. '.repeat(1200)}`
  expect(long.length).toBeGreaterThan(60_000)
  await d.getByTestId('capture-transcript-text').fill(long)
  await expect(d.getByTestId('capture-transcript-truncated')).toHaveText(
    'Only the first 60,000 characters will be used.',
  )
  await expect(d.getByTestId('capture-transcript-meter')).toHaveAttribute('data-over', '')
  await d.getByTestId('capture-transcript-go').click()
  await continueCaptureNotice(a.page)
  await expect(a.page.getByTestId('ai-preview-panel')).toBeVisible({ timeout: 20_000 })
  const sent = JSON.parse(fake.calls[0]?.body?.toString('utf8') ?? '{}') as { text: string }
  expect(sent.text.length).toBeLessThanOrEqual(60_000)
  expect(long.startsWith(sent.text)).toBe(true)
  await a.page.getByTestId('ai-preview-discard').click()
})
