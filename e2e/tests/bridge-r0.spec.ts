// Bridge release R0 in the browser (docs/EXCALIDRAW-MIGRATION.md §5.9 step 4, §5.10, §7.5 step 3), on
// the real stack:
//   - maintenance: POST /internal/maintenance {on:true} closes the open board with 4099 MAINTENANCE and
//     the page says "Lobby is updating"; a new tab is refused the same way; off again, Retry opens the
//     board with everything that was saved before;
//   - a board born on the new canvas (a board file with only lb_* tables) is refused by the sync server
//     before any room opens: the page says "This board was made on the new canvas. It opens again after
//     the switch." and the file is left byte-identical.
import { createHash } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Page } from '@playwright/test'
import { signInContext } from './support/api.ts'
import { edit, expectConn, getShape, waitForBoard } from './support/board.ts'
import { expect, test } from './support/fixtures.ts'
import { SYNC_URL } from './support/ports.ts'

const maintenance = async (secret: string, on: boolean) => {
  const res = await fetch(`${SYNC_URL}/internal/maintenance`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-draftroom-internal': secret },
    body: JSON.stringify({ on }),
  })
  expect(res.status).toBe(200)
  return (await res.json()) as { maintenance: boolean; closedSockets: number }
}

const expectSyncError = async (page: Page, reason: string, title: string, text: RegExp | string) => {
  const screen = page.getByTestId('sync-error')
  await expect(screen).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('sync-error-reason')).toHaveText(reason)
  await expect(screen.getByRole('heading')).toHaveText(title)
  await expect(screen).toContainText(text)
}

test('maintenance mode: the board closes with "Lobby is updating" and opens again afterwards', async ({
  stack,
  session,
  browser,
  board,
}) => {
  const a = await session('alice')
  await edit(a.page, (ed, id) => ed.createShape({ id, type: 'note', x: 120, y: 120 }), 'shape:before-maint')
  await expect.poll(async () => (await getShape(a.page, 'shape:before-maint')) !== null).toBe(true)
  // saved on the server before maintenance goes on
  await expect(a.page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', { timeout: 30_000 })
  try {
    const on = await maintenance(stack.internalSecret, true)
    expect(on.maintenance).toBe(true)
    expect(on.closedSockets).toBeGreaterThanOrEqual(1)
    await expectSyncError(a.page, 'MAINTENANCE', 'Lobby is updating', /Lobby is updating\./)

    // a new tab is refused the same way
    const context = await browser.newContext()
    try {
      await signInContext(context, 'alice')
      const page = await context.newPage()
      await page.goto(`/b/${board}`)
      await expectSyncError(page, 'MAINTENANCE', 'Lobby is updating', /Lobby is updating\./)
    } finally {
      await context.close()
    }
  } finally {
    await maintenance(stack.internalSecret, false)
  }
  await a.page.getByTestId('sync-retry').click()
  await waitForBoard(a.page)
  await expectConn(a.page, 'online')
  await expect.poll(async () => (await getShape(a.page, 'shape:before-maint')) !== null).toBe(true)
})

test('a board born on the new canvas is refused with its message and left untouched', async ({
  stack,
  browser,
  board,
}) => {
  // What the Excalidraw build leaves: only lb_* tables, lb_meta without converted_from.
  const path = join(stack.dataDir, 'rooms', `board-${board}.sqlite`)
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('CREATE TABLE lb_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.exec(
      `CREATE TABLE lb_elements (id TEXT PRIMARY KEY, clock INTEGER NOT NULL, idx TEXT NOT NULL,
         deleted INTEGER NOT NULL, deleted_clock INTEGER, deleted_at INTEGER, type TEXT NOT NULL,
         version INTEGER NOT NULL, gclock TEXT NOT NULL, data TEXT NOT NULL)`,
    )
    db.exec("INSERT INTO lb_meta (key, value) VALUES ('clock', '1'), ('epoch', 'e-e2e')")
    db.exec(
      "INSERT INTO lb_elements (id, clock, idx, deleted, type, version, gclock, data) VALUES ('r1', 1, 'a0', 0, 'rectangle', 1, '{}', '{}')",
    )
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } finally {
    db.close()
  }
  const sha = () => createHash('sha256').update(readFileSync(path)).digest('hex')
  const before = sha()

  try {
    const context = await browser.newContext()
    try {
      await signInContext(context, 'alice')
      const page = await context.newPage()
      await page.goto(`/b/${board}`)
      await expectSyncError(
        page,
        'NEW_CANVAS_BOARD',
        'Made on the new canvas',
        'This board was made on the new canvas. It opens again after the switch.',
      )
    } finally {
      await context.close()
    }
    expect(sha()).toBe(before)
    const check = new DatabaseSync(path, { readOnly: true })
    try {
      const tables = (
        check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
          name: string
        }>
      ).map((r) => r.name)
      expect(tables).toEqual(['lb_elements', 'lb_meta'])
    } finally {
      check.close()
    }
  } finally {
    // The stack is shared with later specs: R0 rightly cannot read this board (the asset collector's
    // pass over Dev Studio would stay incomplete, storage-2.spec.ts), so the file goes with the test.
    // Sync never opened it, so nothing holds it.
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true })
  }
})
