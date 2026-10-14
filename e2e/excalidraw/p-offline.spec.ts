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
