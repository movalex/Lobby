// Wave S, WS2 (docs/WAVE-S-CONTRACTS.md §3.3): video A/B in the review viewer, with the versions switch on. H.264
// playback needs branded Chrome (as media-video.spec.ts), so this file runs on the `chrome` channel. One transport:
// Play drives A and B follows A's clock (B muted); a seek moves both; the wipe clips B; the A and B keys (inside the
// viewer only) toggle which one shows.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e exec playwright test -c excalidraw/playwright.config.ts s2-compare-video
import { join } from 'node:path'
import type { Locator } from '@playwright/test'
import { expect, selectNone, test } from '../tests/support/canvas.ts'
import { fileFromPath } from '../tests/support/files.ts'
import { FIXTURES_DIR } from '../tests/support/stack.ts'
import { cardItems, fileCard, insertFiles, newItems } from './media-kit.ts'
import { chipOf, uploadNewVersion, withVersions } from './s2-kit.ts'

const fixture = (name: string) => join(FIXTURES_DIR, name)

test.use({ channel: 'chrome', viewport: { width: 1440, height: 900 } })

const clock = (v: Locator) =>
  v.evaluate((el) => {
    const x = el as HTMLVideoElement
    return { t: x.currentTime, paused: x.paused, muted: x.muted, error: x.error?.code ?? null }
  })

test('S2 video A/B: one transport, B follows A muted; seek; wipe; the A and B keys toggle', async ({
  canvasSession,
}) => {
  test.setTimeout(180_000)
  const a = await withVersions(await canvasSession('alice'))
  const before = new Set((await cardItems(a.page)).map((f) => f.id))
  await insertFiles(a.page, [fixture('video.mp4')])
  const [card] = await newItems(a.page, cardItems, before, 1)
  if (!card) throw new Error('no card')
  await expect(fileCard(a.page, 'video.mp4')).toHaveAttribute('data-status', 'ready', { timeout: 60_000 })
  await uploadNewVersion(a.page, card.id, { ...fileFromPath(fixture('video.mp4')), name: 'trailer-v2.mp4' })
  await expect(fileCard(a.page, 'trailer-v2.mp4')).toHaveAttribute('data-status', 'ready', {
    timeout: 60_000,
  })
  await expect(chipOf(a.page, card.id)).toHaveText('v2')

  await selectNone(a.page)
  await chipOf(a.page, card.id).click()
  await a.page
    .getByTestId('version-list')
    .locator(`[data-version="${card.facts.versionId}"]`)
    .getByTestId('version-compare')
    .click()
  const viewer = a.page.getByTestId('review-viewer')
  await expect(viewer.getByTestId('compare')).toHaveAttribute('data-kind', 'video')
  const va = viewer.getByTestId('compare-a')
  const vb = viewer.getByTestId('compare-b')
  await expect(va).toHaveAttribute(
    'src',
    new RegExp(`/files/${card.facts.assetId}/${card.facts.versionId}/original`),
  )
  await expect.poll(async () => (await clock(vb)).muted).toBe(true)

  await viewer.getByTestId('compare-play').click()
  await expect.poll(async () => (await clock(va)).t, { timeout: 20_000 }).toBeGreaterThan(1)
  const playing = await Promise.all([clock(va), clock(vb)])
  expect(playing[0].paused).toBe(false)
  expect(playing[1].paused).toBe(false)
  expect(playing[0].error).toBeNull()
  expect(playing[1].error).toBeNull()
  // B on A's clock (the follower seeks past 60 ms; reading the two clocks is not atomic)
  expect(Math.abs(playing[0].t - playing[1].t)).toBeLessThan(0.3)

  await viewer.getByTestId('compare-play').click()
  await expect.poll(async () => (await clock(vb)).paused).toBe(true)
  // seek while paused: B follows within a check (250 ms)
  await viewer.getByTestId('compare-seek').fill('3.5')
  await expect.poll(async () => Math.abs((await clock(va)).t - 3.5)).toBeLessThan(0.1)
  await expect.poll(async () => Math.abs((await clock(vb)).t - 3.5)).toBeLessThan(0.1)
  await expect(viewer.getByTestId('compare-time')).toContainText('0:03.5')

  // wipe: B clipped at the divider
  await viewer.getByTestId('compare-mode-wipe').click()
  await viewer.getByTestId('compare-wipe').fill('25')
  await expect(viewer.locator('.lobby-cmp__pane--b')).toHaveAttribute(
    'style',
    /inset\(0(px)? 0(px)? 0(px)? 25%\)/,
  )

  // the A and B keys, inside the viewer
  await viewer.getByTestId('compare-mode-side').focus()
  await a.page.keyboard.press('b')
  await expect(viewer.getByTestId('compare-show-b')).toHaveAttribute('aria-pressed', 'true')
  await expect(viewer.locator('.lobby-cmp__videos')).toHaveAttribute('data-shown', 'B')
  await a.page.keyboard.press('a')
  await expect(viewer.locator('.lobby-cmp__videos')).toHaveAttribute('data-shown', 'A')
  // still one element on the board: the keys never reached it
  expect((await cardItems(a.page)).map((f) => f.id)).toEqual([card.id])
  await a.page.keyboard.press('Escape')
  await expect(viewer).toHaveCount(0)
})
