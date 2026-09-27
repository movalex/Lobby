// Milestone-0 demonstrations 6 and 7: the shared dr-file-card shape, and real uploads going through
// the dev file routes and the preview worker (child process) to cards on both clients.
//
// The migration of dr-file-card and server-side rejection of invalid records are covered below the
// browser: packages/canvas-schema/src/file-card.test.ts, apps/web/src/schema.test.ts (client schema
// === server schema), apps/sync/test/protocol/schema.test.ts (old/new clients, migrate on load) and
// apps/sync/test/protocol/validation.test.ts (INVALID_RECORD).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { edit, fileCard, getShape, insertFiles, type Session } from './support/board.ts'
import { expect, test } from './support/fixtures.ts'
import { capture } from './support/screenshots.ts'
import { FIXTURES_DIR } from './support/stack.ts'

const fixture = (name: string) => join(FIXTURES_DIR, name)
const ORIGINAL_HREF = /^\/files\/ast_[0-9A-Za-z]{20}\/ver_[0-9A-Za-z]{20}\/original\?board=/
const DERIVATIVE_SRC = /^\/files\/ast_[0-9A-Za-z]{20}\/ver_[0-9A-Za-z]{20}\/d\/drv_[0-9A-Za-z]{20}\?board=/

/** The image decoded (so the derivative route really served an image) and is board-scoped. */
async function expectLoadedImage(img: Locator, board: string) {
  await expect(img).toHaveAttribute('src', DERIVATIVE_SRC)
  await expect(img).toHaveAttribute('src', new RegExp(`\\?board=${board}$`))
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
}

/** The download link serves the original bytes of `name` as an attachment. */
async function expectDownload(s: Session, card: Locator, name: string, board: string) {
  const link = card.getByTestId('file-card-download')
  await expect(link).toHaveAttribute('href', ORIGINAL_HREF)
  await expect(link).toHaveAttribute('href', new RegExp(`\\?board=${board}$`))
  const href = (await link.getAttribute('href')) ?? ''
  const res = await s.page.request.get(href)
  expect(res.status()).toBe(200)
  expect(res.headers()['content-disposition']).toMatch(/^attachment;/)
  expect(Buffer.compare(await res.body(), readFileSync(fixture(name)))).toBe(0)
}

/** Records every data-status each file card shows, in order (deduplicated), keyed by file name. */
async function recordCardStatuses(page: Page) {
  await page.evaluate(() => {
    const log: Record<string, string[]> = {}
    ;(window as unknown as { __cardStatuses: Record<string, string[]> }).__cardStatuses = log
    const note = () => {
      for (const el of document.querySelectorAll('[data-testid="file-card"]')) {
        const name = el.querySelector('.dr-fc__name')?.textContent ?? '?'
        const status = el.getAttribute('data-status') ?? '?'
        log[name] ??= []
        const seq = log[name]
        if (seq[seq.length - 1] !== status) seq.push(status)
      }
    }
    new MutationObserver(note).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-status'],
    })
    note()
  })
}
const cardStatuses = (page: Page) =>
  page.evaluate(() => (window as unknown as { __cardStatuses: Record<string, string[]> }).__cardStatuses)

test('6) custom dr-file-card (shared schema): a card created on A renders on B with the same props', async ({
  session,
}) => {
  const CARD = 'shape:schema-card'
  const a = await session('alice')
  const b = await session('bob')
  await edit(
    a.page,
    (ed, id) =>
      ed.createShape({
        id,
        type: 'dr-file-card',
        x: 200,
        y: 160,
        props: {
          w: 260,
          h: 356,
          // Ids the schema accepts but that name no stored upload, so every tab renders the hint props.
          assetId: 'ast_schemaDemo01',
          versionId: 'ver_schemaDemo01',
          kind: 'pdf',
          name: 'q3-plan.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 48213,
          status: 'processing',
          pageCount: 12,
          durationMs: null,
          posterDerivativeId: null,
        },
      }),
    CARD,
  )
  const card = fileCard(b.page, 'q3-plan.pdf')
  await expect(card).toHaveAttribute('data-kind', 'pdf')
  await expect(card).toHaveAttribute('data-status', 'processing')
  await expect(card.getByTestId('file-card-pages')).toHaveText('12 pages')
  const onA = await getShape(a.page, CARD)
  const onB = await getShape(b.page, CARD)
  expect(onB?.props).toEqual(onA?.props)
  expect(onB?.props).toMatchObject({ name: 'q3-plan.pdf', pageCount: 12, posterDerivativeId: null })

  // And back: B's edit to the custom shape reaches A.
  await edit(
    b.page,
    (ed, id) => ed.updateShape({ id, type: 'dr-file-card', props: { name: 'q3-plan-v2.pdf' } }),
    CARD,
  )
  await expect(fileCard(a.page, 'q3-plan-v2.pdf')).toBeVisible()
})

test('7) uploads: PDF, MP4, encrypted PDF and an attachment become cards on both clients', async ({
  session,
  stack,
  board,
}) => {
  const a = await session('alice')
  const b = await session('bob')
  await Promise.all([recordCardStatuses(a.page), recordCardStatuses(b.page)])
  const files = ['document.pdf', 'video.mp4', 'encrypted.pdf', 'notes.zip']

  // With the worker stopped, every card must sit in 'queued' where both users can see it.
  await stack.worker.kill()
  await insertFiles(a.page, files.map(fixture))
  for (const s of [a, b]) {
    for (const name of files) await expect(fileCard(s.page, name)).toHaveAttribute('data-status', 'queued')
  }
  await stack.worker.start()

  for (const s of [a, b]) {
    await test.step(`${s.user}: document.pdf -> ready, cover + 4 pages`, async () => {
      const card = fileCard(s.page, 'document.pdf')
      await expect(card).toHaveAttribute('data-status', 'ready', { timeout: 30_000 })
      await expect(card).toHaveAttribute('data-kind', 'pdf')
      await expectLoadedImage(card.getByTestId('file-card-preview'), board)
      await expect(card.getByTestId('file-card-pages')).toHaveText('4 pages')
      // Pages 2..4 were rendered eagerly too (the page strip).
      await expect(card.locator('[data-testid="file-card-strip"] img')).toHaveCount(3)
    })
    await test.step(`${s.user}: video.mp4 -> ready, poster + duration + play`, async () => {
      const card = fileCard(s.page, 'video.mp4')
      await expect(card).toHaveAttribute('data-status', 'ready', { timeout: 30_000 })
      await expect(card).toHaveAttribute('data-kind', 'video')
      await expectLoadedImage(card.getByTestId('file-card-preview'), board)
      await expect(card.getByTestId('file-card-duration')).toHaveText('0:05')
      await expect(card.getByTestId('file-card-play')).toBeVisible()
    })
    await test.step(`${s.user}: encrypted.pdf -> failed, readable error, download`, async () => {
      const card = fileCard(s.page, 'encrypted.pdf')
      await expect(card).toHaveAttribute('data-status', 'failed', { timeout: 30_000 })
      await expect(card.getByTestId('file-card-error')).toHaveText(
        'This PDF is password-protected. Download it to view it.',
      )
      await expectDownload(s, card, 'encrypted.pdf', board)
    })
    await test.step(`${s.user}: notes.zip -> attachment card with download`, async () => {
      const card = fileCard(s.page, 'notes.zip')
      await expect(card).toHaveAttribute('data-status', 'ready', { timeout: 30_000 })
      await expect(card).toHaveAttribute('data-kind', 'other')
      await expect(card).toContainText('Attachment')
      await expect(card.getByTestId('file-card-preview')).toHaveCount(0)
      await expectDownload(s, card, 'notes.zip', board)
    })
  }

  // Every card moved forward only: queued first, then (possibly a brief processing), then terminal.
  const terminal: Record<string, string> = {
    'document.pdf': 'ready',
    'video.mp4': 'ready',
    'encrypted.pdf': 'failed',
    'notes.zip': 'ready',
  }
  for (const s of [a, b]) {
    const seen = await cardStatuses(s.page)
    for (const name of files) {
      const seq = seen[name] ?? []
      expect([
        ['queued', terminal[name]],
        ['queued', 'processing', terminal[name]],
      ]).toContainEqual(seq)
    }
    test.info().annotations.push({ type: `${s.user} card statuses`, description: JSON.stringify(seen) })
  }

  // A wider window so the whole row of cards clears tldraw's style panel in the screenshot.
  await b.page.setViewportSize({ width: 1600, height: 820 })
  await edit(b.page, (ed) => ed.zoomToFit())
  for (const name of files) await expect(fileCard(b.page, name)).toBeInViewport()
  await capture('file-cards-ready.png', b.page, test.info())
})

test('7) video card plays the original MP4 on the other client', { tag: '@chrome' }, async ({
  session,
  board,
}) => {
  const a = await session('alice')
  const b = await session('bob')
  await insertFiles(a.page, [fixture('video.mp4')])
  const card = fileCard(b.page, 'video.mp4')
  await expect(card).toHaveAttribute('data-status', 'ready', { timeout: 30_000 })
  await card.getByTestId('file-card-play').click()
  const video = card.getByTestId('file-card-video')
  await expect(video).toHaveAttribute(
    'src',
    new RegExp(`^/files/ast_\\w{20}/ver_\\w{20}/original\\?board=${board}$`),
  )
  await expect
    .poll(() => video.evaluate((v) => (v as HTMLVideoElement).currentTime), { timeout: 20_000 })
    .toBeGreaterThan(0.5)
  expect(await video.evaluate((v) => (v as HTMLVideoElement).error)).toBeNull()
  // Clicking play must not have selected (or started dragging) the card.
  expect(await b.page.evaluate(() => window.editor?.getSelectedShapeIds() ?? [])).toEqual([])
  await capture('video-playing.png', b.page, test.info())
})
