// P-003 (wave P release audit): a short offline blip while editing. The browser says it is offline before the
// board's socket notices (its heartbeat takes up to 30 s): the board says so at once, calmly ("Offline – your
// changes are kept on this device and will sync…"), and a part of Lobby that fails to load while offline (here the
// export code, which a thumbnail or an export would load) says nothing: never a "reload" toast mid-edit. Back
// online, the banner goes and the edit made offline reaches bob.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/p-offline.spec.ts   (from e2e/)
import {
  clickItem,
  createNote,
  expect,
  expectSaved,
  itemText,
  test,
  waitForItem,
} from '../tests/support/canvas.ts'
import { connPill } from './board-kit.ts'

test('P-003: offline mid-edit shows a clear offline banner at once; a chunk that fails offline says nothing; back online the edit syncs', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const page = a.page
  const before = await createNote(page, { x: 200, y: 160, text: 'Before the blip' })
  await expectSaved(page)
  await waitForItem(b.page, before)
  await expect(page.getByTestId('offline-banner')).toHaveCount(0)

  await a.context.setOffline(true)
  await test.step('the browser is offline: the banner and the status say so within a moment', async () => {
    const banner = page.getByTestId('offline-banner')
    await expect(banner).toBeVisible({ timeout: 3_000 })
    await expect(banner).toContainText('Offline – your changes are kept on this device and will sync')
    await expect(connPill(page)).toHaveAttribute('data-state', 'offline')
  })

  await test.step('an edit made offline, and a part of Lobby that cannot load now: no notice, no reload toast', async () => {
    const note = await createNote(page, { x: 520, y: 160, text: 'Typed while offline' })
    // the export code (not loaded yet on this tab) is asked for while offline: it fails to load
    await clickItem(page, note, { button: 'right' })
    await expect(page.getByTestId('context-menu')).toBeVisible()
    await page.getByTestId('context-menu-sub.export-as-button').click()
    await page.getByTestId('context-menu.export-as-png').click()
    await page.waitForTimeout(2_500)
    await expect(page.getByTestId('stale-chunk-offline-notice')).toHaveCount(0)
    await expect(page.getByTestId('stale-chunk-notice')).toHaveCount(0)
    await expect(page.getByText(/reload/i)).toHaveCount(0)
    await expect(page.getByTestId('offline-banner')).toBeVisible()

    await a.context.setOffline(false)
    await expect(page.getByTestId('offline-banner')).toHaveCount(0, { timeout: 30_000 })
    await expectSaved(page)
    await waitForItem(b.page, note)
    await expect.poll(() => itemText(b.page, note)).toBe('Typed while offline')
  })
})

// Wave P review: the Share dialog's code, asked for while offline, failed to load and React.lazy kept the failure
// for the tab's lifetime: Share did nothing for the rest of the tab, and the code was never asked for again (so
// not even a notice came). Now the failed open says nothing (the banner speaks) and closes itself, and the next
// open asks for the code again: the dialog opens, or, where the browser keeps its failed import (Chromium does),
// one calm notice says that part did not finish loading while offline (never "Lobby has been updated"), and its
// Reload brings the dialog back.
test('P-003 review: Share clicked while offline does nothing visible; back online, Share opens the dialog or says why once', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const page = a.page
  await a.context.setOffline(true)
  await expect(page.getByTestId('offline-banner')).toBeVisible({ timeout: 3_000 })

  await test.step('offline: Share shows nothing, no dialog and no notice', async () => {
    await page.getByTestId('share-button').click()
    await page.waitForTimeout(2_000)
    await expect(page.getByTestId('share-dialog')).toHaveCount(0)
    await expect(page.getByTestId('stale-chunk-notice')).toHaveCount(0)
    await expect(page.getByTestId('stale-chunk-offline-notice')).toHaveCount(0)
  })

  await a.context.setOffline(false)
  await expect(page.getByTestId('offline-banner')).toHaveCount(0, { timeout: 30_000 })
  const dialog = page.getByTestId('share-dialog')
  const notice = page.getByTestId('stale-chunk-notice')
  await test.step('back online: Share opens the dialog, or one calm notice with Reload', async () => {
    await page.getByTestId('share-button').click()
    await expect(dialog.or(notice)).toBeVisible()
  })
  if ((await dialog.count()) > 0) return

  await test.step('the notice: the offline words, once; Share again adds no second one', async () => {
    await expect(notice).toHaveCount(1)
    await expect(notice).toContainText('did not finish loading while you were offline')
    await expect(notice).not.toContainText('has been updated')
    await page.getByTestId('share-button').click()
    await page.waitForTimeout(1_000)
    await expect(notice).toHaveCount(1)
    await expect(notice).toContainText('did not finish loading while you were offline')
  })

  await test.step('its Reload: the board again, and Share opens the dialog', async () => {
    await page.getByTestId('stale-chunk-reload').click()
    await expect(page.getByTestId('lobby-board')).toHaveAttribute('data-phase', 'ready', { timeout: 30_000 })
    await page.getByTestId('share-button').click()
    await expect(dialog).toBeVisible()
    await expect(notice).toHaveCount(0)
  })
})

// Wave P review: Windows and VPNs often report navigator.onLine false (with an `offline` event) while the network
// works. The board said "Offline" while its socket was live. Now the browser's signal starts a quick probe of the
// socket: a socket that answers is trusted (the board stays Live), and only one that does not shows offline.
test('P-003 review: a wrong offline signal while the socket is live: the board stays Live and edits sync', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const page = a.page
  await expect(connPill(page)).toHaveAttribute('data-state', 'online')
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
    window.dispatchEvent(new Event('offline'))
  })
  await page.waitForTimeout(3_000)
  await expect(page.getByTestId('offline-banner')).toHaveCount(0)
  await expect(connPill(page)).toHaveAttribute('data-state', 'online')
  const note = await createNote(page, { x: 320, y: 200, text: 'Still live' })
  await expectSaved(page)
  await waitForItem(b.page, note)
  await expect.poll(() => itemText(b.page, note)).toBe('Still live')
  await expect(page.getByTestId('offline-banner')).toHaveCount(0)
})
