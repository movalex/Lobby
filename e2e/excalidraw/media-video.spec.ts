// Wave 3g, ported from e2e/tests/files.spec.ts "7) video card plays the original MP4 on the other client"
// (tagged @chrome there): H.264 playback needs branded Chrome, so this file runs on the `chrome` channel
// (a worker of its own, so a stack of its own).
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw -- media-video
import { join } from 'node:path'
import { expect, selection, selectNone, test } from '../tests/support/canvas.ts'
import { FIXTURES_DIR } from '../tests/support/stack.ts'
import { fileCard, insertFiles } from './media-kit.ts'

const fixture = (name: string) => join(FIXTURES_DIR, name)

test.use({ channel: 'chrome' })

test('7) video card plays the original MP4 on the other client', async ({ canvasSession, board }) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await insertFiles(a.page, [fixture('video.mp4')])
  const card = fileCard(b.page, 'video.mp4')
  await expect(card).toHaveAttribute('data-status', 'ready', { timeout: 60_000 })
  await selectNone(b.page)
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
  expect(await selection(b.page)).toEqual([])
})
