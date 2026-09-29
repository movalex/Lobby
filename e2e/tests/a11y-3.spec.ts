// a11y-3 (the Monday review's accessibility share, docs/BACKLOG.md): the AI summary panel takes the
// keyboard and is announced (A11Y2-03); Share "Create…" and Export "Download PDF" keep the keyboard on
// the control that was used and say what happened (A11Y-01); Revoke… targets, the checkpoint preview's
// first focus and the account badge's Tab stop (A11Y-08, A11Y-09); arriving on a board lands on a named
// canvas (A11Y2-09); Ctrl+/ and "?" open the shortcuts instead of flipping the theme (A11Y2-07/08);
// the Share badge's name starts with what it shows (A11Y2-10). OpenAI is the local fake (support/ai.ts).
import type { Page } from '@playwright/test'
import { AI_API_ENV, type FakeOpenAi, startFakeOpenAi } from './support/ai.ts'
import { read, waitForBoard } from './support/board.ts'
import { test as base, expect } from './support/fixtures.ts'
import { openHistory } from './support/history.ts'
import { capture } from './support/screenshots.ts'
import { createShapes, noteAt, selectIds } from './support/tags.ts'
import { canvasMode } from './support/theme.ts'

const test = base.extend<object, { openai: FakeOpenAi }>({
  openai: [
    async ({ stack: _ }, use) => {
      const fake = await startFakeOpenAi()
      await use(fake)
      await fake.close()
    },
    { scope: 'worker' },
  ],
})

test.use({ viewport: { width: 1440, height: 900 }, apiEnv: AI_API_ENV })
test.beforeEach(({ openai }) => openai.reset())

/** What has the keyboard: 'BODY', a test id, or the element's tag and classes. */
const focusOf = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null
    if (!a || a === document.body) return 'BODY'
    return (
      a.getAttribute('data-testid') ??
      `${a.tagName.toLowerCase()}${a.classList.length ? `.${[...a.classList].join('.')}` : ''}`
    )
  })

const selected = (page: Page) => read(page, (ed) => ed.getSelectedShapeIds().length)

const NOTES = [
  noteAt('shape:a11y3-a', 0, 0, 'Open on the boss fight'),
  noteAt('shape:a11y3-b', 240, 0, 'One unbroken shot'),
  noteAt('shape:a11y3-c', 480, 0, 'Cut it from player clips'),
]
const NOTE_IDS = NOTES.map((n) => n.id)

async function selectNotes(page: Page) {
  await createShapes(page, NOTES)
  await read(page, () => null)
  await page.evaluate(() => {
    const ed = window.editor as unknown as { zoomToFit(o: { immediate: boolean }): void }
    ed.zoomToFit({ immediate: true })
  })
  await selectIds(page, NOTE_IDS)
}

test('A11Y2-03: a summary asked for from the keyboard takes the focus and is announced; Escape closes it from anywhere and keeps the selection', async ({
  session,
}, testInfo) => {
  const a = await session('alice')
  await selectNotes(a.page)
  const panel = a.page.getByTestId('ai-summary-panel')
  const status = a.page.getByTestId('ai-summary-status')

  await test.step('keyboard: Summarize, Continue with Enter; the panel has the focus and is a named dialog', async () => {
    await a.page.getByTestId('selection-ai').click()
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
    await expect(a.page.getByRole('dialog', { name: /Summary/ })).toBeVisible()
    await expect(status).toHaveText('Summary ready.')
    await capture('a11y3-summary-focused.png', a.page, testInfo)
    // Tab stays with the panel's controls; Escape closes it and gives the keyboard back.
    await a.page.keyboard.press('Shift+Tab')
    await expect(panel.getByTestId('ai-summary-copy')).toBeFocused()
    await a.page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await expect(status).toHaveText('')
    expect(await focusOf(a.page)).not.toBe('BODY')
    expect(await selected(a.page)).toBe(3)
  })

  await test.step('pointer: the focus stays put, the text is announced, and Escape on the board closes it (not the selection)', async () => {
    await a.page.getByTestId('selection-ai').click()
    await a.page.getByTestId('ai-summarize').click()
    await expect(panel.getByTestId('ai-summary-text')).toContainText('launch trailer')
    await expect(status).toContainText('Summary ready: The team is looking for the launch trailer')
    expect(
      await a.page.evaluate(() => !!document.activeElement?.closest('[data-testid="ai-summary-panel"]')),
    ).toBe(false)
    await a.page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    expect(await selected(a.page)).toBe(3)
  })
})

test('A11Y-01 + A11Y-08: Share "Create…" keeps the keyboard and says what it did; Revoke… is at least 24 px; Export "Download PDF" keeps the keyboard', async ({
  session,
}, testInfo) => {
  const a = await session('alice')
  await createShapes(a.page, [NOTES[0] as Record<string, unknown>])
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
    await capture('a11y3-share-created.png', a.page, testInfo)
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

  await test.step('Export, Download PDF by keyboard: the button has the keyboard again afterwards', async () => {
    await a.page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await a.page.getByTestId('export-button').click()
    const exp = a.page.getByTestId('export-dialog')
    await expect(exp).toBeVisible()
    const pdf = exp.getByTestId('export-pdf')
    await pdf.focus()
    const download = a.page.waitForEvent('download')
    await a.page.keyboard.press('Enter')
    await download
    await expect(exp.getByTestId('export-status')).toContainText('Downloaded')
    await expect(pdf).toBeFocused()
    await capture('a11y3-export-done.png', a.page, testInfo)
  })
})

test('A11Y-08: the checkpoint preview opens with the keyboard inside it (Zoom to fit), not on ×', async ({
  session,
}, testInfo) => {
  const a = await session('alice')
  await createShapes(a.page, [NOTES[0] as Record<string, unknown>])
  await expect(a.page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved')
  const panel = await openHistory(a.page)
  await panel.getByTestId('checkpoint-name').fill('Before clean-up')
  await panel.getByTestId('checkpoint-save').click()
  const preview = panel.getByTestId('checkpoint-preview').first()
  await expect(preview).toBeVisible()
  await preview.click()
  const dialog = a.page.getByTestId('checkpoint-preview-dialog')
  await expect(dialog.getByTestId('checkpoint-preview-canvas')).toContainText('Open on the boss fight')
  await expect(dialog.getByTestId('checkpoint-preview-fit')).toBeFocused()
  await capture('a11y3-preview-focus.png', a.page, testInfo)
  await a.page.keyboard.press('Enter') // Zoom to fit: the dialog stays open
  await expect(dialog).toBeVisible()
  await a.page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})

test('A11Y2-09 + A11Y-09 + A11Y2-10: arriving puts the keyboard on the canvas named "<title> board"; the account badge is tabbed to right after Share; the Share badge name starts with its text', async ({
  session,
}) => {
  const a = await session('alice')
  await a.page.reload()
  await waitForBoard(a.page)
  const title = (await a.page.getByTestId('board-title').textContent())?.trim() ?? ''
  expect(title).not.toBe('')
  await expect
    .poll(() =>
      a.page.evaluate(() => {
        const el = document.activeElement
        return el?.classList.contains('tl-container') ? el.getAttribute('aria-label') : null
      }),
    )
    .toBe(`${title} board`)
  await expect(a.page.getByRole('application', { name: `${title} board` })).toBeVisible()

  // Tab order from the top of the page: the skip link, the top bar up to Share, then the account badge.
  await fromPageTop(a.page)
  const ids: string[] = []
  for (let i = 0; i < 20; i++) {
    await a.page.keyboard.press('Tab')
    ids.push(await focusOf(a.page))
    if (ids.at(-1) === 'dev-identity-badge') break
  }
  expect(ids[0]).toBe('skip-to-canvas')
  expect(ids.indexOf('dev-identity-badge')).toBe(ids.indexOf('share-button') + 1)

  // WCAG 2.5.3: the badge's visible words start its accessible name.
  const badge = a.page.getByTestId('share-badge')
  if (await badge.isVisible()) {
    const shown = ((await badge.locator('.dr-sharebadge__text').textContent()) ?? '').trim()
    expect(shown).not.toBe('')
    expect((await badge.getAttribute('aria-label')) ?? '').toMatch(new RegExp(`^${escapeRe(shown)}\\. `))
  }
})

test('A11Y2-07 + A11Y2-08: Ctrl+/ no longer flips the theme; "?" and Ctrl+/ open the shortcuts, which say how to go inside a frame', async ({
  session,
}, testInfo) => {
  const a = await session('alice')
  await a.page.reload()
  await waitForBoard(a.page)
  const before = await canvasMode(a.page)
  const dialog = a.page.locator('.tlui-shortcuts-dialog__body')
  await a.page.keyboard.press('ControlOrMeta+/')
  await expect(dialog).toBeVisible()
  expect(await canvasMode(a.page)).toBe(before)
  await a.page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await a.page.keyboard.press('Shift+/')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Go inside the selected frame')
  expect(await canvasMode(a.page)).toBe(before)
  await capture('a11y3-shortcuts.png', a.page, testInfo)
})

/**
 * Tab starts from the top of the page again. (A plain blur() leaves the browser's sequential-focus
 * starting point where the focus was: the canvas, since arriving on a board focuses it.)
 */
async function fromPageTop(page: Page) {
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.classList.contains('tl-container') === true))
    .toBe(true)
  await page.evaluate(() => {
    document.body.tabIndex = -1
    document.body.focus()
  })
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
