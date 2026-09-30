// PORTED from e2e/tests/a11y-3.spec.ts (the tldraw spec keeps running on the default build) to the
// Excalidraw board page (owner 3i): the AI summary takes the keyboard and is announced (A11Y2-03); Share
// "Create…" keeps the keyboard and says what it did, Revoke… is at least 24 px (A11Y-01, A11Y-08); Export
// "Download PDF" keeps the keyboard; the checkpoint preview opens on Zoom to fit (A11Y-08); arriving puts
// the keyboard on a canvas named "<title> board" and the account badge follows Share in Tab order
// (A11Y2-09, A11Y-09, A11Y2-10); Ctrl+/ and "?" leave the theme alone and open the shortcuts (A11Y2-07/08).
//
// Deviations from the tldraw spec: Share and Export are two tests (Export is 3e's); Ctrl+/ and "?" leaving
// the theme alone and opening the shortcuts dialog are two tests (the dialog is 3a's); the canvas's name and
// role are read on the element that has the keyboard (the engine's container, named by the a11y feature)
// instead of `.tl-container`. Tests of other owners' features are expected failures (`needs`).
import type { Page } from '@playwright/test'
import { type FakeOpenAi, startFakeOpenAi } from '../tests/support/ai.ts'
import { test as base, expect, select, zoomToFit } from '../tests/support/canvas.ts'
import {
  A11Y_AI_ENV,
  A11Y_FAKE_OPENAI_PORT,
  boardHasFocus,
  focusCanvas,
  focusOf,
  MISSING_FEATURE_MS,
  note,
  selected,
  waitForA11y,
  withCanvas,
} from './a11y-kit.ts'

const test = base.extend<object, { openai: FakeOpenAi }>({
  openai: [
    async ({ stack: _ }, use) => {
      const fake = await startFakeOpenAi(A11Y_FAKE_OPENAI_PORT)
      await use(fake)
      await fake.close()
    },
    { scope: 'worker' },
  ],
})

test.use({ viewport: { width: 1440, height: 900 }, apiEnv: A11Y_AI_ENV })
test.beforeEach(({ openai }) => openai.reset())

const TEXTS = ['Open on the boss fight', 'One unbroken shot', 'Cut it from player clips']

async function threeNotes(page: Page): Promise<string[]> {
  const ids: string[] = []
  for (const [i, t] of TEXTS.entries()) ids.push(await note(page, i * 240, 0, t))
  await zoomToFit(page)
  return ids
}

/** The canvas's colour mode as the engine draws it. */
const canvasMode = (page: Page) =>
  withCanvas(page, (c) => c.theme(), null).then(async (t) => {
    const cls = await page.evaluate(() =>
      document.querySelector('.excalidraw')?.classList.contains('theme--dark'),
    )
    return (cls ? 'dark' : 'light') === t ? t : 'mixed'
  })

test('A11Y2-03: a summary asked for from the keyboard takes the focus and is announced; Escape closes it from anywhere and keeps the selection', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  const ids = await threeNotes(a.page)
  await select(a.page, ids)
  const panel = a.page.getByTestId('ai-summary-panel')
  const status = a.page.getByTestId('ai-summary-status')
  await a.page.getByTestId('selection-ai').click({ timeout: MISSING_FEATURE_MS })
  await expect(a.page.getByTestId('ai-summarize')).toBeFocused()
  await a.page.keyboard.press('Enter')
  const cont = a.page.getByTestId('ai-notice-continue')
  await expect(cont.or(panel).first()).toBeVisible()
  if (await cont.isVisible()) {
    await expect(cont).toBeFocused()
    await a.page.keyboard.press('Enter')
  }
  await expect(panel.getByTestId('ai-summary-text')).toContainText('launch trailer')
  await expect(panel.getByTestId('ai-summary-add')).toBeFocused()
  await expect(panel).toHaveAttribute('role', 'dialog')
  await expect(status).toHaveText('Summary ready.')
  await a.page.keyboard.press('Shift+Tab')
  await expect(panel.getByTestId('ai-summary-copy')).toBeFocused()
  await a.page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(status).toHaveText('')
  expect(await focusOf(a.page)).not.toBe('BODY')
  expect((await selected(a.page)).length).toBe(3)

  await a.page.getByTestId('selection-ai').click()
  await a.page.getByTestId('ai-summarize').click()
  await expect(panel.getByTestId('ai-summary-text')).toContainText('launch trailer')
  await expect(status).toContainText('Summary ready: The team is looking for the launch trailer')
  await a.page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  expect((await selected(a.page)).length).toBe(3)
})

test('A11Y-01 + A11Y-08: Share "Create…" keeps the keyboard and says what it did; Revoke… is at least 24 px', async ({
  canvasSession,
}, testInfo) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  await note(a.page, 0, 0, TEXTS[0] as string)
  await a.page.getByTestId('share-button').click()
  const dialog = a.page.getByTestId('share-dialog')
  await expect(dialog).toBeVisible()

  await test.step('client link: Enter on "Create and copy link"', async () => {
    const create = dialog.getByTestId('review-link-create')
    await create.focus()
    await a.page.keyboard.press('Enter')
    await expect(dialog.getByTestId('review-link-row')).toHaveCount(1)
    await expect(dialog.getByTestId('review-link-status')).toContainText('Client link created')
    await expect(create).toBeFocused()
    await expect(create).toHaveText('Create and copy link')
  })

  await test.step('workshop link: Enter on "Create workshop link"', async () => {
    const more = dialog.getByTestId('share-more')
    if ((await more.getAttribute('open')) === null) await dialog.getByTestId('share-more-toggle').click()
    const create = dialog.getByTestId('workshop-link-create')
    await create.focus()
    await a.page.keyboard.press('Enter')
    await expect(dialog.getByTestId('workshop-link-row')).toHaveCount(1)
    await expect(dialog.getByTestId('workshop-link-status')).toContainText('Workshop link created')
    await expect(create).toBeFocused()
    await a.page.screenshot({ path: testInfo.outputPath('a11y3-share-created.png') })
  })

  await test.step('every Revoke… is at least 24 × 24 px', async () => {
    const revokes = dialog.getByTestId('review-link-revoke')
    await expect(revokes).toHaveCount(2)
    for (const box of await revokes.evaluateAll((els) =>
      els.map((el) => ({ w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height })),
    )) {
      expect(box.h).toBeGreaterThanOrEqual(24)
      expect(box.w).toBeGreaterThanOrEqual(24)
    }
  })
})

test('A11Y-01: Export "Download PDF" by keyboard: the button has the keyboard again afterwards', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  await note(a.page, 0, 0, TEXTS[0] as string)
  await a.page.getByTestId('export-button').click({ timeout: MISSING_FEATURE_MS })
  const exp = a.page.getByTestId('export-dialog')
  await expect(exp).toBeVisible()
  const pdf = exp.getByTestId('export-pdf')
  await pdf.focus()
  const download = a.page.waitForEvent('download')
  await a.page.keyboard.press('Enter')
  await download
  await expect(exp.getByTestId('export-status')).toContainText('Downloaded')
  await expect(pdf).toBeFocused()
})

test('A11Y-08: the checkpoint preview opens with the keyboard inside it (Zoom to fit), not on ×', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  await note(a.page, 0, 0, TEXTS[0] as string)
  await a.page.getByTestId('dock-tab-history').click({ timeout: MISSING_FEATURE_MS })
  const panel = a.page.getByTestId('history-panel')
  await panel.getByTestId('checkpoint-name').fill('Before clean-up')
  await panel.getByTestId('checkpoint-save').click()
  const preview = panel.getByTestId('checkpoint-preview').first()
  await expect(preview).toBeVisible()
  await preview.click()
  const dialog = a.page.getByTestId('checkpoint-preview-dialog')
  await expect(dialog.getByTestId('checkpoint-preview-canvas')).toBeVisible()
  await expect(dialog.getByTestId('checkpoint-preview-fit')).toBeFocused()
  await a.page.keyboard.press('Enter')
  await expect(dialog).toBeVisible()
  await a.page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})

test('A11Y2-09 + A11Y-09 + A11Y2-10: arriving puts the keyboard on the canvas named "<title> board"; the account badge is tabbed to right after Share; the Share badge name starts with its text', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await a.page.reload()
  await waitForA11y(a.page)
  const title = (await a.page.getByTestId('board-title').textContent())?.trim() ?? ''
  expect(title).not.toBe('')
  await expect
    .poll(() =>
      a.page.evaluate(() => {
        const el = document.activeElement
        return el?.closest('.excalidraw') && el.getAttribute('role') === 'application'
          ? el.getAttribute('aria-label')
          : null
      }),
    )
    .toBe(`${title} board`)
  await expect(a.page.getByRole('application', { name: `${title} board` })).toBeVisible()

  // Tab order from the top of the page: the skip link, the top bar up to Share, then the account badge
  await expect.poll(() => boardHasFocus(a.page)).toBe(true)
  await a.page.evaluate(() => {
    document.body.tabIndex = -1
    document.body.focus()
  })
  const ids: string[] = []
  for (let i = 0; i < 20; i++) {
    await a.page.keyboard.press('Tab')
    ids.push(await focusOf(a.page))
    if (ids.at(-1) === 'dev-identity-badge') break
  }
  expect(ids[0]).toBe('skip-to-canvas')
  expect(ids.indexOf('dev-identity-badge')).toBe(ids.indexOf('share-button') + 1)

  const badge = a.page.getByTestId('share-badge')
  if (await badge.isVisible()) {
    const shown = ((await badge.locator('.dr-sharebadge__text').textContent()) ?? '').trim()
    expect(shown).not.toBe('')
    expect((await badge.getAttribute('aria-label')) ?? '').toMatch(new RegExp(`^${escapeRe(shown)}\\. `))
  }
})

test('A11Y2-07: Ctrl+/ and "?" on the board leave the theme alone', async ({ canvasSession }) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  await focusCanvas(a.page)
  const before = await canvasMode(a.page)
  expect(before).not.toBe('mixed')
  await a.page.keyboard.press('ControlOrMeta+/')
  await a.page.waitForTimeout(200)
  expect(await canvasMode(a.page)).toBe(before)
  await a.page.keyboard.press('Escape')
  await focusCanvas(a.page)
  await a.page.keyboard.press('Shift+/')
  await a.page.waitForTimeout(200)
  expect(await canvasMode(a.page)).toBe(before)
})

test('A11Y2-07 + A11Y2-08: "?" and Ctrl+/ open the shortcuts, which say how to go inside a frame', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  await focusCanvas(a.page)
  const dialog = a.page.getByRole('dialog', { name: /Keyboard shortcuts/ })
  await a.page.keyboard.press('ControlOrMeta+/')
  await expect(dialog).toBeVisible({ timeout: MISSING_FEATURE_MS })
  await a.page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  // "?" as a keyboard types it (Shift+/ on a US layout gives the key "?"); Playwright's Shift+/ sends "/"
  await a.page.keyboard.press('Shift+?')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Go inside the selected frame')
})

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
