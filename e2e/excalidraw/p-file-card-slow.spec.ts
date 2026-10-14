// Wave P (code audit item 3): a file card whose preview never comes (the preview worker is down or busy) used to say
// "Queued for preview…" for ever. After two minutes it says the preview is taking longer than usual and that the file can
// still be downloaded; when the worker is back and the preview is made, the card shows it as before.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/p-file-card-slow.spec.ts --project=chromium --workers=1
import { join } from 'node:path'
import { expect, test } from '../tests/support/canvas.ts'
import { FIXTURES_DIR } from '../tests/support/stack.ts'
import { fileCard, insertFiles } from './media-kit.ts'

test('a card still queued after two minutes says the preview is taking longer and the file can be downloaded', async ({
  canvasSession,
  stack,
}) => {
  test.setTimeout(240_000)
  const a = await canvasSession('alice')
  await stack.worker.kill()
  try {
    // timers made from here on run on a clock the test can move (time still flows)
    await a.page.clock.install()
    await insertFiles(a.page, [join(FIXTURES_DIR, 'document.pdf')])
    const card = fileCard(a.page, 'document.pdf')
    await expect(card).toHaveAttribute('data-status', 'queued', { timeout: 30_000 })
    const state = card.getByTestId('file-card-state')
    await expect(state).toHaveText('Queued for preview…')

    await a.page.clock.fastForward('01:30')
    await expect(state).toHaveText('Queued for preview…')

    await a.page.clock.fastForward('00:40')
    await expect(state).toHaveText('Preview is taking longer than usual; you can still download the file.')
    await expect(card.getByTestId('file-card-download')).toBeVisible()
  } finally {
    await stack.worker.start()
  }
  // the worker is back: the preview is made, and the waiting text goes
  const card = fileCard(a.page, 'document.pdf')
  await expect(card).toHaveAttribute('data-status', 'ready', { timeout: 90_000 })
  await expect(card.getByTestId('file-card-state')).toHaveCount(0)
})
