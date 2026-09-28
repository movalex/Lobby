// Storage visibility and the unreferenced-file collector (UPL-1, SEAM-02, SEAM-11): the dashboard
// sidebar says how much of the workspace's storage is used ("Storage: 1.2 GB of 100 GB"), and an owner's
// storage check reads every board of the workspace through the real sync server. The api's own rules
// (every reference source, marking, deleting) are covered by apps/api/test/files/gc.test.ts; the sync
// endpoint by apps/sync/test/http/asset-refs.test.ts.
import type { Page } from '@playwright/test'
import type { Me } from './support/api.ts'
import { signInThroughUi } from './support/board.ts'
import { expect, test } from './support/fixtures.ts'
import { WEB_URL } from './support/ports.ts'
import { capture } from './support/screenshots.ts'
import { THEME_KEY } from './support/theme.ts'

const MiB = 1024 * 1024

/** The sidebar's formatting (apps/web/src/dashboard/Sidebar.tsx formatStorage). */
function formatStorage(bytes: number): string {
  if (bytes >= 1024 * MiB) return `${Number((bytes / (1024 * MiB)).toFixed(1))} GB`
  if (bytes >= MiB) return `${Math.round(bytes / MiB)} MB`
  if (bytes > 0) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return '0 MB'
}

interface Storage {
  usedBytes: number
  quotaBytes: number
  files: number
  boards: { count: number; max: number }
  gc?: { mode: string; unreferenced: { versions: number } }
}

const storageOf = async (page: Page, wid: string) => {
  const res = await page.request.get(`/api/workspaces/${wid}/storage`)
  expect(res.status()).toBe(200)
  return (await res.json()) as Storage
}

async function uploadBin(page: Page, boardId: string, bytes: number) {
  const res = await page.request.post(`/api/boards/${boardId}/assets`, {
    headers: {
      origin: WEB_URL,
      'content-type': 'application/octet-stream',
      'x-file-name': 'handover-notes.bin',
    },
    data: Buffer.alloc(bytes, 7),
  })
  expect(res.status(), await res.text()).toBe(201)
}

test('storage line: the dashboard says how much of the workspace storage is used (light, dark, phone)', async ({
  browser,
  users,
  stackReady: _,
}, testInfo) => {
  const user = { handle: `sto-${Date.now().toString(36).slice(-6)}`, name: 'Stella Moreno' }
  const context = await browser.newContext({ viewport: { width: 1360, height: 860 } })
  try {
    const page = await context.newPage()
    await page.goto('/')
    await signInThroughUi(page, user)
    const me = (await (await page.request.get('/api/me')).json()) as Me
    const wid = me.workspaces.find((w) => w.name === "Stella Moreno's workspace")?.id ?? ''
    expect(wid).not.toBe('')
    await page.goto(`/w/${wid}`)
    const line = page.getByTestId('storage-usage')
    // A brand-new workspace stores nothing; the e2e api keeps the 2 GB default quota.
    await expect(line).toHaveText('Storage: 0 MB of 2 GB')
    const empty = await storageOf(page, wid)
    expect(empty).toMatchObject({ usedBytes: 0, quotaBytes: 2048 * MiB, files: 0 })
    expect(empty.gc?.mode).toBe('report') // the owner sees the collector's summary; report-only by default

    // An upload counts at once (an attachment: the worker makes no previews for it).
    const created = await page.request.post(`/api/workspaces/${wid}/boards`, {
      headers: { origin: WEB_URL },
      data: { title: 'Handover' },
    })
    expect(created.status()).toBe(201)
    const boardId = ((await created.json()) as { id: string }).id
    await uploadBin(page, boardId, 1.5 * MiB)
    const after = await storageOf(page, wid)
    expect(after).toMatchObject({ files: 1, boards: { count: 1, max: 10_000 } })
    expect(after.usedBytes).toBe(1.5 * MiB)
    await page.reload()
    await expect(line).toHaveText(`Storage: ${formatStorage(after.usedBytes)} of 2 GB`)
    await expect(line).toHaveText('Storage: 2 MB of 2 GB')
    await capture('storage-line-light.png', page, testInfo)

    await page.evaluate(([key]) => localStorage.setItem(key as string, 'dark'), [THEME_KEY])
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(line).toHaveText('Storage: 2 MB of 2 GB')
    await capture('storage-line-dark.png', page, testInfo)

    await page.setViewportSize({ width: 390, height: 844 })
    await page.reload()
    await expect(line).toBeVisible()
    const box = await line.boundingBox()
    expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    await capture('storage-line-phone-dark.png', page, testInfo)
    await page.evaluate(([key]) => localStorage.setItem(key as string, 'light'), [THEME_KEY])
    await page.reload()
    await expect(line).toHaveText('Storage: 2 MB of 2 GB')
    await capture('storage-line-phone-light.png', page, testInfo)

    // A plain member of a workspace sees the line too, without the collector's summary.
    const bob = await users.api('bob')
    const memberView = await bob.fetch('GET', `/api/workspaces/${users.devStudioId}/storage`)
    expect(memberView.status()).toBe(200)
    expect(await memberView.json()).not.toHaveProperty('gc')
  } finally {
    await context.close()
  }
})

test('storage check: an owner checks the workspace now, and every board is read through the sync server', async ({
  users,
  stackReady: _,
}) => {
  const alice = await users.api('alice')
  const boards = [await users.createBoard('Storage check A'), await users.createBoard('Storage check B')]
  for (const b of boards) expect((await alice.ticket(b)).role).toBe('owner') // the boards exist
  const res = await alice.fetch('POST', `/api/workspaces/${users.devStudioId}/storage/scan`)
  expect(res.status(), await res.text()).toBe(200)
  const report = (await res.json()) as {
    summary: {
      lastRun: { mode: string; complete: boolean; boardsScanned: number; boardsFailed: number } | null
    }
    versions: unknown[]
  }
  // Report-only, complete: every board answered (a Dev Studio of this run may hold other boards too).
  expect(report.summary.lastRun).toMatchObject({ mode: 'report', complete: true, boardsFailed: 0 })
  const listed = await alice.listBoards(users.devStudioId)
  const trashed = await alice.listBoards(users.devStudioId, 'trashed')
  const archived = await alice.listBoards(users.devStudioId, 'archived')
  expect(report.summary.lastRun?.boardsScanned).toBe(listed.length + trashed.length + archived.length)
  // Nothing uploaded in this run is a week old, so nothing is reported unreferenced.
  expect(report.versions).toEqual([])

  // A member may not run it or read the report.
  const bob = await users.api('bob')
  expect((await bob.fetch('POST', `/api/workspaces/${users.devStudioId}/storage/scan`)).status()).toBe(403)
  expect((await bob.fetch('GET', `/api/workspaces/${users.devStudioId}/storage/gc-report`)).status()).toBe(
    403,
  )
})
