// Wave M (W4, M4-1, FTU-5 preview): the AI preview shows the one thing there is to judge. Group into themes on four
// notes (the api with the fake OpenAI, which names the first two 'First Thoughts' and the next two 'Next Steps')
// lists "First Thoughts (2) · Next Steps (2)" in its panel and draws each new label's outline with its theme's name,
// before anything is written; in the light theme and in the dark one, those words read at 4.5:1 or more.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/m4-preview.spec.ts --project=chromium --workers=1
import type { Page } from '@playwright/test'
import { type FakeOpenAi, startFakeOpenAi } from '../tests/support/ai.ts'
import { test as base, createNote, expect, expectSaved, items } from '../tests/support/canvas.ts'
import { pushCount } from '../tests/support/excalidraw.ts'
import { capture } from '../tests/support/screenshots.ts'
import {
  AI_API_ENV_3H,
  aiMenu,
  aiPreviewPanel,
  continueIfAsked,
  contrastOf,
  FAKE_OPENAI_PORT_3H,
  foreignRequests,
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

const WORDS = ['Book the venue', 'Draft the brief', 'Call the studio', 'Cut the teaser']

async function fourNotes(page: Page): Promise<string[]> {
  const ids: string[] = []
  for (const [i, text] of WORDS.entries()) {
    ids.push(await createNote(page, { x: (i % 2) * 260, y: Math.floor(i / 2) * 260, text }))
    await expectSaved(page)
  }
  return ids
}

/** AI › Group into themes on `ids`, up to the preview (the notice continued when it shows). */
async function themesPreview(page: Page, ids: string[]) {
  await showBounds(page, { x: -60, y: -60, w: 640, h: 640 })
  await selectIds(page, ids)
  await openAiMenu(page)
  await aiMenu(page).getByTestId('ai-themes').click()
  await continueIfAsked(page)
  await expect(aiPreviewPanel(page)).toBeVisible({ timeout: 20_000 })
}

for (const mode of ['light', 'dark'] as const) {
  test(`M4-1 (${mode}): Group into themes shows “First Thoughts (2)” and “Next Steps (2)” before Apply, the words at 4.5:1 or more`, async ({
    canvasSession,
  }, testInfo) => {
    const a = await canvasSession('alice')
    const foreign = foreignRequests(a.page)
    if (mode === 'dark') {
      await a.page.emulateMedia({ colorScheme: 'dark' })
      await expect(a.page.locator('html')).toHaveAttribute('data-theme', 'dark')
    } else await expect(a.page.locator('html')).toHaveAttribute('data-theme', 'light')
    const ids = await fourNotes(a.page)
    const before = JSON.stringify((await items(a.page)).map((e) => [e.id, e.x, e.y]).sort())
    const pushes = await pushCount(a.page)
    await themesPreview(a.page, ids)
    const panel = aiPreviewPanel(a.page)

    await test.step('the panel names the themes with their notes', async () => {
      await expect(panel.getByTestId('ai-preview-groups')).toHaveText('First Thoughts (2) · Next Steps (2)')
      await expect(panel.getByTestId('ai-preview-group')).toHaveText(['First Thoughts (2)', 'Next Steps (2)'])
    })

    await test.step('each new label’s outline carries its theme’s name', async () => {
      const names = a.page.getByTestId('ai-preview-name')
      await expect(names).toHaveCount(2)
      expect((await names.allTextContents()).sort()).toEqual(['First Thoughts', 'Next Steps'])
    })

    await test.step(`the words read at 4.5:1 or more in ${mode}`, async () => {
      for (const loc of [
        ...(await a.page.getByTestId('ai-preview-name').all()),
        ...(await panel.getByTestId('ai-preview-group').all()),
        panel.getByTestId('ai-preview-summary'),
      ]) {
        // past the outlines' fade-in
        await expect.poll(() => contrastOf(loc), { timeout: 5_000 }).toBeGreaterThanOrEqual(4.5)
      }
      await capture(`m4-preview-${mode}.png`, a.page, testInfo)
    })

    await test.step('nothing was written before Apply; Apply then groups the notes in one push', async () => {
      expect(await pushCount(a.page)).toBe(pushes)
      expect(JSON.stringify((await items(a.page)).map((e) => [e.id, e.x, e.y]).sort())).toBe(before)
      await panel.getByTestId('ai-preview-apply').click()
      await expect(panel).toHaveCount(0)
      await expect(a.page.getByTestId('ai-done')).toBeVisible({ timeout: 20_000 })
      await expectSaved(a.page)
      const labels = (await items(a.page)).filter(
        (e) => (e.customData as { lobby?: { kind?: string } } | undefined)?.lobby?.kind === 'ai-theme-label',
      )
      expect(labels.map((l) => (l as { originalText?: string }).originalText).sort()).toEqual([
        'First Thoughts',
        'Next Steps',
      ])
      expect(foreign).toEqual([])
    })
  })
}
