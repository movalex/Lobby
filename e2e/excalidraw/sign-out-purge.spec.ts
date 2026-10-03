// CRIT-18 (wave A, A5): the offline edit queue (IndexedDB `lobby-offline`, canvas/sync/adapter/offline-idb.ts)
// is deleted when the session ends. Before, it was purged only on a guest welcome and on a FORBIDDEN or
// NOT_FOUND close: after Sign out, a board's unsent edits stayed readable in the browser (a shared
// machine). App.tsx now purges every queue of the user who was signed in once the session ends.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/sign-out-purge.spec.ts   (from e2e/)
import type { Page } from '@playwright/test'
import { createItem, expect, expectSaved, saveState, test } from '../tests/support/canvas.ts'
import { expectSaveState } from '../tests/support/excalidraw.ts'

/** The offline queue records of `uid` in this browser (every board and tab), as element ids. */
const queuedFor = (page: Page, uid: string): Promise<string[]> =>
  page.evaluate(
    (who) =>
      new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open('lobby-offline')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const db = open.result
          if (!db.objectStoreNames.contains('queues')) {
            db.close()
            return resolve([])
          }
          const req = db.transaction('queues', 'readonly').objectStore('queues').getAll()
          req.onerror = () => reject(req.error)
          req.onsuccess = () => {
            const recs = req.result as { uid: string; entries: { element: { id: string } }[] }[]
            db.close()
            resolve(recs.filter((r) => r.uid === who).flatMap((r) => r.entries.map((e) => e.element.id)))
          }
        }
      }),
    uid,
  )

test('Sign out deletes the board edits this user had queued on the device (CRIT-18)', async ({
  canvasSession,
  stack,
}) => {
  const a = await canvasSession('alice')
  await expectSaved(a.page)
  // the sync server goes away: alice's edits stay on the device (the api, and so Sign out, still work)
  await stack.sync.kill()
  try {
    await expectSaveState(a.page, 'offline')
    const ids = ['queued-1', 'queued-2']
    for (const [i, id] of ids.entries())
      await createItem(a.page, 'rectangle', { id, x: 80 + i * 160, y: 100, width: 120, height: 100 })
    await expect.poll(async () => (await saveState(a.page)).offlineChanges).toBe(2)
    await expect.poll(async () => (await queuedFor(a.page, a.id)).sort()).toEqual(ids)

    // the account menu (on these stacks the development sign-in's badge) and its Sign out
    await a.page.getByTestId('dev-identity-badge').click({ timeout: 15_000 })
    await a.page.getByTestId('sign-out').click({ timeout: 15_000 })
    await expect(a.page).toHaveURL(/\/signin/)
    expect((await a.page.request.get('/api/me')).status()).toBe(401)
    // nothing of alice's is left in the browser
    await expect.poll(() => queuedFor(a.page, a.id), { timeout: 10_000 }).toEqual([])
  } finally {
    await stack.sync.start()
  }
})
